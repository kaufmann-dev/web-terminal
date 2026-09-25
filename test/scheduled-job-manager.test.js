'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Cron } = require('croner');
const { createTerminalEnvironment } = require('../app');
const {
  JobError,
  MAX_JOB_RUN_HISTORY,
  ScheduledJobManager,
  isValidJobId,
  normalizeJobInput,
  previewSchedule,
} = require('../scheduled-job-manager');

const baseJob = {
  name: 'Nightly backup',
  command: 'echo hello',
  schedule: '0 3 * * *',
  timezone: 'Europe/Vienna',
};

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-terminal-jobs-'));
  const workdir = path.join(root, 'workdir');
  await fs.mkdir(workdir);
  const crons = [];
  class RecordingCron extends Cron {
    constructor(pattern, cronOptions, callback) {
      super(pattern, { ...cronOptions, paused: true }, callback);
      this.callback = callback;
      crons.push(this);
    }
  }
  const create = (overrides = {}) => new ScheduledJobManager({
    stateDirectory: path.join(root, 'state', 'jobs'),
    terminalEnvironment: { PATH: process.env.PATH, HOME: root },
    terminalWorkdir: workdir,
    killTimeoutMs: 200,
    CronClass: RecordingCron,
    logger: { error() {}, warn() {} },
    ...options,
    ...overrides,
  });
  const manager = create();
  await manager.initialize();
  t.after(async () => {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  const fire = (id) => {
    const cron = crons.filter((entry) => !entry.isStopped()).find((entry) => manager.crons.get(id) === entry);
    assert.ok(cron, 'job is scheduled');
    cron.callback();
  };
  return { root, workdir, manager, create, crons, fire };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition.');
}

function finishedRun(manager, id) {
  return waitFor(() => {
    const job = manager.get(id);
    return !job.running && job.lastRun?.status !== 'running' ? job.lastRun : null;
  });
}

function processIsAlive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

test('job input validation normalizes schedules and rejects unsafe values', () => {
  assert.deepEqual(normalizeJobInput({ ...baseJob, schedule: '  0   3 * * * ', name: ' Backup ' }), {
    name: 'Backup',
    command: 'echo hello',
    schedule: '0 3 * * *',
    timezone: 'Europe/Vienna',
    enabled: true,
    timeoutSeconds: 0,
  });
  assert.equal(normalizeJobInput({ ...baseJob, schedule: '@Daily' }).schedule, '@daily');
  assert.equal(normalizeJobInput({ ...baseJob, timezone: 'utc' }).timezone, 'UTC');

  const invalid = [
    null,
    [],
    { ...baseJob, name: '' },
    { ...baseJob, name: 'x'.repeat(65) },
    { ...baseJob, name: 'bad\nname' },
    { ...baseJob, command: '   ' },
    { ...baseJob, command: 'echo \0' },
    { ...baseJob, command: 'x'.repeat(8193) },
    { ...baseJob, schedule: '* * * * * *' },
    { ...baseJob, schedule: '0 3 * *' },
    { ...baseJob, schedule: '99 3 * * *' },
    { ...baseJob, schedule: '@reboot' },
    { ...baseJob, schedule: '0 0 30 2 *' },
    { ...baseJob, timezone: 'Not/AZone' },
    { ...baseJob, timezone: undefined },
    { ...baseJob, enabled: 'yes' },
    { ...baseJob, timeoutSeconds: -1 },
    { ...baseJob, timeoutSeconds: 1.5 },
    { ...baseJob, timeoutSeconds: 8 * 24 * 60 * 60 },
  ];
  for (const input of invalid) {
    assert.throws(() => normalizeJobInput(input), (error) => error instanceof JobError && error.status === 400);
  }
});

test('schedule previews list upcoming runs in the job timezone', () => {
  const preview = previewSchedule('0 9 * * 1-5', 'America/New_York');
  assert.equal(preview.nextRuns.length, 5);
  for (const run of preview.nextRuns) {
    const date = new Date(run);
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23',
    }).format(date);
    assert.equal(Number(hour), 9);
    assert.ok(![0, 6].includes(date.getUTCDay()));
  }
  assert.ok(isValidJobId('3f1c7b6e-1d2a-4c3b-8a9f-0123456789ab'));
  assert.ok(!isValidJobId('../../etc/passwd'));
});

test('jobs persist, schedule, and capture output with the job environment', async (t) => {
  const { manager, create, fire, workdir } = await fixture(t);
  const job = await manager.create({
    ...baseJob,
    command: 'pwd; echo "$WEB_TERMINAL_JOB_NAME"; echo "$HOME"; echo oops >&2',
  });
  assert.ok(isValidJobId(job.id));
  assert.ok(job.nextRunAt);
  assert.equal(job.running, false);

  fire(job.id);
  const run = await finishedRun(manager, job.id);
  assert.equal(run.status, 'success');
  assert.equal(run.trigger, 'schedule');
  assert.equal(run.exitCode, 0);
  const log = (await manager.readLog(job.id, run.id)).toString();
  assert.match(log, new RegExp(`^${workdir}\nNightly backup\n`));
  assert.match(log, /oops/);

  const reloaded = create();
  await reloaded.initialize();
  t.after(() => reloaded.shutdown());
  const [stored] = reloaded.list();
  assert.equal(stored.id, job.id);
  assert.equal(stored.lastRun.status, 'success');
  assert.ok(stored.nextRunAt);
  const mode = (await fs.stat(manager.statePath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('non-zero exits fail and manual runs reject overlap', async (t) => {
  const { manager } = await fixture(t);
  const failing = await manager.create({ ...baseJob, command: 'exit 7' });
  await manager.runNow(failing.id);
  const run = await finishedRun(manager, failing.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.exitCode, 7);
  assert.equal(run.trigger, 'manual');

  const slow = await manager.create({ ...baseJob, command: 'sleep 30' });
  await manager.runNow(slow.id);
  await assert.rejects(manager.runNow(slow.id), { status: 409 });
  const stopped = await manager.stop(slow.id);
  assert.equal(stopped.status, 'stopped');
  await assert.rejects(manager.stop(slow.id), { status: 409 });
  await assert.rejects(manager.runNow('3f1c7b6e-1d2a-4c3b-8a9f-0123456789ab'), { status: 404 });
});

test('overlapping scheduled runs are skipped and history stays bounded', async (t) => {
  const { manager, fire } = await fixture(t);
  const job = await manager.create({ ...baseJob, command: 'sleep 30' });
  fire(job.id);
  await waitFor(() => manager.get(job.id).running);
  for (let index = 0; index < MAX_JOB_RUN_HISTORY + 5; index += 1) {
    fire(job.id);
  }
  const { runs } = manager.get(job.id);
  assert.equal(runs.length, MAX_JOB_RUN_HISTORY);
  assert.ok(runs.slice(0, MAX_JOB_RUN_HISTORY - 1).every((run) => run.status === 'skipped'));
  await manager.stop(job.id);
  assert.equal(manager.get(job.id).running, false);
});

test('timeouts terminate every process in the job session', async (t) => {
  const { manager, workdir } = await fixture(t);
  const job = await manager.create({
    ...baseJob,
    command: 'sleep 30 & echo $! > background.pid; trap "" TERM; sleep 30',
    timeoutSeconds: 1,
  });
  await manager.runNow(job.id);
  const backgroundPid = Number(await waitFor(async () => (
    await fs.readFile(path.join(workdir, 'background.pid'), 'utf8').catch(() => '')
  ).trim()));
  assert.ok(processIsAlive(backgroundPid));
  const run = await finishedRun(manager, job.id);
  assert.equal(run.status, 'timeout');
  await waitFor(() => !processIsAlive(backgroundPid));
});

test('logs are capped and marked as truncated', async (t) => {
  const { manager } = await fixture(t, { maxLogBytes: 100 });
  const job = await manager.create({ ...baseJob, command: 'head -c 5000 /dev/zero | tr "\\0" a' });
  await manager.runNow(job.id);
  const run = await finishedRun(manager, job.id);
  assert.equal(run.status, 'success');
  assert.equal(run.truncated, true);
  const log = (await manager.readLog(job.id, run.id)).toString();
  assert.equal(log, `${'a'.repeat(100)}\n[web-terminal: output truncated after 1 MiB]\n`);
});

test('deleting a running job stops it and removes its logs', async (t) => {
  const { manager, workdir } = await fixture(t);
  const job = await manager.create({ ...baseJob, command: 'echo $$ > shell.pid; sleep 30' });
  await manager.runNow(job.id);
  const shellPid = Number(await waitFor(async () => (
    await fs.readFile(path.join(workdir, 'shell.pid'), 'utf8').catch(() => '')
  ).trim()));
  await manager.delete(job.id);
  assert.equal(processIsAlive(shellPid), false);
  assert.deepEqual(manager.list(), []);
  await assert.rejects(fs.stat(path.join(manager.runDirectory, job.id)), { code: 'ENOENT' });
  await assert.rejects(manager.delete(job.id), { status: 404 });
});

test('disabling a job unschedules it without losing its definition', async (t) => {
  const { manager } = await fixture(t);
  const job = await manager.create(baseJob);
  const disabled = await manager.update(job.id, { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.nextRunAt, null);
  assert.equal(manager.crons.has(job.id), false);
  const changed = await manager.update(job.id, { enabled: true, schedule: '@hourly' });
  assert.equal(changed.schedule, '@hourly');
  assert.ok(changed.nextRunAt);
  await assert.rejects(manager.update(job.id, { schedule: 'nope' }), { status: 400 });
  assert.equal(manager.get(job.id).schedule, '@hourly');
});

test('startup marks unfinished runs as interrupted and preserves unreadable state', async (t) => {
  const { root, create } = await fixture(t);
  const stateDirectory = path.join(root, 'restart');
  await fs.mkdir(stateDirectory, { recursive: true });
  const jobId = '3f1c7b6e-1d2a-4c3b-8a9f-0123456789ab';
  const runId = '7b0d3c2e-5f4a-4b3c-9d8e-0123456789ab';
  await fs.writeFile(path.join(stateDirectory, 'jobs.json'), JSON.stringify({
    version: 1,
    jobs: [
      { id: jobId, ...baseJob, enabled: false, timeoutSeconds: 0, runs: [{ id: runId, status: 'running' }] },
      { id: 'not-a-uuid', ...baseJob },
    ],
  }));
  const restarted = create({ stateDirectory });
  await restarted.initialize();
  t.after(() => restarted.shutdown());
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.get(jobId).runs[0].status, 'interrupted');
  const saved = JSON.parse(await fs.readFile(path.join(stateDirectory, 'jobs.json'), 'utf8'));
  assert.equal(saved.jobs.length, 1);
  assert.equal(saved.jobs[0].runs[0].status, 'interrupted');

  const corruptDirectory = path.join(root, 'corrupt');
  await fs.mkdir(corruptDirectory, { recursive: true });
  await fs.writeFile(path.join(corruptDirectory, 'jobs.json'), '{not json');
  const recovered = create({ stateDirectory: corruptDirectory });
  await recovered.initialize();
  t.after(() => recovered.shutdown());
  assert.deepEqual(recovered.list(), []);
  const files = await fs.readdir(corruptDirectory);
  assert.ok(files.some((file) => file.startsWith('jobs.json.corrupt-')));
});

test('shutdown interrupts running jobs and records the result', async (t) => {
  const { manager, create } = await fixture(t);
  const job = await manager.create({ ...baseJob, command: 'sleep 30' });
  await manager.runNow(job.id);
  await manager.shutdown();
  assert.equal(manager.get(job.id).lastRun.status, 'interrupted');
  await assert.rejects(manager.runNow(job.id), { status: 503 });
  const reloaded = create();
  await reloaded.initialize();
  t.after(() => reloaded.shutdown());
  assert.equal(reloaded.get(job.id).lastRun.status, 'interrupted');
});

test('the terminal environment given to jobs excludes application secrets', () => {
  const saved = { ...process.env };
  process.env.OIDC_CLIENT_SECRET = 'secret';
  process.env.SESSION_SECRET = 'secret';
  process.env.ELEVENLABS_API_KEY = 'secret';
  try {
    const environment = createTerminalEnvironment({ terminalHome: '/home-dir', terminalWorkdir: '/work' });
    assert.equal(environment.OIDC_CLIENT_SECRET, undefined);
    assert.equal(environment.SESSION_SECRET, undefined);
    assert.equal(environment.ELEVENLABS_API_KEY, undefined);
  } finally {
    for (const name of ['OIDC_CLIENT_SECRET', 'SESSION_SECRET', 'ELEVENLABS_API_KEY']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
