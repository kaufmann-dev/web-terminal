'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWebTerminal } = require('../app');
const { oidcServiceOptions } = require('./oidc-test-helpers');

const fontRoutes = [
  '/vendor/fonts/inter-400.woff2',
  '/vendor/fonts/inter-500.woff2',
  '/vendor/fonts/inter-600.woff2',
  '/vendor/fonts/jetbrains-mono-400.woff2',
  '/vendor/fonts/jetbrains-mono-600.woff2',
];

test('pinned fonts are public and unspecified font paths return 404', async (t) => {
  const service = createWebTerminal({
    ...oidcServiceOptions(),
    publicOrigin: 'http://127.0.0.1',
    sessionManager: { shutdown: async () => {} },
  });
  await service.start({ port: 0, host: '127.0.0.1' });
  t.after(() => service.stop());

  const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
  for (const route of fontRoutes) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /^font\/woff2\b/, route);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'wOF2', route);
  }

  const unknownResponse = await fetch(`${baseUrl}/vendor/fonts/inter-700.woff2`);
  assert.equal(unknownResponse.status, 404);
});
