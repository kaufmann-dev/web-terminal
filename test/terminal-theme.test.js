const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

test('workspace, host, and xterm use the shared terminal background', () => {
  const stylesheet = fs.readFileSync(
    path.join(projectRoot, 'public', 'css', 'style.css'),
    'utf8',
  );
  const terminalClient = fs.readFileSync(
    path.join(projectRoot, 'public', 'js', 'terminal.js'),
    'utf8',
  );

  assert.match(stylesheet, /--terminal-bg:\s*#08090c;/);
  assert.match(
    stylesheet,
    /\.terminal-workspace\s*\{[^}]*background:\s*var\(--terminal-bg\);[^}]*\}/s,
  );
  assert.match(
    stylesheet,
    /\.terminal-host\s*\{[^}]*background:\s*var\(--terminal-bg\);[^}]*\}/s,
  );
  assert.match(
    terminalClient,
    /getPropertyValue\('--terminal-bg'\)[\s\S]*background:\s*terminalBackground,/,
  );
});
