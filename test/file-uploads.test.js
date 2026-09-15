'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const { once } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const { FileUploadStore, MAX_UPLOAD_BYTES } = require('../file-upload-store');
const { createWebTerminal } = require('../app');
const { authenticate, cookieHeader, createFakeOpenidClient, oidcServiceOptions } = require('./oidc-test-helpers');

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-terminal-uploads-'));
  const directory = path.join(root, 'workspace');
  await fs.mkdir(directory);
  await fs.mkdir(path.join(directory, 'project'));
  await fs.mkdir(path.join(directory, '.hidden'));
  await fs.mkdir(path.join(root, 'outside'));
  await fs.symlink(path.join(root, 'outside'), path.join(directory, 'escape'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, directory, store: new FileUploadStore({ directory }) };
}

function source(data, headers = {}) {
  const stream = Readable.from([data]);
  stream.headers = headers;
  return stream;
}

test('directory browsing and uploads stay inside the workspace', async (t) => {
  const { directory, store } = await workspace(t);
  assert.deepEqual((await store.list()).directories, ['.hidden', 'project']);
  assert.equal((await store.list('project')).directory, path.join(directory, 'project'));
  for (const destination of ['../outside', 'escape', '/', '\0', ['project']]) {
    await assert.rejects(store.list(destination));
  }
  await assert.rejects(store.list('missing'), { code: 'ENOENT' });
  for (const filename of ['../oops', 'a/b', 'a\\b', '.', '..', '', 'bad\nname', 'a'.repeat(256)]) {
    await assert.rejects(store.save(source('x'), { directory: 'project', filename,
      signal: new AbortController().signal }), { status: 400 });
  }
  const saved = await store.save(source(Buffer.from('héllo')), { directory: 'project', filename: 'café image.txt',
    signal: new AbortController().signal });
  assert.equal(saved.path, path.join(directory, 'project', 'café image.txt'));
  assert.equal(saved.bytes, 6);
  assert.equal(await fs.readFile(saved.path, 'utf8'), 'héllo');
  assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o600);
  const empty = await store.save(source(Buffer.alloc(0)), { directory: 'project', filename: 'empty',
    signal: new AbortController().signal });
  assert.equal(empty.bytes, 0);
  assert.equal((await fs.stat(empty.path)).size, 0);
});

test('size checks, cancellation and write failures leave no partial destination', async (t) => {
  const { directory } = await workspace(t);
  const store = new FileUploadStore({ directory, maxBytes: 4 });
  const save = (stream, options = {}) => store.save(stream, { filename: 'file', signal: new AbortController().signal, ...options });
  await assert.rejects(save(source('12345', { 'content-length': '5' })), { status: 413 });
  await assert.rejects(save(source('12345')), { status: 413 });
  await assert.rejects(save(source('1'), { beforePublish: () => { throw new Error('write refused'); } }), /write refused/);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['.hidden', 'escape', 'project']);
  const abort = new AbortController();
  const stream = new PassThrough();
  const saving = save(stream, { signal: abort.signal });
  await once(stream, 'resume');
  stream.write('12');
  abort.abort();
  await assert.rejects(saving, { name: 'AbortError' });
  assert.deepEqual((await fs.readdir(directory)).sort(), ['.hidden', 'escape', 'project']);
  const exact = await save(source('1234'));
  assert.equal(exact.bytes, 4);
});

test('concurrent uploads publish atomically and never overwrite files or symlinks', async (t) => {
  const { store, directory } = await workspace(t);
  const save = (data) => store.save(source(data), { filename: 'same', signal: new AbortController().signal });
  const outcomes = await Promise.allSettled([save('first'), save('second')]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
  assert.ok(['first', 'second'].includes(await fs.readFile(path.join(directory, 'same'), 'utf8')));
  await fs.symlink('same', path.join(directory, 'link'));
  await assert.rejects(store.save(source('replace'), { filename: 'link', signal: new AbortController().signal }), { status: 409 });
  assert.equal((await fs.lstat(path.join(directory, 'link'))).isSymbolicLink(), true);
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.part')), false);
});

test('swapping the destination for an outside symlink cannot redirect an upload', async (t) => {
  const { store, directory, root } = await workspace(t);
  await assert.rejects(store.save(source('data'), { directory: 'project', filename: 'file',
    signal: new AbortController().signal,
    beforePublish: async () => {
      await fs.rename(path.join(directory, 'project'), path.join(root, 'moved'));
      await fs.symlink(path.join(root, 'outside'), path.join(directory, 'project'));
    } }), { status: 409 });
  assert.deepEqual(await fs.readdir(path.join(root, 'outside')), []);
  assert.deepEqual(await fs.readdir(path.join(root, 'moved')), []);
});

async function serviceFixture(t) {
  const fixture = await workspace(t);
  let clock = Date.now();
  const openidClient = createFakeOpenidClient();
  const service = createWebTerminal(oidcServiceOptions({ openidClient,
    terminalWorkdir: fixture.directory, terminalHome: fixture.directory,
    sessionManager: { shutdown: async () => {} }, now: () => clock,
  }));
  await service.start({ port: 0, host: '127.0.0.1' });
  t.after(() => service.stop());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const { cookies, csrfToken } = await authenticate(base, openidClient);
  const headers = { Cookie: cookieHeader(cookies), 'CSRF-Token': csrfToken, 'Content-Type': 'application/octet-stream' };
  return { ...fixture, service, base, headers, advance: (ms) => { clock += ms; } };
}

test('upload API enforces authentication, CSRF, MIME type and filename conflicts', async (t) => {
  const { base, headers, directory } = await serviceFixture(t);
  const url = `${base}/api/uploads?directory=project&filename=file.json`;
  assert.equal((await fetch(`${base}/api/upload-directories`)).status, 401);
  assert.equal((await fetch(url, { method: 'POST', body: 'x' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', body: 'x', headers: { Cookie: headers.Cookie } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', body: 'x', headers: { ...headers, 'Content-Type': 'application/json' } })).status, 415);
  const listing = await fetch(`${base}/api/upload-directories?path=project`, { headers });
  assert.equal(listing.status, 200);
  assert.equal(listing.headers.get('cache-control'), 'no-store');
  const upload = await fetch(url, { method: 'POST', headers, body: '{"test":true}' });
  assert.equal(upload.status, 201);
  assert.deepEqual(await upload.json(), { path: path.join(directory, 'project', 'file.json'), bytes: 13 });
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'replace' })).status, 409);
  assert.equal(await fs.readFile(path.join(directory, 'project', 'file.json'), 'utf8'), '{"test":true}');
  assert.equal((await fetch(`${base}/static/project/file.json`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/uploads?directory=escape&filename=bad`, { method: 'POST', headers, body: 'x' })).status, 403);
});

test('streaming API enforces the real 100 MiB boundary without Content-Length', async (t) => {
  const { base, headers, directory } = await serviceFixture(t);
  const chunk = Buffer.alloc(1024 * 1024, 42);
  async function* bytes(extra) {
    for (let i = 0; i < MAX_UPLOAD_BYTES / chunk.length; i += 1) yield chunk;
    if (extra) yield Buffer.from('x');
  }
  for (const extra of [false, true]) {
    const response = await fetch(`${base}/api/uploads?filename=${extra ? 'too-big' : 'exact'}`, {
      method: 'POST', headers, body: Readable.from(bytes(extra)), duplex: 'half',
    });
    assert.equal(response.status, extra ? 413 : 201);
    await response.text();
  }
  assert.equal((await fs.stat(path.join(directory, 'exact'))).size, MAX_UPLOAD_BYTES);
  await assert.rejects(fs.stat(path.join(directory, 'too-big')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.part')), false);
});

async function startSlowUpload(base, headers, filename) {
  const request = http.request(`${base}/api/uploads?filename=${filename}`, { method: 'POST', headers });
  const response = new Promise((resolve, reject) => {
    request.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    request.on('error', reject);
  });
  request.write('partial');
  return { request, response };
}

async function waitForPartial(directory) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await fs.readdir(directory)).some((name) => name.endsWith('.part'))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('upload did not start');
}

test('one upload per login, expiry and logout cancel partial uploads', async (t) => {
  const { base, headers, directory, advance } = await serviceFixture(t);
  const slow = await startSlowUpload(base, headers, 'expired');
  await waitForPartial(directory);
  const second = await fetch(`${base}/api/uploads?filename=second`, { method: 'POST', headers, body: 'x' });
  assert.equal(second.status, 409);
  advance(25 * 60 * 60 * 1000);
  slow.request.end();
  assert.equal(await slow.response, 401);
  await assert.rejects(fs.stat(path.join(directory, 'expired')), { code: 'ENOENT' });

  const fresh = await serviceFixture(t);
  const logoutUpload = await startSlowUpload(fresh.base, fresh.headers, 'logged-out');
  await waitForPartial(fresh.directory);
  const logout = await fetch(`${fresh.base}/logout`, { method: 'POST', headers: fresh.headers });
  assert.equal(logout.status, 200);
  assert.equal(await logoutUpload.response, 409);
  logoutUpload.request.end();
  await assert.rejects(fs.stat(path.join(fresh.directory, 'logged-out')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(fresh.directory)).some((name) => name.endsWith('.part')), false);
});

test('graceful shutdown cancels uploads and removes partials', async (t) => {
  const { base, headers, directory, service } = await serviceFixture(t);
  const slow = await startSlowUpload(base, headers, 'stopped');
  await waitForPartial(directory);
  const stopping = service.stop();
  assert.equal(await slow.response, 409);
  slow.request.end();
  await stopping;
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.part')), false);
});

test('only accepted submissions extend activity; browsing, invalid paths and transfer bytes do not', async (t) => {
  const { base, headers, service, directory, advance } = await serviceFixture(t);
  const activity = async () => {
    const sessions = await new Promise((resolve, reject) => service.sessionStore.all((error, values) => (
      error ? reject(error) : resolve(Object.values(values))
    )));
    return sessions[0].lastActivityAt;
  };
  const initial = await activity();
  advance(1000);
  await fetch(`${base}/api/upload-directories`, { headers });
  await fetch(`${base}/api/uploads?directory=escape&filename=bad`, { method: 'POST', headers, body: 'x' });
  assert.equal(await activity(), initial);
  const slow = await startSlowUpload(base, headers, 'activity');
  await waitForPartial(directory);
  // Wait for the acceptance callback to save the local session, not just open the temp file.
  for (let attempt = 0; (await activity()) === initial && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await activity(), initial + 1000);
  advance(1000);
  slow.request.end('more bytes');
  assert.equal(await slow.response, 201);
  assert.equal(await activity(), initial + 1000);
});

test('a disconnected request removes partials and releases its upload slot', async (t) => {
  const { base, headers, directory } = await serviceFixture(t);
  const slow = await startSlowUpload(base, headers, 'disconnected');
  const disconnected = assert.rejects(slow.response, { code: 'ECONNRESET' });
  await waitForPartial(directory);
  slow.request.destroy();
  await disconnected;
  let response;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    response = await fetch(`${base}/api/uploads?filename=next`, { method: 'POST', headers, body: 'ok' });
    if (response.status !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(response.status, 201);
  await assert.rejects(fs.stat(path.join(directory, 'disconnected')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.part')), false);
});
