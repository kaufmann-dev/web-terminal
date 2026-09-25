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

test('common cron schedules are described in words', async () => {
  const { SCHEDULE_PRESETS, describeSchedule } = await import('../public/js/scheduled-jobs.mjs');
  const cases = {
    '* * * * *': 'Every minute',
    '*/15 * * * *': 'Every 15 minutes',
    '0 * * * *': 'Every hour',
    '30 * * * *': 'Every hour at :30',
    '0 */6 * * *': 'Every 6 hours',
    '15 */2 * * *': 'Every 2 hours at :15',
    '0 3 * * *': 'Every day at 03:00',
    '5 21 * * *': 'Every day at 21:05',
    '0 9 * * 1-5': 'Weekdays at 09:00',
    '0 10 * * 0,6': 'Weekends at 10:00',
    '0 3 * * 0': 'Every Sunday at 03:00',
    '0 3 * * 7': 'Every Sunday at 03:00',
    '0 8 * * 1,3,5': 'Every Mon, Wed, Fri at 08:00',
    '0 8 * * 2-4': 'Every Tue–Thu at 08:00',
    '0 3 1 * *': 'Monthly on day 1 at 03:00',
    '@daily': 'Every day at 00:00',
    '@HOURLY': 'Every hour',
  };
  for (const [schedule, description] of Object.entries(cases)) {
    assert.equal(describeSchedule(schedule), description, schedule);
  }
  for (const schedule of ['0 3 1 1 *', '0 9,17 * * *', '0 3 1 * 1', '0 3 * * MON', '0 25 * * *', 'nonsense']) {
    assert.equal(describeSchedule(schedule), null, schedule);
  }
  for (const preset of SCHEDULE_PRESETS) {
    assert.ok(describeSchedule(preset.schedule), preset.schedule);
  }
});

test('relative times and timeouts read naturally', async () => {
  const { formatRelativeTime, formatTimeout } = await import('../public/js/scheduled-jobs.mjs');
  const now = Date.parse('2026-09-25T12:00:00Z');
  const at = (seconds) => new Date(now + seconds * 1000).toISOString();
  assert.equal(formatRelativeTime(at(10), now, 'en'), 'in a moment');
  assert.equal(formatRelativeTime(at(-10), now, 'en'), 'just now');
  assert.equal(formatRelativeTime(at(5 * 60), now, 'en'), 'in 5 minutes');
  assert.equal(formatRelativeTime(at(-2 * 3600), now, 'en'), '2 hours ago');
  assert.equal(formatRelativeTime(at(26 * 3600), now, 'en'), 'tomorrow');
  assert.equal(formatRelativeTime(at(-3 * 86400), now, 'en'), '3 days ago');
  assert.equal(formatRelativeTime(at(-400 * 86400), now, 'en'), 'last year');
  assert.equal(formatRelativeTime('not a date', now, 'en'), '');
  assert.equal(formatTimeout(0), 'None');
  assert.equal(formatTimeout(15 * 60), '15 min');
  assert.equal(formatTimeout(90 * 60), '90 min');
  assert.equal(formatTimeout(2 * 3600), '2 h');
});

test('the jobs dialog has a list, an empty state, a detail view, and an editor', () => {
  const view = fs.readFileSync(path.join(projectRoot, 'views', 'terminal.html'), 'utf8');
  const dialog = view.slice(view.indexOf('<dialog id="jobs-dialog"'));
  for (const id of [
    'jobs-list-view', 'jobs-empty', 'jobs-empty-new', 'jobs-list', 'jobs-new', 'jobs-detail-view',
    'jobs-detail-back', 'jobs-detail-title', 'jobs-detail-command', 'jobs-detail-meta', 'jobs-detail-run',
    'jobs-detail-toggle', 'jobs-detail-edit', 'jobs-detail-delete', 'jobs-runs', 'jobs-editor', 'job-save',
  ]) {
    assert.match(dialog, new RegExp(`id="${id}"`), id);
  }
  assert.match(dialog, /<button id="jobs-detail-delete" class="btn-dialog-danger"/);
  assert.doesNotMatch(dialog, /jobs-runs-view/);
});
