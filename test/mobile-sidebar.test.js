const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

test('mobile sidebar shadow is rendered only while the sidebar is open', () => {
  const stylesheet = fs.readFileSync(
    path.join(projectRoot, 'public', 'css', 'style.css'),
    'utf8',
  );

  const mobileStyles = stylesheet.match(/@media \(max-width: 720px\) \{([\s\S]*)\}\s*$/);
  assert.ok(mobileStyles, 'expected mobile breakpoint styles');

  assert.match(
    mobileStyles[1],
    /\.session-sidebar\s*\{[^}]*transform:\s*translateX\(-100%\);(?![^}]*box-shadow)[^}]*\}/s,
  );
  assert.match(
    mobileStyles[1],
    /\.sessions-open \.session-sidebar\s*\{[^}]*transform:\s*translateX\(0\);[^}]*box-shadow:\s*12px 0 0 rgb\(0 0 0 \/ 22%\);[^}]*\}/s,
  );
});
