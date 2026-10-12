'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const terminalClipboardModule = import(pathToFileURL(
  path.join(__dirname, '..', 'public', 'js', 'terminal-clipboard.mjs'),
));

test('OSC 52 clipboard writes decode UTF-8 text for any selection target', async () => {
  const { decodeOsc52ClipboardWrite } = await terminalClipboardModule;
  const encoded = Buffer.from('Model: GPT ✓\nline two', 'utf8').toString('base64');

  assert.equal(decodeOsc52ClipboardWrite(`c;${encoded}`), 'Model: GPT ✓\nline two');
  assert.equal(decodeOsc52ClipboardWrite(`;${encoded}`), 'Model: GPT ✓\nline two');
  assert.equal(decodeOsc52ClipboardWrite(`pc;${encoded}`), 'Model: GPT ✓\nline two');
});

test('OSC 52 queries and malformed payloads are ignored', async () => {
  const { decodeOsc52ClipboardWrite } = await terminalClipboardModule;
  const invalidUtf8 = Buffer.from([0xff, 0xfe]).toString('base64');

  for (const payload of ['c;?', 'c;', 'c', 'c;not base64!', `c;${invalidUtf8}`]) {
    assert.equal(decodeOsc52ClipboardWrite(payload), null, payload);
  }
});
