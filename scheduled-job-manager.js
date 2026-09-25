'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Cron } = require('croner');
const { delay, signalLinuxSession } = require('./terminal-session-manager');

const MAX_JOBS = 100;
const MAX_JOB_NAME_LENGTH = 64;
const MAX_JOB_COMMAND_LENGTH = 8192;
const MAX_JOB_SCHEDULE_LENGTH = 128;
const MAX_JOB_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
const MAX_JOB_RUN_HISTORY = 20;
const MAX_JOB_LOG_BYTES = 1024 * 1024;
const SCHEDULE_PREVIEW_COUNT = 5;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCHEDULE_NICKNAMES = new Set([
  '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly',
]);
const RUN_STATUSES = new Set([
  'running', 'success', 'failed', 'timeout', 'stopped', 'skipped', 'interrupted',
]);
const TRUNCATION_MARKER = '\n[web-terminal: output truncated after 1 MiB]\n';

class JobError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isValidJobId(id) {
  return typeof id === 'string' && JOB_ID_PATTERN.test(id);
}

function normalizeTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 64) {
    throw new JobError(400, 'Choose a valid IANA timezone, for example Europe/Vienna.');
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new JobError(400, 'Choose a valid IANA timezone, for example Europe/Vienna.');
  }
}

function normalizeSchedule(schedule) {
  if (typeof schedule !== 'string') {
    throw new JobError(400, 'Enter a cron schedule, for example 0 3 * * *.');
  }
  const normalized = schedule.trim().split(/\s+/).join(' ');
  if (!normalized || normalized.length > MAX_JOB_SCHEDULE_LENGTH) {
    throw new JobError(400, 'Enter a cron schedule, for example 0 3 * * *.');
  }
  if (normalized.startsWith('@')) {
    if (!SCHEDULE_NICKNAMES.has(normalized.toLowerCase())) {
      throw new JobError(400, 'Use @hourly, @daily, @weekly, @monthly, or @yearly.');
    }
    return normalized.toLowerCase();
  }
  if (normalized.split(' ').length !== 5) {
    throw new JobError(400, 'Cron schedules need five fields: minute hour day-of-month month day-of-week.');
  }
  return normalized;
}

function previewSchedule(schedule, timezone, count = SCHEDULE_PREVIEW_COUNT, CronClass = Cron) {
  const normalizedSchedule = normalizeSchedule(schedule);
  const normalizedTimezone = normalizeTimezone(timezone);
  let cron;
  try {
    cron = new CronClass(normalizedSchedule, { timezone: normalizedTimezone, paused: true });
    const runs = cron.nextRuns(count);
    if (runs.length === 0) {
      throw new JobError(400, 'This schedule never runs.');
    }
    return {
      schedule: normalizedSchedule,
      timezone: normalizedTimezone,
      nextRuns: runs.map((date) => date.toISOString()),
    };
  } catch (error) {
    if (error instanceof JobError) throw error;
    throw new JobError(400, `Invalid cron schedule: ${error.message}`);
  } finally {
    cron?.stop();
  }
}

function normalizeJobInput(input, CronClass = Cron) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new JobError(400, 'Send the job as a JSON object.');
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MAX_JOB_NAME_LENGTH || /[\x00-\x1f\x7f]/.test(name)) {
    throw new JobError(400, `Job names must be 1-${MAX_JOB_NAME_LENGTH} characters without control characters.`);
  }

  const { command } = input;
  if (typeof command !== 'string' || !command.trim()
    || command.length > MAX_JOB_COMMAND_LENGTH || command.includes('\0')) {
    throw new JobError(400, `Commands must be 1-${MAX_JOB_COMMAND_LENGTH} characters without NUL bytes.`);
  }

  const enabled = input.enabled ?? true;
  if (typeof enabled !== 'boolean') {
    throw new JobError(400, 'Enabled must be true or false.');
  }

  const timeoutSeconds = input.timeoutSeconds ?? 0;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0
    || timeoutSeconds > MAX_JOB_TIMEOUT_SECONDS) {
    throw new JobError(400, 'Timeouts must be whole seconds between 0 (none) and seven days.');
  }

  const { schedule, timezone } = previewSchedule(input.schedule, input.timezone, 1, CronClass);
  return { name, command, schedule, timezone, enabled, timeoutSeconds };
}

function editableFields(job) {
  return {
    name: job.name,
    command: job.command,
    schedule: job.schedule,
    timezone: job.timezone,
    enabled: job.enabled,
    timeoutSeconds: job.timeoutSeconds,
  };
}

function sanitizeStoredRun(run) {
  if (!run || typeof run !== 'object' || !isValidJobId(run.id) || !RUN_STATUSES.has(run.status)) {
    return null;
  }
  return {
    id: run.id,
    trigger: run.trigger === 'manual' ? 'manual' : 'schedule',
    status: run.status,
    startedAt: typeof run.startedAt === 'string' ? run.startedAt : null,
    finishedAt: typeof run.finishedAt === 'string' ? run.finishedAt : null,
    exitCode: Number.isInteger(run.exitCode) ? run.exitCode : null,
    signal: typeof run.signal === 'string' ? run.signal : null,
    truncated: run.truncated === true,
  };
}

class ScheduledJobManager {
  constructor(options) {
    this.stateDirectory = options.stateDirectory;
    this.statePath = path.join(this.stateDirectory, 'jobs.json');
    this.runDirectory = path.join(this.stateDirectory, 'runs');
    this.terminalEnvironment = { ...options.terminalEnvironment };
    this.terminalWorkdir = options.terminalWorkdir;
    this.bashPath = options.bashPath || '/bin/bash';
    this.killTimeoutMs = options.killTimeoutMs ?? 2000;
    this.maxLogBytes = options.maxLogBytes ?? MAX_JOB_LOG_BYTES;
    this.spawnProcess = options.spawnProcess || spawn;
    this.CronClass = options.CronClass || Cron;
    this.signalSession = options.signalSession || signalLinuxSession;
    this.now = options.now || Date.now;
    this.logger = options.logger || console;
    this.jobs = new Map();
    this.crons = new Map();
    this.active = new Map();
    this.writeQueue = Promise.resolve();
    this.shuttingDown = false;
  }

  async initialize() {
    await fsp.mkdir(this.runDirectory, { recursive: true, mode: 0o700 });

    let stored = { jobs: [] };
    try {
      stored = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const preserved = `${this.statePath}.corrupt-${this.now()}`;
        this.logger.error(`Unable to read scheduled jobs; preserving the file as ${preserved}: ${error.message}`);
        await fsp.rename(this.statePath, preserved).catch(() => {});
      }
    }

    let changed = false;
    for (const storedJob of Array.isArray(stored?.jobs) ? stored.jobs : []) {
      if (!storedJob || !isValidJobId(storedJob.id) || this.jobs.has(storedJob.id)) {
        changed = true;
        continue;
      }
      let fields;
      try {
        fields = normalizeJobInput(storedJob, this.CronClass);
      } catch (error) {
        this.logger.warn(`Ignoring invalid scheduled job ${storedJob.id}: ${error.message}`);
        changed = true;
        continue;
      }
      const runs = (Array.isArray(storedJob.runs) ? storedJob.runs : [])
        .map(sanitizeStoredRun)
        .filter(Boolean)
        .slice(0, MAX_JOB_RUN_HISTORY);
      for (const run of runs) {
        if (run.status === 'running') {
          run.status = 'interrupted';
          run.finishedAt = new Date(this.now()).toISOString();
          changed = true;
        }
      }
      this.jobs.set(storedJob.id, {
        id: storedJob.id,
        ...fields,
        createdAt: typeof storedJob.createdAt === 'string' ? storedJob.createdAt : null,
        updatedAt: typeof storedJob.updatedAt === 'string' ? storedJob.updatedAt : null,
        runs,
      });
    }

    if (changed) {
      await this._persist();
    }
    for (const job of this.jobs.values()) {
      this._schedule(job);
    }
  }

  list() {
    return [...this.jobs.values()]
      .map((job) => this._publicJob(job))
      .sort((a, b) => a.name.localeCompare(b.name) || String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  get(id) {
    const job = this._requireJob(id);
    return { ...this._publicJob(job), runs: job.runs.map((run) => ({ ...run })) };
  }

  preview(schedule, timezone) {
    return previewSchedule(schedule, timezone, SCHEDULE_PREVIEW_COUNT, this.CronClass);
  }

  async create(input) {
    if (this.jobs.size >= MAX_JOBS) {
      throw new JobError(409, `Delete a job before adding more; the limit is ${MAX_JOBS}.`);
    }
    const fields = normalizeJobInput(input, this.CronClass);
    const timestamp = new Date(this.now()).toISOString();
    const job = { id: randomUUID(), ...fields, createdAt: timestamp, updatedAt: timestamp, runs: [] };
    this.jobs.set(job.id, job);
    try {
      await this._persist();
    } catch (error) {
      this.jobs.delete(job.id);
      throw error;
    }
    this._schedule(job);
    return this._publicJob(job);
  }

  async update(id, input) {
    const job = this._requireJob(id);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new JobError(400, 'Send the job as a JSON object.');
    }
    const previous = editableFields(job);
    const fields = normalizeJobInput({ ...previous, ...input }, this.CronClass);
    const previousUpdatedAt = job.updatedAt;
    Object.assign(job, fields, { updatedAt: new Date(this.now()).toISOString() });
    try {
      await this._persist();
    } catch (error) {
      Object.assign(job, previous, { updatedAt: previousUpdatedAt });
      throw error;
    }
    this._schedule(job);
    return this._publicJob(job);
  }

  async delete(id) {
    const job = this._requireJob(id);
    this._unschedule(id);
    this.jobs.delete(id);
    const active = this.active.get(id);
    if (active) {
      await this._terminate(active, 'stopped');
    }
    await fsp.rm(path.join(this.runDirectory, id), { recursive: true, force: true });
    await this._persist();
    return this._publicJob(job);
  }

  async runNow(id) {
    const job = this._requireJob(id);
    if (this.active.has(id)) {
      throw new JobError(409, 'This job is already running.');
    }
    if (this.shuttingDown) {
      throw new JobError(503, 'Scheduled jobs are shutting down.');
    }
    const run = this._startRun(job, 'manual');
    return { ...run };
  }

  async stop(id) {
    this._requireJob(id);
    const active = this.active.get(id);
    if (!active) {
      throw new JobError(409, 'This job is not running.');
    }
    await this._terminate(active, 'stopped');
    return { ...active.run };
  }

  async readLog(id, runId) {
    const job = this._requireJob(id);
    if (!isValidJobId(runId) || !job.runs.some((run) => run.id === runId)) {
      throw new JobError(404, 'Job run not found.');
    }
    try {
      return await fsp.readFile(this._logPath(id, runId));
    } catch (error) {
      if (error.code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const id of [...this.crons.keys()]) {
      this._unschedule(id);
    }
    await Promise.all([...this.active.values()].map((active) => this._terminate(active, 'interrupted')));
    await this.writeQueue;
  }

  _requireJob(id) {
    const job = isValidJobId(id) ? this.jobs.get(id) : undefined;
    if (!job) {
      throw new JobError(404, 'Scheduled job not found.');
    }
    return job;
  }

  _publicJob(job) {
    const nextRun = this.crons.get(job.id)?.nextRun();
    return {
      ...editableFields(job),
      id: job.id,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      nextRunAt: nextRun ? nextRun.toISOString() : null,
      running: this.active.has(job.id),
      lastRun: job.runs[0] ? { ...job.runs[0] } : null,
    };
  }

  _logPath(id, runId) {
    return path.join(this.runDirectory, id, `${runId}.log`);
  }

  _schedule(job) {
    this._unschedule(job.id);
    if (!job.enabled || this.shuttingDown) {
      return;
    }
    const cron = new this.CronClass(
      job.schedule,
      { timezone: job.timezone, unref: true },
      () => this._onSchedule(job.id),
    );
    this.crons.set(job.id, cron);
  }

  _unschedule(id) {
    const cron = this.crons.get(id);
    if (cron) {
      cron.stop();
      this.crons.delete(id);
    }
  }

  _onSchedule(id) {
    const job = this.jobs.get(id);
    if (!job || !job.enabled || this.shuttingDown) {
      return;
    }
    if (this.active.has(id)) {
      const timestamp = new Date(this.now()).toISOString();
      this._addRun(job, {
        id: randomUUID(),
        trigger: 'schedule',
        status: 'skipped',
        startedAt: timestamp,
        finishedAt: timestamp,
        exitCode: null,
        signal: null,
        truncated: false,
      });
      this._persist().catch((error) => {
        this.logger.error(`Unable to record skipped job ${id}: ${error.message}`);
      });
      return;
    }
    this._startRun(job, 'schedule');
  }

  _addRun(job, run) {
    job.runs.unshift(run);
    for (const removed of job.runs.splice(MAX_JOB_RUN_HISTORY)) {
      fsp.rm(this._logPath(job.id, removed.id), { force: true }).catch(() => {});
    }
  }

  _startRun(job, trigger) {
    const run = {
      id: randomUUID(),
      trigger,
      status: 'running',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      truncated: false,
    };
    let resolveFinished;
    const active = {
      jobId: job.id,
      run,
      child: null,
      streams: [],
      stopReason: null,
      done: false,
      timeoutTimer: null,
      finished: new Promise((resolve) => { resolveFinished = resolve; }),
      resolveFinished,
    };
    this.active.set(job.id, active);
    this._addRun(job, run);
    this._persist().catch((error) => {
      this.logger.error(`Unable to record job run ${job.id}: ${error.message}`);
    });
    this._execute(job, active).catch((error) => {
      this.logger.error(`Scheduled job ${job.id} failed to run: ${error.message}`);
      this._finishRun(active, { exitCode: null, signal: null });
    });
    return run;
  }

  async _execute(job, active) {
    await fsp.mkdir(path.join(this.runDirectory, job.id), { recursive: true, mode: 0o700 });
    const log = fs.createWriteStream(this._logPath(job.id, active.run.id), { flags: 'wx', mode: 0o600 });
    active.log = log;
    log.on('error', (error) => {
      this.logger.error(`Unable to write log for job ${job.id}: ${error.message}`);
    });
    if (active.stopReason) {
      this._finishRun(active, { exitCode: null, signal: null });
      return;
    }

    let loggedBytes = 0;
    const capture = (chunk) => {
      if (loggedBytes >= this.maxLogBytes) return;
      const remaining = this.maxLogBytes - loggedBytes;
      log.write(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      loggedBytes += Math.min(chunk.length, remaining);
      if (loggedBytes >= this.maxLogBytes) {
        active.run.truncated = true;
        log.write(TRUNCATION_MARKER);
      }
    };

    const child = this.spawnProcess(this.bashPath, ['-c', job.command], {
      cwd: this.terminalWorkdir,
      env: {
        ...this.terminalEnvironment,
        WEB_TERMINAL_JOB_ID: job.id,
        WEB_TERMINAL_JOB_NAME: job.name,
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    active.child = child;
    active.streams = [child.stdout, child.stderr].filter(Boolean);
    for (const stream of active.streams) {
      stream.on('data', capture);
    }
    child.once('error', (error) => {
      log.write(`[web-terminal: unable to start job: ${error.message}]\n`);
      this._finishRun(active, { exitCode: null, signal: null });
    });
    // `close` waits for every holder of the output pipes, matching cron's behaviour
    // for commands that leave background processes attached to their output.
    child.once('close', (exitCode, signal) => {
      this._finishRun(active, { exitCode, signal });
    });

    if (job.timeoutSeconds > 0) {
      active.timeoutTimer = setTimeout(() => {
        this._terminate(active, 'timeout').catch((error) => {
          this.logger.error(`Unable to stop timed-out job ${job.id}: ${error.message}`);
        });
      }, job.timeoutSeconds * 1000);
    }
  }

  async _terminate(active, reason) {
    if (active.done) {
      return active.finished;
    }
    active.stopReason ??= reason;
    const pid = active.child?.pid;
    if (!pid) {
      return active.finished;
    }

    const signalOptions = { logger: this.logger };
    await this.signalSession(pid, 'SIGTERM', signalOptions);
    await Promise.race([active.finished, delay(this.killTimeoutMs)]);
    if (!active.done) {
      await this.signalSession(pid, 'SIGKILL', signalOptions);
      await Promise.race([active.finished, delay(1000)]);
    }
    if (!active.done) {
      // A process that escaped the job's Linux session can still hold the output
      // pipes. Close our ends so the run can finish.
      for (const stream of active.streams) stream.destroy();
      await Promise.race([active.finished, delay(1000)]);
    }
    if (!active.done) {
      this._finishRun(active, { exitCode: null, signal: 'SIGKILL' });
    }
    return active.finished;
  }

  _finishRun(active, { exitCode, signal }) {
    if (active.done) {
      return;
    }
    active.done = true;
    clearTimeout(active.timeoutTimer);

    const { run } = active;
    if (active.stopReason) {
      run.status = active.stopReason;
    } else {
      run.status = exitCode === 0 ? 'success' : 'failed';
    }
    run.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    run.signal = signal ?? null;
    run.finishedAt = new Date(this.now()).toISOString();

    const closeLog = active.log && !active.log.closed
      ? new Promise((resolve) => active.log.end(resolve))
      : Promise.resolve();
    closeLog.then(async () => {
      if (this.active.get(active.jobId) === active) {
        this.active.delete(active.jobId);
      }
      if (this.jobs.has(active.jobId)) {
        await this._persist().catch((error) => {
          this.logger.error(`Unable to record job result ${active.jobId}: ${error.message}`);
        });
      }
      active.resolveFinished(run);
    });
  }

  _persist() {
    const write = this.writeQueue.then(() => this._writeState());
    this.writeQueue = write.catch(() => {});
    return write;
  }

  async _writeState() {
    const state = {
      version: 1,
      jobs: [...this.jobs.values()].map((job) => ({
        id: job.id,
        ...editableFields(job),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        runs: job.runs,
      })),
    };
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await fsp.rename(temporaryPath, this.statePath);
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = {
  JobError,
  MAX_JOBS,
  MAX_JOB_COMMAND_LENGTH,
  MAX_JOB_LOG_BYTES,
  MAX_JOB_NAME_LENGTH,
  MAX_JOB_RUN_HISTORY,
  MAX_JOB_TIMEOUT_SECONDS,
  ScheduledJobManager,
  isValidJobId,
  normalizeJobInput,
  previewSchedule,
};
