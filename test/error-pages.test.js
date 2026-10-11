'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWebTerminal } = require('../app');
const { renderErrorPage } = require('../error-page');
const { oidcServiceOptions } = require('./oidc-test-helpers');

test('unknown routes return an HTML 404 page, or JSON under /api', async (t) => {
  const service = createWebTerminal({
    ...oidcServiceOptions(),
    publicOrigin: 'http://127.0.0.1',
    sessionManager: { shutdown: async () => {} },
  });
  await service.start({ port: 0, host: '127.0.0.1' });
  t.after(() => service.stop());

  const baseUrl = `http://127.0.0.1:${service.server.address().port}`;

  const pageResponse = await fetch(`${baseUrl}/does-not-exist`);
  assert.equal(pageResponse.status, 404);
  assert.match(pageResponse.headers.get('content-type'), /^text\/html\b/);
  const page = await pageResponse.text();
  assert.match(page, /<h1>Page not found<\/h1>/);
  assert.match(page, /Error 404/);

  const apiResponse = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(apiResponse.status, 404);
  assert.deepEqual(await apiResponse.json(), { error: 'Not found.' });
});

test('error pages use status-specific copy', () => {
  assert.match(renderErrorPage(403), /<h1>Access denied<\/h1>/);
  assert.match(renderErrorPage(500), /<h1>Something went wrong<\/h1>/);
  assert.match(renderErrorPage(503), /<h1>Something went wrong<\/h1>/);
  assert.match(renderErrorPage(400), /<h1>Request could not be completed<\/h1>/);
});
