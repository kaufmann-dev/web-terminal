(() => {
  const logoutBtn = document.getElementById('logout-btn');
  const sidebar = document.getElementById('session-sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebarClose = document.getElementById('sidebar-close');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const sessionForm = document.getElementById('session-form');
  const sessionNameInput = document.getElementById('session-name');
  const createSessionBtn = document.getElementById('create-session-btn');
  const sessionList = document.getElementById('session-list');
  const sessionStatus = document.getElementById('session-status');
  const activeSessionLabel = document.getElementById('active-session-label');
  const terminalFrame = document.getElementById('ttyd-frame');
  const terminalPlaceholder = document.getElementById('terminal-placeholder');
  const terminalPlaceholderMessage = document.getElementById('terminal-placeholder-message');

  const sessionNamePattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const refreshIntervalMs = 15000;

  let csrfToken = '';
  let sessions = [];
  let activeSessionName = null;
  let mutationInProgress = false;

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function apiRequest(url, options = {}) {
    const response = await fetch(url, options);

    if (response.status === 401) {
      window.location.href = '/';
      throw new ApiError('Your login session has expired.', 401);
    }

    let data = null;
    if (response.status !== 204) {
      try {
        data = await response.json();
      } catch (err) {
        data = null;
      }
    }

    if (!response.ok) {
      throw new ApiError(data && data.error ? data.error : 'Request failed.', response.status);
    }

    return data;
  }

  function setStatus(message, isError = false) {
    sessionStatus.textContent = message;
    sessionStatus.classList.toggle('is-error', isError);
  }

  function setSidebarOpen(open) {
    document.body.classList.toggle('sessions-open', open);
    sidebarToggle.setAttribute('aria-expanded', String(open));
    sidebarToggle.title = open ? 'Hide terminal sessions' : 'Show terminal sessions';
  }

  function updateTerminalUrl(name) {
    const url = new URL(window.location.href);
    if (name) {
      url.searchParams.set('session', name);
    } else {
      url.searchParams.delete('session');
    }
    window.history.replaceState({}, '', url);
  }

  function showEmptyTerminal(message) {
    activeSessionName = null;
    activeSessionLabel.textContent = '';
    terminalFrame.hidden = true;
    terminalFrame.removeAttribute('src');
    terminalFrame.dataset.session = '';
    terminalPlaceholderMessage.textContent = message;
    terminalPlaceholder.hidden = false;
    updateTerminalUrl(null);
  }

  function selectSession(name, { closeSidebar = false } = {}) {
    const selectedSession = sessions.find((session) => session.name === name);
    if (!selectedSession) {
      return;
    }

    activeSessionName = name;
    activeSessionLabel.textContent = `/ ${name}`;
    terminalPlaceholder.hidden = true;
    terminalFrame.hidden = false;
    terminalFrame.title = `Terminal session ${name}`;

    if (terminalFrame.dataset.session !== name) {
      terminalFrame.dataset.session = name;
      terminalFrame.src = `/ttyd/?arg=${encodeURIComponent(name)}`;
    }

    updateTerminalUrl(name);
    renderSessions();
    if (closeSidebar) {
      setSidebarOpen(false);
    }
  }

  function buildSessionRow(session) {
    const row = document.createElement('div');
    row.className = 'session-row';
    if (session.name === activeSessionName) {
      row.classList.add('is-active');
    }

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'session-open';
    openButton.setAttribute('aria-pressed', String(session.name === activeSessionName));
    openButton.title = `Open ${session.name}`;

    const name = document.createElement('span');
    name.className = 'session-row-name';
    name.textContent = session.name;

    const details = document.createElement('span');
    details.className = 'session-row-details';
    const clientLabel = session.attachedClients === 1 ? 'client' : 'clients';
    details.textContent = `${session.attachedClients} ${clientLabel} · ${session.windows} windows`;

    openButton.append(name, details);
    openButton.addEventListener('click', () => selectSession(session.name, { closeSidebar: true }));

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'session-delete';
    deleteButton.title = `Delete ${session.name}`;
    deleteButton.setAttribute('aria-label', `Delete terminal session ${session.name}`);
    deleteButton.textContent = '×';
    deleteButton.disabled = mutationInProgress;
    deleteButton.addEventListener('click', () => deleteSession(session.name));

    row.append(openButton, deleteButton);
    return row;
  }

  function renderSessions() {
    sessionList.replaceChildren(...sessions.map(buildSessionRow));
    if (sessions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'session-list-empty';
      empty.textContent = 'No sessions yet.';
      sessionList.append(empty);
    }
  }

  async function fetchSessions() {
    const data = await apiRequest('/api/terminal-sessions');
    sessions = data.sessions || [];
    return sessions;
  }

  async function refreshSessions({ createDefault = false, preferredSession = null } = {}) {
    await fetchSessions();

    if (createDefault && sessions.length === 0) {
      try {
        await apiRequest('/api/terminal-sessions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ name: 'main' }),
        });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) {
          throw err;
        }
      }
      await fetchSessions();
    }

    renderSessions();

    const requestedSession = preferredSession || activeSessionName;
    if (requestedSession && sessions.some((session) => session.name === requestedSession)) {
      selectSession(requestedSession);
      return;
    }

    if (sessions.length > 0) {
      selectSession(sessions[0].name);
      return;
    }

    showEmptyTerminal('Create a session to open a terminal.');
  }

  async function createSession(event) {
    event.preventDefault();
    const name = sessionNameInput.value.trim();

    if (!sessionNamePattern.test(name)) {
      setStatus('Use 1-32 lowercase letters, numbers, or hyphens.', true);
      sessionNameInput.focus();
      return;
    }

    mutationInProgress = true;
    createSessionBtn.disabled = true;
    setStatus(`Creating ${name}…`);
    renderSessions();

    try {
      await apiRequest('/api/terminal-sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ name }),
      });
      sessionNameInput.value = '';
      await refreshSessions({ preferredSession: name });
      setStatus(`Created ${name}.`);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      mutationInProgress = false;
      createSessionBtn.disabled = false;
      renderSessions();
    }
  }

  async function deleteSession(name) {
    const confirmed = window.confirm(
      `Delete “${name}”? All processes running in this session will stop.`,
    );
    if (!confirmed) {
      return;
    }

    mutationInProgress = true;
    createSessionBtn.disabled = true;
    setStatus(`Deleting ${name}…`);
    renderSessions();

    try {
      await apiRequest(`/api/terminal-sessions/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: { 'CSRF-Token': csrfToken },
      });

      if (activeSessionName === name) {
        showEmptyTerminal('Selecting another terminal session…');
      }
      await refreshSessions();
      setStatus(`Deleted ${name}.`);
    } catch (err) {
      setStatus(err.message, true);
      await refreshSessions().catch(() => {});
    } finally {
      mutationInProgress = false;
      createSessionBtn.disabled = false;
      renderSessions();
    }
  }

  async function logout() {
    logoutBtn.disabled = true;
    try {
      const response = await fetch('/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': csrfToken,
        },
      });
      if (response.ok) {
        window.location.href = '/';
        return;
      }
      setStatus('Logout failed. Please try again.', true);
    } catch (err) {
      setStatus('Logout failed. Please try again.', true);
    }
    logoutBtn.disabled = false;
  }

  async function initialize() {
    try {
      const tokenResponse = await fetch('/csrf-token');
      const tokenData = await tokenResponse.json();
      csrfToken = tokenData.csrfToken || '';
      if (!csrfToken) {
        throw new Error('Unable to initialize request protection.');
      }

      const requestedSession = new URL(window.location.href).searchParams.get('session');
      await refreshSessions({ createDefault: true, preferredSession: requestedSession });
      setStatus('');
    } catch (err) {
      setStatus(err.message || 'Unable to load terminal sessions.', true);
      showEmptyTerminal('Terminal sessions are unavailable.');
    }
  }

  sidebarToggle.addEventListener('click', () => {
    setSidebarOpen(!document.body.classList.contains('sessions-open'));
  });
  sidebarClose.addEventListener('click', () => setSidebarOpen(false));
  sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));
  sessionForm.addEventListener('submit', createSession);
  logoutBtn.addEventListener('click', logout);

  window.addEventListener('focus', () => {
    if (!mutationInProgress) {
      refreshSessions().catch((err) => setStatus(err.message, true));
    }
  });

  window.setInterval(() => {
    if (!document.hidden && !mutationInProgress) {
      refreshSessions().catch((err) => setStatus(err.message, true));
    }
  }, refreshIntervalMs);

  initialize();
})();
