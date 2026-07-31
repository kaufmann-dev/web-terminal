'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const clipboardReaderModule = import(pathToFileURL(
  path.join(__dirname, '..', 'public', 'js', 'clipboard-reader.mjs'),
));

function clipboardItem(representations) {
  return {
    types: Object.keys(representations),
    async getType(type) {
      return representations[type];
    },
  };
}

test('rich clipboard reads every supported image type', async () => {
  const { readClipboardContent } = await clipboardReaderModule;

  for (const contentType of ['image/png', 'image/jpeg', 'image/webp']) {
    const image = new Blob([contentType], { type: contentType });
    const result = await readClipboardContent({
      async read() {
        return [clipboardItem({ [contentType]: image })];
      },
    });

    assert.deepEqual(result, { kind: 'image', image, contentType });
  }
});

test('rich clipboard prioritizes an image over text across items', async () => {
  const { readClipboardContent } = await clipboardReaderModule;
  const image = new Blob(['webp'], { type: 'image/webp' });

  const result = await readClipboardContent({
    async read() {
      return [
        clipboardItem({ 'text/plain': new Blob(['caption'], { type: 'text/plain' }) }),
        clipboardItem({ 'image/webp': image }),
      ];
    },
  });

  assert.deepEqual(result, {
    kind: 'image',
    image,
    contentType: 'image/webp',
  });
});

test('rich clipboard reads plain text when no supported image exists', async () => {
  const { readClipboardContent } = await clipboardReaderModule;

  const result = await readClipboardContent({
    async read() {
      return [clipboardItem({
        'image/gif': new Blob(['gif'], { type: 'image/gif' }),
        'text/plain': new Blob(['terminal input'], { type: 'text/plain' }),
      })];
    },
  });

  assert.deepEqual(result, { kind: 'text', text: 'terminal input' });
});

test('rich clipboard distinguishes empty and unsupported content', async () => {
  const { readClipboardContent } = await clipboardReaderModule;

  assert.deepEqual(
    await readClipboardContent({ read: async () => [] }),
    { kind: 'empty' },
  );
  assert.deepEqual(
    await readClipboardContent({
      read: async () => [clipboardItem({
        'image/gif': new Blob(['gif'], { type: 'image/gif' }),
      })],
    }),
    { kind: 'unsupported' },
  );
});

test('clipboard falls back to readText only when rich reads are unavailable', async () => {
  const { readClipboardContent } = await clipboardReaderModule;
  let readTextCalls = 0;

  const result = await readClipboardContent({
    async readText() {
      readTextCalls += 1;
      return 'fallback text';
    },
  });

  assert.deepEqual(result, { kind: 'text', text: 'fallback text' });
  assert.equal(readTextCalls, 1);
});

test('rejected rich reads report denial without retrying as text', async () => {
  const { readClipboardContent } = await clipboardReaderModule;
  const error = new DOMException('Paste denied.', 'NotAllowedError');
  let readTextCalls = 0;

  const result = await readClipboardContent({
    async read() {
      throw error;
    },
    async readText() {
      readTextCalls += 1;
      return 'must not paste';
    },
  });

  assert.deepEqual(result, { kind: 'denied', error });
  assert.equal(readTextCalls, 0);
});

test('clipboard reports unavailable access and empty fallback text', async () => {
  const { readClipboardContent } = await clipboardReaderModule;

  assert.deepEqual(await readClipboardContent(undefined), { kind: 'unavailable' });
  assert.deepEqual(await readClipboardContent({}), { kind: 'unavailable' });
  assert.deepEqual(
    await readClipboardContent({ readText: async () => '' }),
    { kind: 'empty' },
  );
});
