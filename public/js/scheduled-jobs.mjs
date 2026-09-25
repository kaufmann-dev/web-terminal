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
  const runsView = get('jobs-runs-view');
  const runsTitle = get('jobs-runs-title');
  const runsList = get('jobs-runs');
  const logOutput = get('jobs-log');
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  let configured = false;
  let view = 'list';
  let jobs = [];
  let editingJob = null;
  let runsJob = null;
  let selectedRunId = null;
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
  const button = (text, action, label) => {
    const node = element('button', text);
    node.type = 'button';
    node.disabled = busy;
    if (label) node.setAttribute('aria-label', label);
    node.addEventListener('click', action);
    return node;
  };
  const setError = (message = '') => {
    error.textContent = message;
    error.hidden = !message;
  };
  const statusBadge = (run) => {
    const { label, tone } = describeRunStatus(run);
    const badge = element('span', label, 'jobs-status');
    badge.dataset.tone = tone;
    return badge;
  };
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
    editor.hidden = view !== 'editor';
    runsView.hidden = view !== 'runs';
    title.textContent = view === 'editor'
      ? (editingJob ? 'Edit job' : 'New job')
      : 'Scheduled jobs';
    setError();
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer);
    pollTimer = null;
    if (!dialog.open || view === 'editor') return;
    const anyRunning = jobs.some((job) => job.running);
    pollTimer = window.setTimeout(refresh, anyRunning ? 2000 : 10000);
  }

  async function refresh() {
    const sequence = ++refreshSequence;
    try {
      if (view === 'runs' && runsJob) {
        const { job } = await apiRequest(`/api/jobs/${runsJob.id}`);
        if (sequence !== refreshSequence) return;
        runsJob = job;
        jobs = jobs.map((entry) => (entry.id === job.id ? job : entry));
        renderRuns();
        const selected = job.runs.find((run) => run.id === selectedRunId);
        // Reload the output until it has been read after the run finished.
        if (selected && (logOutput.dataset.runId !== selected.id || logOutput.dataset.complete !== 'true')) {
          await loadLog(selected);
        }
      } else {
        const data = await apiRequest('/api/jobs');
        if (sequence !== refreshSequence) return;
        jobs = data.jobs;
        renderList();
      }
    } catch (failure) {
      if (sequence !== refreshSequence) return;
      if (failure.status === 404 && view === 'runs') {
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
    if (view === 'runs') renderRuns();
    saveButton.disabled = busy;
  }

  function renderList() {
    list.replaceChildren();
    const running = jobs.filter((job) => job.running).length;
    summary.textContent = jobs.length
      ? `${jobs.length} job${jobs.length === 1 ? '' : 's'}${running ? `, ${running} running` : ''}.`
      : 'No scheduled jobs yet. Jobs run a Bash command in the background on a cron schedule.';
    for (const job of jobs) {
      const item = element('li', '', 'jobs-item');
      item.dataset.enabled = String(job.enabled);
      const heading = element('div', '', 'jobs-item-heading');
      const name = element('span', job.name, 'jobs-item-name');
      name.title = job.name;
      heading.append(name, statusBadge(job.running ? { status: 'running' } : job.lastRun));

      const schedule = element('p', '', 'jobs-item-meta');
      schedule.append(element('code', job.schedule), ` · ${job.timezone}`);
      const next = element('p', job.enabled
        ? `Next run: ${job.nextRunAt ? formatDateTime(job.nextRunAt) : 'none'}`
        : 'Paused', 'jobs-item-meta');
      const command = element('code', job.command.split('\n')[0], 'jobs-item-command');
      command.title = job.command;

      const actions = element('div', '', 'jobs-item-actions');
      actions.append(
        job.running
          ? button('Stop', () => perform(async () => {
            await mutate('POST', `/api/jobs/${job.id}/stop`);
            await refresh();
          }), `Stop ${job.name}`)
          : button('Run now', () => perform(async () => {
            await mutate('POST', `/api/jobs/${job.id}/runs`);
            await refresh();
          }), `Run ${job.name} now`),
        button(job.enabled ? 'Pause' : 'Resume', () => perform(async () => {
          await mutate('PATCH', `/api/jobs/${job.id}`, { enabled: !job.enabled });
          await refresh();
        }), `${job.enabled ? 'Pause' : 'Resume'} ${job.name}`),
        button('Edit', () => openEditor(job), `Edit ${job.name}`),
        button('History', () => openRuns(job), `Show run history for ${job.name}`),
        button('Delete', () => {
          const confirmed = window.confirm(
            `Delete the job "${job.name}"? Its run history is removed and a running command is stopped.`,
          );
          if (!confirmed) return;
          perform(async () => {
            await mutate('DELETE', `/api/jobs/${job.id}`);
            await refresh();
          });
        }, `Delete ${job.name}`),
      );
      item.append(heading, command, schedule, next, actions);
      list.append(item);
    }
  }

  function renderRuns() {
    if (!runsJob) return;
    runsTitle.textContent = runsJob.name;
    runsList.replaceChildren();
    if (!runsJob.runs?.length) {
      runsList.append(element('li', 'This job has not run yet.', 'jobs-muted'));
      logOutput.hidden = true;
      return;
    }
    for (const run of runsJob.runs) {
      const item = element('li');
      const entry = button('', () => {
        selectedRunId = run.id;
        renderRuns();
        loadLog(run);
      });
      entry.disabled = false;
      entry.className = 'jobs-run';
      entry.setAttribute('aria-pressed', String(run.id === selectedRunId));
      const when = element('span', formatDateTime(run.startedAt), 'jobs-run-time');
      const detail = element('span', [
        run.trigger === 'manual' ? 'Manual' : 'Scheduled',
        run.status === 'skipped' ? '' : formatDuration(run.startedAt, run.finishedAt),
        run.truncated ? 'output truncated' : '',
      ].filter(Boolean).join(' · '), 'jobs-muted');
      entry.append(when, statusBadge(run), detail);
      item.append(entry);
      runsList.append(item);
    }
    logOutput.hidden = !selectedRunId;
  }

  async function loadLog(run) {
    if (!run) return;
    if (run.status === 'skipped') {
      logOutput.dataset.runId = run.id;
      logOutput.dataset.complete = 'true';
      logOutput.textContent = 'This run was skipped because the previous run was still running.';
      return;
    }
    try {
      const response = await window.fetch(`/api/jobs/${runsJob.id}/runs/${run.id}/log`);
      if (response.status === 401) {
        onAuthExpired();
        return;
      }
      if (!response.ok) throw new Error('Unable to load the run output.');
      const text = await response.text();
      if (selectedRunId !== run.id) return;
      const atBottom = logOutput.scrollTop + logOutput.clientHeight >= logOutput.scrollHeight - 4;
      logOutput.dataset.runId = run.id;
      logOutput.dataset.complete = String(run.status !== 'running');
      logOutput.textContent = text || (run.status === 'running' ? 'Waiting for output…' : 'No output.');
      if (atBottom) logOutput.scrollTop = logOutput.scrollHeight;
    } catch (failure) {
      setError(failure.message);
    }
  }

  function openRuns(job) {
    runsJob = { ...job, runs: [] };
    selectedRunId = null;
    logOutput.textContent = '';
    delete logOutput.dataset.runId;
    showView('runs');
    renderRuns();
    get('jobs-runs-back').focus({ preventScroll: true });
    refresh().then(() => {
      const firstRun = runsJob?.runs?.[0];
      if (!selectedRunId && firstRun) {
        selectedRunId = firstRun.id;
        renderRuns();
        loadLog(firstRun);
      }
    });
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
        preview.dataset.state = 'ok';
        preview.replaceChildren(element('p', `Next runs (${data.timezone}):`), runs);
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
    showView('list');
    renderList();
    refresh();
  }

  opener.addEventListener('click', open);
  get('jobs-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    window.clearTimeout(pollTimer);
    window.clearTimeout(previewTimer);
    refreshSequence += 1;
    (isMobile() ? get('sidebar-toggle') : opener).focus({ preventScroll: true });
  });
  get('jobs-new').addEventListener('click', () => openEditor());
  get('job-cancel').addEventListener('click', () => {
    showView('list');
    refresh();
  });
  get('jobs-runs-back').addEventListener('click', () => {
    runsJob = null;
    showView('list');
    renderList();
    refresh();
  });
  get('jobs-runs-refresh').addEventListener('click', () => refresh());
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
        await mutate('PATCH', `/api/jobs/${editingJob.id}`, payload);
      } else {
        await mutate('POST', '/api/jobs', payload);
      }
      editingJob = null;
      showView('list');
      await refresh();
      get('jobs-new').focus({ preventScroll: true });
    });
  });

  return {
    enable() { configured = true; opener.disabled = false; },
  };
}
