'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function uploadError(error) {
  if (error instanceof UploadError) return error;
  if (error.name === 'AbortError') return new UploadError(409, 'Upload cancelled.');
  if (error.code === 'EEXIST') return new UploadError(409, 'A file with this name already exists. Rename it and retry.');
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return new UploadError(403, 'The destination is not writable or accessible.');
  if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return new UploadError(400, 'Choose an existing directory inside the workspace.');
  if (error.code === 'ENOSPC' || error.code === 'EDQUOT') return new UploadError(507, 'There is not enough space to save this file.');
  return new UploadError(503, 'File storage is unavailable.');
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateFilename(filename) {
  if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..'
    || /[\\/\x00-\x1f\x7f]/.test(filename) || Buffer.byteLength(filename) > 255) {
    throw new UploadError(400, 'Use a filename without slashes or control characters, up to 255 bytes.');
  }
}

class FileUploadStore {
  constructor({ directory, maxBytes = MAX_UPLOAD_BYTES }) {
    this.directory = directory;
    this.maxBytes = maxBytes;
  }

  async openDirectory(value = '') {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) {
      throw new UploadError(400, 'Enter a valid destination directory.');
    }
    const root = await fs.realpath(this.directory);
    const requested = path.resolve(this.directory, value);
    if (!isWithin(this.directory, requested) && !isWithin(root, requested)) {
      throw new UploadError(403, 'The destination must be inside the workspace.');
    }
    const directory = await fs.realpath(requested);
    if (!isWithin(root, directory)) throw new UploadError(403, 'The destination must be inside the workspace.');

    // Walk canonical components through pinned Linux directory descriptors. A swapped
    // symlink cannot redirect a later temporary-file creation or publication.
    let handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const component of path.relative(root, directory).split(path.sep).filter(Boolean)) {
        const next = await fs.open(`/proc/self/fd/${handle.fd}/${component}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await handle.close();
        handle = next;
      }
      return { root, directory, handle, anchoredPath: `/proc/self/fd/${handle.fd}` };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async list(value) {
    const target = await this.openDirectory(value);
    try {
      const entries = await fs.readdir(target.anchoredPath, { withFileTypes: true });
      return {
        root: target.root,
        directory: target.directory,
        directories: entries.filter((entry) => entry.isDirectory())
          .map((entry) => entry.name).sort((a, b) => a.localeCompare(b)),
      };
    } finally {
      await target.handle.close();
    }
  }

  async save(request, { directory, filename, signal, onAccepted = () => {}, beforePublish = () => {} }) {
    validateFilename(filename);
    const length = request.headers?.['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > this.maxBytes)) {
      throw new UploadError(413, 'File exceeds the 100 MiB limit.');
    }
    const target = await this.openDirectory(directory);
    const temporary = `${target.anchoredPath}/.web-terminal-upload-${randomUUID()}.part`;
    const destination = `${target.anchoredPath}/${filename}`;
    let file;
    let input;
    let bytes = 0;
    const abortInput = () => input?.destroy(signal.reason || new DOMException('Cancelled', 'AbortError'));
    const disconnected = () => input?.destroy(new DOMException('Disconnected', 'AbortError'));
    try {
      signal.throwIfAborted();
      try {
        await fs.lstat(destination);
        throw new UploadError(409, 'A file with this name already exists. Rename it and retry.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      file = await fs.open(temporary, 'wx', 0o600);
      signal.throwIfAborted();
      await onAccepted();
      input = new PassThrough();
      signal.addEventListener('abort', abortInput, { once: true });
      request.on('aborted', disconnected);
      request.on('error', disconnected);
      if (request.aborted) disconnected();
      if (signal.aborted) abortInput();
      request.pipe(input);
      for await (const chunk of input) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > this.maxBytes) throw new UploadError(413, 'File exceeds the 100 MiB limit.');
        await file.writeFile(chunk);
      }
      await file.close();
      file = null;
      signal.throwIfAborted();
      await beforePublish();
      const actualDirectory = await fs.realpath(target.anchoredPath);
      if (actualDirectory !== target.directory || !isWithin(target.root, actualDirectory)) {
        throw new UploadError(409, 'The destination moved during upload. Choose it again.');
      }
      // Hard-link publication is atomic and fails if any entry already has this name.
      await fs.link(temporary, destination);
      return { path: path.join(target.directory, filename), bytes };
    } finally {
      signal.removeEventListener('abort', abortInput);
      request.removeListener('aborted', disconnected);
      request.removeListener('error', disconnected);
      if (input) {
        request.unpipe(input);
        input.destroy();
      }
      request.resume();
      await file?.close();
      try {
        await fs.unlink(temporary);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      } finally {
        await target.handle.close();
      }
    }
  }
}

module.exports = { FileUploadStore, UploadError, uploadError, MAX_UPLOAD_BYTES };
