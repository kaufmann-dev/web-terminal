'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWebTerminal } = require('../app');
const { authenticate, cookieHeader, createFakeOpenidClient, oidcServiceOptions } = require('./oidc-test-helpers');

async function serviceFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-terminal-jobs-api-'));
  const openidClient = createFakeOpenidClient();
  const service = createWebTerminal(oidcServiceOptions({
    openidClient,
    terminalWorkdir: root,
    terminalHome: root,
    jobManager: undefined,
    sessionManager: { shutdown: async () => {} },
  }));
  await service.start({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await service.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const { cookies, csrfToken } = await authenticate(base, openidClient);
  const headers = { Cookie: cookieHeader(cookies), 'CSRF-Token': csrfToken, 'Content-Type': 'application/json' };
  const api = (route, options = {}) => fetch(`${base}${route}`, { headers, ...options });
  return { root, service, base, headers, api };
}

const job = {
  name: 'Say hello',
  command: 'echo hello from job',
  schedule: '*/15 * * * *',
  timezone: 'UTC',
};

test('jobs API requires authentication and CSRF tokens', async (t) => {
  const { base, headers } = await serviceFixture(t);
  assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
  assert.equal((await fetch(`${base}/api/jobs`, {
    method: 'POST', body: JSON.stringify(job), headers: { 'Content-Type': 'application/json' },
  })).status, 401);
  assert.equal((await fetch(`${base}/api/jobs`, {
    method: 'POST', body: JSON.stringify(job), headers: { Cookie: headers.Cookie, 'Content-Type': 'application/json' },
  })).status, 403);
});

test('jobs API creates, runs, reads logs, updates, and deletes jobs', async (t) => {
  const { root, api, service } = await serviceFixture(t);
  assert.equal(service.config.jobStateDirectory, path.join(root, '.local', 'state', 'web-terminal', 'jobs'));

  const listed = await api('/api/jobs');
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await listed.json(), { jobs: [] });

  const invalid = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ ...job, schedule: '61 * * * *' }) });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /cron schedule/i);

  const created = await api('/api/jobs', { method: 'POST', body: JSON.stringify(job) });
  assert.equal(created.status, 201);
  const { job: createdJob } = await created.json();
  assert.equal(createdJob.name, 'Say hello');
  assert.ok(createdJob.nextRunAt);

  const started = await api(`/api/jobs/${createdJob.id}/runs`, { method: 'POST' });
  assert.equal(started.status, 202);
  const { run } = await started.json();
  assert.equal(run.status, 'running');

  let detail;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    detail = (await (await api(`/api/jobs/${createdJob.id}`)).json()).job;
    if (!detail.running) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(detail.runs[0].status, 'success');
  const log = await api(`/api/jobs/${createdJob.id}/runs/${run.id}/log`);
  assert.equal(log.status, 200);
  assert.match(log.headers.get('content-type'), /^text\/plain/);
  assert.equal(await log.text(), 'hello from job\n');
  assert.equal((await api(`/api/jobs/${createdJob.id}/runs/not-a-run/log`)).status, 404);

  const disabled = await api(`/api/jobs/${createdJob.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
  assert.equal(disabled.status, 200);
  const { job: disabledJob } = await disabled.json();
  assert.equal(disabledJob.enabled, false);
  assert.equal(disabledJob.nextRunAt, null);

  assert.equal((await api(`/api/jobs/${createdJob.id}/stop`, { method: 'POST' })).status, 409);
  assert.equal((await api(`/api/jobs/${createdJob.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/jobs/${createdJob.id}`)).status, 404);
  assert.equal((await api('/api/jobs/..%2F..%2Fetc', { method: 'DELETE' })).status, 404);
});

test('schedule preview returns upcoming runs or a validation error', async (t) => {
  const { api } = await serviceFixture(t);
  const preview = await api(`/api/jobs/schedule-preview?${new URLSearchParams({ schedule: '0 3 * * *', timezone: 'Europe/Vienna' })}`);
  assert.equal(preview.status, 200);
  const body = await preview.json();
  assert.equal(body.nextRuns.length, 5);
  assert.equal(body.timezone, 'Europe/Vienna');

  const invalid = await api(`/api/jobs/schedule-preview?${new URLSearchParams({ schedule: '0 3 * * *', timezone: 'Mars/Base' })}`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /timezone/);
});
