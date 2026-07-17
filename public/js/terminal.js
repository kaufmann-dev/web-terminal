(async () => {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('/vendor/xterm/xterm.mjs'),
    import('/vendor/xterm/addon-fit.mjs'),
  ]);
  await Promise.all([
    document.fonts.load('400 14px "JetBrains Mono"'),
    document.fonts.load('600 14px "JetBrains Mono"'),
  ]);

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
  const terminalHost = document.getElementById('terminal-host');
  const connectionStatus = document.getElementById('connection-status');
  const terminalPlaceholder = document.getElementById('terminal-placeholder');
  const terminalPlaceholderMessage = document.getElementById('terminal-placeholder-message');

  const sessionNamePattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const refreshIntervalMs = 15000;
  const noReconnectCloseCodes = new Set([4000, 4001, 4002, 4003, 4004]);

  let csrfToken = '';
  let sessions = [];
  let activeSessionName = null;
  let activeController = null;
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

  function setConnectionStatus(message, isError = false) {
    connectionStatus.textContent = message;
    connectionStatus.classList.toggle('is-error', isError);
    connectionStatus.hidden = !message;
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

  class TerminalController {
    constructor(sessionName, onSessionExit) {
      this.sessionName = sessionName;
      this.onSessionExit = onSessionExit;
      this.socket = null;
      this.disposed = false;
      this.ready = false;
      this.reconnectDelay = 250;
      this.reconnectTimer = null;
      this.reconnectInProgress = false;
      this.reconnectRequested = false;
      this.resizeTimer = null;
      this.writeQueue = Promise.resolve();

      this.terminal = new Terminal({
        cursorBlink: true,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 14,
        fontWeight: '400',
        fontWeightBold: '600',
        lineHeight: 1.2,
        scrollback: 10000,
        theme: {
          background: '#0b0c10',
          foreground: '#d5d9df',
          cursor: '#66fcf1',
          selectionBackground: '#285f5c',
        },
      });
      this.fitAddon = new FitAddon();
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.open(terminalHost);

      this.inputDisposable = this.terminal.onData((data) => {
        if (this.ready) {
          this.send({ type: 'input', data });
        }
      });
      this.binaryDisposable = this.terminal.onBinary((data) => {
        if (this.ready) {
          this.send({ type: 'binary', data: window.btoa(data) });
        }
      });
      this.resizeObserver = new ResizeObserver(() => {
        window.clearTimeout(this.resizeTimer);
        this.resizeTimer = window.setTimeout(() => this.fitAndNotify(), 100);
      });
      this.resizeObserver.observe(terminalHost);
      terminalHost.addEventListener('click', this.focusTerminal);

      this.fitAndNotify();
      this.connect();
    }

    focusTerminal = () => {
      if (this.ready) {
        this.terminal.focus();
      }
    };

    dimensions() {
      this.fitAddon.fit();
      const cols = Math.min(500, Math.max(2, this.terminal.cols));
      const rows = Math.min(200, Math.max(1, this.terminal.rows));
      if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
        this.terminal.resize(cols, rows);
      }
      return { cols, rows };
    }

    fitAndNotify() {
      if (this.disposed || !terminalHost.isConnected || terminalHost.hidden) {
        return;
      }
      let size;
      try {
        size = this.dimensions();
      } catch (err) {
        return;
      }
      if (this.ready) {
        this.send({ type: 'resize', ...size });
      }
    }

    connect() {
      if (this.disposed) {
        return;
      }

      this.ready = false;
      setConnectionStatus('Connecting…');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws/terminal?session=${encodeURIComponent(this.sessionName)}`;
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.addEventListener('open', () => {
        if (this.socket !== socket || this.disposed) {
          socket.close(1000, 'Terminal changed.');
          return;
        }
        this.send({ type: 'attach', ...this.dimensions() });
        setConnectionStatus('Restoring terminal…');
      });

      socket.addEventListener('message', (event) => {
        if (this.socket !== socket || this.disposed) {
          return;
        }
        if (typeof event.data !== 'string') {
          const bytes = new Uint8Array(event.data);
          this.writeQueue = this.writeQueue.then(() => new Promise((resolve) => {
            this.terminal.write(bytes, resolve);
          }));
          return;
        }

        let message;
        try {
          message = JSON.parse(event.data);
        } catch (err) {
          socket.close(4000, 'Invalid server message.');
          return;
        }

        if (message.type === 'snapshot') {
          this.ready = false;
          this.writeQueue = this.writeQueue.then(() => {
            this.terminal.reset();
          });
          return;
        }
        if (message.type === 'ready') {
          this.writeQueue = this.writeQueue.then(() => {
            if (this.socket !== socket || this.disposed) {
              return;
            }
            this.ready = true;
            this.reconnectDelay = 250;
            setConnectionStatus('');
            this.terminal.focus();
          });
          return;
        }
        if (message.type === 'exit') {
          this.ready = false;
          setConnectionStatus('Terminal process exited.', true);
          this.onSessionExit();
          return;
        }
        if (message.type === 'error') {
          setConnectionStatus(message.message || 'Terminal connection error.', true);
        }
      });

      socket.addEventListener('close', (event) => {
        if (this.socket !== socket || this.disposed) {
          return;
        }
        this.socket = null;
        this.ready = false;

        if (event.code === 4001) {
          setConnectionStatus('This session was opened in another tab.', true);
          return;
        }
        if (event.code === 4002 || event.code === 4004) {
          setConnectionStatus('Your login session has ended.', true);
          window.location.href = '/';
          return;
        }
        if (event.code === 4003) {
          setConnectionStatus('Terminal session ended.', true);
          this.onSessionExit();
          return;
        }
        if (noReconnectCloseCodes.has(event.code)) {
          setConnectionStatus(event.reason || 'Terminal connection closed.', true);
          return;
        }

        setConnectionStatus('Connection lost. Reconnecting…', true);
        this.scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        if (this.socket === socket && !this.disposed) {
          setConnectionStatus('Terminal connection error.', true);
        }
      });
    }

    scheduleReconnect() {
      window.clearTimeout(this.reconnectTimer);
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(5000, this.reconnectDelay * 2);
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.attemptReconnect();
      }, delay);
    }

    async attemptReconnect() {
      if (this.disposed || this.socket || this.reconnectInProgress) {
        return;
      }

      this.reconnectInProgress = true;
      let shouldRetry = false;
      try {
        const data = await apiRequest('/api/terminal-sessions');
        if (this.disposed) {
          return;
        }
        if (!(data.sessions || []).some((session) => session.name === this.sessionName)) {
          setConnectionStatus('Terminal session ended.', true);
          this.onSessionExit();
          return;
        }
        this.connect();
      } catch (err) {
        shouldRetry = !(err instanceof ApiError) || err.status !== 401;
      } finally {
        this.reconnectInProgress = false;
        const retryImmediately = this.reconnectRequested;
        this.reconnectRequested = false;
        if (shouldRetry && !this.disposed && !this.socket) {
          if (retryImmediately) {
            this.attemptReconnect();
          } else {
            this.scheduleReconnect();
          }
        }
      }
    }

    reconnectNow() {
      if (this.disposed || this.socket) {
        return;
      }
      if (this.reconnectInProgress) {
        this.reconnectRequested = true;
        return;
      }
      if (this.reconnectTimer === null) {
        return;
      }
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.attemptReconnect();
    }

    send(message) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(message));
      }
    }

    dispose() {
      if (this.disposed) {
        return;
      }
      this.disposed = true;
      this.ready = false;
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectRequested = false;
      window.clearTimeout(this.resizeTimer);
      this.resizeObserver.disconnect();
      terminalHost.removeEventListener('click', this.focusTerminal);
      this.inputDisposable.dispose();
      this.binaryDisposable.dispose();
      if (this.socket && (this.socket.readyState === WebSocket.CONNECTING
        || this.socket.readyState === WebSocket.OPEN)) {
        this.socket.close(1000, 'Terminal changed.');
      }
      this.terminal.dispose();
      terminalHost.replaceChildren();
    }
  }

  function disposeActiveController() {
    if (activeController) {
      activeController.dispose();
      activeController = null;
    }
  }

  function showEmptyTerminal(message) {
    disposeActiveController();
    activeSessionName = null;
    activeSessionLabel.textContent = '';
    terminalHost.hidden = true;
    setConnectionStatus('');
    terminalPlaceholderMessage.textContent = message;
    terminalPlaceholder.hidden = false;
    updateTerminalUrl(null);
  }

  function selectSession(name, { closeSidebar = false } = {}) {
    const selectedSession = sessions.find((session) => session.name === name);
    if (!selectedSession) {
      return;
    }

    if (activeSessionName !== name || !activeController) {
      disposeActiveController();
      activeSessionName = name;
      activeSessionLabel.textContent = `/ ${name}`;
      terminalPlaceholder.hidden = true;
      terminalHost.hidden = false;
      activeController = new TerminalController(name, () => {
        window.setTimeout(() => {
          refreshSessions().catch((err) => setStatus(err.message, true));
        }, 0);
      });
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
    details.textContent = `${session.attachedClients} ${clientLabel}`;

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

  function reconnectActiveSessionNow() {
    if (activeController) {
      activeController.reconnectNow();
    }
  }

  window.addEventListener('online', reconnectActiveSessionNow);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      reconnectActiveSessionNow();
    }
  });

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

  await initialize();
})().catch((err) => {
  const status = document.getElementById('session-status');
  const placeholder = document.getElementById('terminal-placeholder-message');
  status.textContent = err.message || 'Unable to initialize the terminal.';
  status.classList.add('is-error');
  placeholder.textContent = 'Terminal initialization failed.';
});
