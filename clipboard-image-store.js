'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
const CLIPBOARD_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const IMAGE_TYPES = Object.freeze({
  'image/png': { extension: 'png' },
  'image/jpeg': { extension: 'jpg' },
  'image/webp': { extension: 'webp' },
});

class ClipboardImageValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_CLIPBOARD_IMAGE';
  }
}

function detectImageContentType(data) {
  if (!Buffer.isBuffer(data)) {
    return null;
  }
  if (data.length >= 8
    && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

class ClipboardImageStore {
  constructor(options) {
    this.directory = options.directory;
    this.maxAgeMs = options.maxAgeMs ?? CLIPBOARD_IMAGE_MAX_AGE_MS;
    this.now = options.now || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    await this.pruneExpired();
  }

  async pruneExpired() {
    let entries;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return;
      }
      throw err;
    }

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      const filePath = path.join(this.directory, entry.name);
      try {
        const stat = await fs.stat(filePath);
        if (this.now() - stat.mtimeMs > this.maxAgeMs) {
          await fs.unlink(filePath);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }
    }));
  }

  async save(data, declaredContentType) {
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new ClipboardImageValidationError('Clipboard image is empty.');
    }
    if (data.length > MAX_CLIPBOARD_IMAGE_BYTES) {
      throw new ClipboardImageValidationError('Clipboard image exceeds the 10 MiB limit.');
    }

    const detectedContentType = detectImageContentType(data);
    if (!IMAGE_TYPES[declaredContentType] || detectedContentType !== declaredContentType) {
      throw new ClipboardImageValidationError('Clipboard image type does not match its contents.');
    }

    await this.initialize();
    const extension = IMAGE_TYPES[detectedContentType].extension;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const randomName = this.randomBytes(16).toString('hex');
      const filePath = path.join(this.directory, `clipboard-${randomName}.${extension}`);
      try {
        await fs.writeFile(filePath, data, { flag: 'wx', mode: 0o600 });
        return filePath;
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw err;
        }
      }
    }
    throw new Error('Unable to allocate a unique clipboard image path.');
  }
}

module.exports = {
  CLIPBOARD_IMAGE_MAX_AGE_MS,
  IMAGE_TYPES,
  MAX_CLIPBOARD_IMAGE_BYTES,
  ClipboardImageStore,
  ClipboardImageValidationError,
  detectImageContentType,
};
