(async () => {
  const desktopTerminalFontSize = 14;
  const mobileTerminalFontSize = 12;
  const [
    { Terminal },
    { FitAddon },
    {
      MobileTerminalFocusManager,
      TouchControlActivationGuard,
      TouchScrollGesture,
      encodeMobileTerminalKey,
      mobileModifiersNeedKeyboard,
      transformMobileTerminalInput,
    },
    { readClipboardContent },
  ] = await Promise.all([
    import('/vendor/xterm/xterm.mjs'),
    import('/vendor/xterm/addon-fit.mjs'),
    import('/static/js/terminal-input.mjs'),
    import('/static/js/clipboard-reader.mjs'),
  ]);
  await Promise.all([
    document.fonts.load(`400 ${desktopTerminalFontSize}px "JetBrains Mono"`),
    document.fonts.load(`600 ${desktopTerminalFontSize}px "JetBrains Mono"`),
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
  const clipboardStatus = document.getElementById('clipboard-status');
  const terminalPlaceholder = document.getElementById('terminal-placeholder');
  const terminalPlaceholderMessage = document.getElementById('terminal-placeholder-message');
  const mobileTerminalControls = document.getElementById('mobile-terminal-controls');
  const mobileTerminalButtons = mobileTerminalControls.querySelectorAll(
    '[data-terminal-control]',
  );
  const touchControlActivation = new TouchControlActivationGuard();
  const mobileLayoutQuery = window.matchMedia('(max-width: 720px)');

  const sessionNamePattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const refreshIntervalMs = 15000;
  const noReconnectCloseCodes = new Set([4000, 4001, 4002, 4003, 4004]);

  let csrfToken = '';
  let sessions = [];
  let activeSessionName = null;
  let activeController = null;
  let mutationInProgress = false;
  let clipboardStatusTimer = null;

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

  function setClipboardStatus(message, isError = false, clearAfterMs = 0) {
    window.clearTimeout(clipboardStatusTimer);
    clipboardStatusTimer = null;
    clipboardStatus.textContent = message;
    clipboardStatus.classList.toggle('is-error', isError);
    clipboardStatus.hidden = !message;
    if (message && clearAfterMs > 0) {
      clipboardStatusTimer = window.setTimeout(() => setClipboardStatus(''), clearAfterMs);
    }
  }

  function updateMobileTerminalControls() {
    const hasActiveTerminal = Boolean(activeController && !activeController.disposed);
    const controlsEnabled = hasActiveTerminal && activeController.ready;
    mobileTerminalControls.hidden = !hasActiveTerminal;
    for (const button of mobileTerminalButtons) {
      button.disabled = !controlsEnabled;
      const modifier = button.dataset.terminalModifier;
      if (modifier) {
        button.setAttribute(
          'aria-pressed',
          String(Boolean(hasActiveTerminal && activeController.mobileModifiers[modifier])),
        );
      }
    }
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
      this.suspended = document.hidden;
      this.reconnectDelay = 250;
      this.reconnectTimer = null;
      this.reconnectInProgress = false;
      this.reconnectRequested = false;
      this.resizeTimer = null;
      this.writeQueue = Promise.resolve();
      this.imageUploadController = null;
      this.clipboardOperationQueue = Promise.resolve();
      this.programmaticInputDepth = 0;
      this.mobileModifiers = { ctrl: false, shift: false, alt: false };
      this.touchScrollGesture = new TouchScrollGesture();
      this.suppressTouchScrollClick = false;
      this.touchScrollClickTimer = null;

      this.terminal = new Terminal({
        cursorBlink: true,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: mobileLayoutQuery.matches
          ? mobileTerminalFontSize
          : desktopTerminalFontSize,
        fontWeight: '400',
        fontWeightBold: '600',
        lineHeight: 1,
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
      this.terminalElement = this.terminal.element;
      this.mobileFocus = new MobileTerminalFocusManager(
        this.terminal,
        () => document.activeElement,
      );

      this.inputDisposable = this.terminal.onData((data) => {
        if (this.mobileFocus.shouldSuppressInput(data)) {
          return;
        }
        if (this.ready) {
          const transformedInput = transformMobileTerminalInput(
            data,
            this.programmaticInputDepth > 0 ? {} : this.mobileModifiers,
          );
          this.send({ type: 'input', data: transformedInput.data });
          if (transformedInput.consumed) {
            this.clearMobileModifiers();
            this.closeMobileKeyboard();
          }
        }
      });
      this.binaryDisposable = this.terminal.onBinary((data) => {
        if (this.ready) {
          this.send({ type: 'binary', data: window.btoa(data) });
        }
      });
      this.selectionDisposable = this.terminal.onSelectionChange(this.copySelection);
      this.resizeObserver = new ResizeObserver(() => {
        window.clearTimeout(this.resizeTimer);
        this.resizeTimer = window.setTimeout(() => this.fitAndNotify(), 100);
      });
      this.resizeObserver.observe(terminalHost);
      terminalHost.addEventListener('click', this.focusTerminal);
      this.terminalElement.addEventListener('keydown', this.handleBrowserPasteKeyDown, true);
      this.terminalElement.addEventListener('paste', this.handlePaste, true);
      this.terminalElement.addEventListener(
        'pointerdown',
        this.handleTouchScrollPointerDown,
      );
      this.terminalElement.addEventListener(
        'pointermove',
        this.handleTouchScrollPointerMove,
        { passive: false },
      );
      this.terminalElement.addEventListener('pointerup', this.handleTouchScrollPointerUp);
      this.terminalElement.addEventListener('pointercancel', this.handleTouchScrollPointerCancel);

      this.fitAndNotify();
      if (!this.suspended) {
        this.connect();
      }
    }

    focusTerminal = (event) => {
      if (this.suppressTouchScrollClick) {
        this.clearTouchScrollClickSuppression();
        event.preventDefault();
        return;
      }
      if (this.ready) {
        this.terminal.focus();
      }
    };

    openMobileKeyboard = () => {
      this.mobileFocus.openKeyboard();
    };

    closeMobileKeyboard = () => {
      this.mobileFocus.closeKeyboard();
    };

    runWithMobileModifiersBypassed = (callback) => {
      this.programmaticInputDepth += 1;
      try {
        return callback();
      } finally {
        this.programmaticInputDepth -= 1;
      }
    };

    inputTerminalProgrammatically = (data) => {
      this.runWithMobileModifiersBypassed(() => this.terminal.input(data));
    };

    pasteTerminalProgrammatically = (text) => {
      this.runWithMobileModifiersBypassed(() => this.terminal.paste(text));
    };

    resetMobileInput = ({ closeKeyboard = false } = {}) => {
      this.clearMobileModifiers();
      if (closeKeyboard) {
        this.closeMobileKeyboard();
      }
    };

    clearTouchScrollClickSuppression = () => {
      window.clearTimeout(this.touchScrollClickTimer);
      this.touchScrollClickTimer = null;
      this.suppressTouchScrollClick = false;
    };

    armTouchScrollClickSuppression = () => {
      this.clearTouchScrollClickSuppression();
      this.suppressTouchScrollClick = true;
      this.touchScrollClickTimer = window.setTimeout(() => {
        this.touchScrollClickTimer = null;
        this.suppressTouchScrollClick = false;
      }, 400);
    };

    releaseTouchScrollPointer = (pointerId) => {
      if (pointerId === null
        || typeof this.terminalElement.hasPointerCapture !== 'function'
        || typeof this.terminalElement.releasePointerCapture !== 'function') {
        return;
      }
      try {
        if (this.terminalElement.hasPointerCapture(pointerId)) {
          this.terminalElement.releasePointerCapture(pointerId);
        }
      } catch (err) {
        // Pointer capture can already be gone after browser gesture cancellation.
      }
    };

    cancelTouchScroll = () => {
      const pointerId = this.touchScrollGesture.activePointerId;
      this.releaseTouchScrollPointer(pointerId);
      this.touchScrollGesture.cancel();
      this.clearTouchScrollClickSuppression();
    };

    handleTouchScrollPointerDown = (event) => {
      if (event.defaultPrevented
        || !mobileLayoutQuery.matches
        || event.pointerType !== 'touch'
        || !event.isPrimary) {
        return;
      }

      this.clearTouchScrollClickSuppression();
      if (!this.touchScrollGesture.start(event.pointerId, event.clientX, event.clientY)) {
        return;
      }
      if (typeof this.terminalElement.setPointerCapture === 'function') {
        try {
          this.terminalElement.setPointerCapture(event.pointerId);
        } catch (err) {
          // Pointer capture is optional; document-level targeting still continues the gesture.
        }
      }
    };

    handleTouchScrollPointerMove = (event) => {
      if (event.pointerType !== 'touch') {
        return;
      }

      const terminalHeight = this.terminalElement.getBoundingClientRect().height;
      const pixelsPerLine = terminalHeight / this.terminal.rows;
      const result = this.touchScrollGesture.move(
        event.pointerId,
        event.clientX,
        event.clientY,
        pixelsPerLine,
      );
      if (!result.recognized) {
        return;
      }

      event.preventDefault();
      const activeBuffer = this.terminal.buffer.active;
      if (result.lines !== 0 && activeBuffer.type === 'normal' && activeBuffer.baseY > 0) {
        this.terminal.scrollLines(result.lines);
      }
    };

    handleTouchScrollPointerUp = (event) => {
      this.releaseTouchScrollPointer(event.pointerId);
      const outcome = this.touchScrollGesture.end(event.pointerId);
      if (outcome === 'gesture') {
        event.preventDefault();
        this.armTouchScrollClickSuppression();
        return;
      }
      if (outcome === 'tap' && this.ready) {
        this.mobileFocus.focusFromTerminalTap();
      }
    };

    handleTouchScrollPointerCancel = (event) => {
      this.releaseTouchScrollPointer(event.pointerId);
      this.touchScrollGesture.cancel(event.pointerId);
    };

    handleBrowserPasteKeyDown = (event) => {
      if (!event.ctrlKey
        || event.shiftKey
        || event.altKey
        || event.metaKey
        || event.key.toLowerCase() !== 'v') {
        return;
      }
      event.stopPropagation();
    };

    handleMobileControl = (action, { manageKeyboard = true } = {}) => {
      if (this.disposed || !this.ready) {
        return;
      }
      const modifier = {
        'modifier-alt': 'alt',
        'modifier-ctrl': 'ctrl',
        'modifier-shift': 'shift',
      }[action];
      if (modifier) {
        this.toggleMobileModifier(modifier, { manageKeyboard });
        return;
      }
      if (action === 'paste') {
        const hadModifiers = this.clearMobileModifiers();
        if (manageKeyboard && hadModifiers) {
          this.closeMobileKeyboard();
        }
        this.requestClipboardPaste();
        return;
      }
      if (this.mobileModifiers.shift
        && (action === 'page-up' || action === 'page-down')) {
        const hadModifiers = this.clearMobileModifiers();
        this.terminal.scrollPages(action === 'page-up' ? -1 : 1);
        if (manageKeyboard && hadModifiers) {
          this.closeMobileKeyboard();
        }
        return;
      }

      const input = encodeMobileTerminalKey(
        action,
        this.terminal.modes.applicationCursorKeysMode,
        this.mobileModifiers,
      );
      if (typeof input !== 'string') {
        return;
      }

      const hadModifiers = this.clearMobileModifiers();
      this.inputTerminalProgrammatically(input);
      if (manageKeyboard && hadModifiers) {
        this.closeMobileKeyboard();
      }
    };

    toggleMobileModifier = (modifier, { manageKeyboard = true } = {}) => {
      const updateModifier = () => {
        this.mobileModifiers[modifier] = !this.mobileModifiers[modifier];
        updateMobileTerminalControls();
        return mobileModifiersNeedKeyboard(this.mobileModifiers);
      };
      if (manageKeyboard) {
        this.mobileFocus.transitionKeyboard(updateModifier);
        return;
      }
      updateModifier();
    };

    clearMobileModifiers = () => {
      if (!this.mobileModifiers.ctrl
        && !this.mobileModifiers.shift
        && !this.mobileModifiers.alt) {
        return false;
      }
      this.mobileModifiers.ctrl = false;
      this.mobileModifiers.shift = false;
      this.mobileModifiers.alt = false;
      updateMobileTerminalControls();
      return true;
    };

    enqueueClipboardOperation = (operation) => {
      this.clipboardOperationQueue = this.clipboardOperationQueue
        .then(() => {
          if (!this.disposed) {
            return operation();
          }
          return undefined;
        })
        .catch((err) => {
          if (!this.disposed) {
            setClipboardStatus(
              err.message || 'Unable to complete the clipboard operation.',
              true,
              5000,
            );
          }
        });
    };

    requestClipboardPaste = () => {
      if (this.disposed || !this.ready) {
        return;
      }

      setClipboardStatus('Reading clipboard…');
      const clipboardRead = readClipboardContent(navigator.clipboard);
      this.enqueueClipboardOperation(async () => {
        let clipboardContent;
        try {
          clipboardContent = await clipboardRead;
        } catch (err) {
          if (!this.disposed) {
            setClipboardStatus(
              'Unable to read the clipboard contents. Copy them again and retry.',
              true,
              5000,
            );
          }
          return;
        }

        await this.applyClipboardContent(clipboardContent);
      });
    };

    applyClipboardContent = async (clipboardContent) => {
      if (this.disposed) {
        return;
      }
      if (!this.ready) {
        setClipboardStatus(
          'The terminal disconnected before the clipboard could be pasted.',
          true,
          5000,
        );
        return;
      }

      if (clipboardContent.kind === 'unavailable') {
        setClipboardStatus(
          'Clipboard access is unavailable. Use the keyboard paste command.',
          true,
          5000,
        );
        return;
      }
      if (clipboardContent.kind === 'denied') {
        setClipboardStatus(
          'Clipboard access was denied. Allow paste access and try again.',
          true,
          5000,
        );
        return;
      }
      if (clipboardContent.kind === 'empty') {
        setClipboardStatus('The clipboard is empty.', false, 3000);
        return;
      }
      if (clipboardContent.kind === 'unsupported') {
        setClipboardStatus(
          'The clipboard contains no supported text, PNG, JPEG, or WebP image.',
          true,
          5000,
        );
        return;
      }
      if (clipboardContent.kind === 'image') {
        await this.uploadClipboardImage(
          clipboardContent.image,
          clipboardContent.contentType,
        );
        return;
      }

      this.pasteTerminalProgrammatically(clipboardContent.text);
      setClipboardStatus('Clipboard text pasted.', false, 3000);
    };

    copySelection = () => {
      if (this.disposed) {
        return;
      }
      const selection = this.terminal.getSelection();
      if (!selection) {
        return;
      }
      const reportCopyFailure = () => {
        setClipboardStatus(
          'Unable to copy the selection. Allow clipboard access and try again.',
          true,
          5000,
        );
      };
      try {
        if (!navigator.clipboard) {
          reportCopyFailure();
          return;
        }
        navigator.clipboard.writeText(selection)
          .then(() => setClipboardStatus('Selection copied to clipboard.', false, 3000))
          .catch(reportCopyFailure);
      } catch (err) {
        reportCopyFailure();
      }
    };

    handlePaste = (event) => {
      const hadModifiers = this.clearMobileModifiers();
      if (hadModifiers) {
        this.closeMobileKeyboard();
      }
      const imageItem = Array.from(event.clipboardData?.items || []).find(
        (item) => item.kind === 'file' && item.type.startsWith('image/'),
      );
      if (!imageItem) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      const image = imageItem.getAsFile();
      if (!image) {
        setClipboardStatus('Unable to read the clipboard image.', true, 5000);
        return;
      }
      this.enqueueClipboardOperation(() => this.uploadClipboardImage(image));
    };

    async uploadClipboardImage(image, contentType = image.type) {
      if (this.disposed) {
        return;
      }
      if (!this.ready) {
        setClipboardStatus('The terminal is disconnected. Reconnect and paste again.', true, 5000);
        return;
      }

      const controller = new AbortController();
      this.imageUploadController = controller;
      setClipboardStatus('Uploading clipboard image…');
      try {
        const data = await apiRequest('/api/clipboard-images', {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'CSRF-Token': csrfToken,
          },
          body: image,
          signal: controller.signal,
        });
        if (this.disposed || controller.signal.aborted) {
          return;
        }
        if (!this.ready) {
          setClipboardStatus(
            'The image was uploaded, but the terminal disconnected. Paste again.',
            true,
            5000,
          );
          return;
        }
        this.pasteTerminalProgrammatically(data.path);
        setClipboardStatus('Image path pasted into the terminal.', false, 3000);
      } catch (err) {
        if (err.name !== 'AbortError') {
          setClipboardStatus(err.message || 'Unable to upload the clipboard image.', true, 5000);
        }
      } finally {
        if (this.imageUploadController === controller) {
          this.imageUploadController = null;
        }
      }
    }

    dimensions() {
      this.fitAddon.fit();
      const cols = Math.min(500, Math.max(2, this.terminal.cols));
      const rows = Math.min(200, Math.max(1, this.terminal.rows));
      if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
        this.terminal.resize(cols, rows);
      }
      return { cols, rows };
    }

    updateTerminalFontSize(isMobile) {
      const fontSize = isMobile ? mobileTerminalFontSize : desktopTerminalFontSize;
      if (this.terminal.options.fontSize === fontSize) {
        return;
      }
      this.terminal.options.fontSize = fontSize;
      this.fitAndNotify();
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
      if (this.disposed || this.suspended) {
        return;
      }

      touchControlActivation.invalidate();
      this.cancelTouchScroll();
      this.resetMobileInput({ closeKeyboard: mobileLayoutQuery.matches });
      this.ready = false;
      updateMobileTerminalControls();
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
            if (this.socket !== socket || this.disposed) {
              resolve();
              return;
            }
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
          touchControlActivation.invalidate();
          this.resetMobileInput({ closeKeyboard: mobileLayoutQuery.matches });
          this.ready = false;
          updateMobileTerminalControls();
          this.writeQueue = this.writeQueue.then(() => {
            if (this.socket !== socket || this.disposed) {
              return;
            }
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
            updateMobileTerminalControls();
            setConnectionStatus('');
            if (!mobileLayoutQuery.matches) {
              this.terminal.focus();
            }
          });
          return;
        }
        if (message.type === 'exit') {
          touchControlActivation.invalidate();
          this.resetMobileInput({ closeKeyboard: mobileLayoutQuery.matches });
          this.ready = false;
          updateMobileTerminalControls();
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
        touchControlActivation.invalidate();
        this.resetMobileInput({ closeKeyboard: mobileLayoutQuery.matches });
        this.ready = false;
        updateMobileTerminalControls();

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
      if (this.suspended) {
        return;
      }
      window.clearTimeout(this.reconnectTimer);
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(5000, this.reconnectDelay * 2);
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.attemptReconnect();
      }, delay);
    }

    async attemptReconnect() {
      if (this.disposed || this.suspended || this.socket || this.reconnectInProgress) {
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
      if (this.disposed || this.suspended || this.socket) {
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

    setPageHidden(hidden) {
      if (this.disposed) {
        return;
      }
      if (hidden) {
        touchControlActivation.invalidate();
        this.cancelTouchScroll();
      }
      if (hidden === this.suspended) {
        if (!hidden) {
          this.reconnectNow();
        }
        return;
      }

      this.suspended = hidden;
      if (!hidden) {
        this.connect();
        return;
      }

      this.resetMobileInput();
      this.ready = false;
      updateMobileTerminalControls();
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectRequested = false;
      const socket = this.socket;
      this.socket = null;
      if (socket && (socket.readyState === WebSocket.CONNECTING
        || socket.readyState === WebSocket.OPEN)) {
        socket.close(1000, 'Page hidden.');
      }
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
      touchControlActivation.invalidate();
      this.resetMobileInput({ closeKeyboard: mobileLayoutQuery.matches });
      this.disposed = true;
      this.cancelTouchScroll();
      this.ready = false;
      updateMobileTerminalControls();
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectRequested = false;
      window.clearTimeout(this.resizeTimer);
      this.resizeObserver.disconnect();
      terminalHost.removeEventListener('click', this.focusTerminal);
      this.terminalElement.removeEventListener('keydown', this.handleBrowserPasteKeyDown, true);
      this.terminalElement.removeEventListener('paste', this.handlePaste, true);
      this.terminalElement.removeEventListener(
        'pointerdown',
        this.handleTouchScrollPointerDown,
      );
      this.terminalElement.removeEventListener(
        'pointermove',
        this.handleTouchScrollPointerMove,
      );
      this.terminalElement.removeEventListener('pointerup', this.handleTouchScrollPointerUp);
      this.terminalElement.removeEventListener(
        'pointercancel',
        this.handleTouchScrollPointerCancel,
      );
      if (this.imageUploadController) {
        this.imageUploadController.abort();
        this.imageUploadController = null;
      }
      this.inputDisposable.dispose();
      this.binaryDisposable.dispose();
      this.selectionDisposable.dispose();
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
    updateMobileTerminalControls();
  }

  function showEmptyTerminal(message) {
    disposeActiveController();
    activeSessionName = null;
    activeSessionLabel.textContent = '';
    terminalHost.hidden = true;
    setConnectionStatus('');
    setClipboardStatus('');
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
      updateMobileTerminalControls();
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
        const data = await response.json();
        window.location.href = data.redirect;
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
  const mobileControlButton = (target) => {
    if (!target || typeof target.closest !== 'function') {
      return null;
    }
    const button = target.closest('[data-terminal-control]');
    if (!button || !mobileTerminalControls.contains(button)) {
      return null;
    }
    return button;
  };
  const mobileControlTargetAction = (target) => (
    mobileControlButton(target)?.dataset.terminalControl || null
  );
  const mobileControlAction = (target) => {
    const button = mobileControlButton(target);
    if (!button || button.disabled || !activeController) {
      return null;
    }
    return button.dataset.terminalControl;
  };
  const activateMobileControl = (
    action,
    controller = activeController,
    options = undefined,
  ) => {
    if (action && controller && controller === activeController) {
      controller.handleMobileControl(action, options);
      return true;
    }
    return false;
  };
  const showMobileControlFeedback = (target, action) => {
    const button = mobileControlButton(target);
    if (
      !button
      || button.disabled
      || button.dataset.terminalControl !== action
      || button.dataset.terminalModifier
    ) {
      return;
    }
    button.classList.remove('is-feedback-active');
    void button.offsetWidth;
    button.classList.add('is-feedback-active');
  };
  document.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) {
      return;
    }
    if (event.pointerType !== 'touch') {
      touchControlActivation.reset();
      return;
    }

    const action = mobileControlAction(event.target);
    if (!action) {
      touchControlActivation.reset();
      return;
    }
    if (touchControlActivation.start(
      event.pointerId,
      action,
      activeController,
      event.clientX,
      event.clientY,
    )) {
      event.preventDefault();
    }
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch' && event.isPrimary) {
      touchControlActivation.move(event.pointerId, event.clientX, event.clientY);
    }
  }, true);
  document.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'touch' || !event.isPrimary) {
      return;
    }
    const releaseTarget = document.elementFromPoint(event.clientX, event.clientY);
    touchControlActivation.end(
      event.pointerId,
      mobileControlTargetAction(releaseTarget),
      event.timeStamp,
      event.clientX,
      event.clientY,
    );
  }, true);
  document.addEventListener('pointercancel', (event) => {
    if (event.pointerType === 'touch') {
      touchControlActivation.cancel(event.pointerId, event.timeStamp);
    }
  }, true);
  document.addEventListener('mousedown', (event) => {
    if (mobileControlAction(event.target)) {
      event.preventDefault();
    }
  }, true);
  document.addEventListener('click', (event) => {
    const targetAction = mobileControlTargetAction(event.target);
    const touchClick = touchControlActivation.consumeClick({
      action: targetAction,
      clientX: event.clientX,
      clientY: event.clientY,
      detail: event.detail,
      firesTouchEvents: event.sourceCapabilities?.firesTouchEvents,
      isControlTarget: Boolean(targetAction),
      pointerId: typeof event.pointerId === 'number' ? event.pointerId : null,
      pointerType: typeof event.pointerType === 'string' ? event.pointerType : '',
      timestamp: event.timeStamp,
    });
    if (touchClick) {
      event.preventDefault();
      event.stopPropagation();
      if (
        touchClick.kind === 'activate'
        && activateMobileControl(
          touchClick.action,
          touchClick.context,
          { manageKeyboard: true },
        )
      ) {
        showMobileControlFeedback(event.target, touchClick.action);
      }
      return;
    }

    const action = mobileControlAction(event.target);
    if (!action) {
      return;
    }
    const isNonPointingActivation = event.detail === 0
      || (event.pointerType === '' && event.pointerId === -1);
    if (isNonPointingActivation) {
      touchControlActivation.reset();
    }
    if (activateMobileControl(action, activeController, {
      manageKeyboard: !isNonPointingActivation,
    })) {
      showMobileControlFeedback(event.target, action);
    }
  }, true);
  const clearMobileControlFeedback = (event) => {
    if (event.animationName === 'mobile-terminal-key-feedback') {
      mobileControlButton(event.target)?.classList.remove('is-feedback-active');
    }
  };
  mobileTerminalControls.addEventListener('animationend', clearMobileControlFeedback);
  mobileTerminalControls.addEventListener('animationcancel', clearMobileControlFeedback);
  mobileLayoutQuery.addEventListener('change', (event) => {
    touchControlActivation.invalidate();
    if (activeController) {
      activeController.updateTerminalFontSize(event.matches);
      if (!event.matches) {
        activeController.clearMobileModifiers();
        activeController.cancelTouchScroll();
      }
    }
  });

  function reconnectActiveSessionNow() {
    if (activeController) {
      activeController.reconnectNow();
    }
  }

  window.addEventListener('online', reconnectActiveSessionNow);
  document.addEventListener('visibilitychange', () => {
    touchControlActivation.invalidate();
    if (activeController) {
      activeController.setPageHidden(document.hidden);
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
