'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const sessionNameModule = import(pathToFileURL(
  path.join(__dirname, '..', 'public', 'js', 'session-name.mjs'),
));

test('terminal name input lowercases typed and submitted uppercase letters', async () => {
  const { bindTerminalSessionNameNormalization } = await sessionNameModule;
  const listeners = new Map();
  const restoredSelections = [];
  const input = {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    selectionDirection: 'none',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    setSelectionRange(start, end, direction) {
      restoredSelections.push({ start, end, direction });
    },
  };
  const normalize = bindTerminalSessionNameNormalization(input);

  input.value = 'My-PROJECT';
  input.selectionStart = 3;
  input.selectionEnd = 3;
  listeners.get('input')();

  assert.equal(input.value, 'my-project');
  assert.deepEqual(restoredSelections, [{ start: 3, end: 3, direction: 'none' }]);

  input.value = 'ANOTHER-One';
  assert.equal(normalize(), 'another-one');
  assert.equal(input.value, 'another-one');
});
