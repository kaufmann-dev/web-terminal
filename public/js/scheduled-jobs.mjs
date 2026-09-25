export const SCHEDULE_PRESETS = Object.freeze([
  { label: 'Every 15 minutes', schedule: '*/15 * * * *' },
  { label: 'Every hour', schedule: '0 * * * *' },
  { label: 'Every day at 03:00', schedule: '0 3 * * *' },
  { label: 'Weekdays at 09:00', schedule: '0 9 * * 1-5' },
  { label: 'Every Sunday at 03:00', schedule: '0 3 * * 0' },
  { label: 'First of the month at 03:00', schedule: '0 3 1 * *' },
]);

export const MAX_TIMEOUT_MINUTES = 7 * 24 * 60;
const SCHEDULE_NICKNAMES = ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'];

export function normalizeSchedule(schedule) {
  return String(schedule ?? '').trim().split(/\s+/).filter(Boolean).join(' ');
}

export function presetForSchedule(schedule) {
  const normalized = normalizeSchedule(schedule);
  return SCHEDULE_PRESETS.find((preset) => preset.schedule === normalized)?.schedule ?? '';
}

export function jobPayloadFromForm({ name, command, schedule, timezone, timeoutMinutes, enabled }) {
  const trimmedName = String(name ?? '').trim();
  if (!trimmedName) throw new Error('Enter a job name.');
  if (trimmedName.length > 64) throw new Error('Job names can be at most 64 characters.');
  if (!String(command ?? '').trim()) throw new Error('Enter a command to run.');
  const normalizedSchedule = normalizeSchedule(schedule);
  const isNickname = SCHEDULE_NICKNAMES.includes(normalizedSchedule.toLowerCase());
  if (!isNickname && normalizedSchedule.split(' ').length !== 5) {
    throw new Error('Cron schedules need five fields: minute hour day-of-month month day-of-week.');
  }
  const trimmedTimezone = String(timezone ?? '').trim();
  if (!trimmedTimezone) throw new Error('Choose a timezone.');
  const timeoutText = String(timeoutMinutes ?? '').trim() || '0';
  const minutes = Number(timeoutText);
  if (!/^\d+$/.test(timeoutText) || minutes > MAX_TIMEOUT_MINUTES) {
    throw new Error(`The timeout must be a whole number of minutes from 0 to ${MAX_TIMEOUT_MINUTES}.`);
  }
  return {
    name: trimmedName,
    command,
    schedule: normalizedSchedule,
    timezone: trimmedTimezone,
    enabled: Boolean(enabled),
    timeoutSeconds: minutes * 60,
  };
}

export function describeRunStatus(run) {
  if (!run) return { label: 'Never run', tone: 'idle' };
  switch (run.status) {
    case 'running': return { label: 'Running', tone: 'running' };
    case 'success': return { label: 'Succeeded', tone: 'success' };
    case 'failed':
      return {
        label: run.signal ? `Failed (${run.signal})` : `Failed (exit ${run.exitCode ?? '?'})`,
        tone: 'error',
      };
    case 'timeout': return { label: 'Timed out', tone: 'error' };
    case 'stopped': return { label: 'Stopped', tone: 'idle' };
    case 'skipped': return { label: 'Skipped: still running', tone: 'warning' };
    case 'interrupted': return { label: 'Interrupted by restart', tone: 'warning' };
    default: return { label: 'Unknown', tone: 'idle' };
  }
}

export function formatDuration(startedAt, finishedAt, now = Date.now()) {
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatDateTime(value, timeZone) {
  if (!value) return '';
  const options = { dateStyle: 'medium', timeStyle: 'short' };
  if (timeZone) options.timeZone = timeZone;
  try {
    return new Date(value).toLocaleString(undefined, options);
  } catch {
    return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NICKNAME_DESCRIPTIONS = {
  '@hourly': 'Every hour',
  '@daily': 'Every day at 00:00',
  '@midnight': 'Every day at 00:00',
  '@weekly': 'Every Sunday at 00:00',
  '@monthly': 'Monthly on day 1 at 00:00',
  '@yearly': 'Every year on January 1 at 00:00',
  '@annually': 'Every year on January 1 at 00:00',
};

const isWithin = (field, max, min = 0) => /^\d+$/.test(field) && Number(field) >= min && Number(field) <= max;
const twoDigits = (value) => String(Number(value)).padStart(2, '0');

function describeDays(field) {
  if (field === '1-5') return 'Weekdays';
  if (['0,6', '6,0', '6,7'].includes(field)) return 'Weekends';
  const parts = field.split(',');
  const labels = [];
  for (const part of parts) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range && Number(range[1]) < Number(range[2]) && Number(range[2]) <= 7) {
      labels.push(`${SHORT_DAY_NAMES[Number(range[1]) % 7]}–${SHORT_DAY_NAMES[Number(range[2]) % 7]}`);
    } else if (isWithin(part, 7)) {
      labels.push(parts.length === 1 ? DAY_NAMES[Number(part) % 7] : SHORT_DAY_NAMES[Number(part) % 7]);
    } else {
      return null;
    }
  }
  return `Every ${labels.join(', ')}`;
}

// Describe common cron shapes in words; anything else is shown as the raw expression.
export function describeSchedule(schedule) {
  const normalized = normalizeSchedule(schedule).toLowerCase();
  if (NICKNAME_DESCRIPTIONS[normalized]) return NICKNAME_DESCRIPTIONS[normalized];
  const fields = normalized.split(' ');
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (month !== '*') return null;
  const everyDay = dayOfMonth === '*' && dayOfWeek === '*';

  if (hour === '*' && everyDay) {
    if (minute === '*') return 'Every minute';
    const step = /^\*\/(\d+)$/.exec(minute);
    if (step) return Number(step[1]) === 1 ? 'Every minute' : `Every ${Number(step[1])} minutes`;
    if (isWithin(minute, 59)) return Number(minute) === 0 ? 'Every hour' : `Every hour at :${twoDigits(minute)}`;
    return null;
  }
  if (!isWithin(minute, 59)) return null;
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep && everyDay) {
    const every = Number(hourStep[1]) === 1 ? 'Every hour' : `Every ${Number(hourStep[1])} hours`;
    return Number(minute) === 0 ? every : `${every} at :${twoDigits(minute)}`;
  }
  if (!isWithin(hour, 23)) return null;
  const time = `${twoDigits(hour)}:${twoDigits(minute)}`;
  if (everyDay) return `Every day at ${time}`;
  if (dayOfMonth === '*') {
    const days = describeDays(dayOfWeek);
    return days ? `${days} at ${time}` : null;
  }
  if (dayOfWeek === '*' && isWithin(dayOfMonth, 31, 1)) return `Monthly on day ${Number(dayOfMonth)} at ${time}`;
  return null;
}

export function formatRelativeTime(value, now = Date.now(), locale = undefined) {
  const difference = Date.parse(value) - now;
  if (!Number.isFinite(difference)) return '';
  const seconds = Math.abs(difference) / 1000;
  if (seconds < 45) return difference >= 0 ? 'in a moment' : 'just now';
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const sign = difference < 0 ? -1 : 1;
  for (const [unit, unitSeconds, limit] of [
    ['minute', 60, 60], ['hour', 3600, 24], ['day', 86400, 30], ['month', 2592000, 12],
  ]) {
    const amount = Math.max(1, Math.round(seconds / unitSeconds));
    if (amount < limit) return format.format(sign * amount, unit);
  }
  return format.format(sign * Math.max(1, Math.round(seconds / 31536000)), 'year');
}

export function formatTimeout(timeoutSeconds) {
  if (!timeoutSeconds) return 'None';
  const minutes = Math.round(timeoutSeconds / 60);
  if (minutes < 60 || minutes % 60) return `${minutes} min`;
  return `${minutes / 60} h`;
}

export function bindScheduledJobs({ document, apiRequest, getCsrfToken, closeSidebar, isMobile, onAuthExpired }) {
  const window = document.defaultView;
  const get = (id) => document.getElementById(id);
  const dialog = get('jobs-dialog');
  const opener = get('jobs-open');
  const title = get('jobs-title');
  const error = get('jobs-error');
  const listView = get('jobs-list-view');
  const list = get('jobs-list');
  const summary = get('jobs-summary');
  const detailView = get('jobs-detail-view');
  const detailTitle = get('jobs-detail-title');
  const detailStatus = get('jobs-detail-status');
  const detailCommand = get('jobs-detail-command');
  const detailMeta = get('jobs-detail-meta');
  const detailRun = get('jobs-detail-run');
  const detailToggle = get('jobs-detail-toggle');
  const detailEdit = get('jobs-detail-edit');
  const detailDelete = get('jobs-detail-delete');
  const runsList = get('jobs-runs');
  const editor = get('jobs-editor');
  const nameInput = get('job-name');
  const commandInput = get('job-command');
  const presetSelect = get('job-preset');
  const scheduleInput = get('job-schedule');
  const timezoneInput = get('job-timezone');
  const timezoneList = get('job-timezones');
  const timeoutInput = get('job-timeout');
  const enabledInput = get('job-enabled');
  const preview = get('job-preview');
  const saveButton = get('job-save');
  const cancelButton = get('job-cancel');
  const newButton = get('jobs-new');
  const runsEmpty = get('jobs-runs-empty');
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  let configured = false;
  let view = 'list';
  let jobs = [];
  let detailJob = null;
  let expandedRunId = null;
  let expandLatestRun = false;
  const logs = new Map();
  let editingJob = null;
  let editorReturn = 'list';
  let busy = false;
  let pollTimer = null;
  let refreshSequence = 0;
  let previewTimer = null;
  let previewSequence = 0;
  let timezonesLoaded = false;

  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action, className, label) => {
    const node = element('button', text, className);
    node.type = 'button';
    node.disabled = busy;
    if (label) node.setAttribute('aria-label', label);
    node.addEventListener('click', action);
    return node;
  };
  const setError = (message = '') => {
    error.textContent = message;
    error.hidden = !message;
    if (message) error.scrollIntoView({ block: 'nearest' });
  };
  const statusBadge = (run) => {
    const { label, tone } = describeRunStatus(run);
    const badge = element('span', label, 'status-badge');
    badge.dataset.tone = tone;
    return badge;
  };
  const scheduleText = (job) => `${describeSchedule(job.schedule) ?? job.schedule} · ${job.timezone}`;
  const mutate = (method, url, body) => apiRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'CSRF-Token': getCsrfToken() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  for (const preset of SCHEDULE_PRESETS) {
    const option = element('option', preset.label);
    option.value = preset.schedule;
    presetSelect.append(option);
  }

  function showView(nextView) {
    view = nextView;
    listView.hidden = view !== 'list';
    detailView.hidden = view !== 'detail';
    editor.hidden = view !== 'editor';
    title.textContent = view === 'editor' ? (editingJob ? 'Edit job' : 'New job') : 'Scheduled jobs';
    // Each view keeps its main action in the shared dialog footer, like the upload dialog.
    newButton.hidden = view !== 'list';
    detailRun.hidden = view !== 'detail';
    cancelButton.hidden = view !== 'editor';
    saveButton.hidden = view !== 'editor';
    summary.textContent = '';
    setError();
  }

  function lastRunText(job) {
    if (job.running) return 'Running now…';
    return job.lastRun ? `Last run ${formatRelativeTime(job.lastRun.startedAt)}` : 'Not run yet';
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer);
    pollTimer = null;
    if (!dialog.open || view === 'editor') return;
    const anyRunning = view === 'detail' ? detailJob?.running : jobs.some((job) => job.running);
    pollTimer = window.setTimeout(refresh, anyRunning ? 2000 : 10000);
  }

  async function refresh() {
    const sequence = ++refreshSequence;
    try {
      if (view === 'detail' && detailJob) {
        const { job } = await apiRequest(`/api/jobs/${detailJob.id}`);
        if (sequence !== refreshSequence || view !== 'detail') return;
        detailJob = job;
        jobs = jobs.map((entry) => (entry.id === job.id ? job : entry));
        if (expandedRunId && !job.runs.some((run) => run.id === expandedRunId)) expandedRunId = null;
        if (expandLatestRun && job.runs[0]) expandedRunId = job.runs[0].id;
        expandLatestRun = false;
        renderDetail();
        await loadExpandedLog();
      } else if (view === 'list') {
        const data = await apiRequest('/api/jobs');
        if (sequence !== refreshSequence || view !== 'list') return;
        jobs = data.jobs;
        renderList();
      }
    } catch (failure) {
      if (sequence !== refreshSequence) return;
      if (failure.status === 404 && view === 'detail') {
        detailJob = null;
        showView('list');
        refresh();
        return;
      }
      setError(failure.message);
    } finally {
      if (sequence === refreshSequence) schedulePoll();
    }
  }

  async function perform(action) {
    if (busy) return;
    busy = true;
    setError();
    renderCurrent();
    try {
      await action();
    } catch (failure) {
      setError(failure.message);
    } finally {
      busy = false;
      renderCurrent();
    }
  }

  function renderCurrent() {
    if (view === 'list') renderList();
    if (view === 'detail' && detailJob) renderDetail();
    saveButton.disabled = busy;
  }

  function runJob(job) {
    return mutate('POST', `/api/jobs/${job.id}/runs`);
  }

  function stopJob(job) {
    return mutate('POST', `/api/jobs/${job.id}/stop`);
  }

  function renderList() {
    list.replaceChildren();
    const running = jobs.filter((job) => job.running).length;
    const paused = jobs.filter((job) => !job.enabled).length;
    summary.textContent = jobs.length
      ? [`${jobs.length} job${jobs.length === 1 ? '' : 's'}`, running && `${running} running`, paused && `${paused} paused`]
        .filter(Boolean).join(' · ')
      : '';
    list.hidden = !jobs.length;
    get('jobs-empty').hidden = jobs.length > 0;
    for (const job of jobs) {
      const item = element('li', '', 'jobs-item');
      item.dataset.enabled = String(job.enabled);
      const row = button('', () => openDetail(job), 'app-list-row jobs-row');
      const body = element('span', '', 'jobs-row-body');
      const heading = element('span', '', 'jobs-row-heading');
      heading.append(element('span', job.name, 'jobs-row-name'), statusBadge(job.running ? { status: 'running' } : job.lastRun));
      const timing = [job.enabled
        ? (job.nextRunAt ? `Next ${formatRelativeTime(job.nextRunAt)}` : 'No upcoming run')
        : 'Paused'];
      if (job.lastRun && job.lastRun.status !== 'running') timing.push(`last ran ${formatRelativeTime(job.lastRun.startedAt)}`);
      body.append(
        heading,
        element('span', scheduleText(job), 'jobs-row-meta'),
        element('span', timing.join(' · '), 'jobs-row-meta'),
      );
      const chevron = element('span', '›', 'app-list-chevron');
      chevron.setAttribute('aria-hidden', 'true');
      row.append(body, chevron);
      row.title = job.nextRunAt && job.enabled ? `Next run: ${formatDateTime(job.nextRunAt)}` : '';
      const quick = job.running
        ? button('Stop', () => perform(async () => { await stopJob(job); await refresh(); }), 'btn-compact jobs-quick', `Stop ${job.name}`)
        : button('Run', () => perform(async () => { await runJob(job); await refresh(); }), 'btn-compact jobs-quick', `Run ${job.name} now`);
      item.append(row, quick);
      list.append(item);
    }
  }

  function renderDetail() {
    const job = detailJob;
    detailTitle.textContent = job.name;
    detailStatus.replaceChildren(statusBadge(job.running ? { status: 'running' } : job.lastRun));
    detailCommand.textContent = job.command;

    detailMeta.replaceChildren();
    const schedule = element('dd');
    const description = describeSchedule(job.schedule);
    if (description) {
      schedule.append(`${description} · ${job.timezone}`, element('code', job.schedule, 'jobs-meta-cron'));
    } else {
      schedule.append(element('code', job.schedule), ` · ${job.timezone}`);
    }
    const next = element('dd', job.enabled
      ? (job.nextRunAt ? `${formatRelativeTime(job.nextRunAt)} · ${formatDateTime(job.nextRunAt)}` : 'No upcoming run')
      : 'Paused');
    for (const [label, value] of [
      ['Schedule', schedule],
      ['Next run', next],
      ['Timeout', element('dd', formatTimeout(job.timeoutSeconds))],
    ]) {
      detailMeta.append(element('dt', label), value);
    }

    detailRun.textContent = job.running ? 'Stop' : 'Run now';
    detailRun.classList.toggle('btn-dialog-primary', !job.running);
    detailRun.setAttribute('aria-label', job.running ? `Stop ${job.name}` : `Run ${job.name} now`);
    detailToggle.textContent = job.enabled ? 'Pause' : 'Resume';
    for (const control of [detailRun, detailToggle, detailEdit, detailDelete]) control.disabled = busy;
    summary.textContent = lastRunText(job);
    renderRuns();
  }

  function renderRuns() {
    const runs = detailJob.runs || [];
    const previousLog = runsList.querySelector('.jobs-log');
    const previousScroll = previousLog && {
      runId: previousLog.dataset.runId,
      top: previousLog.scrollTop,
      atBottom: previousLog.scrollTop + previousLog.clientHeight >= previousLog.scrollHeight - 4,
    };
    runsList.replaceChildren();
    runsEmpty.hidden = runs.length > 0;
    for (const run of runs) {
      const item = element('li', '', 'jobs-run-item');
      const expanded = run.id === expandedRunId;
      const toggle = button('', () => {
        expandedRunId = expanded ? null : run.id;
        renderRuns();
        loadExpandedLog();
      }, 'app-list-row jobs-run');
      toggle.disabled = false;
      toggle.setAttribute('aria-expanded', String(expanded));
      const chevron = element('span', '›', 'app-list-chevron jobs-run-chevron');
      chevron.setAttribute('aria-hidden', 'true');
      const time = element('span', formatDateTime(run.startedAt), 'jobs-run-time');
      time.title = formatRelativeTime(run.startedAt);
      const detail = [
        run.trigger === 'manual' ? 'Manual' : 'Scheduled',
        run.status === 'skipped' ? '' : formatDuration(run.startedAt, run.finishedAt),
        run.truncated ? 'output truncated' : '',
      ].filter(Boolean).join(' · ');
      toggle.append(chevron, time, element('span', detail, 'jobs-run-detail'), statusBadge(run));
      item.append(toggle);
      if (expanded) {
        const output = element('pre', '', 'code-block jobs-log');
        output.id = `jobs-log-${run.id}`;
        output.dataset.runId = run.id;
        output.tabIndex = 0;
        output.setAttribute('aria-label', 'Run output');
        toggle.setAttribute('aria-controls', output.id);
        const cached = logs.get(run.id);
        if (cached?.text) {
          output.textContent = cached.text;
        } else {
          output.classList.add('jobs-log-empty');
          output.textContent = !cached ? 'Loading output…'
            : run.status === 'running' ? 'Waiting for output…' : 'No output.';
        }
        item.append(output);
        if (previousScroll?.runId === run.id) {
          output.scrollTop = previousScroll.atBottom ? output.scrollHeight : previousScroll.top;
        } else if (run.status === 'running') {
          output.scrollTop = output.scrollHeight;
        }
      }
      runsList.append(item);
    }
  }

  async function loadExpandedLog() {
    const job = detailJob;
    const run = job?.runs?.find((entry) => entry.id === expandedRunId);
    if (!run || logs.get(run.id)?.complete) return;
    if (run.status === 'skipped') {
      logs.set(run.id, { text: 'Skipped because the previous run was still running.', complete: true });
      renderRuns();
      return;
    }
    try {
      const response = await window.fetch(`/api/jobs/${job.id}/runs/${run.id}/log`);
      if (response.status === 401) {
        onAuthExpired();
        return;
      }
      if (!response.ok) throw new Error('Unable to load the run output.');
      const text = await response.text();
      logs.set(run.id, { text, complete: run.status !== 'running' });
      if (detailJob === job && expandedRunId === run.id) renderRuns();
    } catch (failure) {
      setError(failure.message);
    }
  }

  function openDetail(job) {
    detailJob = { ...job, runs: job.runs || [] };
    expandedRunId = null;
    expandLatestRun = true;
    logs.clear();
    showView('detail');
    renderDetail();
    get('jobs-detail-back').focus({ preventScroll: true });
    refresh();
  }

  function showList() {
    detailJob = null;
    showView('list');
    renderList();
    refresh();
  }

  function loadTimezones() {
    if (timezonesLoaded) return;
    timezonesLoaded = true;
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    for (const zone of zones.includes('UTC') ? zones : ['UTC', ...zones]) {
      const option = element('option');
      option.value = zone;
      timezoneList.append(option);
    }
  }

  function openEditor(job = null) {
    loadTimezones();
    editingJob = job;
    editorReturn = view === 'detail' ? 'detail' : 'list';
    nameInput.value = job?.name ?? '';
    commandInput.value = job?.command ?? '';
    scheduleInput.value = job?.schedule ?? '0 3 * * *';
    presetSelect.value = presetForSchedule(scheduleInput.value);
    timezoneInput.value = job?.timezone ?? browserTimezone;
    timeoutInput.value = String(Math.round((job?.timeoutSeconds ?? 0) / 60));
    enabledInput.checked = job?.enabled ?? true;
    saveButton.textContent = job ? 'Save changes' : 'Create job';
    window.clearTimeout(pollTimer);
    showView('editor');
    updatePreview(0);
    nameInput.focus({ preventScroll: true });
  }

  function closeEditor() {
    editingJob = null;
    if (editorReturn === 'detail' && detailJob) {
      showView('detail');
      renderDetail();
      refresh();
      detailEdit.focus({ preventScroll: true });
    } else {
      showList();
      newButton.focus({ preventScroll: true });
    }
  }

  function updatePreview(delay = 300) {
    window.clearTimeout(previewTimer);
    const sequence = ++previewSequence;
    const schedule = normalizeSchedule(scheduleInput.value);
    const timezone = timezoneInput.value.trim();
    if (!schedule || !timezone) {
      preview.replaceChildren();
      return;
    }
    previewTimer = window.setTimeout(async () => {
      try {
        const data = await apiRequest(`/api/jobs/schedule-preview?${new URLSearchParams({ schedule, timezone })}`);
        if (sequence !== previewSequence) return;
        const runs = element('ol');
        for (const run of data.nextRuns) runs.append(element('li', formatDateTime(run, data.timezone)));
        const description = describeSchedule(data.schedule);
        preview.dataset.state = 'ok';
        preview.replaceChildren(
          element('p', `${description ? `${description}. ` : ''}Next runs (${data.timezone}):`),
          runs,
        );
      } catch (failure) {
        if (sequence !== previewSequence) return;
        preview.dataset.state = 'error';
        preview.replaceChildren(element('p', failure.message));
      }
    }, delay);
  }

  function open() {
    if (!configured) return;
    closeSidebar();
    if (!dialog.open) dialog.showModal();
    showList();
  }

  opener.addEventListener('click', open);
  get('jobs-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    window.clearTimeout(pollTimer);
    window.clearTimeout(previewTimer);
    refreshSequence += 1;
    (isMobile() ? get('sidebar-toggle') : opener).focus({ preventScroll: true });
  });
  newButton.addEventListener('click', () => openEditor());
  get('jobs-detail-back').addEventListener('click', () => {
    showList();
    newButton.focus({ preventScroll: true });
  });
  detailRun.addEventListener('click', () => perform(async () => {
    const job = detailJob;
    if (job.running) {
      await stopJob(job);
    } else {
      const { run } = await runJob(job);
      expandedRunId = run.id;
      logs.delete(run.id);
    }
    await refresh();
  }));
  detailToggle.addEventListener('click', () => perform(async () => {
    await mutate('PATCH', `/api/jobs/${detailJob.id}`, { enabled: !detailJob.enabled });
    await refresh();
  }));
  detailEdit.addEventListener('click', () => openEditor(detailJob));
  detailDelete.addEventListener('click', () => {
    const job = detailJob;
    const confirmed = window.confirm(
      `Delete the job "${job.name}"? Its run history is removed and a running command is stopped.`,
    );
    if (!confirmed) return;
    perform(async () => {
      await mutate('DELETE', `/api/jobs/${job.id}`);
      showList();
    });
  });
  cancelButton.addEventListener('click', closeEditor);
  presetSelect.addEventListener('change', () => {
    if (presetSelect.value) scheduleInput.value = presetSelect.value;
    updatePreview(0);
  });
  scheduleInput.addEventListener('input', () => {
    presetSelect.value = presetForSchedule(scheduleInput.value);
    updatePreview();
  });
  timezoneInput.addEventListener('input', () => updatePreview());
  editor.addEventListener('submit', (event) => {
    event.preventDefault();
    let payload;
    try {
      payload = jobPayloadFromForm({
        name: nameInput.value,
        command: commandInput.value,
        schedule: scheduleInput.value,
        timezone: timezoneInput.value,
        timeoutMinutes: timeoutInput.value,
        enabled: enabledInput.checked,
      });
    } catch (failure) {
      setError(failure.message);
      return;
    }
    perform(async () => {
      if (editingJob) {
        const { job } = await mutate('PATCH', `/api/jobs/${editingJob.id}`, payload);
        detailJob = { ...detailJob, ...job };
        editorReturn = 'detail';
        closeEditor();
      } else {
        const { job } = await mutate('POST', '/api/jobs', payload);
        editingJob = null;
        openDetail(job);
      }
    });
  });

  return {
    enable() { configured = true; opener.disabled = false; },
  };
}
