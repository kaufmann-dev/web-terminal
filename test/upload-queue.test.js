'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('upload queue freezes its destination and continues after individual failures', async () => {
  const { UploadQueue } = await import('../public/js/file-explorer.mjs');
  const calls = [];
  let active = 0;
  const queue = new UploadQueue({ send: async (options) => {
    active += 1;
    assert.equal(active, 1);
    calls.push([options.name, options.directory]);
    options.onProgress(2);
    assert.equal(queue.items.find((item) => item.name === options.name).loaded, 2);
    await Promise.resolve();
    active -= 1;
    if (options.name === 'conflict') throw new Error('Already exists');
    return { path: `${options.directory}/${options.name}`, bytes: 2 };
  } });
  queue.add([{ name: 'first', size: 2 }, { name: 'conflict', size: 2 }, { name: 'last', size: 2 }]);
  const run = queue.run('/code/project');
  queue.add([{ name: 'ignored-during-upload', size: 2 }]);
  await queue.run('/code/different');
  await run;
  assert.deepEqual(calls, [['first', '/code/project'], ['conflict', '/code/project'], ['last', '/code/project']]);
  assert.deepEqual(queue.items.map((item) => item.status), ['saved', 'error', 'saved']);
  queue.items[1].name = 'renamed';
  await queue.run('/code/project');
  assert.deepEqual(calls.at(-1), ['renamed', '/code/project']);
  assert.equal(calls.length, 4, 'saved files must not upload twice');
});

test('cancel stops the active and remaining uploads while preserving saved files', async () => {
  const { UploadQueue } = await import('../public/js/file-explorer.mjs');
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const queue = new UploadQueue({ send: async ({ name, signal }) => {
    if (name === 'first') return { path: '/code/first' };
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  queue.add(['first', 'second', 'third'].map((name) => ({ name, size: 1 })));
  const run = queue.run('/code');
  await waiting;
  queue.cancel();
  await run;
  assert.deepEqual(queue.items.map((item) => item.status), ['saved', 'cancelled', 'cancelled']);
  assert.equal(queue.running, false);
});

test('oversized files never transfer, empty files transfer, and expired authentication stops the queue', async () => {
  const { UploadQueue } = await import('../public/js/file-explorer.mjs');
  let expired = 0;
  const calls = [];
  const queue = new UploadQueue({ maxBytes: 1024 * 1024, onAuthExpired: () => { expired += 1; }, send: async ({ name }) => {
    calls.push(name);
    if (name === 'expired') throw Object.assign(new Error('Expired'), { status: 401 });
    return { path: `/code/${name}` };
  } });
  queue.add([{ name: 'too-large', size: 1024 * 1024 + 1 }, { name: 'empty', size: 0 },
    { name: 'expired', size: 1 }, { name: 'remaining', size: 1 }]);
  await queue.run('/code');
  assert.deepEqual(calls, ['empty', 'expired']);
  assert.equal(expired, 1);
  assert.equal(queue.items[0].message, 'File exceeds the 1.0 MiB limit.');
  assert.deepEqual(queue.items.map((item) => item.status), ['error', 'saved', 'error', 'cancelled']);
});

// A fake upload server behind the XHR interface. A handler that returns nothing never answers.
function fakeServer(handler) {
  const requests = [];
  const createRequest = () => ({
    upload: {}, headers: {},
    open(method, url) { this.method = method; this.url = new URL(url, 'http://localhost'); },
    setRequestHeader(key, value) { this.headers[key] = value; },
    send(body) {
      this.body = body;
      requests.push(this);
      queueMicrotask(async () => {
        const reply = await handler(this);
        if (!reply || this.aborted) return;
        this.status = reply.status;
        this.responseText = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        this.onload();
      });
    },
    abort() { this.aborted = true; this.onabort(); },
  });
  return { requests, createRequest };
}

// Stores appended chunks like the real server, starting from an optional partial.
function storage(file, partial = '') {
  const state = { stored: partial, stall: () => false, fail: () => null };
  state.handler = async (xhr) => {
    if (xhr.method === 'POST') {
      return { status: 200, body: { directory: '/code/project', offset: state.stored.length } };
    }
    const offset = Number(xhr.url.searchParams.get('offset'));
    if (offset !== state.stored.length) return { status: 409, body: { error: 'Moved', offset: state.stored.length } };
    const failure = state.fail(xhr);
    if (failure) return failure;
    const text = await xhr.body.text();
    if (state.stall(xhr)) {
      state.stored += text.slice(0, 1);
      return null;
    }
    xhr.upload.onprogress({ loaded: text.length });
    state.stored += text;
    return state.stored.length === file.size
      ? { status: 201, body: { path: '/code/project/name', bytes: file.size } }
      : { status: 200, body: { offset: state.stored.length } };
  };
  return state;
}

const fileOf = (text) => new File([text], 'name', { lastModified: 5 });

test('uploads resume from the server offset in chunks with CSRF and file identity', async () => {
  const { uploadFile } = await import('../public/js/file-explorer.mjs');
  const file = fileOf('0123456789');
  const state = storage(file, '012');
  const server = fakeServer(state.handler);
  const progress = [];
  const result = await uploadFile({ file, name: 'a & b.txt', directory: 'project', csrfToken: 'token', chunkBytes: 4,
    signal: new AbortController().signal, createRequest: server.createRequest, onProgress: (loaded) => progress.push(loaded) });
  assert.deepEqual(result, { path: '/code/project/name', bytes: 10 });
  assert.equal(state.stored, '0123456789');
  const [begin, ...chunks] = server.requests;
  assert.equal(begin.method, 'POST');
  assert.equal(begin.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(begin.body), { directory: 'project', filename: 'a & b.txt', size: 10, lastModified: 5 });
  assert.deepEqual(chunks.map((xhr) => [xhr.method, xhr.url.searchParams.get('offset')]), [['PUT', '3'], ['PUT', '7']]);
  assert.deepEqual(Object.fromEntries(chunks[0].url.searchParams), {
    directory: '/code/project', filename: 'a & b.txt', size: '10', lastModified: '5', offset: '3',
  });
  assert.ok(server.requests.every((xhr) => xhr.headers['CSRF-Token'] === 'token'));
  assert.equal(chunks[0].headers['Content-Type'], 'application/octet-stream');
  assert.equal(progress[0], 3);
  assert.equal(progress.at(-1), 10);

  const empty = fakeServer(storage(fileOf('')).handler);
  assert.equal((await uploadFile({ file: fileOf(''), name: 'empty', directory: '', csrfToken: 't', chunkBytes: 4,
    signal: new AbortController().signal, createRequest: empty.createRequest })).bytes, 0);
  assert.equal(empty.requests.length, 2);
});

test('stalls, lost connections and gateway errors retry and resume where the server stopped', async () => {
  const { uploadFile } = await import('../public/js/file-explorer.mjs');
  const file = fileOf('0123456789');
  const state = storage(file);
  let puts = 0;
  state.stall = () => ++puts === 2;
  let gatewayFailures = 0;
  // After the stall resumes at 5, the last chunk starts at 9 and first meets a gateway error.
  state.fail = (xhr) => (xhr.url.searchParams.get('offset') === '9' && !gatewayFailures++ ? { status: 502, body: '<html>' } : null);
  const server = fakeServer(state.handler);
  const retries = [];
  const waits = [];
  const result = await uploadFile({ file, name: 'name', directory: '', csrfToken: 't', chunkBytes: 4, stallMs: 20,
    signal: new AbortController().signal, createRequest: server.createRequest, retryDelays: [1, 2, 3],
    wait: async (ms) => { waits.push(ms); }, onRetry: (ms, error) => retries.push([ms, error.message]) });
  assert.equal(result.bytes, 10);
  assert.equal(state.stored, '0123456789');
  assert.deepEqual(retries, [[1, 'The connection stalled.'], [1, 'Upload failed (HTTP 502).']]);
  assert.deepEqual(server.requests.filter((xhr) => xhr.method === 'POST').length, 3);

  const lost = fakeServer((xhr) => { xhr.onerror(); });
  await assert.rejects(uploadFile({ file, name: 'name', directory: '', csrfToken: 't', chunkBytes: 4,
    signal: new AbortController().signal, createRequest: lost.createRequest, retryDelays: [1, 2], wait: async () => {} }),
  { message: 'Connection lost. Retry to resume.' });
  assert.equal(lost.requests.length, 3);
});

test('client errors fail at once and cancellation stops waiting retries', async () => {
  const { uploadFile } = await import('../public/js/file-explorer.mjs');
  const file = fileOf('0123');
  const conflict = fakeServer(() => ({ status: 409, body: { error: 'A file with this name already exists.' } }));
  await assert.rejects(uploadFile({ file, name: 'name', directory: '', csrfToken: 't', chunkBytes: 4,
    signal: new AbortController().signal, createRequest: conflict.createRequest }),
  { status: 409, message: 'A file with this name already exists.' });
  assert.equal(conflict.requests.length, 1);

  const abort = new AbortController();
  const unavailable = fakeServer(() => ({ status: 503, body: { error: 'File storage is unavailable.' } }));
  const uploading = uploadFile({ file, name: 'name', directory: '', csrfToken: 't', chunkBytes: 4,
    signal: abort.signal, createRequest: unavailable.createRequest, onRetry: () => abort.abort() });
  await assert.rejects(uploading, { name: 'AbortError' });
});

test('removing a started file discards its partial; saved and unstarted files are not discarded', async () => {
  const { UploadQueue, discardUpload } = await import('../public/js/file-explorer.mjs');
  const discarded = [];
  const queue = new UploadQueue({ discard: (item) => discarded.push(item.name), send: async ({ name }) => {
    if (name === 'failed') throw new Error('Failed');
    return { path: `/code/${name}` };
  } });
  queue.add([fileOf('a'), fileOf('b'), fileOf('c')]);
  queue.items[0].name = 'saved';
  queue.items[1].name = 'failed';
  queue.items[2].name = 'unstarted';
  await queue.run('/code', queue.items.slice(0, 2));
  for (const item of [...queue.items]) queue.remove(item);
  assert.deepEqual(discarded, ['failed']);
  assert.deepEqual(queue.items, []);

  const server = fakeServer(() => ({ status: 204, body: '' }));
  await discardUpload({ file: fileOf('abc'), name: 'x y', directory: '/code', csrfToken: 't', createRequest: server.createRequest });
  assert.equal(server.requests[0].method, 'DELETE');
  assert.deepEqual(Object.fromEntries(server.requests[0].url.searchParams),
    { directory: '/code', filename: 'x y', size: '3', lastModified: '5' });
});
