'use strict';

const fs = require('fs');
const path = require('path');
const nodePty = require('node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const MIN_COLS = 2;
const MIN_ROWS = 1;
const MAX_SCROLLBACK = 10000;
const MAX_BUFFERED_BYTES = 1024 * 1024;

const SOCKET_CLOSE_CODES = Object.freeze({
  PROTOCOL_ERROR: 4000,
  REPLACED: 4001,
  AUTH_EXPIRED: 4002,
  SESSION_ENDED: 4003,
  LOGGED_OUT: 4004,
  CLIENT_TOO_SLOW: 4005,
});

function isValidTerminalSize(cols, rows) {
  return Number.isInteger(cols)
    && Number.isInteger(rows)
    && cols >= MIN_COLS
    && cols <= MAX_COLS
    && rows >= MIN_ROWS
    && rows <= MAX_ROWS;
}

function listLinuxSessionPids(sessionId, procRoot = '/proc') {
  const pids = [];

  for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }

    try {
      const stat = fs.readFileSync(path.join(procRoot, entry.name, 'stat'), 'utf8');
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd === -1) {
        continue;
      }

      const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
      if (Number(fields[3]) === sessionId) {
        pids.push(Number(entry.name));
      }
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ESRCH') {
        throw err;
      }
    }
  }

  return pids;
}

function writeTerminal(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class DuplicateTerminalSessionError extends Error {
  constructor(name) {
    super(`Terminal session already exists: ${name}`);
    this.code = 'TERMINAL_SESSION_EXISTS';
  }
}

class TerminalSessionManager {
  constructor(options) {
    this.sessions = new Map();
    this.terminalEnvironment = { ...options.terminalEnvironment };
    this.terminalWorkdir = options.terminalWorkdir;
    this.bashPath = options.bashPath || '/bin/bash';
    this.bashRcPath = options.bashRcPath;
    this.killTimeoutMs = options.killTimeoutMs ?? 2000;
    this.spawnPty = options.spawnPty || nodePty.spawn;
    this.TerminalClass = options.TerminalClass || HeadlessTerminal;
    this.SerializeAddonClass = options.SerializeAddonClass || SerializeAddon;
    this.listSessionPids = options.listSessionPids || listLinuxSessionPids;
    this.signalProcess = options.signalProcess || process.kill.bind(process);
    this.logger = options.logger || console;
  }

  listSessions() {
    return [...this.sessions.values()]
      .map((session) => ({
        name: session.name,
        attachedClients: session.client && session.client.ready ? 1 : 0,
      }))
      .sort((a, b) => {
        if (a.name === 'main') return -1;
        if (b.name === 'main') return 1;
        return a.name.localeCompare(b.name);
      });
  }

  hasSession(name) {
    return this.sessions.has(name);
  }

  createSession(name) {
    if (this.sessions.has(name)) {
      throw new DuplicateTerminalSessionError(name);
    }

    const terminal = new this.TerminalClass({
      allowProposedApi: true,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      scrollback: MAX_SCROLLBACK,
    });
    const serializeAddon = new this.SerializeAddonClass();
    terminal.loadAddon(serializeAddon);

    let ptyProcess;
    try {
      ptyProcess = this.spawnPty(
        this.bashPath,
        ['--rcfile', this.bashRcPath, '-i'],
        {
          name: 'xterm-256color',
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS,
          cwd: this.terminalWorkdir,
          env: this.terminalEnvironment,
          encoding: 'utf8',
        },
      );
    } catch (err) {
      terminal.dispose();
      throw err;
    }

    let resolveExit;
    const session = {
      name,
      terminal,
      serializeAddon,
      ptyProcess,
      client: null,
      queue: Promise.resolve(),
      deleting: false,
      exited: false,
      disposed: false,
      exitPromise: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      resolveExit,
      disposables: [],
    };

    session.disposables.push(terminal.onData((data) => {
      if (session.exited || (session.client && session.client.ready)) {
        return;
      }
      session.ptyProcess.write(data);
    }));

    session.disposables.push(ptyProcess.onData((data) => {
      this._enqueue(session, async () => {
        if (session.disposed) {
          return;
        }
        await writeTerminal(session.terminal, data);
        if (session.client && session.client.ready) {
          this._sendBinary(session, session.client, Buffer.from(data, 'utf8'));
        }
      });
    }));

    session.disposables.push(ptyProcess.onExit((event) => {
      this._handleExit(session, event);
    }));

    this.sessions.set(name, session);
    return { name, attachedClients: 0 };
  }

  async attachClient(name, socket, loginSessionId, cols, rows) {
    const session = this.sessions.get(name);
    if (!session || session.exited || session.deleting) {
      return false;
    }
    if (!isValidTerminalSize(cols, rows)) {
      throw new RangeError('Invalid terminal dimensions.');
    }

    if (session.client && session.client.socket !== socket) {
      this._closeClient(
        session,
        session.client,
        SOCKET_CLOSE_CODES.REPLACED,
        'Terminal opened by another client.',
      );
    }

    const client = {
      socket,
      loginSessionId,
      ready: false,
    };
    session.client = client;

    await this._enqueue(session, async () => {
      if (session.client !== client || session.exited || session.deleting) {
        return;
      }

      session.terminal.resize(cols, rows);
      session.ptyProcess.resize(cols, rows);
      const snapshot = session.serializeAddon.serialize({
        scrollback: MAX_SCROLLBACK,
        excludeAltBuffer: false,
      });

      if (!this._sendJson(session, client, { type: 'snapshot' })) {
        return;
      }
      if (!this._sendBinary(session, client, Buffer.from(snapshot, 'utf8'))) {
        return;
      }
      if (!this._sendJson(session, client, { type: 'ready' })) {
        return;
      }
      client.ready = true;
    });

    return session.client === client && client.ready;
  }

  detachClient(name, socket) {
    const session = this.sessions.get(name);
    if (session && session.client && session.client.socket === socket) {
      session.client = null;
      return true;
    }
    return false;
  }

  writeInput(name, socket, data) {
    const session = this._getReadySessionForSocket(name, socket);
    if (!session || typeof data !== 'string') {
      return false;
    }
    session.ptyProcess.write(data);
    return true;
  }

  writeBinary(name, socket, data) {
    const session = this._getReadySessionForSocket(name, socket);
    if (!session || !Buffer.isBuffer(data)) {
      return false;
    }
    session.ptyProcess.write(data);
    return true;
  }

  resize(name, socket, cols, rows) {
    const session = this._getReadySessionForSocket(name, socket);
    if (!session || !isValidTerminalSize(cols, rows)) {
      return false;
    }

    return this._enqueue(session, async () => {
      if (this._getReadySessionForSocket(name, socket) !== session) {
        return false;
      }
      session.terminal.resize(cols, rows);
      session.ptyProcess.resize(cols, rows);
      return true;
    });
  }

  async deleteSession(name) {
    const session = this.sessions.get(name);
    if (!session) {
      return false;
    }

    session.deleting = true;
    this.sessions.delete(name);
    if (session.client) {
      this._sendJson(session, session.client, {
        type: 'exit',
        exitCode: null,
        signal: 'SIGHUP',
      });
      this._closeClient(
        session,
        session.client,
        SOCKET_CLOSE_CODES.SESSION_ENDED,
        'Terminal session deleted.',
      );
    }

    await this._signalSession(session.ptyProcess.pid, 'SIGHUP');
    try {
      session.ptyProcess.kill('SIGHUP');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        this.logger.warn(`Unable to signal terminal session ${name}: ${err.message}`);
      }
    }

    await Promise.race([session.exitPromise, delay(this.killTimeoutMs)]);
    if (!session.exited) {
      await this._signalSession(session.ptyProcess.pid, 'SIGKILL');
      try {
        session.ptyProcess.kill('SIGKILL');
      } catch (err) {
        if (err.code !== 'ESRCH') {
          this.logger.warn(`Unable to kill terminal session ${name}: ${err.message}`);
        }
      }
      await Promise.race([session.exitPromise, delay(250)]);
    }

    if (!session.exited) {
      session.exited = true;
      session.resolveExit({ exitCode: null, signal: 'SIGKILL' });
    }
    await session.queue;
    this._disposeSession(session);
    return true;
  }

  async shutdown() {
    await Promise.all([...this.sessions.keys()].map((name) => this.deleteSession(name)));
  }

  _getReadySessionForSocket(name, socket) {
    const session = this.sessions.get(name);
    if (!session || !session.client || !session.client.ready) {
      return null;
    }
    return session.client.socket === socket ? session : null;
  }

  _enqueue(session, task) {
    const operation = session.queue.then(task);
    session.queue = operation.catch((err) => {
      this.logger.error(`Terminal session ${session.name} queue error: ${err.message}`);
    });
    return operation;
  }

  _handleExit(session, event) {
    if (session.exited) {
      return;
    }
    session.exited = true;
    if (this.sessions.get(session.name) === session) {
      this.sessions.delete(session.name);
    }

    this._enqueue(session, async () => {
      if (session.client) {
        this._sendJson(session, session.client, {
          type: 'exit',
          exitCode: event.exitCode,
          signal: event.signal ?? null,
        });
        this._closeClient(
          session,
          session.client,
          SOCKET_CLOSE_CODES.SESSION_ENDED,
          'Terminal process exited.',
        );
      }
    }).finally(() => this._disposeSession(session));

    session.resolveExit(event);
  }

  async _signalSession(sessionId, signal) {
    let pids;
    try {
      pids = this.listSessionPids(sessionId);
    } catch (err) {
      this.logger.warn(`Unable to enumerate terminal process session ${sessionId}: ${err.message}`);
      pids = [sessionId];
    }

    const descendants = pids.filter((pid) => pid !== sessionId);
    const orderedPids = [...descendants, ...pids.filter((pid) => pid === sessionId)];

    for (const pid of orderedPids) {
      try {
        this.signalProcess(pid, signal);
      } catch (err) {
        if (err.code !== 'ESRCH') {
          this.logger.warn(`Unable to send ${signal} to terminal process ${pid}: ${err.message}`);
        }
      }

      // Give the shell session leader a chance to reap terminated foreground
      // children before it receives the same signal. Containers commonly run
      // Node as PID 1, which cannot otherwise reap grandchildren orphaned at
      // the same instant as their shell.
      if (pid !== sessionId && orderedPids.includes(sessionId)) {
        await delay(25);
      }
    }
  }

  _sendJson(session, client, message) {
    return this._send(session, client, JSON.stringify(message), false);
  }

  _sendBinary(session, client, data) {
    return this._send(session, client, data, true);
  }

  _send(session, client, data, binary) {
    const socket = client.socket;
    if (session.client !== client || socket.readyState !== 1) {
      return false;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this._closeClient(
        session,
        client,
        SOCKET_CLOSE_CODES.CLIENT_TOO_SLOW,
        'Terminal client is too slow.',
      );
      return false;
    }

    socket.send(data, { binary });
    return true;
  }

  _closeClient(session, client, code, reason) {
    if (session.client === client) {
      session.client = null;
    }
    client.ready = false;
    if (client.socket.readyState === 0 || client.socket.readyState === 1) {
      client.socket.close(code, reason);
    }
  }

  _disposeSession(session) {
    if (session.disposed) {
      return;
    }
    session.disposed = true;
    for (const disposable of session.disposables) {
      disposable.dispose();
    }
    session.terminal.dispose();
  }
}

module.exports = {
  DuplicateTerminalSessionError,
  INITIAL_COLS,
  INITIAL_ROWS,
  MAX_BUFFERED_BYTES,
  MAX_COLS,
  MAX_ROWS,
  MAX_SCROLLBACK,
  MIN_COLS,
  MIN_ROWS,
  SOCKET_CLOSE_CODES,
  TerminalSessionManager,
  isValidTerminalSize,
  listLinuxSessionPids,
  writeTerminal,
};
