'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const resetScript = path.join(
  __dirname,
  '..',
  'scripts',
  'initialize-podman6-storage.sh',
);

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runReset(terminalHome, configHome, dataHome, runtimeDir) {
  return spawnSync(
    'bash',
    [resetScript, terminalHome, configHome, dataHome, runtimeDir],
    { encoding: 'utf8' },
  );
}

test('Podman 6 storage reset removes legacy state once and preserves credentials', async (t) => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'web-terminal-podman-reset-'),
  );
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const terminalHome = path.join(temporaryRoot, 'home');
  const configHome = path.join(terminalHome, '.config');
  const dataHome = path.join(terminalHome, '.local', 'share');
  const runtimeDir = path.join(temporaryRoot, 'runtime');
  const storageRoot = path.join(dataHome, 'containers', 'storage');
  const legacyCniRoot = path.join(configHome, 'cni');
  const runRoot = path.join(runtimeDir, 'containers');
  const stateRoot = path.join(terminalHome, '.local', 'state', 'web-terminal');
  const resetMarker = path.join(stateRoot, 'podman6-storage-reset-v1');
  const inProgressMarker = `${resetMarker}.in-progress`;
  const registryAuth = path.join(configHome, 'containers', 'auth.json');
  const workspaceFile = path.join(terminalHome, 'project', 'keep.txt');

  await Promise.all([
    fs.mkdir(path.join(storageRoot, 'libpod'), { recursive: true }),
    fs.mkdir(path.join(storageRoot, 'volumes', 'legacy', '_data'), {
      recursive: true,
    }),
    fs.mkdir(path.join(legacyCniRoot, 'net.d'), { recursive: true }),
    fs.mkdir(runRoot, { recursive: true }),
    fs.mkdir(path.dirname(registryAuth), { recursive: true }),
    fs.mkdir(path.dirname(workspaceFile), { recursive: true }),
    fs.mkdir(stateRoot, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(storageRoot, 'libpod', 'bolt_state.db'), 'legacy-db'),
    fs.writeFile(
      path.join(storageRoot, 'volumes', 'legacy', '_data', 'value'),
      'legacy-volume',
    ),
    fs.writeFile(path.join(legacyCniRoot, 'net.d', 'legacy.conflist'), '{}'),
    fs.writeFile(path.join(runRoot, 'stale-runtime'), 'stale'),
    fs.writeFile(registryAuth, '{"auths":{}}'),
    fs.writeFile(workspaceFile, 'keep'),
    fs.writeFile(inProgressMarker, 'interrupted'),
  ]);
  await fs.chmod(path.join(storageRoot, 'volumes'), 0o555);
  await fs.chmod(storageRoot, 0o555);

  const firstReset = runReset(terminalHome, configHome, dataHome, runtimeDir);
  assert.equal(firstReset.status, 0, firstReset.stderr);
  assert.match(firstReset.stdout, /Initializing clean Podman 6 storage/);
  assert.equal(await pathExists(storageRoot), false);
  assert.equal(await pathExists(legacyCniRoot), false);
  assert.equal(await pathExists(runRoot), false);
  assert.equal(await pathExists(inProgressMarker), false);
  assert.equal(await pathExists(resetMarker), true);
  assert.equal(await fs.readFile(registryAuth, 'utf8'), '{"auths":{}}');
  assert.equal(await fs.readFile(workspaceFile, 'utf8'), 'keep');

  await fs.mkdir(storageRoot, { recursive: true });
  const currentDatabase = path.join(storageRoot, 'db.sql');
  await fs.writeFile(currentDatabase, 'podman-6-state');

  const secondReset = runReset(terminalHome, configHome, dataHome, runtimeDir);
  assert.equal(secondReset.status, 0, secondReset.stderr);
  assert.equal(secondReset.stdout, '');
  assert.equal(await fs.readFile(currentDatabase, 'utf8'), 'podman-6-state');

  await fs.mkdir(path.join(storageRoot, 'libpod'), { recursive: true });
  await fs.writeFile(path.join(storageRoot, 'libpod', 'bolt_state.db'), 'legacy-db');
  const restoredLegacyReset = runReset(
    terminalHome,
    configHome,
    dataHome,
    runtimeDir,
  );
  assert.equal(restoredLegacyReset.status, 0, restoredLegacyReset.stderr);
  assert.equal(await pathExists(storageRoot), false);
  assert.equal(await pathExists(resetMarker), true);
});

test('Podman 6 storage reset rejects paths outside the terminal home', async (t) => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'web-terminal-podman-reset-safety-'),
  );
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const terminalHome = path.join(temporaryRoot, 'home');
  const configHome = path.join(terminalHome, '.config');
  const outsideDataHome = path.join(temporaryRoot, 'outside-data');
  const runtimeDir = path.join(temporaryRoot, 'runtime');
  const sentinel = path.join(outsideDataHome, 'containers', 'storage', 'keep');
  await fs.mkdir(path.dirname(sentinel), { recursive: true });
  await fs.writeFile(sentinel, 'keep');

  const result = runReset(
    terminalHome,
    configHome,
    outsideDataHome,
    runtimeDir,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing unsafe Podman reset path/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
});
