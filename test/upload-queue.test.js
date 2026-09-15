'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('upload queue freezes its destination and continues after individual failures', async () => {
  const { UploadQueue } = await import('../public/js/file-uploads.mjs');
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
  const { UploadQueue } = await import('../public/js/file-uploads.mjs');
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
  const { UploadQueue, MAX_UPLOAD_BYTES } = await import('../public/js/file-uploads.mjs');
  let expired = 0;
  const calls = [];
  const queue = new UploadQueue({ onAuthExpired: () => { expired += 1; }, send: async ({ name }) => {
    calls.push(name);
    if (name === 'expired') throw Object.assign(new Error('Expired'), { status: 401 });
    return { path: `/code/${name}` };
  } });
  queue.add([{ name: 'too-large', size: MAX_UPLOAD_BYTES + 1 }, { name: 'empty', size: 0 },
    { name: 'expired', size: 1 }, { name: 'remaining', size: 1 }]);
  await queue.run('/code');
  assert.deepEqual(calls, ['empty', 'expired']);
  assert.equal(expired, 1);
  assert.deepEqual(queue.items.map((item) => item.status), ['error', 'saved', 'error', 'cancelled']);
});

test('XHR transfer sends encoded paths and CSRF, reports progress and surfaces proxy errors', async () => {
  const { sendUpload } = await import('../public/js/file-uploads.mjs');
  let xhr;
  const createRequest = () => (xhr = {
    upload: {}, headers: {}, open(method, url) { this.method = method; this.url = url; },
    setRequestHeader(key, value) { this.headers[key] = value; }, send(file) { this.file = file; },
    abort() { this.onabort(); },
  });
  const file = { size: 10 };
  const progress = [];
  const options = { file, name: 'a & b.txt', directory: '/code/space name', csrfToken: 'test-token',
    signal: new AbortController().signal, createRequest, onProgress: (...args) => progress.push(args) };
  const promise = sendUpload(options);
  const url = new URL(xhr.url, 'http://localhost');
  assert.equal(url.searchParams.get('filename'), 'a & b.txt');
  assert.equal(url.searchParams.get('directory'), '/code/space name');
  assert.equal(xhr.headers['CSRF-Token'], 'test-token');
  assert.equal(xhr.headers['Content-Type'], 'application/octet-stream');
  assert.equal(xhr.file, file);
  xhr.upload.onprogress({ loaded: 5, total: 10 });
  assert.deepEqual(progress, [[5, 10]]);
  xhr.status = 201;
  xhr.responseText = JSON.stringify({ path: '/code/space name/a & b.txt', bytes: 10 });
  xhr.onload();
  assert.equal((await promise).bytes, 10);
  const proxy = sendUpload(options);
  xhr.status = 413;
  xhr.responseText = '<html>too large</html>';
  xhr.onload();
  await assert.rejects(proxy, { status: 413 });
  const abort = new AbortController();
  const cancelled = sendUpload({ ...options, signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
});
