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

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes || 0)} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function breadcrumbSegments(root, directory) {
  const segments = [{ label: root, path: root }];
  let accumulated = root;
  for (const part of directory.slice(root.length).split('/').filter(Boolean)) {
    accumulated = `${accumulated.replace(/\/$/, '')}/${part}`;
    segments.push({ label: part, path: accumulated });
  }
  return segments;
}

export function parentDirectory(root, directory) {
  if (!root || !directory || directory === root || !directory.startsWith(root)) return null;
  const parent = directory.slice(0, directory.lastIndexOf('/')) || '/';
  return parent.length < root.length ? root : parent;
}

export function filterFolders(names, query = '') {
  const needle = query.trim().toLowerCase();
  return needle ? names.filter((name) => name.toLowerCase().includes(needle)) : names;
}

export function uploadableItems(items) {
  return items.filter((item) => item.status !== 'saved' && item.file.size <= MAX_UPLOAD_BYTES);
}

export function describeUploadStatus(item) {
  switch (item.status) {
    case 'uploading': {
      const percent = Math.min(100, Math.round(item.loaded / Math.max(1, item.file.size) * 100));
      return { label: percent >= 100 ? 'Saving' : `Uploading ${percent}%`, tone: 'running' };
    }
    case 'saved': return { label: 'Saved', tone: 'success' };
    case 'error':
      return { label: item.file.size > MAX_UPLOAD_BYTES ? 'Too large' : 'Failed', tone: 'error' };
    case 'cancelled': return { label: 'Cancelled', tone: 'idle' };
    default: return null;
  }
}

export function selectionSummary(items, destination, running = false) {
  const saved = items.filter((item) => item.status === 'saved').length;
  if (running) return `${saved} of ${items.length} saved. Uploading…`;
  if (!items.length) return 'No files selected · up to 100 MiB each';
  const failed = items.filter((item) => item.status === 'error').length;
  const cancelled = items.filter((item) => item.status === 'cancelled').length;
  if (saved || failed || cancelled) {
    return `${saved} of ${items.length} saved.${failed ? ` ${failed} failed.` : ''}`
      + `${cancelled ? ` ${cancelled} cancelled.` : ''}`;
  }
  const bytes = items.reduce((total, item) => total + item.file.size, 0);
  const files = `${items.length} file${items.length === 1 ? '' : 's'} · ${formatBytes(bytes)}`;
  return destination ? `${files} → ${destination}` : files;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const FOLDER_ICON = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z';
const PARENT_ICON = 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v5';
const FOLDER_FILTER_THRESHOLD = 8;

export function bindFileUploads({ document, apiRequest, getCsrfToken, closeSidebar, isMobile, onAuthExpired }) {
  const get = (id) => document.getElementById(id);
  const dialog = get('upload-dialog');
  const opener = get('upload-open');
  const picker = get('upload-files');
  const pathInput = get('upload-directory');
  const folders = get('upload-folders');
  const breadcrumbs = get('upload-breadcrumbs');
  const locationBar = get('upload-location');
  const editPath = get('upload-edit-path');
  const pathEditor = get('upload-path-editor');
  const filter = get('upload-folder-filter');
  const fileList = get('upload-file-list');
  const error = get('upload-error');
  const summary = get('upload-summary');
  const submit = get('upload-submit');
  const cancel = get('upload-cancel');
  const fields = get('upload-destination-fields');
  const choose = get('upload-choose');
  const workspace = document.querySelector('.terminal-workspace');
  const storageKey = 'terminal.upload-directory';
  let root = null;
  let destination = null;
  let directories = [];
  let browsing = false;
  let browseSequence = 0;
  let editingPath = false;
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
  const button = (text, action, className) => {
    const node = element('button', text, className);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const icon = (path, className) => {
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) svg.setAttribute('class', className);
    const shape = document.createElementNS(SVG_NAMESPACE, 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    return svg;
  };

  function renderLocation() {
    locationBar.hidden = editingPath;
    pathEditor.hidden = !editingPath;
    breadcrumbs.replaceChildren();
    if (!destination) {
      breadcrumbs.append(element('span', browsing ? 'Loading…' : 'No folder selected', 'upload-breadcrumb-placeholder'));
      return;
    }
    const segments = breadcrumbSegments(root, destination);
    segments.forEach((segment, index) => {
      if (index) {
        const separator = element('span', '/', 'upload-breadcrumb-separator');
        separator.setAttribute('aria-hidden', 'true');
        breadcrumbs.append(separator);
      }
      if (index === segments.length - 1) {
        const current = element('span', segment.label, 'upload-breadcrumb-current');
        current.setAttribute('aria-current', 'location');
        breadcrumbs.append(current);
      } else {
        const crumb = button(segment.label, () => browse(segment.path, { focusFolders: true }), 'upload-breadcrumb');
        crumb.title = segment.path;
        breadcrumbs.append(crumb);
      }
    });
    breadcrumbs.scrollLeft = breadcrumbs.scrollWidth;
    markClippedBreadcrumbs();
  }

  function markClippedBreadcrumbs() {
    breadcrumbs.classList.toggle('upload-breadcrumbs-clipped', breadcrumbs.scrollLeft > 0);
  }

  function folderRow(label, target, iconPath, ariaLabel) {
    const row = button('', () => browse(target, { focusFolders: true }), 'app-list-row upload-folder');
    const name = element('span', label, 'upload-folder-name');
    const chevron = element('span', '›', 'app-list-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    row.append(icon(iconPath, 'app-list-icon'), name, chevron);
    row.title = target;
    if (ariaLabel) row.setAttribute('aria-label', ariaLabel);
    return row;
  }

  function renderFolders() {
    filter.hidden = browsing || directories.length <= FOLDER_FILTER_THRESHOLD;
    folders.replaceChildren();
    folders.setAttribute('aria-busy', String(browsing));
    if (browsing) {
      folders.append(element('p', 'Loading folders…', 'app-list-note'));
      return;
    }
    if (!destination) return;
    const parent = parentDirectory(root, destination);
    if (parent) folders.append(folderRow('..', parent, PARENT_ICON, 'Parent folder'));
    const visible = filterFolders(directories, filter.hidden ? '' : filter.value);
    for (const name of visible) {
      folders.append(folderRow(name, `${destination.replace(/\/$/, '')}/${name}`, FOLDER_ICON));
    }
    if (!directories.length) {
      folders.append(element('p', 'No subfolders — files will be saved here.', 'app-list-note'));
    } else if (!visible.length) {
      folders.append(element('p', 'No folders match the filter.', 'app-list-note'));
    }
  }

  function renderFiles() {
    fileList.replaceChildren();
    for (const item of queue.items) {
      const row = element('li', '', 'upload-file');
      row.dataset.state = item.status;
      const main = element('div', '', 'upload-file-main');
      if (!queue.running && item.status !== 'saved') {
        const input = element('input', '', 'input-compact');
        input.type = 'text';
        input.value = item.name;
        input.spellcheck = false;
        input.setAttribute('autocapitalize', 'none');
        input.setAttribute('aria-label', `Filename for ${item.file.name}`);
        input.addEventListener('input', () => { item.name = input.value; });
        main.append(input);
      } else {
        const name = element('span', item.name, 'upload-filename');
        name.title = item.name;
        main.append(name);
      }
      main.append(element('span', formatBytes(item.file.size), 'upload-size'));
      const status = describeUploadStatus(item);
      if (status) {
        const badge = element('span', status.label, 'status-badge');
        badge.dataset.tone = status.tone;
        main.append(badge);
      }
      if (!queue.running) {
        if (['error', 'cancelled'].includes(item.status) && item.file.size <= MAX_UPLOAD_BYTES) {
          const retry = button('Retry', () => queue.run(destination, [item]), 'btn-compact');
          retry.disabled = !destination || browsing || editingPath;
          retry.setAttribute('aria-label', `Retry ${item.name}`);
          main.append(retry);
        }
        const action = item.status === 'saved' ? 'Dismiss' : 'Remove';
        const remove = button('×', () => {
          queue.items = queue.items.filter((entry) => entry !== item);
          queue.render();
          (fileList.querySelector('input, button') || choose).focus({ preventScroll: true });
        }, 'icon-button icon-button-compact upload-file-remove');
        remove.setAttribute('aria-label', `${action} ${item.name}`);
        remove.title = action;
        main.append(remove);
      }
      row.append(main);
      const message = item.status === 'saved' ? item.path
        : ['pending', 'uploading'].includes(item.status) ? '' : item.message;
      if (message) row.append(element('p', message, 'upload-file-message'));
      if (item.status === 'uploading') {
        const progress = element('progress');
        progress.max = Math.max(1, item.file.size);
        progress.value = item.loaded;
        progress.setAttribute('aria-label', `Uploading ${item.name}`);
        row.append(progress);
      }
      fileList.append(row);
    }
  }

  function render() {
    fields.disabled = queue.running;
    choose.disabled = queue.running;
    const uploadable = uploadableItems(queue.items).length;
    submit.disabled = queue.running || browsing || editingPath || !destination || !uploadable;
    submit.textContent = queue.running ? 'Uploading…'
      : uploadable ? `Upload ${uploadable} file${uploadable === 1 ? '' : 's'}` : 'Upload';
    cancel.hidden = !queue.running;
    const current = queue.items.find((item) => item.status === 'uploading');
    const percent = current ? Math.min(100, Math.round(current.loaded / Math.max(1, current.file.size) * 100)) : 0;
    opener.textContent = queue.running ? `Upload · ${percent}%` : 'Upload';
    summary.textContent = selectionSummary(queue.items, destination, queue.running);
    renderFiles();
  }

  const queue = new UploadQueue({
    send: (options) => sendUpload({ ...options, csrfToken: getCsrfToken() }),
    onAuthExpired,
    render,
  });

  async function browse(path = '', { focusFolders = false } = {}) {
    const sequence = ++browseSequence;
    browsing = true;
    setError();
    renderLocation();
    renderFolders();
    queue.render();
    let succeeded = false;
    try {
      const data = await apiRequest(`/api/upload-directories?${new URLSearchParams({ path })}`);
      if (sequence !== browseSequence) return false;
      root = data.root;
      destination = data.directory;
      directories = data.directories;
      filter.value = '';
      try { sessionStorage.setItem(storageKey, destination); } catch { /* Storage is optional. */ }
      succeeded = true;
    } catch (failure) {
      if (sequence !== browseSequence) return false;
      setError(failure.message);
    } finally {
      if (sequence === browseSequence) {
        browsing = false;
        if (succeeded) editingPath = false;
        renderLocation();
        renderFolders();
        queue.render();
        if (succeeded && focusFolders) {
          (folders.querySelector('button') || editPath).focus({ preventScroll: true });
        }
      }
    }
    return succeeded;
  }

  function setEditingPath(editing) {
    editingPath = editing;
    renderLocation();
    queue.render();
    if (editing) {
      pathInput.value = destination || '';
      pathInput.focus({ preventScroll: true });
      pathInput.select();
    } else {
      editPath.focus({ preventScroll: true });
    }
  }

  async function open(files = []) {
    if (!configured) return;
    closeSidebar();
    if (!dialog.open) dialog.showModal();
    queue.add(files);
    if (!destination && !browsing) {
      let remembered = '';
      try { remembered = sessionStorage.getItem(storageKey) || ''; } catch { /* Storage is optional. */ }
      if (!(await browse(remembered)) && remembered && !destination) browse('');
    }
  }
  opener.addEventListener('click', () => open());
  get('upload-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (editingPath) {
      editingPath = false;
      renderLocation();
      queue.render();
    }
    (isMobile() ? get('sidebar-toggle') : opener).focus({ preventScroll: true });
  });
  choose.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    queue.add(picker.files);
    picker.value = '';
  });
  editPath.addEventListener('click', () => setEditingPath(true));
  breadcrumbs.addEventListener('scroll', markClippedBreadcrumbs, { passive: true });
  pathInput.addEventListener('keydown', (event) => {
    // Cancelling the keydown keeps the dialog open; Escape only leaves path editing.
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setEditingPath(false);
  });
  filter.addEventListener('input', renderFolders);
  get('upload-path-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!queue.running && editingPath) browse(pathInput.value, { focusFolders: true });
  });
  submit.addEventListener('click', () => { if (destination && !editingPath) queue.run(destination); });
  cancel.addEventListener('click', () => queue.cancel());

  let dragDepth = 0;
  let dropzoneDepth = 0;
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
  choose.addEventListener('dragenter', (event) => {
    if (!hasFiles(event) || queue.running) return;
    dropzoneDepth += 1;
    choose.dataset.dragging = 'true';
  });
  choose.addEventListener('dragleave', () => {
    dropzoneDepth = Math.max(0, dropzoneDepth - 1);
    if (!dropzoneDepth) delete choose.dataset.dragging;
  });
  document.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropzoneDepth = 0;
    workspace.classList.remove('upload-dragging');
    delete choose.dataset.dragging;
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
  renderLocation();
  renderFolders();
  queue.render();
  return {
    enable() { configured = true; opener.disabled = false; },
    cancel() { queue.cancel(); },
  };
}
