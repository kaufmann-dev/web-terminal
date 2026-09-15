export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function sendUpload({ file, name, directory, csrfToken, signal, onProgress,
  createRequest = () => new XMLHttpRequest() }) {
  return new Promise((resolve, reject) => {
    const request = createRequest();
    const abort = () => request.abort();
    const done = (callback, value) => {
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    request.open('POST', `/api/uploads?${new URLSearchParams({ directory, filename: name })}`);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('CSRF-Token', csrfToken);
    request.upload.onprogress = (event) => onProgress(event.loaded, event.total || file.size);
    request.onload = () => {
      let data;
      try { data = JSON.parse(request.responseText); } catch { /* Proxy errors may be HTML. */ }
      if (request.status === 201 && typeof data?.path === 'string') {
        done(resolve, data);
      } else {
        const error = new Error(data?.error || `Upload failed (HTTP ${request.status}). Retry when ready.`);
        error.status = request.status;
        done(reject, error);
      }
    };
    request.onerror = () => done(reject, new Error('Connection lost. Check the destination before retrying.'));
    request.onabort = () => done(reject, new DOMException('Upload cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      done(reject, new DOMException('Upload cancelled.', 'AbortError'));
      return;
    }
    request.send(file);
  });
}

export class UploadQueue {
  constructor({ send, render = () => {}, onAuthExpired = () => {} }) {
    this.send = send;
    this.render = render;
    this.onAuthExpired = onAuthExpired;
    this.items = [];
    this.running = false;
    this.controller = null;
  }

  add(files) {
    if (this.running) return;
    for (const file of files) {
      const tooLarge = file.size > MAX_UPLOAD_BYTES;
      this.items.push({ file, name: file.name, status: tooLarge ? 'error' : 'pending',
        message: tooLarge ? 'File exceeds the 100 MiB limit.' : 'Ready', loaded: 0 });
    }
    this.render();
  }

  cancel() { this.controller?.abort(); }

  async run(directory, items = this.items.filter((item) => item.status !== 'saved')) {
    if (this.running || !items.length) return;
    this.running = true;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.render();
    try {
      for (const item of items) {
        if (signal.aborted) {
          item.status = 'cancelled';
          item.message = 'Cancelled';
          continue;
        }
        if (item.file.size > MAX_UPLOAD_BYTES) continue;
        item.status = 'uploading';
        item.loaded = 0;
        item.message = 'Uploading…';
        this.render();
        try {
          const result = await this.send({ file: item.file, name: item.name, directory, signal,
            onProgress: (loaded) => {
              item.loaded = loaded;
              item.message = loaded >= item.file.size ? 'Saving…' : 'Uploading…';
              this.render();
            } });
          item.status = 'saved';
          item.path = result.path;
          item.message = `Saved to ${result.path}`;
        } catch (error) {
          item.status = error.name === 'AbortError' ? 'cancelled' : 'error';
          item.message = error.message;
          if (error.status === 401) {
            this.cancel();
            this.onAuthExpired();
          }
        }
        this.render();
      }
    } finally {
      this.running = false;
      this.controller = null;
      this.render();
    }
  }
}

export function bindFileUploads({ document, apiRequest, getCsrfToken, closeSidebar, isMobile, onAuthExpired }) {
  const get = (id) => document.getElementById(id);
  const dialog = get('upload-dialog');
  const opener = get('upload-open');
  const picker = get('upload-files');
  const pathInput = get('upload-directory');
  const folders = get('upload-folders');
  const breadcrumbs = get('upload-breadcrumbs');
  const fileList = get('upload-file-list');
  const error = get('upload-error');
  const summary = get('upload-summary');
  const submit = get('upload-submit');
  const cancel = get('upload-cancel');
  const fields = get('upload-destination-fields');
  const choose = get('upload-choose');
  const workspace = document.querySelector('.terminal-workspace');
  const storageKey = 'terminal.upload-directory';
  let destination = null;
  let browsing = false;
  let browseSequence = 0;
  let configured = false;
  const setError = (message = '') => {
    error.textContent = message;
    error.hidden = !message;
  };
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const queue = new UploadQueue({
    send: (options) => sendUpload({ ...options, csrfToken: getCsrfToken() }),
    onAuthExpired,
    render: () => {
      fields.disabled = queue.running;
      choose.disabled = queue.running;
      submit.disabled = queue.running || browsing || !destination
        || !queue.items.some((item) => item.status !== 'saved' && item.file.size <= MAX_UPLOAD_BYTES);
      cancel.hidden = !queue.running;
      const saved = queue.items.filter((item) => item.status === 'saved').length;
      const failed = queue.items.filter((item) => item.status === 'error').length;
      const cancelled = queue.items.filter((item) => item.status === 'cancelled').length;
      const current = queue.items.find((item) => item.status === 'uploading');
      const percent = current ? Math.min(100, Math.round(current.loaded / Math.max(1, current.file.size) * 100)) : 0;
      opener.textContent = queue.running ? `Upload · ${percent}%` : 'Upload';
      summary.textContent = queue.running ? `${saved} of ${queue.items.length} saved. Uploading…`
        : queue.items.length ? `${saved} of ${queue.items.length} saved.${failed ? ` ${failed} failed.` : ''}${cancelled ? ` ${cancelled} cancelled.` : ''}`
          : 'Up to 100 MiB per file.';
      fileList.replaceChildren();
      for (const item of queue.items) {
        const row = element('li', '', 'upload-file');
        row.dataset.state = item.status;
        const heading = element('div', '', 'upload-file-heading');
        if (!queue.running && item.status !== 'saved') {
          const input = element('input');
          input.value = item.name;
          input.setAttribute('aria-label', `Filename for ${item.file.name}`);
          input.addEventListener('input', () => { item.name = input.value; });
          heading.append(input);
        } else {
          const name = element('span', item.name, 'upload-filename');
          name.title = item.name;
          heading.append(name);
        }
        heading.append(element('span', `${(item.file.size / (1024 * 1024)).toFixed(2)} MiB`, 'upload-size'));
        if (!queue.running) {
          if (['error', 'cancelled'].includes(item.status) && item.file.size <= MAX_UPLOAD_BYTES) {
            const retry = button('Retry', () => queue.run(destination, [item]));
            retry.disabled = !destination || browsing;
            heading.append(retry);
          }
          const remove = button(item.status === 'saved' ? 'Dismiss' : 'Remove', () => {
            queue.items = queue.items.filter((entry) => entry !== item);
            queue.render();
          });
          remove.setAttribute('aria-label', `${item.status === 'saved' ? 'Dismiss' : 'Remove'} ${item.name}`);
          heading.append(remove);
        }
        row.append(heading, element('p', item.message, 'upload-file-message'));
        if (item.status === 'uploading') {
          const progress = element('progress');
          progress.max = Math.max(1, item.file.size);
          progress.value = item.loaded;
          progress.setAttribute('aria-label', `Uploading ${item.name}`);
          row.append(progress);
        }
        fileList.append(row);
      }
    },
  });

  async function browse(path = '') {
    const sequence = ++browseSequence;
    browsing = true;
    destination = null;
    setError();
    folders.textContent = 'Loading folders…';
    queue.render();
    try {
      const data = await apiRequest(`/api/upload-directories?${new URLSearchParams({ path })}`);
      if (sequence !== browseSequence) return;
      destination = data.directory;
      pathInput.value = destination;
      try { sessionStorage.setItem(storageKey, destination); } catch { /* Storage is optional. */ }
      breadcrumbs.replaceChildren();
      let accumulated = data.root;
      breadcrumbs.append(button(data.root, () => browse(data.root)));
      for (const part of destination.slice(data.root.length).split('/').filter(Boolean)) {
        accumulated = `${accumulated.replace(/\/$/, '')}/${part}`;
        const target = accumulated;
        breadcrumbs.append(element('span', '/'), button(part, () => browse(target)));
      }
      folders.replaceChildren();
      for (const name of data.directories) {
        const entry = button(name, () => browse(`${data.directory}/${name}`));
        entry.title = name;
        folders.append(entry);
      }
      if (!data.directories.length) folders.textContent = 'No subfolders. You can upload into this folder.';
    } catch (failure) {
      if (sequence !== browseSequence) return;
      folders.textContent = '';
      setError(failure.message);
    } finally {
      if (sequence === browseSequence) {
        browsing = false;
        queue.render();
      }
    }
  }

  function open(files = []) {
    if (!configured) return;
    closeSidebar();
    if (!dialog.open) dialog.showModal();
    queue.add(files);
    if (!destination && !browsing) {
      let remembered = '';
      try { remembered = sessionStorage.getItem(storageKey) || ''; } catch { /* Storage is optional. */ }
      browse(remembered);
    }
  }
  opener.addEventListener('click', () => open());
  get('upload-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    (isMobile() ? get('sidebar-toggle') : opener).focus({ preventScroll: true });
  });
  choose.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    queue.add(picker.files);
    picker.value = '';
  });
  pathInput.addEventListener('input', () => {
    ++browseSequence;
    browsing = false;
    destination = null;
    queue.render();
  });
  get('upload-path-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!queue.running) browse(pathInput.value);
  });
  submit.addEventListener('click', () => { if (destination) queue.run(destination); });
  cancel.addEventListener('click', () => queue.cancel());

  let dragDepth = 0;
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  workspace.addEventListener('dragenter', (event) => {
    if (!hasFiles(event) || !configured) return;
    event.preventDefault();
    dragDepth += 1;
    workspace.classList.add('upload-dragging');
  });
  workspace.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) workspace.classList.remove('upload-dragging');
  });
  document.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    workspace.classList.remove('upload-dragging');
    if (!workspace.contains(event.target) && !dialog.contains(event.target)) return;
    if (queue.running) { open(); setError('Wait for the upload to finish before adding files.'); return; }
    const items = Array.from(event.dataTransfer.items || []);
    if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      open();
      setError('Choose individual files. To upload a folder, ZIP it first.');
      return;
    }
    open(Array.from(event.dataTransfer.files));
  });
  window.addEventListener('pagehide', () => queue.cancel());
  window.addEventListener('beforeunload', () => queue.cancel());
  queue.render();
  return {
    enable() { configured = true; opener.disabled = false; },
    cancel() { queue.cancel(); },
  };
}
