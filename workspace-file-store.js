'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { finished } = require('node:stream/promises');
const { ZipFile } = require('yazl');

const MIB = 1024 * 1024;
const DEFAULT_UPLOAD_LIMIT_MIB = 100;
const UPLOAD_CHUNK_BYTES = 8 * MIB;
const PART_PREFIX = '.web-terminal-upload-';
const PART_SUFFIX = '.part';
const STALE_PART_MS = 24 * 60 * 60 * 1000;
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

// Archives store these already-compressed formats as-is instead of deflating them again.
const STORED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.mp3', '.m4a', '.ogg', '.opus', '.flac',
  '.mp4', '.m4v', '.mov', '.webm', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar',
  '.woff2', '.docx', '.xlsx', '.pptx', '.jar',
]);
// Entries that disappear or change type between listing and opening are left out of an archive.
const VANISHED_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

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
  if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return new UploadError(400, 'Choose an existing folder.');
  if (error.code === 'ENOSPC' || error.code === 'EDQUOT') return new UploadError(507, 'There is not enough space to save this file.');
  return new UploadError(503, 'File storage is unavailable.');
}

async function assertAvailable(target, filename) {
  try {
    await fs.lstat(`${target.anchoredPath}/${filename}`);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new UploadError(409, 'A file with this name already exists. Rename it and retry.');
}

async function removeEntry(entryPath) {
  try {
    await fs.unlink(entryPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
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

// ZIP uses '/' as its only separator, and many extractors also split names on backslashes.
function archivePath(name) {
  return name.replaceAll('\\', '_');
}

async function openEntry(entryPath, flags) {
  try {
    return await fs.open(entryPath, flags);
  } catch (error) {
    if (VANISHED_CODES.has(error.code)) return null;
    throw error;
  }
}

async function addDirectory(zip, directory, prefix, options) {
  const { includeHidden, signal } = options;
  const stats = await directory.stat();
  zip.addEmptyDirectory(prefix, { mtime: stats.mtime, mode: stats.mode });
  const anchoredPath = `/proc/self/fd/${directory.fd}`;
  const entries = (await fs.readdir(anchoredPath, { withFileTypes: true }))
    .filter((entry) => includeHidden || !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    signal.throwIfAborted();
    const entryPath = `${anchoredPath}/${entry.name}`;
    const archiveName = `${prefix}/${archivePath(entry.name)}`;
    if (entry.isDirectory()) {
      const child = await openEntry(entryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!child) continue;
      try {
        await addDirectory(zip, child, archiveName, options);
      } finally {
        await child.close();
      }
    } else if (entry.isFile()) {
      // O_NONBLOCK keeps a FIFO swapped in after the listing from blocking the open.
      const file = await openEntry(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!file) continue;
      let input;
      try {
        const fileStats = await file.stat();
        if (!fileStats.isFile()) continue;
        input = file.createReadStream();
        zip.addReadStreamLazy(archiveName, { mtime: fileStats.mtime, mode: fileStats.mode,
          compress: !STORED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) },
        (callback) => callback(null, input));
        // One file at a time: the output's backpressure paces disk reads.
        await finished(input, { signal });
      } finally {
        if (input) input.destroy();
        else await file.close();
      }
    }
  }
}

class WorkspaceFileStore {
  constructor({ directory, maxBytes = DEFAULT_UPLOAD_LIMIT_MIB * MIB }) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.activeParts = new Set();
    this.tooLargeMessage = `File exceeds the ${maxBytes % MIB ? `${maxBytes}-byte` : `${maxBytes / MIB} MiB`} limit.`;
  }

  // Empty and relative paths resolve against the workspace; any folder the server user can reach
  // may be opened.
  async openDirectory(value = '') {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) {
      throw new UploadError(400, 'Enter a valid destination directory.');
    }
    const directory = await fs.realpath(path.resolve(this.directory, value));

    // Walk canonical components from / through pinned Linux directory descriptors. A swapped
    // symlink cannot redirect a later temporary-file creation or publication.
    let handle = await fs.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const component of directory.split(path.sep).filter(Boolean)) {
        const next = await fs.open(`/proc/self/fd/${handle.fd}/${component}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await handle.close();
        handle = next;
      }
      return { directory, handle, anchoredPath: `/proc/self/fd/${handle.fd}` };
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
      throw new UploadError(400, 'Choose a regular file.');
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
      if (!stats.isFile()) throw new UploadError(400, 'Choose a regular file.');
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

  // Streams a folder as a ZIP whose entries sit under one top-level folder. Only regular files and
  // directories are included, each opened through its parent's pinned descriptor with O_NOFOLLOW.
  async archive(value, { includeHidden = false, signal }) {
    const target = await this.openDirectory(value);
    const name = path.basename(target.directory) || 'root';
    const zip = new ZipFile();
    const stream = zip.outputStream;
    // The walk stops when the caller aborts or the stream closes early, for example on disconnect.
    const walk = new AbortController();
    zip.on('error', (error) => stream.destroy(error));
    stream.once('close', () => walk.abort());
    const abort = () => stream.destroy(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    (async () => {
      try {
        await addDirectory(zip, target.handle, archivePath(name), { includeHidden, signal: walk.signal });
        zip.end();
      } catch (error) {
        stream.destroy(error);
      } finally {
        signal.removeEventListener('abort', abort);
        await target.handle.close();
      }
    })();
    return { name, stream };
  }

  // Partial uploads live beside their destination, so publication is a same-filesystem hard link.
  // The partial's name derives from the file's identity and its size is the resume offset, so an
  // upload resumes after a disconnect, page reload, or server restart.
  identify({ filename, size, lastModified }) {
    validateFilename(filename);
    if (!/^\d+$/.test(String(size)) || !Number.isSafeInteger(Number(size))) {
      throw new UploadError(400, 'Enter a valid file size.');
    }
    if (!/^-?\d+$/.test(String(lastModified)) || !Number.isSafeInteger(Number(lastModified))) {
      throw new UploadError(400, 'Enter a valid modification time.');
    }
    if (Number(size) > this.maxBytes) throw new UploadError(413, this.tooLargeMessage);
    const digest = createHash('sha256')
      .update(JSON.stringify([filename, Number(size), Number(lastModified)])).digest('hex').slice(0, 32);
    return { filename, size: Number(size), part: `${PART_PREFIX}${digest}${PART_SUFFIX}` };
  }

  async begin(upload, { directory }) {
    const { filename, size, part } = this.identify(upload);
    const target = await this.openDirectory(directory);
    try {
      await this.removeStaleParts(target);
      await assertAvailable(target, filename);
      let offset = 0;
      try {
        const stats = await fs.lstat(`${target.anchoredPath}/${part}`);
        if (stats.isFile() && stats.size <= size) offset = stats.size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return { directory: target.directory, offset };
    } finally {
      await target.handle.close();
    }
  }

  // Appends one chunk at `offset`. Bytes received before a disconnect stay in the partial, and the
  // final chunk publishes the file.
  async append(request, upload, { directory, offset, signal, onAccepted = () => {}, beforePublish = () => {} }) {
    const { filename, size, part } = this.identify(upload);
    if (!/^\d+$/.test(String(offset)) || Number(offset) > size) {
      throw new UploadError(400, 'Enter a valid upload offset.');
    }
    const start = Number(offset);
    const limit = Math.min(size - start, UPLOAD_CHUNK_BYTES);
    const length = request.headers?.['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
      throw new UploadError(413, 'The upload chunk is too large.');
    }
    const target = await this.openDirectory(directory);
    const key = `${target.directory}\0${part}`;
    if (this.activeParts.has(key)) {
      await target.handle.close();
      throw new UploadError(409, 'This file is already uploading in another window.');
    }
    this.activeParts.add(key);
    const partial = `${target.anchoredPath}/${part}`;
    let file;
    let input;
    let bytes = 0;
    const abortInput = () => input?.destroy(signal.reason || new DOMException('Cancelled', 'AbortError'));
    const disconnected = () => input?.destroy(new DOMException('Disconnected', 'AbortError'));
    try {
      signal.throwIfAborted();
      await assertAvailable(target, filename);
      file = await fs.open(partial,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stats = await file.stat();
      if (!stats.isFile()) throw new UploadError(409, 'The partial upload is not a regular file.');
      let current = stats.size;
      if (current > size) {
        await file.truncate(0);
        current = 0;
      }
      if (current !== start) {
        throw Object.assign(new UploadError(409, 'The upload position changed.'), { offset: current });
      }
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
        if (bytes + chunk.length > limit) {
          await file.truncate(start);
          throw new UploadError(413, 'The upload chunk is too large.');
        }
        bytes += chunk.length;
        await file.writeFile(chunk);
      }
      if (start + bytes < size) return { offset: start + bytes };
      await file.sync();
      await file.close();
      file = null;
      signal.throwIfAborted();
      await beforePublish();
      // A partial that cannot be published here is useless: a renamed or redirected upload has a
      // different identity.
      try {
        const actualDirectory = await fs.realpath(target.anchoredPath);
        if (actualDirectory !== target.directory) {
          throw new UploadError(409, 'The destination moved during upload. Choose it again.');
        }
        // Hard-link publication is atomic and fails if any entry already has this name.
        await fs.link(partial, `${target.anchoredPath}/${filename}`);
      } finally {
        await removeEntry(partial);
      }
      return { path: path.join(target.directory, filename), bytes: size };
    } finally {
      signal.removeEventListener('abort', abortInput);
      request.removeListener('aborted', disconnected);
      request.removeListener('error', disconnected);
      if (input) {
        request.unpipe(input);
        input.destroy();
      }
      request.resume();
      try {
        await file?.close();
      } finally {
        this.activeParts.delete(key);
        await target.handle.close();
      }
    }
  }

  async discard(upload, { directory }) {
    const { part } = this.identify(upload);
    const target = await this.openDirectory(directory);
    try {
      if (this.activeParts.has(`${target.directory}\0${part}`)) {
        throw new UploadError(409, 'This file is still uploading.');
      }
      await removeEntry(`${target.anchoredPath}/${part}`);
    } finally {
      await target.handle.close();
    }
  }

  // Abandoned partials are removed when a later upload starts in the same folder.
  async removeStaleParts(target) {
    const now = Date.now();
    for (const entry of await fs.readdir(target.anchoredPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(PART_PREFIX) || !entry.name.endsWith(PART_SUFFIX)
        || this.activeParts.has(`${target.directory}\0${entry.name}`)) continue;
      const entryPath = `${target.anchoredPath}/${entry.name}`;
      try {
        const stats = await fs.lstat(entryPath);
        if (stats.isFile() && now - stats.mtimeMs > STALE_PART_MS) await removeEntry(entryPath);
      } catch (error) {
        if (!VANISHED_CODES.has(error.code)) throw error;
      }
    }
  }
}

module.exports = { WorkspaceFileStore, UploadError, uploadError, inlineType, DEFAULT_UPLOAD_LIMIT_MIB,
  UPLOAD_CHUNK_BYTES, STALE_PART_MS };
