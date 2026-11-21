'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const { once } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const { inflateRawSync } = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { WorkspaceFileStore, inlineType, UPLOAD_CHUNK_BYTES, STALE_PART_MS } = require('../workspace-file-store');
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
  return { root, directory, store: new WorkspaceFileStore({ directory }) };
}

// Reads a ZIP without ZIP64 or a comment: the central directory gives names, methods, modes and offsets.
function readZip(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const entries = [];
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < buffer.readUInt16LE(end + 10); index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    entries.push({ name, method, mode: buffer.readUInt32LE(offset + 38) >>> 16,
      data: method === 8 ? inflateRawSync(raw) : raw });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function archiveEntries(store, value, options = {}) {
  const { stream } = await store.archive(value, { signal: new AbortController().signal, ...options });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return readZip(Buffer.concat(chunks));
}

// File URLs carry the absolute path, one encoded component per segment.
function contentUrl(base, ...parts) {
  return `${base}/api/files/content/${path.join(...parts).split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
}

function source(data, headers = {}) {
  const stream = Readable.from([data]);
  stream.headers = headers;
  return stream;
}

const signal = () => new AbortController().signal;
const identity = (filename, data) => ({ filename, size: Buffer.byteLength(data), lastModified: 1 });
const partials = async (directory) => (await fs.readdir(directory)).filter((name) => name.endsWith('.part'));

// Starts or resumes an upload and sends the rest of the file as one chunk.
async function storeUpload(store, data, filename, options = {}) {
  const upload = identity(filename, data);
  const { offset } = await store.begin(upload, { directory: options.directory });
  return store.append(source(Buffer.from(data).subarray(offset)), upload, { offset, signal: signal(), ...options });
}

test('browsing starts at the workspace, resolves relative paths there, and reaches any folder', async (t) => {
  const { directory, root, store } = await workspace(t);
  const start = await store.list();
  assert.equal(start.directory, directory);
  assert.deepEqual(start.directories, ['.hidden', 'project']);
  assert.equal((await store.list('project')).directory, path.join(directory, 'project'));
  for (const destination of ['../outside', 'escape', path.join(root, 'outside')]) {
    assert.equal((await store.list(destination)).directory, path.join(root, 'outside'), destination);
  }
  assert.equal((await store.list('/')).directory, '/');
  for (const destination of ['\0', ['project']]) {
    await assert.rejects(store.list(destination), { status: 400 });
  }
  await assert.rejects(store.list('missing'), { code: 'ENOENT' });
  const outside = await storeUpload(store, 'x', 'note', { directory: path.join(root, 'outside') });
  assert.equal(outside.path, path.join(root, 'outside', 'note'));
  assert.equal(await fs.readFile(outside.path, 'utf8'), 'x');
  for (const filename of ['../oops', 'a/b', 'a\\b', '.', '..', '', 'bad\nname', 'a'.repeat(256)]) {
    await assert.rejects(store.begin({ filename, size: 1, lastModified: 1 }, { directory: 'project' }), { status: 400 });
  }
  for (const upload of [{ filename: 'x', size: -1, lastModified: 1 }, { filename: 'x', size: 1, lastModified: 'now' }]) {
    await assert.rejects(store.begin(upload, { directory: 'project' }), { status: 400 });
  }
  const saved = await storeUpload(store, Buffer.from('héllo'), 'café image.txt', { directory: 'project' });
  assert.equal(saved.path, path.join(directory, 'project', 'café image.txt'));
  assert.equal(saved.bytes, 6);
  assert.equal(await fs.readFile(saved.path, 'utf8'), 'héllo');
  assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o600);
  const empty = await storeUpload(store, Buffer.alloc(0), 'empty', { directory: 'project' });
  assert.equal(empty.bytes, 0);
  assert.equal((await fs.stat(empty.path)).size, 0);
});

test('chunks resume from the partial, enforce sizes, and keep received bytes after cancellation', async (t) => {
  const { directory } = await workspace(t);
  const store = new WorkspaceFileStore({ directory, maxBytes: 8 });
  const upload = identity('file', '12345678');
  await assert.rejects(store.begin(identity('big', '123456789'), {}), { status: 413, message: 'File exceeds the 8-byte limit.' });
  assert.deepEqual(await store.begin(upload, {}), { directory, offset: 0 });
  assert.deepEqual(await store.append(source('123'), upload, { offset: 0, signal: signal() }), { offset: 3 });
  assert.deepEqual(await store.begin(upload, {}), { directory, offset: 3 });
  await assert.rejects(store.append(source('x'), upload, { offset: 0, signal: signal() }), { status: 409, offset: 3 });
  await assert.rejects(store.append(source('x'), upload, { offset: 9, signal: signal() }), { status: 400 });
  await assert.rejects(store.append(source('456789', { 'content-length': '6' }), upload, { offset: 3, signal: signal() }),
    { status: 413 });
  await assert.rejects(store.append(source('456789'), upload, { offset: 3, signal: signal() }), { status: 413 });
  assert.equal((await store.begin(upload, {})).offset, 3);

  const abort = new AbortController();
  const stream = new PassThrough();
  const resumed = once(stream, 'resume');
  const appending = store.append(stream, upload, { offset: 3, signal: abort.signal });
  await resumed;
  await assert.rejects(store.append(source('4'), upload, { offset: 3, signal: signal() }), { status: 409 });
  await assert.rejects(store.discard(upload, {}), { status: 409 });
  stream.write('45');
  for (let attempt = 0; (await store.begin(upload, {})).offset < 5 && attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  abort.abort();
  await assert.rejects(appending, { name: 'AbortError' });
  assert.equal((await store.begin(upload, {})).offset, 5);

  await assert.rejects(store.append(source('678'), upload, { offset: 5, signal: signal(),
    beforePublish: () => { throw new Error('write refused'); } }), /write refused/);
  assert.equal((await store.begin(upload, {})).offset, 8);
  assert.deepEqual(await store.append(source(Buffer.alloc(0)), upload, { offset: 8, signal: signal() }),
    { path: path.join(directory, 'file'), bytes: 8 });
  assert.equal(await fs.readFile(path.join(directory, 'file'), 'utf8'), '12345678');
  assert.deepEqual(await partials(directory), []);
});

test('discarded and stale partials are removed', async (t) => {
  const { store, directory } = await workspace(t);
  const upload = identity('other', 'abc');
  await store.append(source('a'), upload, { offset: 0, signal: signal() });
  await store.discard(upload, {});
  await store.discard(upload, {});
  assert.deepEqual(await partials(directory), []);
  await store.append(source('a'), upload, { offset: 0, signal: signal() });
  const [part] = await partials(directory);
  assert.equal((await fs.stat(path.join(directory, part))).mode & 0o777, 0o600);
  assert.equal((await store.begin({ ...upload, lastModified: 2 }, {})).offset, 0, 'a changed file starts over');
  const old = new Date(Date.now() - STALE_PART_MS - 1000);
  await fs.utimes(path.join(directory, part), old, old);
  assert.equal((await store.begin(upload, {})).offset, 0);
  assert.deepEqual(await partials(directory), []);
});

test('concurrent uploads publish atomically and never overwrite files or symlinks', async (t) => {
  const { store, directory } = await workspace(t);
  const save = (data) => storeUpload(store, data, 'same');
  const outcomes = await Promise.allSettled([save('first'), save('second')]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
  assert.ok(['first', 'second'].includes(await fs.readFile(path.join(directory, 'same'), 'utf8')));
  await fs.symlink('same', path.join(directory, 'link'));
  await assert.rejects(storeUpload(store, 'replace', 'link'), { status: 409 });
  assert.equal((await fs.lstat(path.join(directory, 'link'))).isSymbolicLink(), true);
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.part')), false);
});

test('swapping the destination for a symlink cannot redirect an upload', async (t) => {
  const { store, directory, root } = await workspace(t);
  await assert.rejects(storeUpload(store, 'data', 'file', { directory: 'project',
    beforePublish: async () => {
      await fs.rename(path.join(directory, 'project'), path.join(root, 'moved'));
      await fs.symlink(path.join(root, 'outside'), path.join(directory, 'project'));
    } }), { status: 409 });
  assert.deepEqual(await fs.readdir(path.join(root, 'outside')), []);
  assert.deepEqual(await fs.readdir(path.join(root, 'moved')), []);
});

test('listings include regular files only, with size and modification time', async (t) => {
  const { directory, store } = await workspace(t);
  await fs.writeFile(path.join(directory, 'b.txt'), 'bb');
  await fs.writeFile(path.join(directory, '.env'), 'a');
  await fs.symlink('b.txt', path.join(directory, 'link.txt'));
  const { files, directories } = await store.list();
  assert.deepEqual(directories, ['.hidden', 'project']);
  assert.deepEqual(files.map(({ name, size }) => ({ name, size })), [{ name: '.env', size: 1 }, { name: 'b.txt', size: 2 }]);
  assert.equal(files[1].modified, (await fs.stat(path.join(directory, 'b.txt'))).mtimeMs);
});

test('only allowlisted images, PDFs and UTF-8 text have an inline type', () => {
  const binary = Buffer.from([0x89, 0x50, 0x00, 0xff]);
  assert.equal(inlineType('a.PNG', binary), 'image/png');
  assert.equal(inlineType('a.jpeg', binary), 'image/jpeg');
  assert.equal(inlineType('a.svg', Buffer.from('<svg/>')), 'image/svg+xml');
  assert.equal(inlineType('a.pdf', binary), 'application/pdf');
  assert.equal(inlineType('a.mp3', binary), 'audio/mpeg');
  assert.equal(inlineType('a.MP4', binary), 'video/mp4');
  for (const name of ['page.html', 'script.js', 'Dockerfile', 'notes.md', 'empty']) {
    assert.equal(inlineType(name, Buffer.from(name === 'empty' ? '' : '<script>héllo</script>')), 'text/plain; charset=utf-8');
  }
  assert.equal(inlineType('archive.zip', binary), null);
  assert.equal(inlineType('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9])), null);
  const sample = Buffer.concat([Buffer.alloc(8 * 1024 - 1, 0x61), Buffer.from('é')]).subarray(0, 8 * 1024);
  assert.equal(inlineType('long.txt', sample), 'text/plain; charset=utf-8');
});

test('files open by relative or absolute path, only as regular files', async (t) => {
  const { directory, root, store } = await workspace(t);
  await fs.writeFile(path.join(directory, 'project', 'a.txt'), 'hello');
  await fs.writeFile(path.join(root, 'outside', 'secret'), 'secret');
  await fs.symlink('a.txt', path.join(directory, 'project', 'link'));
  await fs.symlink(path.join(root, 'outside', 'secret'), path.join(directory, 'leak'));
  for (const value of ['project/a.txt', path.join(directory, 'project', 'a.txt')]) {
    const file = await store.openFile(value);
    assert.deepEqual({ name: file.name, size: file.size, type: file.type },
      { name: 'a.txt', size: 5, type: 'text/plain; charset=utf-8' });
    await file.handle.close();
  }
  for (const value of ['../outside/secret', 'escape/secret', path.join(root, 'outside', 'secret')]) {
    const file = await store.openFile(value);
    assert.equal(file.name, 'secret', value);
    await file.handle.close();
  }
  for (const value of ['leak', 'project/link', 'project', '', '.', 'a\0b',
    ['project/a.txt'], undefined]) {
    await assert.rejects(store.openFile(value), `${value}`);
  }
  await assert.rejects(store.openFile('project/missing'), { code: 'ENOENT' });
});

test('folders archive as ZIPs of regular files and directories without following symlinks', async (t) => {
  const { directory, root, store } = await workspace(t);
  const project = path.join(directory, 'project');
  const text = 'compressible '.repeat(200);
  await fs.mkdir(path.join(project, 'src', 'empty'), { recursive: true });
  await fs.mkdir(path.join(project, '.git'));
  await fs.writeFile(path.join(project, '.git', 'HEAD'), 'ref');
  await fs.writeFile(path.join(project, '.env'), 'SECRET=1');
  await fs.writeFile(path.join(project, 'notes.txt'), text);
  await fs.writeFile(path.join(project, 'src', 'café.jpg'), 'jpeg');
  await fs.writeFile(path.join(project, 'src', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  await fs.writeFile(path.join(project, 'back\\slash'), 'b');
  await fs.writeFile(path.join(root, 'outside', 'secret'), 'secret');
  await fs.symlink(path.join(root, 'outside', 'secret'), path.join(project, 'leak'));
  await fs.symlink(path.join(root, 'outside'), path.join(project, 'outside-dir'));
  await promisify(execFile)('mkfifo', [path.join(project, 'pipe')]);

  const entries = await archiveEntries(store, 'project');
  assert.deepEqual(entries.map((entry) => entry.name), [
    'project/', 'project/back_slash', 'project/notes.txt', 'project/src/', 'project/src/café.jpg',
    'project/src/empty/', 'project/src/run.sh',
  ]);
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
  assert.equal(byName['project/notes.txt'].method, 8);
  assert.equal(byName['project/notes.txt'].data.toString(), text);
  assert.equal(byName['project/src/café.jpg'].method, 0);
  assert.equal(byName['project/src/café.jpg'].data.toString(), 'jpeg');
  assert.equal(byName['project/src/run.sh'].mode & 0o777, 0o755);
  assert.equal(byName['project/src/'].mode & 0o170000, 0o040000);

  const hidden = (await archiveEntries(store, path.join(directory, 'project'), { includeHidden: true }))
    .map((entry) => entry.name);
  for (const name of ['project/.env', 'project/.git/', 'project/.git/HEAD']) assert.ok(hidden.includes(name), name);
  assert.equal((await archiveEntries(store, '')).at(0).name, 'workspace/');

  for (const value of ['../outside', 'escape']) {
    assert.deepEqual((await archiveEntries(store, value)).map((entry) => entry.name), ['outside/', 'outside/secret'], value);
  }
  for (const value of ['a\0b', ['project']]) {
    await assert.rejects(store.archive(value, { signal: new AbortController().signal }), `${value}`);
  }
  const abort = new AbortController();
  const { stream } = await store.archive('project', { signal: abort.signal });
  abort.abort();
  await assert.rejects(once(stream, 'data'));
  assert.equal(stream.destroyed, true);
});

async function serviceFixture(t, options = {}) {
  const fixture = await workspace(t);
  let clock = Date.now();
  const openidClient = createFakeOpenidClient();
  const service = createWebTerminal(oidcServiceOptions({ openidClient,
    terminalWorkdir: fixture.directory, terminalHome: fixture.directory,
    sessionManager: { shutdown: async () => {} }, now: () => clock, ...options,
  }));
  await service.start({ port: 0, host: '127.0.0.1' });
  t.after(() => service.stop());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const { cookies, csrfToken } = await authenticate(base, openidClient);
  const headers = { Cookie: cookieHeader(cookies), 'CSRF-Token': csrfToken, 'Content-Type': 'application/octet-stream' };
  return { ...fixture, service, base, headers, advance: (ms) => { clock += ms; } };
}

const uploadUrl = (base, query) => `${base}/api/uploads?${new URLSearchParams(query)}`;

function beginUpload(base, headers, body) {
  return fetch(`${base}/api/uploads`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
}

// Starts or resumes an upload through the API and sends the rest of the file as one chunk.
async function apiUpload(base, headers, { directory = '', filename, data }) {
  const upload = identity(filename, data);
  const begin = await beginUpload(base, headers, { ...upload, directory });
  if (begin.status !== 200) return begin;
  const { directory: resolved, offset } = await begin.json();
  return fetch(uploadUrl(base, { ...upload, directory: resolved, offset }), { method: 'PUT', headers,
    body: Buffer.from(data).subarray(offset) });
}

test('upload API enforces authentication, CSRF, MIME type and filename conflicts', async (t) => {
  const { base, headers, directory } = await serviceFixture(t);
  const url = uploadUrl(base, { directory: 'project', filename: 'file.json', size: 13, lastModified: 1, offset: 0 });
  assert.equal((await fetch(`${base}/api/files`)).status, 401);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await fetch(url, { method, body: method === 'DELETE' ? undefined : 'x' })).status, 401, method);
    assert.equal((await fetch(url, { method, headers: { Cookie: headers.Cookie } })).status, 403, method);
  }
  assert.equal((await fetch(url, { method: 'PUT', body: 'x', headers: { ...headers, 'Content-Type': 'application/json' } })).status, 415);
  const listing = await fetch(`${base}/api/files?path=project`, { headers });
  assert.equal(listing.status, 200);
  assert.equal(listing.headers.get('cache-control'), 'no-store');
  const upload = await apiUpload(base, headers, { directory: 'project', filename: 'file.json', data: '{"test":true}' });
  assert.equal(upload.status, 201);
  assert.equal(upload.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await upload.json(), { path: path.join(directory, 'project', 'file.json'), bytes: 13 });
  const replace = await apiUpload(base, headers, { directory: 'project', filename: 'file.json', data: 'replace' });
  assert.equal(replace.status, 409);
  assert.deepEqual(await replace.json(), { error: 'A file with this name already exists. Rename it and retry.' });
  assert.equal(await fs.readFile(path.join(directory, 'project', 'file.json'), 'utf8'), '{"test":true}');
  assert.equal((await fetch(`${base}/static/project/file.json`, { headers })).status, 404);
  assert.equal((await apiUpload(base, headers, { directory: 'missing', filename: 'bad', data: 'x' })).status, 400);
  assert.equal((await beginUpload(base, headers, { directory: 'project', filename: 'a/b', size: 1, lastModified: 1 })).status, 400);
});

test('upload limit defaults to 100 MiB and rejects invalid overrides', async (t) => {
  const { base, headers, directory } = await serviceFixture(t);
  assert.equal((await fetch(`${base}/api/uploads`)).status, 401);
  const config = await fetch(`${base}/api/uploads`, { headers });
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await config.json(), { maxBytes: 100 * 1024 * 1024, chunkBytes: UPLOAD_CHUNK_BYTES });
  for (const uploadLimitMib of ['0', '-1', '1.5', '10MB', '99999999999']) {
    assert.throws(() => createWebTerminal(oidcServiceOptions({ terminalWorkdir: directory, terminalHome: directory,
      uploadLimitMib })), /UPLOAD_LIMIT_MIB must be a positive whole number of MiB/, uploadLimitMib);
  }
});

test('chunked API enforces the configured limit and chunk boundaries without Content-Length', async (t) => {
  const { base, headers, directory } = await serviceFixture(t, { uploadLimitMib: '9' });
  const maxBytes = 9 * 1024 * 1024;
  assert.deepEqual(await (await fetch(`${base}/api/uploads`, { headers })).json(), { maxBytes, chunkBytes: UPLOAD_CHUNK_BYTES });
  const tooBig = await beginUpload(base, headers, { filename: 'too-big', size: maxBytes + 1, lastModified: 1 });
  assert.equal(tooBig.status, 413);
  assert.deepEqual(await tooBig.json(), { error: 'File exceeds the 9 MiB limit.' });
  const data = Buffer.alloc(maxBytes, 42);
  const upload = { filename: 'big', size: maxBytes, lastModified: 1, directory };
  const put = (offset, body) => fetch(uploadUrl(base, { ...upload, offset }), {
    method: 'PUT', headers, body: Readable.from([body]), duplex: 'half',
  });
  const first = await put(0, data.subarray(0, UPLOAD_CHUNK_BYTES));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { offset: UPLOAD_CHUNK_BYTES });
  const mismatch = await put(0, data.subarray(0, 1));
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await mismatch.json(), { error: 'The upload position changed.', offset: UPLOAD_CHUNK_BYTES });
  const overflow = await put(UPLOAD_CHUNK_BYTES, Buffer.alloc(maxBytes - UPLOAD_CHUNK_BYTES + 1));
  assert.equal(overflow.status, 413);
  await overflow.text();
  const last = await put(UPLOAD_CHUNK_BYTES, data.subarray(UPLOAD_CHUNK_BYTES));
  assert.equal(last.status, 201);
  await last.text();
  assert.deepEqual(await fs.readFile(path.join(directory, 'big')), data);
  assert.deepEqual(await partials(directory), []);
});

const SLOW_UPLOAD_SIZE = 10;

async function startSlowUpload(base, headers, filename, size = SLOW_UPLOAD_SIZE) {
  const request = http.request(uploadUrl(base, { filename, size, lastModified: 1, offset: 0 }), { method: 'PUT', headers });
  const response = new Promise((resolve, reject) => {
    request.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    request.on('error', reject);
  });
  request.write('partial');
  return { request, response };
}

async function partialSize(directory) {
  const [part] = await partials(directory);
  return part ? (await fs.stat(path.join(directory, part))).size : 0;
}

async function waitForPartial(directory, bytes = 'partial'.length) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await partialSize(directory) >= bytes) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('upload did not start');
}

const resumeSlowUpload = (base, headers, filename, rest) => fetch(uploadUrl(base, {
  filename, size: SLOW_UPLOAD_SIZE, lastModified: 1, offset: 'partial'.length,
}), { method: 'PUT', headers, body: rest });

test('a newer chunk replaces a stalled one; expiry and logout stop uploads but keep their partials', async (t) => {
  const { base, headers, directory, advance } = await serviceFixture(t);
  const stalled = await startSlowUpload(base, headers, 'stalled');
  await waitForPartial(directory);
  const resumed = await resumeSlowUpload(base, headers, 'stalled', 'abc');
  assert.equal(resumed.status, 201);
  assert.equal(await stalled.response, 409);
  stalled.request.destroy();
  assert.equal(await fs.readFile(path.join(directory, 'stalled'), 'utf8'), 'partialabc');

  const slow = await startSlowUpload(base, headers, 'expired');
  await waitForPartial(directory);
  advance(25 * 60 * 60 * 1000);
  slow.request.end('abc');
  assert.equal(await slow.response, 401);
  await assert.rejects(fs.stat(path.join(directory, 'expired')), { code: 'ENOENT' });
  assert.equal(await partialSize(directory), SLOW_UPLOAD_SIZE, 'the complete partial publishes after login');

  const fresh = await serviceFixture(t);
  const logoutUpload = await startSlowUpload(fresh.base, fresh.headers, 'logged-out');
  await waitForPartial(fresh.directory);
  const logout = await fetch(`${fresh.base}/logout`, { method: 'POST', headers: fresh.headers });
  assert.equal(logout.status, 200);
  assert.equal(await logoutUpload.response, 409);
  logoutUpload.request.end();
  await assert.rejects(fs.stat(path.join(fresh.directory, 'logged-out')), { code: 'ENOENT' });
});

test('graceful shutdown stops uploads and keeps partials for resumption', async (t) => {
  const { base, headers, directory, service } = await serviceFixture(t);
  const slow = await startSlowUpload(base, headers, 'stopped');
  await waitForPartial(directory);
  const stopping = service.stop();
  assert.equal(await slow.response, 409);
  slow.request.end();
  await stopping;
  assert.equal(await partialSize(directory), 'partial'.length);
});

test('only accepted chunks extend activity; browsing, invalid paths and transfer bytes do not', async (t) => {
  const { base, headers, service, directory, advance } = await serviceFixture(t);
  const activity = async () => {
    const sessions = await new Promise((resolve, reject) => service.sessionStore.all((error, values) => (
      error ? reject(error) : resolve(Object.values(values))
    )));
    return sessions[0].lastActivityAt;
  };
  const initial = await activity();
  advance(1000);
  await fetch(`${base}/api/files`, { headers });
  await fs.writeFile(path.join(directory, 'note.txt'), 'note');
  assert.equal(await (await fetch(contentUrl(base, directory, 'note.txt'), { headers })).text(), 'note');
  await fs.rm(path.join(directory, 'note.txt'));
  await (await fetch(`${base}/api/files/archive?path=project`, { headers })).arrayBuffer();
  await apiUpload(base, headers, { directory: 'missing', filename: 'bad', data: 'x' });
  await beginUpload(base, headers, { filename: 'activity', size: SLOW_UPLOAD_SIZE, lastModified: 1 });
  assert.equal(await activity(), initial);
  const slow = await startSlowUpload(base, headers, 'activity');
  await waitForPartial(directory);
  // Wait for the acceptance callback to save the local session, not just open the partial.
  for (let attempt = 0; (await activity()) === initial && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await activity(), initial + 1000);
  advance(1000);
  slow.request.end('abc');
  assert.equal(await slow.response, 201);
  assert.equal(await activity(), initial + 1000);
});

test('a disconnected chunk keeps its received bytes and the upload resumes from them', async (t) => {
  const { base, headers, directory } = await serviceFixture(t);
  const slow = await startSlowUpload(base, headers, 'disconnected');
  const disconnected = assert.rejects(slow.response, { code: 'ECONNRESET' });
  await waitForPartial(directory);
  slow.request.destroy();
  await disconnected;
  let begin;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    begin = await (await beginUpload(base, headers, { filename: 'disconnected', size: SLOW_UPLOAD_SIZE, lastModified: 1 })).json();
    if (begin.offset === 'partial'.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(begin, { directory, offset: 'partial'.length });
  assert.equal((await resumeSlowUpload(base, headers, 'disconnected', 'abc')).status, 201);
  assert.equal(await fs.readFile(path.join(directory, 'disconnected'), 'utf8'), 'partialabc');
  const removed = identity('removed', 'abc');
  await fetch(uploadUrl(base, { ...removed, offset: 0 }), { method: 'PUT', headers, body: 'a' });
  assert.equal((await fetch(uploadUrl(base, removed), { method: 'DELETE', headers })).status, 204);
  assert.deepEqual(await partials(directory), []);
});

test('file content is served inline only as inert types and otherwise as an attachment', async (t) => {
  const { base, headers, directory, root } = await serviceFixture(t);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const text = 'compressible '.repeat(2000);
  await fs.writeFile(path.join(directory, 'project', 'image.png'), png);
  await fs.writeFile(path.join(directory, 'project', 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await fs.writeFile(path.join(directory, 'project', 'page.html'), '<script>alert(1)</script>');
  await fs.writeFile(path.join(directory, 'project', 'doc.pdf'), '%PDF-1.7');
  await fs.writeFile(path.join(directory, 'project', 'data.bin'), png);
  await fs.writeFile(path.join(directory, 'project', "café (1)'s.txt"), text);
  await fs.writeFile(path.join(directory, 'project', 'empty'), '');
  await fs.writeFile(path.join(root, 'outside', 'secret'), 'secret');
  await fs.symlink(path.join(root, 'outside', 'secret'), path.join(directory, 'project', 'leak'));
  const get = (name, extra = '') => fetch(`${contentUrl(base, directory, 'project', name)}${extra}`,
    { headers: { Cookie: headers.Cookie, 'Accept-Encoding': 'gzip' } });

  assert.equal((await fetch(contentUrl(base, directory, 'project', 'image.png'))).status, 401);
  assert.equal((await get('missing')).status, 400);
  assert.equal((await get('leak')).status, 400);
  assert.equal((await fetch(contentUrl(base, directory, 'project'), { headers })).status, 400);
  assert.equal(await (await fetch(contentUrl(base, root, 'outside', 'secret'), { headers })).text(), 'secret');

  const image = await get('image.png');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('content-disposition'), "inline; filename*=UTF-8''image.png");
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(image.headers.get('cache-control'), 'no-store, no-transform');
  assert.match(image.headers.get('content-security-policy'), /^sandbox; default-src 'none'/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

  const svg = await get('drawing.svg');
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(svg.headers.get('content-security-policy'), /^sandbox;/);

  const html = await get('page.html');
  assert.equal(html.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(html.headers.get('content-security-policy'), /^sandbox;/);
  assert.equal(await html.text(), '<script>alert(1)</script>');

  const pdf = await get('doc.pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /^inline;/);
  assert.doesNotMatch(pdf.headers.get('content-security-policy'), /sandbox/);

  const binary = await get('data.bin');
  assert.equal(binary.headers.get('content-type'), 'application/octet-stream');
  assert.match(binary.headers.get('content-disposition'), /^attachment;/);

  const download = await get("café (1)'s.txt", '?download=1');
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('content-disposition'),
    "attachment; filename*=UTF-8''caf%C3%A9%20%281%29%27s.txt");
  assert.equal(download.headers.get('content-encoding'), null);
  assert.equal(download.headers.get('content-length'), String(Buffer.byteLength(text)));
  assert.equal(await download.text(), text);

  const range = (value) => fetch(contentUrl(base, directory, 'project', 'image.png'),
    { headers: { Cookie: headers.Cookie, Range: value } });
  const partial = await range('bytes=1-3');
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 1-3/6');
  assert.equal(partial.headers.get('content-length'), '3');
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), png.subarray(1, 4));
  const unsatisfiable = await range('bytes=10-');
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */6');
  assert.equal(image.headers.get('accept-ranges'), 'bytes');

  const empty = await get('empty');
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal(await empty.text(), '');
});

test('folder archive API streams authenticated ZIP attachments', async (t) => {
  const { base, headers, directory } = await serviceFixture(t);
  await fs.writeFile(path.join(directory, 'project', 'a.txt'), 'compressible '.repeat(2000));
  await fs.writeFile(path.join(directory, 'project', '.env'), 'SECRET=1');
  const get = (query) => fetch(`${base}/api/files/archive?${query}`,
    { headers: { Cookie: headers.Cookie, 'Accept-Encoding': 'gzip' } });

  assert.equal((await fetch(`${base}/api/files/archive?path=project`)).status, 401);
  const escaped = await get('path=escape');
  assert.equal(escaped.headers.get('content-disposition'), "attachment; filename*=UTF-8''outside.zip");
  await escaped.arrayBuffer();
  assert.equal((await get('path=missing')).status, 400);
  assert.equal((await get('path=a&path=b')).status, 400);

  const archive = await get(`path=${encodeURIComponent(path.join(directory, 'project'))}`);
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get('content-type'), 'application/zip');
  assert.equal(archive.headers.get('content-disposition'), "attachment; filename*=UTF-8''project.zip");
  assert.equal(archive.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(archive.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(archive.headers.get('content-encoding'), null);
  assert.deepEqual(readZip(Buffer.from(await archive.arrayBuffer())).map((entry) => entry.name),
    ['project/', 'project/a.txt']);

  const hidden = await get('path=project&hidden=1');
  assert.deepEqual(readZip(Buffer.from(await hidden.arrayBuffer())).map((entry) => entry.name),
    ['project/', 'project/.env', 'project/a.txt']);
  const root = await get('');
  assert.equal(root.headers.get('content-disposition'), "attachment; filename*=UTF-8''workspace.zip");
  await root.arrayBuffer();
});

test('graceful shutdown ends folder archives that are still streaming', async (t) => {
  const { base, headers, directory, service } = await serviceFixture(t);
  // Random bytes do not compress, so the archive outgrows the socket buffers and stays open.
  await fs.writeFile(path.join(directory, 'project', 'random.bin'), require('node:crypto').randomBytes(32 * 1024 * 1024));
  const response = await fetch(`${base}/api/files/archive?path=project`, { headers });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  await service.stop();
  await assert.rejects(async () => { while (!(await reader.read()).done); });
});
