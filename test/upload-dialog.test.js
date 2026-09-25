'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

test('upload dialog helpers format sizes, breadcrumbs, parents, and filters', async () => {
  const {
    breadcrumbSegments,
    filterFolders,
    formatBytes,
    parentDirectory,
  } = await import('../public/js/file-uploads.mjs');

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(12.4 * 1024 * 1024), '12.4 MiB');
  assert.equal(formatBytes(250 * 1024 * 1024), '250 MiB');

  assert.deepEqual(breadcrumbSegments('/code', '/code'), [{ label: '/code', path: '/code' }]);
  assert.deepEqual(breadcrumbSegments('/code', '/code/.cargo/registry'), [
    { label: '/code', path: '/code' },
    { label: '.cargo', path: '/code/.cargo' },
    { label: 'registry', path: '/code/.cargo/registry' },
  ]);
  assert.deepEqual(breadcrumbSegments('/', '/srv/app').map((segment) => segment.path), ['/', '/srv', '/srv/app']);

  assert.equal(parentDirectory('/code', '/code'), null);
  assert.equal(parentDirectory('/code', '/code/project'), '/code');
  assert.equal(parentDirectory('/code', '/code/.cargo/registry'), '/code/.cargo');
  assert.equal(parentDirectory('/', '/srv'), '/');
  assert.equal(parentDirectory('/code', '/elsewhere'), null);

  const names = ['api', 'Web-App', '.cargo', 'webhooks'];
  assert.deepEqual(filterFolders(names, ''), names);
  assert.deepEqual(filterFolders(names, '  WEB '), ['Web-App', 'webhooks']);
  assert.deepEqual(filterFolders(names, 'missing'), []);
});

test('upload summaries describe the selection, progress, and results', async () => {
  const { selectionSummary, uploadableItems, MAX_UPLOAD_BYTES } = await import('../public/js/file-uploads.mjs');
  const item = (status, size = 1024 * 1024) => ({ status, file: { size } });

  assert.equal(selectionSummary([], '/code'), 'No files selected · up to 100 MiB each');
  assert.equal(selectionSummary([item('pending')], '/code/project'), '1 file · 1.0 MiB → /code/project');
  assert.equal(selectionSummary([item('pending'), item('pending')], null), '2 files · 2.0 MiB');
  assert.equal(
    selectionSummary([item('saved'), item('uploading'), item('pending')], '/code', true),
    '1 of 3 saved. Uploading…',
  );
  assert.equal(
    selectionSummary([item('saved'), item('error'), item('cancelled')], '/code'),
    '1 of 3 saved. 1 failed. 1 cancelled.',
  );

  const tooLarge = item('error', MAX_UPLOAD_BYTES + 1);
  const retryable = item('error');
  assert.deepEqual(uploadableItems([item('saved'), tooLarge, retryable]), [retryable]);
});

test('upload dialog markup puts files first and keeps a single destination path bar', () => {
  const view = fs.readFileSync(path.join(projectRoot, 'views', 'terminal.html'), 'utf8');
  const dialog = view.slice(view.indexOf('<dialog id="upload-dialog"'), view.indexOf('</dialog>'));
  for (const id of [
    'upload-error', 'upload-choose', 'upload-files', 'upload-file-list', 'upload-path-form',
    'upload-destination-fields', 'upload-location', 'upload-breadcrumbs', 'upload-edit-path',
    'upload-path-editor', 'upload-directory', 'upload-folder-filter', 'upload-folders',
    'upload-summary', 'upload-cancel', 'upload-submit',
  ]) {
    assert.match(dialog, new RegExp(`id="${id}"`), id);
  }
  assert.ok(dialog.indexOf('id="upload-choose"') < dialog.indexOf('id="upload-path-form"'));
  assert.match(dialog, /<div id="upload-path-editor" class="upload-path-row" hidden>/);
  assert.match(dialog, /id="upload-directory"[^>]*enterkeyhint="go"/);
  assert.match(dialog, /<button id="upload-submit" class="btn-dialog-primary"/);
});

test('upload and job dialogs share one dialog structure and component set', () => {
  const view = fs.readFileSync(path.join(projectRoot, 'views', 'terminal.html'), 'utf8');
  const dialogMarkup = (id) => {
    const start = view.indexOf(`<dialog id="${id}"`);
    return view.slice(start, view.indexOf('</dialog>', start));
  };
  for (const id of ['upload-dialog', 'jobs-dialog']) {
    const dialog = dialogMarkup(id);
    assert.match(dialog, new RegExp(`^<dialog id="${id}" class="app-dialog `), id);
    for (const part of ['app-dialog-header', 'app-dialog-body', 'app-dialog-error', 'app-dialog-footer',
      'app-dialog-status', 'app-dialog-actions', 'app-dialog-label', 'app-list', 'btn-dialog-primary', 'dashed-panel']) {
      assert.match(dialog, new RegExp(`class="[^"]*\\b${part}\\b`), `${id} uses ${part}`);
    }
    const footer = dialog.slice(dialog.indexOf('app-dialog-footer'));
    assert.match(footer, /class="btn-dialog-primary"/, `${id} keeps its primary action in the footer`);
    assert.doesNotMatch(dialog, /class="[^"]*\bupload-(?:dialog-|footer|section|error|button)/, id);
  }
  const stylesheet = fs.readFileSync(path.join(projectRoot, 'public', 'css', 'style.css'), 'utf8');
  assert.doesNotMatch(stylesheet, /\.(?:jobs-status|jobs-hint|upload-section-label|upload-footer-actions|sidebar-uploads)\b/);
});

test('upload file rows use the shared status badge vocabulary', async () => {
  const { describeUploadStatus, MAX_UPLOAD_BYTES } = await import('../public/js/file-uploads.mjs');
  const file = { size: 200 };
  assert.equal(describeUploadStatus({ status: 'pending', file }), null);
  assert.deepEqual(describeUploadStatus({ status: 'uploading', loaded: 50, file }), { label: 'Uploading 25%', tone: 'running' });
  assert.deepEqual(describeUploadStatus({ status: 'uploading', loaded: 200, file }), { label: 'Saving', tone: 'running' });
  assert.deepEqual(describeUploadStatus({ status: 'saved', file }), { label: 'Saved', tone: 'success' });
  assert.deepEqual(describeUploadStatus({ status: 'error', file }), { label: 'Failed', tone: 'error' });
  assert.deepEqual(describeUploadStatus({ status: 'error', file: { size: MAX_UPLOAD_BYTES + 1 } }), { label: 'Too large', tone: 'error' });
  assert.deepEqual(describeUploadStatus({ status: 'cancelled', file }), { label: 'Cancelled', tone: 'idle' });
});
