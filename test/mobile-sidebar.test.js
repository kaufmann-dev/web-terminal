const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const stylesheetPath = path.join(projectRoot, 'public', 'css', 'style.css');
const terminalScriptPath = path.join(projectRoot, 'public', 'js', 'terminal.js');
const terminalViewPath = path.join(projectRoot, 'views', 'terminal.html');
const mobileMediaQuery = '@media (max-width: 720px) {';

function getMobileStyles(stylesheet) {
  const start = stylesheet.indexOf(mobileMediaQuery);
  assert.notEqual(start, -1, 'expected mobile breakpoint styles');
  const end = stylesheet.indexOf('@media (prefers-reduced-motion: reduce)', start);
  assert.notEqual(end, -1, 'expected reduced-motion styles after the mobile breakpoint');
  return stylesheet.slice(start + mobileMediaQuery.length, end);
}

test('mobile sidebar has no shadow while closed or open', () => {
  const stylesheet = fs.readFileSync(stylesheetPath, 'utf8');
  const mobileStyles = getMobileStyles(stylesheet);

  assert.match(
    mobileStyles,
    /\.session-sidebar\s*\{[^}]*transform:\s*translateX\(-100%\);(?![^}]*box-shadow)[^}]*\}/s,
  );
  assert.match(
    mobileStyles,
    /\.sessions-open \.session-sidebar\s*\{[^}]*transform:\s*translateX\(0\);(?![^}]*box-shadow)[^}]*\}/s,
  );
});

test('collapsed-sidebar layout uses the visible viewport and reserves mobile controls', () => {
  const stylesheet = fs.readFileSync(stylesheetPath, 'utf8');
  const desktopStyles = stylesheet.slice(0, stylesheet.indexOf(mobileMediaQuery));
  const mobileStyles = getMobileStyles(stylesheet);

  assert.match(
    desktopStyles,
    /\.mobile-terminal-controls\s*\{\s*display:\s*none;\s*\}/s,
  );
  assert.doesNotMatch(desktopStyles, /\.mobile-terminal-controls\s*\{[^}]*display:\s*flex;/s);
  assert.match(mobileStyles, /\.terminal-body\s*\{[^}]*height:\s*100dvh;/s);
  assert.match(mobileStyles, /\.terminal-main\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(
    mobileStyles,
    /\.mobile-terminal-controls\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;/s,
  );
  assert.match(
    mobileStyles,
    /\.mobile-terminal-key\s*\{[^}]*min-width:\s*44px;[^}]*height:\s*44px;/s,
  );
  assert.match(
    mobileStyles,
    /\.mobile-terminal-key\[aria-pressed="true"\]\s*\{[^}]*border-color:\s*var\(--accent\);/s,
  );
  assert.match(
    mobileStyles,
    /\.mobile-terminal-key-icon\s*\{[^}]*width:\s*20px;[^}]*stroke:\s*currentcolor;/s,
  );
  assert.match(
    mobileStyles,
    /\.terminal-host \.xterm\s*\{[^}]*touch-action:\s*pinch-zoom;/s,
  );
  assert.doesNotMatch(
    desktopStyles,
    /\.terminal-host \.xterm\s*\{[^}]*touch-action:\s*pinch-zoom;/s,
  );
});

test('mobile control group exposes the terminal keys in priority order', () => {
  const terminalView = fs.readFileSync(terminalViewPath, 'utf8');
  const workspaceEnd = terminalView.indexOf(
    '</section>',
    terminalView.indexOf('class="terminal-workspace"'),
  );
  const controlsMatch = terminalView.match(
    /<div id="mobile-terminal-controls"([^>]*)>([\s\S]*?)<\/div>/,
  );
  assert.ok(controlsMatch, 'expected the mobile terminal control group');
  assert.ok(controlsMatch.index > workspaceEnd, 'controls must reserve space after the workspace');
  assert.match(controlsMatch[1], /\brole="group"/);
  assert.match(controlsMatch[1], /\baria-label="Terminal controls"/);
  assert.match(controlsMatch[1], /\bhidden\b/);

  const buttons = [...controlsMatch[2].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(
    buttons.map((button) => button[1].match(/data-terminal-control="([^"]+)"/)?.[1]),
    [
      'modifier-ctrl',
      'modifier-alt',
      'paste',
      'escape',
      'tab',
      'arrow-left',
      'arrow-up',
      'arrow-down',
      'arrow-right',
      'home',
      'end',
      'page-up',
      'page-down',
    ],
  );
  for (const [, attributes] of buttons) {
    assert.match(attributes, /\btype="button"/);
    assert.match(attributes, /\baria-label="[^"]+"/);
    assert.match(attributes, /\bdisabled\b/);
  }

  for (const modifier of ['ctrl', 'alt']) {
    const modifierButton = buttons.find((button) => (
      button[1].includes(`data-terminal-modifier="${modifier}"`)
    ));
    assert.ok(modifierButton, `expected the ${modifier} modifier button`);
    assert.match(modifierButton[1], /\baria-pressed="false"/);
  }
});

test('mobile arrow controls use one consistent hardcoded SVG path', () => {
  const terminalView = fs.readFileSync(terminalViewPath, 'utf8');
  const arrowButtons = [...terminalView.matchAll(
    /<button\b([^>]*data-terminal-control="arrow-[^"]+"[^>]*)>([\s\S]*?)<\/button>/g,
  )];

  assert.equal(arrowButtons.length, 4);
  for (const [, , content] of arrowButtons) {
    assert.match(
      content,
      /<svg\b[^>]*class="mobile-terminal-key-icon"[^>]*aria-hidden="true"[^>]*focusable="false"/,
    );
    assert.match(content, /<path d="M15 5 8 12l7 7"/);
    assert.doesNotMatch(content, /[←↑↓→]/);
  }
});

test('mobile controls use xterm input modes and browser text paste', () => {
  const terminalScript = fs.readFileSync(terminalScriptPath, 'utf8');

  assert.match(terminalScript, /import\('\/static\/js\/terminal-input\.mjs'\)/);
  assert.match(terminalScript, /encodeMobileTerminalKey\(/);
  assert.match(terminalScript, /transformMobileTerminalInput\(/);
  assert.match(terminalScript, /this\.terminal\.modes\.applicationCursorKeysMode/);
  assert.match(terminalScript, /this\.terminal\.input\(input\)/);
  assert.doesNotMatch(
    terminalScript,
    /this\.terminal\.input\(input\);\s*this\.terminal\.focus\(\)/,
  );
  assert.match(terminalScript, /navigator\.clipboard\.readText\(\)/);
  assert.match(terminalScript, /this\.terminal\.paste\(text\)/);
  const pasteHandler = terminalScript.slice(
    terminalScript.indexOf('pasteClipboardText = async'),
    terminalScript.indexOf('copySelection =', terminalScript.indexOf('pasteClipboardText = async')),
  );
  assert.doesNotMatch(pasteHandler, /this\.terminal\.focus\(\)/);
  assert.match(
    terminalScript,
    /toggleMobileModifier = \(modifier\) => \{/,
  );
  const modifierToggle = terminalScript.slice(
    terminalScript.indexOf('toggleMobileModifier ='),
    terminalScript.indexOf('clearMobileModifiers ='),
  );
  const modifierActivation = modifierToggle.slice(
    modifierToggle.indexOf('this.terminal.focus()'),
  );
  const modifierDeactivation = modifierToggle.slice(
    0,
    modifierToggle.indexOf('this.terminal.focus()'),
  );
  assert.match(modifierActivation, /this\.mobileModifiers\[modifier\] = true/);
  assert.doesNotMatch(modifierDeactivation, /this\.terminal\.focus\(\)/);
  assert.match(modifierDeactivation, /this\.terminal\.blur\(\)/);

  const inputHandler = terminalScript.slice(
    terminalScript.indexOf('this.inputDisposable ='),
    terminalScript.indexOf('this.binaryDisposable ='),
  );
  assert.match(
    inputHandler,
    /this\.send\([^;]+;\s*if \(transformedInput\.consumed\) \{[^}]*this\.clearMobileModifiers\(\);[^}]*this\.terminal\.blur\(\);/s,
  );
  assert.match(terminalScript, /mobileTerminalControls\.hidden = !hasActiveTerminal/);
  assert.match(terminalScript, /button\.disabled = !controlsEnabled/);
  assert.match(terminalScript, /mobileLayoutQuery\.addEventListener\('change'/);
});

test('collapsed-sidebar terminal scrolls retained output with touch gestures', () => {
  const terminalScript = fs.readFileSync(terminalScriptPath, 'utf8');
  const touchHandlers = terminalScript.slice(
    terminalScript.indexOf('handleTouchScrollPointerDown ='),
    terminalScript.indexOf('handleBrowserPasteKeyDown ='),
  );

  assert.match(terminalScript, /\bTouchScrollGesture\b/);
  assert.match(terminalScript, /new TouchScrollGesture\(\)/);
  for (const eventName of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.match(
      terminalScript,
      new RegExp(`addEventListener\\(\\s*'${eventName}'`),
    );
    assert.match(
      terminalScript,
      new RegExp(`removeEventListener\\(\\s*'${eventName}'`),
    );
  }
  assert.match(touchHandlers, /!mobileLayoutQuery\.matches/);
  assert.match(touchHandlers, /event\.pointerType !== 'touch'/);
  assert.match(touchHandlers, /!event\.isPrimary/);
  assert.match(
    touchHandlers,
    /this\.terminalElement\.getBoundingClientRect\(\)\.height/,
  );
  assert.match(touchHandlers, /terminalHeight \/ this\.terminal\.rows/);
  assert.match(touchHandlers, /activeBuffer\.type === 'normal'/);
  assert.match(touchHandlers, /activeBuffer\.baseY > 0/);
  assert.match(touchHandlers, /this\.terminal\.scrollLines\(result\.lines\)/);
  assert.match(touchHandlers, /this\.armTouchScrollClickSuppression\(\)/);
  assert.doesNotMatch(touchHandlers, /this\.terminal\.input\(/);
  assert.doesNotMatch(touchHandlers, /this\.send\(/);

  const focusHandler = terminalScript.slice(
    terminalScript.indexOf('focusTerminal ='),
    terminalScript.indexOf('handleBrowserPasteKeyDown ='),
  );
  assert.match(focusHandler, /if \(this\.suppressTouchScrollClick\)/);
  assert.match(focusHandler, /event\.preventDefault\(\)/);
  assert.match(terminalScript, /setPageHidden\(hidden\)[\s\S]*this\.cancelTouchScroll\(\)/);
  assert.match(
    terminalScript,
    /!event\.matches[\s\S]*activeController\.cancelTouchScroll\(\)/,
  );
});
