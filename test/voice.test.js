'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { createWebTerminal, SESSION_IDLE_TTL_MS, SESSION_ABSOLUTE_TTL_MS } = require('../app');
const { createTranscriptionService, cleanTranscript, MAX_VOICE_BYTES, VoiceError } = require('../voice-transcription');
const { authenticate, cookieHeader, oidcServiceOptions } = require('./oidc-test-helpers');

const deferred = () => Promise.withResolvers();
async function fixture(t, options = {}) {
  const config = oidcServiceOptions({ elevenlabsApiKey: 'test-voice-key',
    sessionManager: { shutdown: async () => {} }, ...options });
  const app = createWebTerminal(config);
  await app.start({ port: 0, host: '127.0.0.1' });
  t.after(() => app.stop());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const { cookies, csrfToken } = await authenticate(url, config.openidClient);
  const headers = { Cookie: cookieHeader(cookies), 'CSRF-Token': csrfToken, 'Content-Type': 'audio/webm;codecs=opus' };
  const post = (overrides = {}) => fetch(`${url}/api/voice/transcriptions`, {
    method: 'POST', headers, body: Buffer.from('recording'), ...overrides });
  const sessions = () => new Promise((resolve, reject) => app.sessionStore.all((err, all) =>
    err ? reject(err) : resolve(Object.values(all))));
  return { app, url, headers, post, sessions };
}

test('provider sends exact Scribe settings and actual MIME, and cleans text', async () => {
  const transcribe = createTranscriptionService({ apiKey: 'secret', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.deepEqual(init.headers, { 'xi-api-key': 'secret' });
    const fields = Object.fromEntries(init.body);
    assert.equal(fields.file.type, 'audio/mp4;codecs=mp4a.40.2');
    assert.equal(fields.file.name, 'recording.m4a');
    assert.equal(await fields.file.text(), 'audio');
    delete fields.file;
    assert.deepEqual(fields, { model_id: 'scribe_v2', no_verbatim: 'true', tag_audio_events: 'false',
      diarize: 'false', timestamps_granularity: 'none', webhook: 'false' });
    return Response.json({ text: ' \tHello\r\nworld\x1b\x00\u0085\t! ' });
  } });
  assert.equal(await transcribe({ audio: Buffer.from('audio'), mimeType: 'audio/mp4;codecs=mp4a.40.2',
    signal: new AbortController().signal }), 'Hello world !');
  assert.equal(cleanTranscript('\n\t\x03'), '');
});

test('provider handles invalid audio, rate limits, failures, invalid JSON, timeout and cancellation without retries', async () => {
  for (const [status, expected] of [[400, 400], [415, 400], [422, 400], [429, 429], [401, 502], [500, 502]]) {
    let calls = 0;
    const transcribe = createTranscriptionService({ apiKey: 'secret', fetchImpl: async () => {
      calls++;
      return new Response('private provider details', { status });
    } });
    await assert.rejects(transcribe({ audio: Buffer.from('x'), mimeType: 'audio/webm', signal: new AbortController().signal }),
      (err) => err.status === expected && !err.message.includes('private'));
    assert.equal(calls, 1);
  }
  for (const response of [() => new Response('not JSON'), () => Response.json({ wrong: true })]) {
    await assert.rejects(createTranscriptionService({ fetchImpl: async () => response() })({
      audio: Buffer.from('x'), mimeType: 'audio/ogg', signal: new AbortController().signal,
    }), { status: 502 });
  }
  const waitingFetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const abort = new AbortController();
  await assert.rejects(createTranscriptionService({ fetchImpl: waitingFetch, timeoutMs: 10 })({
    audio: Buffer.from('x'), mimeType: 'audio/webm', signal: abort.signal,
  }), { status: 504 });
  const pending = createTranscriptionService({ fetchImpl: waitingFetch })({
    audio: Buffer.from('x'), mimeType: 'audio/webm', signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
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
  assert.deepEqual(await config.json(), { configured: true, maxBytes: MAX_VOICE_BYTES, maxDurationMs: 300000 });
  assert.equal((await f.sessions())[0].lastActivityAt, initial.lastActivityAt);
  assert.equal((await f.post({ headers: { 'Content-Type': 'application/json' }, body: '{invalid' })).status, 401);
  assert.equal((await f.post({ headers: { Cookie: f.headers.Cookie, 'Content-Type': 'application/json' }, body: '{invalid' })).status, 403);
  for (const type of ['application/json', 'audio/wav', 'video/mp4', 'audio/webm;evil=value']) {
    assert.equal((await f.post({ headers: { ...f.headers, 'Content-Type': type } })).status, 415);
  }
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
  for (const type of ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    const response = await f.post({ headers: { ...f.headers, 'Content-Type': type } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'hi there' });
  }
  assert.equal(calls, 4);
  assert.equal((await f.sessions())[0].lastActivityAt, now);
  now += SESSION_IDLE_TTL_MS;
  assert.equal((await f.post()).status, 401);
  assert.equal(calls, 4);
});

test('missing credentials disable voice without blocking startup', async (t) => {
  const f = await fixture(t, { elevenlabsApiKey: '' });
  assert.equal((await (await fetch(`${f.url}/api/voice`, { headers: f.headers })).json()).configured, false);
  assert.equal((await f.post()).status, 503);
});

test('one request per login, disconnect cancellation, bookkeeping cleanup and fixed processing activity', async (t) => {
  let now = Date.now();
  let entered = deferred();
  let finish = deferred();
  let signal;
  const f = await fixture(t, { now: () => now, transcribe: async (args) => {
    signal = args.signal;
    entered.resolve();
    return new Promise((resolve, reject) => {
      finish.promise.then(resolve);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
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
  const upstreamCanceled = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  client.abort();
  await rejected;
  await upstreamCanceled;
  entered = deferred(); finish = deferred();
  const next = f.post();
  await entered.promise;
  now += 30000;
  finish.resolve('done');
  assert.equal((await next).status, 200);
  assert.equal((await f.sessions())[0].lastActivityAt, submissionTime);
});

test('provider errors release request slots and absolute expiry remains bounded', async (t) => {
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

test('chezmoi secret filter excludes ElevenLabs credentials', () => {
  const source = fs.readFileSync('scripts/start.sh', 'utf8');
  assert.match(source, /unset_environment=\([^)]*-u ELEVENLABS_API_KEY/);
});


test('logout aborts active transcription without recreating the login session', async (t) => {
  const entered = deferred();
  const f = await fixture(t, { transcribe: async ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    entered.resolve();
  }) });
  const pending = f.post();
  await entered.promise;
  assert.equal((await fetch(`${f.url}/logout`, { method: 'POST', headers: f.headers })).status, 200);
  assert.equal((await pending).status, 409);
  assert.deepEqual(await f.sessions(), []);
  assert.equal((await f.post()).status, 401);
});
