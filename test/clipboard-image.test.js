'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWebTerminal } = require('../app');
const {
  MAX_CLIPBOARD_IMAGE_BYTES,
  detectImageContentType,
} = require('../clipboard-image-store');
const {
  authenticate,
  cookieHeader,
  createFakeOpenidClient,
  oidcServiceOptions,
} = require('./oidc-test-helpers');

test('clipboard image signatures identify supported browser formats', () => {
  assert.equal(detectImageContentType(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])), 'image/png');
  assert.equal(detectImageContentType(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg');
  assert.equal(detectImageContentType(Buffer.from('RIFF1234WEBP')), 'image/webp');
  assert.equal(detectImageContentType(Buffer.from('GIF89a')), null);
});

test('clipboard image uploads are protected, validated, stored, and pruned', async (t) => {
  let currentTime = 1_800_000_000_000;
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'web-terminal-clipboard-test-'));
  const imageDirectory = path.join(temporaryRoot, 'images');
  await fs.mkdir(imageDirectory);
  const stalePath = path.join(imageDirectory, 'stale.png');
  await fs.writeFile(stalePath, Buffer.from('stale'));
  const staleTime = new Date(Date.now() - (25 * 60 * 60 * 1000));
  await fs.utimes(stalePath, staleTime, staleTime);

  const openidClient = createFakeOpenidClient();
  const service = createWebTerminal({
    ...oidcServiceOptions({ openidClient }),
    publicOrigin: 'http://127.0.0.1',
    terminalWorkdir: temporaryRoot,
    terminalHome: temporaryRoot,
    clipboardImageDirectory: imageDirectory,
    clipboardImageStore: undefined,
    sessionManager: { shutdown: async () => {} },
    now: () => currentTime,
  });
  await service.start({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await service.stop();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  await assert.rejects(fs.access(stalePath), { code: 'ENOENT' });

  const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('clipboard-image'),
  ]);

  const unauthenticatedResponse = await fetch(`${baseUrl}/api/clipboard-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: png,
  });
  assert.equal(unauthenticatedResponse.status, 401);

  const { cookies, csrfToken } = await authenticate(baseUrl, openidClient);
  const authenticatedHeaders = {
    Cookie: cookieHeader(cookies),
    'CSRF-Token': csrfToken,
  };
  const sessionsBeforeUpload = await new Promise((resolve, reject) => {
    service.sessionStore.all((err, sessions) => (
      err ? reject(err) : resolve(Object.values(sessions))
    ));
  });
  const loginActivityAt = sessionsBeforeUpload[0].lastActivityAt;

  const missingCsrfResponse = await fetch(`${baseUrl}/api/clipboard-images`, {
    method: 'POST',
    headers: {
      Cookie: authenticatedHeaders.Cookie,
      'Content-Type': 'image/png',
    },
    body: png,
  });
  assert.equal(missingCsrfResponse.status, 403);

  const unsupportedResponse = await fetch(`${baseUrl}/api/clipboard-images`, {
    method: 'POST',
    headers: { ...authenticatedHeaders, 'Content-Type': 'image/gif' },
    body: Buffer.from('GIF89a'),
  });
  assert.equal(unsupportedResponse.status, 415);

  const mismatchedResponse = await fetch(`${baseUrl}/api/clipboard-images`, {
    method: 'POST',
    headers: { ...authenticatedHeaders, 'Content-Type': 'image/png' },
    body: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
  });
  assert.equal(mismatchedResponse.status, 415);

  currentTime += 1000;
  const uploadResponse = await fetch(`${baseUrl}/api/clipboard-images`, {
    method: 'POST',
    headers: { ...authenticatedHeaders, 'Content-Type': 'image/png' },
    body: png,
  });
  assert.equal(uploadResponse.status, 201);
  const sessionsAfterUpload = await new Promise((resolve, reject) => {
    service.sessionStore.all((err, sessions) => (
      err ? reject(err) : resolve(Object.values(sessions))
    ));
  });
  assert.equal(loginActivityAt, currentTime - 1000);
  assert.equal(sessionsAfterUpload[0].lastActivityAt, currentTime);
  const upload = await uploadResponse.json();
  assert.equal(path.dirname(upload.path), imageDirectory);
  assert.match(path.basename(upload.path), /^clipboard-[a-f0-9]{32}\.png$/);
  assert.deepEqual(await fs.readFile(upload.path), png);
  const uploadedStat = await fs.stat(upload.path);
  assert.equal(uploadedStat.mode & 0o777, 0o600);
  const directoryStat = await fs.stat(imageDirectory);
  assert.equal(directoryStat.mode & 0o777, 0o700);

  const oversizedResponse = await fetch(`${baseUrl}/api/clipboard-images`, {
    method: 'POST',
    headers: { ...authenticatedHeaders, 'Content-Type': 'image/png' },
    body: Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 1),
  });
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), {
    error: 'Clipboard image exceeds the 10 MiB limit.',
  });
});
