'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const TYPE_SAMPLE_BYTES = 8 * 1024;
const INLINE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.pdf', 'application/pdf'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
]);

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
  if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return new UploadError(400, 'Choose an existing location inside the workspace.');
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

// Returns the only media types a workspace file may be rendered as in the browser. Anything
// that is not an allowlisted image, PDF, audio or video file is shown as plain text or not at all.
function inlineType(name, head) {
  const known = INLINE_TYPES.get(path.extname(name).toLowerCase());
  if (known) return known;
  if (head.includes(0)) return null;
  // The sample may end inside a multi-byte character.
  for (let trim = 0; trim <= Math.min(3, head.length); trim += 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - trim));
      return 'text/plain; charset=utf-8';
    } catch { /* Try a shorter sample. */ }
    if (head.length < TYPE_SAMPLE_BYTES) break;
  }
  return null;
}

class WorkspaceFileStore {
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
      const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
        try {
          const stats = await fs.lstat(`${target.anchoredPath}/${entry.name}`);
          return stats.isFile() ? { name: entry.name, size: stats.size, modified: stats.mtimeMs } : null;
        } catch {
          return null;
        }
      }));
      return {
        root: target.root,
        directory: target.directory,
        directories: entries.filter((entry) => entry.isDirectory())
          .map((entry) => entry.name).sort((a, b) => a.localeCompare(b)),
        files: files.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)),
      };
    } finally {
      await target.handle.close();
    }
  }

  async openFile(value) {
    if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) {
      throw new UploadError(400, 'Choose a file inside the workspace.');
    }
    const name = path.basename(value);
    validateFilename(name);
    const target = await this.openDirectory(path.dirname(value));
    let handle;
    try {
      // O_NOFOLLOW rejects symlinks; O_NONBLOCK keeps a FIFO from blocking the open.
      handle = await fs.open(`${target.anchoredPath}/${name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stats = await handle.stat();
      if (!stats.isFile()) throw new UploadError(400, 'Choose a file inside the workspace.');
      const sample = Buffer.alloc(Math.min(TYPE_SAMPLE_BYTES, stats.size));
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      return { handle, name, size: stats.size, type: inlineType(name, sample.subarray(0, bytesRead)) };
    } catch (error) {
      await handle?.close();
      throw error;
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

module.exports = { WorkspaceFileStore, UploadError, uploadError, inlineType, MAX_UPLOAD_BYTES };
