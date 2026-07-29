const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const terminalInputModule = import(pathToFileURL(
  path.join(__dirname, '..', 'public', 'js', 'terminal-input.mjs'),
));

test('mobile terminal keys follow normal and application cursor modes', async () => {
  const { encodeMobileTerminalKey } = await terminalInputModule;

  assert.equal(encodeMobileTerminalKey('escape', false), '\u001b');
  assert.equal(encodeMobileTerminalKey('tab', false), '\t');
  assert.equal(encodeMobileTerminalKey('arrow-left', false), '\u001b[D');
  assert.equal(encodeMobileTerminalKey('arrow-up', true), '\u001bOA');
  assert.equal(encodeMobileTerminalKey('arrow-down', false), '\u001b[B');
  assert.equal(encodeMobileTerminalKey('arrow-right', true), '\u001bOC');
  assert.equal(encodeMobileTerminalKey('home', false), '\u001b[H');
  assert.equal(encodeMobileTerminalKey('home', true), '\u001bOH');
  assert.equal(encodeMobileTerminalKey('end', false), '\u001b[F');
  assert.equal(encodeMobileTerminalKey('end', true), '\u001bOF');
  assert.equal(encodeMobileTerminalKey('page-up', false), '\u001b[5~');
  assert.equal(encodeMobileTerminalKey('page-down', false), '\u001b[6~');
  assert.equal(encodeMobileTerminalKey('unknown', false), null);
});

test('mobile terminal keys encode Ctrl and Alt like xterm', async () => {
  const { encodeMobileTerminalKey } = await terminalInputModule;

  assert.equal(
    encodeMobileTerminalKey('arrow-left', false, { ctrl: true }),
    '\u001b[1;5D',
  );
  assert.equal(
    encodeMobileTerminalKey('arrow-up', true, { alt: true }),
    '\u001b[1;3A',
  );
  assert.equal(
    encodeMobileTerminalKey('end', true, { ctrl: true, alt: true }),
    '\u001b[1;7F',
  );
  assert.equal(
    encodeMobileTerminalKey('page-up', false, { ctrl: true }),
    '\u001b[5;5~',
  );
  assert.equal(
    encodeMobileTerminalKey('page-down', false, { ctrl: true, alt: true }),
    '\u001b[6;7~',
  );
  assert.equal(
    encodeMobileTerminalKey('page-down', false, { alt: true }),
    '\u001b[6~',
  );
  assert.equal(
    encodeMobileTerminalKey('escape', false, { alt: true }),
    '\u001b\u001b',
  );
});

test('one-shot modifiers transform the next typed character', async () => {
  const { transformMobileTerminalInput } = await terminalInputModule;

  assert.deepEqual(
    transformMobileTerminalInput('c', { ctrl: true }),
    { data: '\u0003', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('C', { ctrl: true }),
    { data: '\u0003', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('v', { alt: true }),
    { data: '\u001bv', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('c', { ctrl: true, alt: true }),
    { data: '\u001b\u0003', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('ab', { ctrl: true }),
    { data: '\u0001b', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('é', { ctrl: true }),
    { data: 'é', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('é', { alt: true }),
    { data: '\u001bé', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('plain text'),
    { data: 'plain text', consumed: false },
  );
});

test('Ctrl input supports xterm control-character aliases', async () => {
  const { transformMobileTerminalInput } = await terminalInputModule;
  const expectedControls = new Map([
    [' ', '\u0000'],
    ['@', '\u0000'],
    ['3', '\u001b'],
    ['4', '\u001c'],
    ['5', '\u001d'],
    ['6', '\u001e'],
    ['7', '\u001f'],
    ['8', '\u007f'],
    ['[', '\u001b'],
    ['\\', '\u001c'],
    [']', '\u001d'],
    ['^', '\u001e'],
    ['_', '\u001f'],
  ]);

  for (const [input, expected] of expectedControls) {
    assert.deepEqual(
      transformMobileTerminalInput(input, { ctrl: true }),
      { data: expected, consumed: true },
    );
  }
});

test('terminal protocol reports bypass armed mobile modifiers', async () => {
  const { transformMobileTerminalInput } = await terminalInputModule;
  const modifiers = { ctrl: true, alt: true };

  assert.deepEqual(
    transformMobileTerminalInput('\u001b[I', modifiers),
    { data: '\u001b[I', consumed: false },
  );
  assert.deepEqual(
    transformMobileTerminalInput('\u001b[O', modifiers),
    { data: '\u001b[O', consumed: false },
  );
  assert.deepEqual(
    transformMobileTerminalInput('\u001b[<0;12;8M', modifiers),
    { data: '\u001b[<0;12;8M', consumed: false },
  );
  assert.deepEqual(
    transformMobileTerminalInput('\u001b[200~pasted\u001b[201~', modifiers),
    { data: '\u001b[200~pasted\u001b[201~', consumed: true },
  );
});
