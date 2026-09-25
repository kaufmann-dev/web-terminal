'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

test('schedule presets round-trip and form payloads are validated', async () => {
  const {
    SCHEDULE_PRESETS,
    jobPayloadFromForm,
    normalizeSchedule,
    presetForSchedule,
  } = await import('../public/js/scheduled-jobs.mjs');

  for (const preset of SCHEDULE_PRESETS) {
    assert.equal(presetForSchedule(` ${preset.schedule.replaceAll(' ', '  ')} `), preset.schedule);
  }
  assert.equal(presetForSchedule('5 4 * * *'), '');
  assert.equal(normalizeSchedule('  0\t3  * * * '), '0 3 * * *');

  const form = {
    name: '  Backup ',
    command: 'restic backup /code',
    schedule: '0  3 * * *',
    timezone: ' Europe/Vienna ',
    timeoutMinutes: '15',
    enabled: true,
  };
  assert.deepEqual(jobPayloadFromForm(form), {
    name: 'Backup',
    command: 'restic backup /code',
    schedule: '0 3 * * *',
    timezone: 'Europe/Vienna',
    enabled: true,
    timeoutSeconds: 900,
  });
  assert.equal(jobPayloadFromForm({ ...form, timeoutMinutes: '' }).timeoutSeconds, 0);
  assert.equal(jobPayloadFromForm({ ...form, schedule: '@daily' }).schedule, '@daily');

  for (const invalid of [
    { name: ' ' },
    { name: 'x'.repeat(65) },
    { command: '  ' },
    { schedule: '0 3 * *' },
    { schedule: '0 0 3 * * *' },
    { timezone: '' },
    { timeoutMinutes: '-1' },
    { timeoutMinutes: '1.5' },
    { timeoutMinutes: '10081' },
  ]) {
    assert.throws(() => jobPayloadFromForm({ ...form, ...invalid }), Error, JSON.stringify(invalid));
  }
});

test('run statuses and durations are described for the job list', async () => {
  const { describeRunStatus, formatDuration } = await import('../public/js/scheduled-jobs.mjs');
  assert.deepEqual(describeRunStatus(null), { label: 'Never run', tone: 'idle' });
  assert.deepEqual(describeRunStatus({ status: 'success' }), { label: 'Succeeded', tone: 'success' });
  assert.equal(describeRunStatus({ status: 'failed', exitCode: 2 }).label, 'Failed (exit 2)');
  assert.equal(describeRunStatus({ status: 'failed', signal: 'SIGKILL' }).label, 'Failed (SIGKILL)');
  assert.equal(describeRunStatus({ status: 'skipped' }).tone, 'warning');
  assert.equal(describeRunStatus({ status: 'timeout' }).tone, 'error');

  const start = '2026-01-01T00:00:00.000Z';
  assert.equal(formatDuration(start, '2026-01-01T00:00:42.000Z'), '42s');
  assert.equal(formatDuration(start, '2026-01-01T00:03:05.000Z'), '3m 5s');
  assert.equal(formatDuration(start, '2026-01-01T02:07:00.000Z'), '2h 7m');
  assert.equal(formatDuration(start, null, Date.parse('2026-01-01T00:00:10.000Z')), '10s');
});

test('the sidebar exposes a jobs dialog beside uploads', () => {
  const view = fs.readFileSync(path.join(projectRoot, 'views', 'terminal.html'), 'utf8');
  const script = fs.readFileSync(path.join(projectRoot, 'public', 'js', 'terminal.js'), 'utf8');
  assert.match(
    view,
    /<div class="sidebar-uploads">\s*<button id="upload-open"[^>]*>Upload<\/button>\s*<button id="jobs-open" class="upload-button" type="button" disabled>Jobs<\/button>/,
  );
  assert.match(view, /<dialog id="jobs-dialog" class="upload-dialog jobs-dialog"/);
  assert.match(script, /import\('\/static\/js\/scheduled-jobs\.mjs'\)/);
  assert.match(script, /uploads\.enable\(\);\s*scheduledJobs\.enable\(\);/);
});
