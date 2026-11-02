'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createWebTerminal, SESSION_IDLE_TTL_MS, SESSION_ABSOLUTE_TTL_MS } = require('../app');
const { createTranscriptionService, cleanTranscript, parseWav, splitSamples, MAX_VOICE_BYTES,
  MAX_VOICE_DURATION_MS, MODEL_FILES, VoiceError } = require('../voice-transcription');
const { authenticate, cookieHeader, oidcServiceOptions } = require('./oidc-test-helpers');

const deferred = () => Promise.withResolvers();
const settle = () => new Promise((resolve) => setImmediate(resolve));
const signal = () => new AbortController().signal;

function wav(samples = new Int16Array(16000), { rate = 16000, channels = 1, format = 1, bits = 16,
  chunks = [] } = {}) {
  const header = Buffer.alloc(24);
  header.write('fmt ', 0, 'latin1');
  header.writeUInt32LE(16, 4);
  header.writeUInt16LE(format, 8);
  header.writeUInt16LE(channels, 10);
  header.writeUInt32LE(rate, 12);
  header.writeUInt32LE(rate * channels * bits / 8, 16);
  header.writeUInt16LE(channels * bits / 8, 20);
  header.writeUInt16LE(bits, 22);
  const data = Buffer.alloc(8);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(samples.byteLength, 4);
  const body = Buffer.concat([header, ...chunks, data,
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'latin1');
  return Buffer.concat([riff, body]);
}

async function fixture(t, options = {}) {
  const transcription = Object.hasOwn(options, 'transcription') ? options.transcription : {
    available: true,
    transcribe: options.transcribe || (async () => ' hi\nthere\x03 '),
    close: async () => {},
  };
  const config = oidcServiceOptions({ sessionManager: { shutdown: async () => {} }, ...options, transcription });
  const app = createWebTerminal(config);
  await app.start({ port: 0, host: '127.0.0.1' });
  t.after(() => app.stop());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const { cookies, csrfToken } = await authenticate(url, config.openidClient);
  const headers = { Cookie: cookieHeader(cookies), 'CSRF-Token': csrfToken, 'Content-Type': 'audio/wav' };
  const post = (overrides = {}) => fetch(`${url}/api/voice/transcriptions`, {
    method: 'POST', headers, body: wav(), ...overrides });
  const sessions = () => new Promise((resolve, reject) => app.sessionStore.all((err, all) =>
    err ? reject(err) : resolve(Object.values(all))));
  return { app, url, headers, post, sessions };
}

function modelDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-model-'));
  for (const name of MODEL_FILES) fs.writeFileSync(path.join(directory, name), '');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeWorkers() {
  const children = [];
  const fork = (modulePath, args, options) => {
    const child = Object.assign(new EventEmitter(), { modulePath, args, options, sent: [],
      exitCode: null, signalCode: null, killed: null });
    child.send = (message) => child.sent.push(message);
    child.kill = (signalName) => {
      child.killed = signalName;
      child.signalCode = signalName;
      queueMicrotask(() => child.emit('exit', null, signalName));
    };
    child.reply = (text) => child.emit('message', { id: child.sent.at(-1).id, text });
    children.push(child);
    return child;
  };
  return { fork, children };
}

function service(t, options = {}) {
  const workers = fakeWorkers();
  const logs = [];
  const instance = createTranscriptionService({ modelDirectory: modelDirectory(t), fork: workers.fork,
    log: (message) => logs.push(message), ...options });
  t.after(() => instance.close());
  return { ...instance, ...workers, logs };
}

test('WAV parsing accepts only 16 kHz mono 16-bit PCM and scales samples', () => {
  const samples = parseWav(wav(Int16Array.of(16384, -32768, 0),
    { chunks: [Buffer.from('LIST\x03\x00\x00\x00abc\x00', 'latin1')] }));
  assert.deepEqual([...samples], [0.5, -1, 0]);
  const invalid = [
    wav(undefined, { rate: 44100 }), wav(undefined, { channels: 2 }), wav(undefined, { format: 3 }),
    wav(Int8Array.of(1, 2), { bits: 8 }), wav().subarray(0, 100), Buffer.from('not a wav file'),
    Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WAVE', 'latin1'), wav().subarray(36)]),
    wav().subarray(0, 36),
  ];
  for (const buffer of invalid) {
    assert.throws(() => parseWav(buffer), { status: 400, message: 'Audio could not be transcribed. Record again.' });
  }
  const tooLong = new Int16Array((MAX_VOICE_DURATION_MS + 2000) * 16 + 16);
  assert.throws(() => parseWav(wav(tooLong)), { status: 413 });
  assert.equal(parseWav(wav(new Int16Array((MAX_VOICE_DURATION_MS + 2000) * 16))).length,
    (MAX_VOICE_DURATION_MS + 2000) * 16);
});

test('long audio is split into segments of at most 30 seconds at the quietest point', () => {
  assert.equal(splitSamples(new Float32Array(30 * 16000)).length, 1);
  const samples = new Float32Array(70 * 16000).fill(0.5);
  samples.fill(0, 27 * 16000, 27 * 16000 + 1600);
  samples.fill(0, 55 * 16000, 55 * 16000 + 1600);
  const segments = splitSamples(samples);
  assert.deepEqual(segments.map((segment) => segment.length), [27 * 16000 + 800, 28 * 16000, 15 * 16000 - 800]);
  assert.ok(segments.every((segment) => segment.length <= 30 * 16000));
  assert.equal(segments.reduce((total, segment) => total + segment.length, 0), samples.length);
});

test('the worker starts lazily with an empty environment and receives work once ready', async (t) => {
  const s = service(t);
  assert.equal(s.available, true);
  assert.equal(s.children.length, 0);
  const pending = s.transcribe({ audio: wav(new Int16Array(31 * 16000)), signal: signal() });
  await settle();
  const [child] = s.children;
  assert.equal(child.modulePath, path.join(__dirname, '..', 'transcription-worker.js'));
  assert.equal(child.args.length, 1);
  assert.deepEqual(child.options.env, {});
  assert.equal(child.options.serialization, 'advanced');
  assert.equal(child.sent.length, 0);
  child.emit('message', { type: 'ready' });
  assert.equal(child.sent.length, 1);
  assert.equal(child.sent[0].segments.length, 2);
  assert.ok(child.sent[0].segments.every((segment) => segment instanceof Float32Array));
  child.reply('hello');
  assert.equal(await pending, 'hello');
});

test('requests decode one at a time on the same worker', async (t) => {
  const s = service(t);
  const first = s.transcribe({ audio: wav(), signal: signal() });
  const second = s.transcribe({ audio: wav(), signal: signal() });
  await settle();
  const [child] = s.children;
  child.emit('message', { type: 'ready' });
  assert.equal(child.sent.length, 1);
  child.reply('one');
  assert.equal(await first, 'one');
  await settle();
  assert.equal(child.sent.length, 2);
  child.reply('two');
  assert.equal(await second, 'two');
  assert.equal(s.children.length, 1);
});

test('an idle worker is stopped and a new one starts on the next request', async (t) => {
  const s = service(t, { idleMs: 10 });
  const first = s.transcribe({ audio: wav(), signal: signal() });
  await settle();
  s.children[0].emit('message', { type: 'ready' });
  s.children[0].reply('one');
  await first;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(s.children[0].killed, 'SIGTERM');
  const second = s.transcribe({ audio: wav(), signal: signal() });
  await settle();
  assert.equal(s.children.length, 2);
  s.children[1].emit('message', { type: 'ready' });
  s.children[1].reply('two');
  assert.equal(await second, 'two');
  assert.deepEqual(s.logs, []);
});

test('timeouts and crashes stop the worker, are logged, and the next request restarts it', async (t) => {
  const s = service(t, { timeoutMs: 10 });
  await assert.rejects(s.transcribe({ audio: wav(), signal: signal() }),
    { status: 504, message: 'Transcription timed out. Record again.' });
  assert.equal(s.children[0].killed, 'SIGTERM');
  const crashed = s.transcribe({ audio: wav(), signal: signal() });
  await settle();
  s.children[1].emit('exit', 1, null);
  await assert.rejects(crashed, { status: 502, message: 'Voice transcription failed. Record again.' });
  const failed = s.transcribe({ audio: wav(), signal: signal() });
  await settle();
  const child = s.children[2];
  child.emit('message', { type: 'ready' });
  child.emit('message', { id: child.sent[0].id, error: 'decoder failed' });
  await assert.rejects(failed, { status: 502 });
  assert.equal(child.killed, null);
  const recovered = s.transcribe({ audio: wav(), signal: signal() });
  await settle();
  child.reply('ok');
  assert.equal(await recovered, 'ok');
  assert.deepEqual(s.logs, ['Voice transcription timed out; stopping the worker.',
    'Voice transcription worker exited with code 1.', 'Voice transcription failed: decoder failed']);
});

test('canceled requests return immediately and the next request waits for the worker', async (t) => {
  const s = service(t);
  const abort = new AbortController();
  const canceled = s.transcribe({ audio: wav(), signal: abort.signal });
  const next = s.transcribe({ audio: wav(), signal: signal() });
  await settle();
  const [child] = s.children;
  child.emit('message', { type: 'ready' });
  abort.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  await settle();
  assert.equal(child.sent.length, 1);
  child.reply('discarded');
  await settle();
  assert.equal(child.sent.length, 2);
  child.reply('kept');
  assert.equal(await next, 'kept');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(s.transcribe({ audio: wav(), signal: aborted.signal }), { name: 'AbortError' });
  assert.equal(child.sent.length, 2);
});

test('closing stops the worker and rejects pending and later requests', async (t) => {
  const s = service(t);
  const pending = s.transcribe({ audio: wav(), signal: signal() });
  await settle();
  await s.close();
  await assert.rejects(pending, { status: 502 });
  assert.equal(s.children[0].killed, 'SIGTERM');
  await assert.rejects(s.transcribe({ audio: wav(), signal: signal() }), { status: 502 });
  assert.equal(s.children.length, 1);
});

test('missing model files and invalid audio never start a worker', async (t) => {
  const workers = fakeWorkers();
  const missing = createTranscriptionService({ modelDirectory: '/nonexistent', fork: workers.fork });
  assert.equal(missing.available, false);
  await assert.rejects(missing.transcribe({ audio: wav(), signal: signal() }),
    { status: 503, message: 'Voice model is not installed.' });
  const s = service(t);
  await assert.rejects(s.transcribe({ audio: Buffer.from('webm'), signal: signal() }), { status: 400 });
  assert.equal(workers.children.length + s.children.length, 0);
});

test('the installed model transcribes silence to an empty string', {
  skip: !fs.existsSync('/opt/web-terminal/voice-model') && 'voice model is not installed',
}, async (t) => {
  const s = createTranscriptionService({ modelDirectory: '/opt/web-terminal/voice-model' });
  t.after(() => s.close());
  assert.equal(await s.transcribe({ audio: wav(), signal: signal() }), '');
});

test('transcripts are cleaned of line breaks and control characters', () => {
  assert.equal(cleanTranscript(' \tHello\r\nworld\x1b\x00\u0085\t! '), 'Hello world !');
  assert.equal(cleanTranscript('\n\t\x03'), '');
});

test('voice auth and CSRF precede parsing, uploads validate, and only submissions extend activity', async (t) => {
  let now = Date.now();
  let calls = 0;
  const f = await fixture(t, { now: () => now, transcribe: async () => { calls++; return ' hi\nthere\x03 '; } });
  const initial = (await f.sessions())[0];
  now += 5000;
  assert.equal((await fetch(`${f.url}/api/voice`)).status, 401);
  const config = await fetch(`${f.url}/api/voice`, { headers: f.headers });
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await config.json(), { available: true, maxBytes: MAX_VOICE_BYTES, maxDurationMs: 300000 });
  assert.equal((await f.sessions())[0].lastActivityAt, initial.lastActivityAt);
  assert.equal((await f.post({ headers: { 'Content-Type': 'application/json' }, body: '{invalid' })).status, 401);
  assert.equal((await f.post({ headers: { Cookie: f.headers.Cookie, 'Content-Type': 'application/json' }, body: '{invalid' })).status, 403);
  for (const type of ['application/json', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/wav;codecs=1']) {
    assert.equal((await f.post({ headers: { ...f.headers, 'Content-Type': type } })).status, 415);
  }
  assert.equal((await f.post({ headers: { ...f.headers, 'Content-Encoding': 'gzip' } })).status, 415);
  for (const suffix of ['/api/voice/transcriptions/', '/API/VOICE/TRANSCRIPTIONS']) {
    const response = await fetch(f.url + suffix, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{invalid' });
    assert.equal(response.status, 401);
    const oversized = await fetch(f.url + suffix, { method: 'POST',
      headers: f.headers, body: Buffer.alloc(MAX_VOICE_BYTES + 1) });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: 'Recording exceeds the 10 MiB limit.' });
  }
  assert.equal((await f.post({ body: '' })).status, 400);
  assert.equal((await f.post({ body: Buffer.alloc(MAX_VOICE_BYTES + 1) })).status, 413);
  assert.equal((await f.sessions())[0].lastActivityAt, initial.lastActivityAt);
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'hi there' });
  assert.equal(calls, 1);
  assert.equal((await f.sessions())[0].lastActivityAt, now);
  now += SESSION_IDLE_TTL_MS;
  assert.equal((await f.post()).status, 401);
  assert.equal(calls, 1);
});

test('a missing voice model disables voice without blocking startup', async (t) => {
  const f = await fixture(t, { voiceModelDirectory: '/nonexistent', transcription: undefined });
  assert.equal((await (await fetch(`${f.url}/api/voice`, { headers: f.headers })).json()).available, false);
  const response = await f.post();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Voice model is not installed.' });
});

test('one request per login, disconnect cancellation, bookkeeping cleanup and fixed processing activity', async (t) => {
  let now = Date.now();
  let entered = deferred();
  let finish = deferred();
  let requestSignal;
  const f = await fixture(t, { now: () => now, transcribe: async (args) => {
    requestSignal = args.signal;
    entered.resolve();
    return new Promise((resolve, reject) => {
      finish.promise.then(resolve);
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
    });
  } });
  now += 1000;
  const submissionTime = now;
  const client = new AbortController();
  const pending = f.post({ signal: client.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  assert.equal((await f.sessions())[0].lastActivityAt, submissionTime);
  assert.equal((await f.post()).status, 429);
  const transcriptionCanceled = new Promise((resolve) => requestSignal.addEventListener('abort', resolve, { once: true }));
  client.abort();
  await rejected;
  await transcriptionCanceled;
  entered = deferred(); finish = deferred();
  const next = f.post();
  await entered.promise;
  now += 30000;
  finish.resolve('done');
  assert.equal((await next).status, 200);
  assert.equal((await f.sessions())[0].lastActivityAt, submissionTime);
});

test('transcription errors release request slots and absolute expiry remains bounded', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now, transcribe: async () => { throw new VoiceError(504, 'Transcription timed out. Record again.'); } });
  for (let day = 1; day < 7; day++) {
    now += SESSION_IDLE_TTL_MS - 1000;
    assert.equal((await f.post()).status, 504);
  }
  const login = (await f.sessions())[0];
  now = login.loginAt + SESSION_ABSOLUTE_TTL_MS;
  assert.equal((await f.post()).status, 401);
});

test('logout aborts active transcription without recreating the login session', async (t) => {
  const entered = deferred();
  const f = await fixture(t, { transcribe: async ({ signal: requestSignal }) => new Promise((_resolve, reject) => {
    requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
    entered.resolve();
  }) });
  const pending = f.post();
  await entered.promise;
  assert.equal((await fetch(`${f.url}/logout`, { method: 'POST', headers: f.headers })).status, 200);
  assert.equal((await pending).status, 409);
  assert.deepEqual(await f.sessions(), []);
  assert.equal((await f.post()).status, 401);
});

test('stopping the application closes the transcription service', async (t) => {
  let closed = 0;
  const f = await fixture(t, { transcription: { available: true, transcribe: async () => '', close: async () => { closed++; } } });
  await f.app.stop();
  assert.equal(closed, 1);
});
