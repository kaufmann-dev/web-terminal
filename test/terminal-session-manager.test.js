'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const {
  SOCKET_CLOSE_CODES,
  TerminalSessionManager,
  isValidTerminalSize,
  listLinuxSessionPids,
  writeTerminal,
} = require('../terminal-session-manager');
const { isValidTerminalSessionName } = require('../app');

class FakePty {
  constructor(pid = 41000) {
    this.pid = pid;
    this.writes = [];
    this.resizes = [];
    this.signals = [];
    this.dataListeners = new Set();
    this.exitListeners = new Set();
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event = { exitCode: 0, signal: 0 }) {
    for (const listener of [...this.exitListeners]) listener(event);
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

  kill(signal) {
    this.signals.push(signal);
  }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = null;
  }

  send(data, options = {}) {
    this.sent.push({ data, binary: Boolean(options.binary) });
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason || ''));
  }
}

function createFakeManager(overrides = {}) {
  const ptys = [];
  const manager = new TerminalSessionManager({
    terminalEnvironment: { TERM: 'xterm-256color' },
    terminalWorkdir: process.cwd(),
    bashRcPath: '/dev/null',
    killTimeoutMs: 5,
    spawnPty: () => {
      const pty = new FakePty(41000 + ptys.length);
      ptys.push(pty);
      return pty;
    },
    listSessionPids: () => [],
    logger: { error() {}, warn() {} },
    ...overrides,
  });
  return { manager, ptys };
}

function binaryMessages(socket) {
  return socket.sent.filter((message) => message.binary).map((message) => message.data);
}

test('validates terminal names and dimensions', () => {
  assert.equal(isValidTerminalSessionName('main'), true);
  assert.equal(isValidTerminalSessionName('project-2'), true);
  assert.equal(isValidTerminalSessionName('Upper'), false);
  assert.equal(isValidTerminalSessionName('-leading'), false);
  assert.equal(isValidTerminalSessionName('a'.repeat(33)), false);
  assert.equal(isValidTerminalSize(2, 1), true);
  assert.equal(isValidTerminalSize(500, 200), true);
  assert.equal(isValidTerminalSize(1, 24), false);
  assert.equal(isValidTerminalSize(80.5, 24), false);
});

test('rejects duplicate session creation', async () => {
  const { manager } = createFakeManager();
  manager.createSession('main');
  assert.throws(() => manager.createSession('main'), { code: 'TERMINAL_SESSION_EXISTS' });
  await manager.deleteSession('main');
});

test('orders PTY output, restores snapshots, and streams live bytes', async () => {
  const { manager, ptys } = createFakeManager();
  manager.createSession('main');
  const session = manager.sessions.get('main');
  ptys[0].emitData('first\r\n');
  ptys[0].emitData('second');
  await session.queue;

  const socket = new FakeSocket();
  assert.equal(await manager.attachClient('main', socket, 'login-1', 80, 24), true);
  const snapshot = binaryMessages(socket)[0].toString('utf8');
  assert.match(snapshot, /first/);
  assert.match(snapshot, /second/);

  const restored = new Terminal({
    allowProposedApi: true,
    cols: 80,
    rows: 24,
    scrollback: 10000,
  });
  const restoredSerializer = new SerializeAddon();
  restored.loadAddon(restoredSerializer);
  await writeTerminal(restored, snapshot);
  assert.match(restoredSerializer.serialize(), /first\r\nsecond/);
  restored.dispose();

  ptys[0].emitData('A');
  ptys[0].emitData('B');
  await session.queue;
  assert.deepEqual(
    binaryMessages(socket).slice(1).map((data) => data.toString('utf8')),
    ['A', 'B'],
  );
  await manager.deleteSession('main');
});

test('bounds the headless scrollback at 10,000 lines', async () => {
  const { manager, ptys } = createFakeManager();
  manager.createSession('main');
  const session = manager.sessions.get('main');
  const lines = Array.from({ length: 10050 }, (_, index) => `line-${String(index).padStart(5, '0')}`);
  ptys[0].emitData(`${lines.join('\r\n')}\r\n`);
  await session.queue;

  assert.ok(session.terminal.buffer.normal.length <= 10024);
  const snapshot = session.serializeAddon.serialize({ scrollback: 10000 });
  assert.doesNotMatch(snapshot, /line-00000/);
  assert.match(snapshot, /line-10049/);
  await manager.deleteSession('main');
});

test('keeps a PTY alive across browser disconnect and includes detached output on reconnect', async () => {
  const { manager, ptys } = createFakeManager();
  manager.createSession('main');
  const firstSocket = new FakeSocket();
  await manager.attachClient('main', firstSocket, 'login-1', 80, 24);
  assert.equal(manager.detachClient('main', firstSocket), true);
  assert.equal(ptys[0].signals.length, 0);
  assert.equal(manager.hasSession('main'), true);

  ptys[0].emitData('completed while disconnected\r\n');
  await manager.sessions.get('main').queue;
  const secondSocket = new FakeSocket();
  await manager.attachClient('main', secondSocket, 'login-1', 80, 24);
  assert.match(binaryMessages(secondSocket)[0].toString('utf8'), /completed while disconnected/);
  await manager.deleteSession('main');
});

test('headless terminal answers device queries only while no browser is ready', async () => {
  const { manager, ptys } = createFakeManager();
  manager.createSession('main');
  const session = manager.sessions.get('main');
  ptys[0].emitData('\x1b[5n');
  await session.queue;
  assert.equal(ptys[0].writes.at(-1), '\x1b[0n');

  const socket = new FakeSocket();
  await manager.attachClient('main', socket, 'login-1', 80, 24);
  const writeCount = ptys[0].writes.length;
  ptys[0].emitData('\x1b[5n');
  await session.queue;
  assert.equal(ptys[0].writes.length, writeCount);
  await manager.deleteSession('main');
});

test('newest client replaces the previous client and owns input', async () => {
  const { manager, ptys } = createFakeManager();
  manager.createSession('main');
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  await manager.attachClient('main', firstSocket, 'login-1', 80, 24);
  await manager.attachClient('main', secondSocket, 'login-2', 100, 30);

  assert.equal(firstSocket.closed.code, SOCKET_CLOSE_CODES.REPLACED);
  assert.equal(manager.writeInput('main', firstSocket, 'old'), false);
  assert.equal(manager.writeInput('main', secondSocket, 'new'), true);
  assert.equal(ptys[0].writes.at(-1), 'new');
  assert.deepEqual(ptys[0].resizes.at(-1), { cols: 100, rows: 30 });
  await manager.deleteSession('main');
});

test('natural shell exit removes the session and notifies the client', async () => {
  const { manager, ptys } = createFakeManager();
  manager.createSession('main');
  const socket = new FakeSocket();
  await manager.attachClient('main', socket, 'login-1', 80, 24);
  const session = manager.sessions.get('main');
  ptys[0].emitExit({ exitCode: 7, signal: 0 });
  await session.exitPromise;
  await session.queue;

  assert.equal(manager.hasSession('main'), false);
  assert.equal(socket.closed.code, SOCKET_CLOSE_CODES.SESSION_ENDED);
  const exitMessage = socket.sent
    .filter((message) => !message.binary)
    .map((message) => JSON.parse(message.data))
    .find((message) => message.type === 'exit');
  assert.deepEqual(exitMessage, { type: 'exit', exitCode: 7, signal: 0 });
});

test('destructive deletion signals every process in the Linux PTY session', async () => {
  const signaled = [];
  const { manager, ptys } = createFakeManager({
    listSessionPids: () => [41000, 41001, 41002],
    signalProcess: (pid, signal) => signaled.push({ pid, signal }),
  });
  manager.createSession('main');
  const originalKill = ptys[0].kill.bind(ptys[0]);
  ptys[0].kill = (signal) => {
    originalKill(signal);
    ptys[0].emitExit({ exitCode: 0, signal: 1 });
  };

  assert.equal(await manager.deleteSession('main'), true);
  assert.deepEqual(signaled, [
    { pid: 41001, signal: 'SIGHUP' },
    { pid: 41002, signal: 'SIGHUP' },
    { pid: 41000, signal: 'SIGHUP' },
  ]);
});

test('destructive deletion escalates a stubborn PTY session to SIGKILL', async () => {
  const signaled = [];
  const { manager, ptys } = createFakeManager({
    listSessionPids: () => [41000, 41001],
    signalProcess: (pid, signal) => signaled.push({ pid, signal }),
  });
  manager.createSession('main');
  await manager.deleteSession('main');

  assert.deepEqual(ptys[0].signals, ['SIGHUP', 'SIGKILL']);
  assert.ok(signaled.some(({ signal }) => signal === 'SIGHUP'));
  assert.ok(signaled.some(({ signal }) => signal === 'SIGKILL'));
});

test('real node-pty deletion terminates a foreground child process', {
  skip: process.platform !== 'linux',
  timeout: 10000,
}, async () => {
  const manager = new TerminalSessionManager({
    terminalEnvironment: { ...process.env, TERM: 'xterm-256color' },
    terminalWorkdir: process.cwd(),
    bashRcPath: '/dev/null',
    killTimeoutMs: 2000,
    logger: { error() {}, warn() {} },
  });
  manager.createSession('real');
  const session = manager.sessions.get('real');
  manager.writeInput = manager.writeInput.bind(manager);
  session.ptyProcess.write('sleep 30\n');

  let processIds = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    processIds = listLinuxSessionPids(session.ptyProcess.pid);
    if (processIds.length > 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(processIds.length > 1, 'expected a foreground sleep process in the PTY session');
  await manager.deleteSession('real');

  for (const pid of processIds) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});
