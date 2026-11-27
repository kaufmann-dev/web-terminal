const assert = require('node:assert/strict');
const test = require('node:test');

const photoModule = () => import('../public/js/photo-capture.mjs');

function fakeCanvas({ blob = new Blob(['jpeg'], { type: 'image/jpeg' }) } = {}) {
  const calls = [];
  const context = {
    set fillStyle(value) { calls.push(['fillStyle', value]); },
    set imageSmoothingQuality(value) { calls.push(['imageSmoothingQuality', value]); },
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
  };
  const canvas = {
    calls,
    getContext: (type) => {
      assert.equal(type, '2d');
      return context;
    },
    toBlob: (callback, type, quality) => {
      calls.push(['toBlob', type, quality]);
      callback(blob);
    },
  };
  return canvas;
}

function fakeBitmap(width, height) {
  return { width, height, closed: 0, close() { this.closed += 1; } };
}

test('photo size scales the long edge down to 2048 pixels and never up', async () => {
  const { PHOTO_MAX_EDGE, scaledPhotoSize } = await photoModule();
  assert.equal(PHOTO_MAX_EDGE, 2048);
  assert.deepEqual(scaledPhotoSize(8160, 6120), { width: 2048, height: 1536 });
  assert.deepEqual(scaledPhotoSize(3024, 4032), { width: 1536, height: 2048 });
  assert.deepEqual(scaledPhotoSize(1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(scaledPhotoSize(20000, 3), { width: 2048, height: 1 });
});

test('photos are decoded upright, flattened on white, scaled, and encoded as JPEG', async () => {
  const { PHOTO_JPEG_QUALITY, preparePhoto } = await photoModule();
  const file = new Blob(['photo'], { type: 'image/jpeg' });
  const bitmap = fakeBitmap(4032, 3024);
  const canvas = fakeCanvas();
  const photo = await preparePhoto(file, {
    decode: async (blob) => {
      assert.equal(blob, file);
      return bitmap;
    },
    createCanvas: () => canvas,
  });

  assert.equal(photo.type, 'image/jpeg');
  assert.equal(canvas.width, 2048);
  assert.equal(canvas.height, 1536);
  assert.deepEqual(canvas.calls, [
    ['fillStyle', '#fff'],
    ['fillRect', 0, 0, 2048, 1536],
    ['imageSmoothingQuality', 'high'],
    ['drawImage', bitmap, 0, 0, 2048, 1536],
    ['toBlob', 'image/jpeg', PHOTO_JPEG_QUALITY],
  ]);
  assert.equal(bitmap.closed, 1);
});

test('the default decoder applies the image orientation', async () => {
  const { preparePhoto } = await photoModule();
  const bitmap = fakeBitmap(10, 10);
  const original = globalThis.createImageBitmap;
  let options;
  globalThis.createImageBitmap = async (_blob, decodeOptions) => {
    options = decodeOptions;
    return bitmap;
  };
  try {
    await preparePhoto(new Blob(['photo']), { createCanvas: () => fakeCanvas() });
  } finally {
    globalThis.createImageBitmap = original;
  }
  assert.deepEqual(options, { imageOrientation: 'from-image' });
});

test('encoding failures reject and still release the decoded bitmap', async () => {
  const { preparePhoto } = await photoModule();
  const bitmap = fakeBitmap(100, 100);
  await assert.rejects(
    preparePhoto(new Blob(['photo']), {
      decode: async () => bitmap,
      createCanvas: () => fakeCanvas({ blob: null }),
    }),
    /Unable to encode the photo/,
  );
  assert.equal(bitmap.closed, 1);

  const drawFailure = fakeBitmap(100, 100);
  const canvas = fakeCanvas();
  canvas.getContext = () => { throw new Error('no context'); };
  await assert.rejects(
    preparePhoto(new Blob(['photo']), { decode: async () => drawFailure, createCanvas: () => canvas }),
    /no context/,
  );
  assert.equal(drawFailure.closed, 1);
});
