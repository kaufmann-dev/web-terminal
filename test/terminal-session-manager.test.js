'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const {
  MAX_BUFFERED_BYTES,
  SOCKET_CLOSE_CODES,
  TerminalSessionManager,
  cleanTerminalTitle,
  isValidTerminalSize,
  listLinuxSessionPids,
  readLinuxForeground,
  writeTerminal,
} = require('../terminal-session-manager');
const { isValidTerminalSessionId } = require('../app');

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
  constructor({ retainBufferedWrites = false } = {}) {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = null;
    this.retainBufferedWrites = retainBufferedWrites;
  }

  send(data, options = {}) {
    this.sent.push({ data, binary: Boolean(options.binary) });
    if (this.retainBufferedWrites) {
      this.bufferedAmount += Buffer.byteLength(data);
    }
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

test('validates terminal session IDs and dimensions', () => {
  assert.equal(isValidTerminalSessionId('0a1b2c3d'), true);
  assert.equal(isValidTerminalSessionId('main'), false);
  assert.equal(isValidTerminalSessionId('0A1B2C3D'), false);
  assert.equal(isValidTerminalSessionId('0a1b2c3'), false);
  assert.equal(isValidTerminalSessionId('0a1b2c3d4'), false);
  assert.equal(isValidTerminalSize(2, 1), true);
  assert.equal(isValidTerminalSize(500, 200), true);
  assert.equal(isValidTerminalSize(1, 24), false);
  assert.equal(isValidTerminalSize(80.5, 24), false);
});

test('creates sessions under distinct generated IDs', async () => {
  const { manager } = createFakeManager();
  const first = manager.createSession();
  const second = manager.createSession();
  assert.match(first.id, /^[0-9a-f]{8}$/);
  assert.notEqual(first.id, second.id);
  await manager.shutdown();
});

test('orders PTY output, restores snapshots, and streams live bytes', async () => {
  const { manager, ptys } = createFakeManager();
  const { id } = manager.createSession();
  const session = manager.sessions.get(id);
  ptys[0].emitData('first\r\n');
  ptys[0].emitData('second');
  await session.queue;

  const socket = new FakeSocket();
  assert.equal(await manager.attachClient(id, socket, 'login-1', 80, 24), true);
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
  await manager.deleteSession(id);
});

test('large reconnect snapshots do not trigger the live-output backpressure limit', async () => {
  const { manager, ptys } = createFakeManager();
  const { id } = manager.createSession();
  const session = manager.sessions.get(id);
  const snapshot = 'x'.repeat(MAX_BUFFERED_BYTES + 1);
  session.serializeAddon.serialize = () => snapshot;

  const socket = new FakeSocket({ retainBufferedWrites: true });
  assert.equal(await manager.attachClient(id, socket, 'login-1', 80, 24), true);
  assert.equal(socket.closed, null);
  assert.deepEqual(
    socket.sent.filter((message) => !message.binary).map((message) => JSON.parse(message.data)),
    [{ type: 'snapshot' }, { type: 'ready' }],
  );
  assert.equal(binaryMessages(socket)[0].toString('utf8'), snapshot);

  socket.bufferedAmount = 0;
  ptys[0].emitData('after restore');
  await session.queue;
  assert.equal(socket.closed, null);

  socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
  ptys[0].emitData('too much live output');
  await session.queue;
  assert.equal(socket.closed.code, SOCKET_CLOSE_CODES.CLIENT_TOO_SLOW);
  await manager.deleteSession(id);
});

test('bounds the headless scrollback at 10,000 lines', async () => {
  const { manager, ptys } = createFakeManager();
  const { id } = manager.createSession();
  const session = manager.sessions.get(id);
  const lines = Array.from({ length: 10050 }, (_, index) => `line-${String(index).padStart(5, '0')}`);
  ptys[0].emitData(`${lines.join('\r\n')}\r\n`);
  await session.queue;

  assert.ok(session.terminal.buffer.normal.length <= 10024);
  const snapshot = session.serializeAddon.serialize({ scrollback: 10000 });
  assert.doesNotMatch(snapshot, /line-00000/);
  assert.match(snapshot, /line-10049/);
  await manager.deleteSession(id);
});

test('keeps a PTY alive across browser disconnect and includes detached output on reconnect', async () => {
  const { manager, ptys } = createFakeManager();
  const { id } = manager.createSession();
  const firstSocket = new FakeSocket();
  await manager.attachClient(id, firstSocket, 'login-1', 80, 24);
  assert.equal(manager.detachClient(id, firstSocket), true);
  assert.equal(ptys[0].signals.length, 0);
  assert.equal(manager.hasSession(id), true);

  ptys[0].emitData('completed while disconnected\r\n');
  await manager.sessions.get(id).queue;
  const secondSocket = new FakeSocket();
  await manager.attachClient(id, secondSocket, 'login-1', 80, 24);
  assert.match(binaryMessages(secondSocket)[0].toString('utf8'), /completed while disconnected/);
  await manager.deleteSession(id);
});

test('headless terminal answers device queries only while no browser is ready', async () => {
  const { manager, ptys } = createFakeManager();
  const { id } = manager.createSession();
  const session = manager.sessions.get(id);
  ptys[0].emitData('\x1b[5n');
  await session.queue;
  assert.equal(ptys[0].writes.at(-1), '\x1b[0n');

  const socket = new FakeSocket();
  await manager.attachClient(id, socket, 'login-1', 80, 24);
  const writeCount = ptys[0].writes.length;
  ptys[0].emitData('\x1b[5n');
  await session.queue;
  assert.equal(ptys[0].writes.length, writeCount);
  await manager.deleteSession(id);
});

test('newest client replaces the previous client and owns input', async () => {
  const { manager, ptys } = createFakeManager();
  const { id } = manager.createSession();
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  await manager.attachClient(id, firstSocket, 'login-1', 80, 24);
  await manager.attachClient(id, secondSocket, 'login-2', 100, 30);

  assert.equal(firstSocket.closed.code, SOCKET_CLOSE_CODES.REPLACED);
  assert.equal(manager.writeInput(id, firstSocket, 'old'), false);
  assert.equal(manager.writeInput(id, secondSocket, 'new'), true);
  assert.equal(ptys[0].writes.at(-1), 'new');
  assert.deepEqual(ptys[0].resizes.at(-1), { cols: 100, rows: 30 });
  await manager.deleteSession(id);
});

test('natural shell exit removes the session and notifies the client', async () => {
  const { manager, ptys } = createFakeManager();
  const { id } = manager.createSession();
  const socket = new FakeSocket();
  await manager.attachClient(id, socket, 'login-1', 80, 24);
  const session = manager.sessions.get(id);
  ptys[0].emitExit({ exitCode: 7, signal: 0 });
  await session.exitPromise;
  await session.queue;

  assert.equal(manager.hasSession(id), false);
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
  const { id } = manager.createSession();
  const originalKill = ptys[0].kill.bind(ptys[0]);
  ptys[0].kill = (signal) => {
    originalKill(signal);
    ptys[0].emitExit({ exitCode: 0, signal: 1 });
  };

  assert.equal(await manager.deleteSession(id), true);
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
  const { id } = manager.createSession();
  await manager.deleteSession(id);

  assert.deepEqual(ptys[0].signals, ['SIGHUP', 'SIGKILL']);
  assert.ok(signaled.some(({ signal }) => signal === 'SIGHUP'));
  assert.ok(signaled.some(({ signal }) => signal === 'SIGKILL'));
});

test('lists each session with its foreground program and home-relative directory', () => {
  const directories = { 41000: '/code', 41001: '/code/projects/app', 41002: '/codex', 41004: '/' };
  const { manager } = createFakeManager({
    terminalEnvironment: { HOME: '/code' },
    readForeground: (pid) => (pid === 41003
      ? null
      : { group: pid, program: 'bash', directory: directories[pid] }),
  });
  const ids = Array.from({ length: 5 }, () => manager.createSession().id);

  assert.deepEqual(manager.listSessions(), [
    { id: ids[0], label: '~', program: 'bash', directory: '~' },
    { id: ids[1], label: 'app', program: 'bash', directory: '~/projects/app' },
    { id: ids[2], label: 'codex', program: 'bash', directory: '/codex' },
    { id: ids[3], label: 'shell', program: null, directory: null },
    { id: ids[4], label: '/', program: 'bash', directory: '/' },
  ]);
});

test('labels a session with a program title only while its process group is in the foreground', async () => {
  let group = 50001;
  const { manager, ptys } = createFakeManager({
    terminalEnvironment: { HOME: '/code' },
    readForeground: () => ({ group, program: 'claude', directory: '/code/projects/app' }),
  });
  const { id } = manager.createSession();
  const session = manager.sessions.get(id);

  ptys[0].emitData('\x1b]0;✳ Fix login bug\x07');
  await session.queue;
  assert.equal(manager.listSessions()[0].label, 'Fix login bug');

  group = ptys[0].pid;
  assert.equal(manager.listSessions()[0].label, 'app');

  group = 50002;
  assert.equal(manager.listSessions()[0].label, 'app');

  ptys[0].emitData('\x1b]2;bash\x07');
  await session.queue;
  group = ptys[0].pid;
  assert.equal(manager.listSessions()[0].label, 'app');
  await manager.deleteSession(id);
});

test('cleans program titles for display', () => {
  assert.equal(cleanTerminalTitle('✳ Fix login bug'), 'Fix login bug');
  assert.equal(cleanTerminalTitle('⠂  Review\u0007 the\tPR  '), 'Review the PR');
  assert.equal(cleanTerminalTitle('x'.repeat(100)), 'x'.repeat(80));
  assert.equal(cleanTerminalTitle(' ✳ '), null);
  assert.equal(cleanTerminalTitle(''), null);
});

test('names Node foreground processes after their title or script', (t) => {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
  t.after(() => fs.rmSync(procRoot, { recursive: true, force: true }));
  const writeProcess = (pid, { stat, comm, cmdline }) => {
    const directory = path.join(procRoot, String(pid));
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'stat'), stat || `${pid} (bash) S 1 ${pid} ${pid} 34816 ${pid + 1} 0`);
    fs.writeFileSync(path.join(directory, 'comm'), `${comm}\n`);
    fs.writeFileSync(path.join(directory, 'cmdline'), cmdline);
    fs.symlinkSync('/code/app', path.join(directory, 'cwd'));
  };
  writeProcess(100, { comm: 'bash', cmdline: '/bin/bash\0-i\0' });
  writeProcess(101, { comm: 'MainThread', cmdline: 'node\0--no-warnings\0/app/node_modules/.bin/codex\0' });
  writeProcess(200, { comm: 'bash', cmdline: '/bin/bash\0-i\0' });
  writeProcess(201, { comm: 'MainThread', cmdline: 'npm run dev\0\0\0' });
  writeProcess(300, { stat: '300 (bash) S 1 300 300 34816 -1 0', comm: 'bash', cmdline: '/bin/bash\0' });

  assert.deepEqual(readLinuxForeground(100, procRoot), { group: 101, program: 'codex', directory: '/code/app' });
  assert.deepEqual(readLinuxForeground(200, procRoot), { group: 201, program: 'npm', directory: '/code/app' });
  assert.deepEqual(readLinuxForeground(300, procRoot), { group: 300, program: 'bash', directory: '/code/app' });
  assert.equal(readLinuxForeground(999, procRoot), null);
});

test('real node-pty session reports its foreground program and directory', {
  skip: process.platform !== 'linux',
  timeout: 10000,
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'test'));
  const manager = new TerminalSessionManager({
    terminalEnvironment: { ...process.env, HOME: home, TERM: 'xterm-256color' },
    terminalWorkdir: home,
    bashRcPath: '/dev/null',
    killTimeoutMs: 2000,
    logger: { error() {}, warn() {} },
  });
  const { id } = manager.createSession();
  const session = manager.sessions.get(id);
  session.ptyProcess.write('cd test && sleep 30\n');

  let listed;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    [listed] = manager.listSessions();
    if (listed.program === 'sleep') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await manager.deleteSession(id);
  assert.deepEqual(listed, { id, label: 'test', program: 'sleep', directory: '~/test' });
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
  const { id } = manager.createSession();
  const session = manager.sessions.get(id);
  manager.writeInput = manager.writeInput.bind(manager);
  session.ptyProcess.write('sleep 30\n');

  let processIds = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    processIds = listLinuxSessionPids(session.ptyProcess.pid);
    if (processIds.length > 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(processIds.length > 1, 'expected a foreground sleep process in the PTY session');
  await manager.deleteSession(id);

  for (const pid of processIds) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});
