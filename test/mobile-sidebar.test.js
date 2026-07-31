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

test('mobile layout stays full-height under the keyboard and follows Safari panning', () => {
  const stylesheet = fs.readFileSync(stylesheetPath, 'utf8');
  const terminalScript = fs.readFileSync(terminalScriptPath, 'utf8');
  const desktopStyles = stylesheet.slice(0, stylesheet.indexOf(mobileMediaQuery));
  const mobileStyles = getMobileStyles(stylesheet);

  assert.match(
    desktopStyles,
    /\.mobile-terminal-controls\s*\{\s*display:\s*none;\s*\}/s,
  );
  assert.doesNotMatch(desktopStyles, /\.mobile-terminal-controls\s*\{[^}]*display:\s*flex;/s);
  assert.match(desktopStyles, /\.terminal-body\s*\{[^}]*height:\s*100vh;/s);
  assert.match(
    mobileStyles,
    /\.terminal-body\s*\{[^}]*height:\s*100dvh;[^}]*\}/s,
  );
  assert.match(
    mobileStyles,
    /\.terminal-header\s*\{[^}]*transform:\s*translateY\(var\(--mobile-visual-viewport-offset-top, 0\)\);/s,
  );
  assert.match(
    mobileStyles,
    /\.mobile-terminal-controls\s*\{[^}]*z-index:\s*10;[^}]*transform:\s*translateY\(var\(--mobile-visual-viewport-offset-top, 0\)\);/s,
  );
  assert.doesNotMatch(stylesheet, /--mobile-visual-viewport-height/);
  assert.match(
    terminalScript,
    /mobileVisualViewportOffsetTop\(visualViewport\)/,
  );
  assert.match(
    terminalScript,
    /document\.documentElement\.style\.setProperty\(\s*mobileViewportOffsetTopProperty,\s*`\$\{offsetTop\}px`,\s*\)/s,
  );
  assert.match(
    terminalScript,
    /mobileViewportSyncFrame = window\.requestAnimationFrame\(\(\) => \{\s*mobileViewportSyncFrame = window\.requestAnimationFrame\(applyMobileViewportOffset\);/s,
  );
  assert.match(
    terminalScript,
    /visualViewport\.addEventListener\('resize', requestMobileViewportSync\);/,
  );
  assert.match(
    terminalScript,
    /visualViewport\.addEventListener\('scroll', requestMobileViewportSync\);/,
  );
  assert.doesNotMatch(terminalScript, /mobileVisualViewportHeight|mobileViewportHeightProperty/);
  assert.match(mobileStyles, /\.terminal-main\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(
    mobileStyles,
    /\.mobile-terminal-controls\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;/s,
  );
  assert.match(
    mobileStyles,
    /\.mobile-terminal-controls\s*\{[^}]*padding:\s*6px 8px;[^}]*border-bottom:\s*1px solid var\(--border\);/s,
  );
  assert.doesNotMatch(mobileStyles, /safe-area-inset-bottom|border-top:/);
  assert.match(
    mobileStyles,
    /\.mobile-terminal-key\s*\{[^}]*min-width:\s*44px;[^}]*height:\s*44px;/s,
  );
  assert.match(
    mobileStyles,
    /\.mobile-terminal-key\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent;/s,
  );
  assert.match(
    mobileStyles,
    /\.mobile-terminal-key\[aria-pressed="true"\]\s*\{[^}]*border-color:\s*var\(--accent\);/s,
  );
  assert.match(
    mobileStyles,
    /\.mobile-terminal-key\.is-feedback-active\s*\{[^}]*animation:\s*mobile-terminal-key-feedback 160ms ease-out;/s,
  );
  assert.match(
    stylesheet,
    /@keyframes mobile-terminal-key-feedback\s*\{[\s\S]*background:\s*var\(--border\);[\s\S]*background:\s*var\(--panel\);/,
  );
  const finePointerStylesStart = mobileStyles.indexOf(
    '@media (hover: hover) and (pointer: fine)',
  );
  assert.notEqual(finePointerStylesStart, -1, 'expected fine-pointer active styles');
  assert.doesNotMatch(
    mobileStyles.slice(0, finePointerStylesStart),
    /\.mobile-terminal-key:active/,
  );
  assert.match(
    mobileStyles.slice(finePointerStylesStart),
    /\.mobile-terminal-key:active\s*\{[^}]*border-color:\s*var\(--accent\);/s,
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
  const mainStart = terminalView.indexOf('<main class="terminal-main">');
  const sidebarStart = terminalView.indexOf('<aside id="session-sidebar"');
  const controlsMatch = terminalView.match(
    /<div id="mobile-terminal-controls"([^>]*)>([\s\S]*?)<\/div>/,
  );
  assert.ok(controlsMatch, 'expected the mobile terminal control group');
  assert.ok(
    controlsMatch.index > mainStart && controlsMatch.index < sidebarStart,
    'controls must be the first content below the header',
  );
  assert.match(controlsMatch[1], /\brole="group"/);
  assert.match(controlsMatch[1], /\baria-label="Terminal controls"/);
  assert.match(controlsMatch[1], /\bhidden\b/);

  const buttons = [...controlsMatch[2].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(
    buttons.map((button) => button[1].match(/data-terminal-control="([^"]+)"/)?.[1]),
    [
      'modifier-ctrl',
      'modifier-shift',
      'modifier-alt',
      'paste',
      'escape',
      'tab',
      'enter',
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

  const pasteButtons = buttons.filter((button) => (
    button[1].includes('data-terminal-control="paste"')
  ));
  assert.equal(pasteButtons.length, 1);
  assert.match(pasteButtons[0][1], /\baria-label="Paste clipboard text or image"/);

  for (const modifier of ['ctrl', 'shift', 'alt']) {
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

test('mobile controls use xterm input modes and adaptive browser paste', () => {
  const terminalScript = fs.readFileSync(terminalScriptPath, 'utf8');

  assert.match(terminalScript, /import\('\/static\/js\/terminal-input\.mjs'\)/);
  assert.match(terminalScript, /\bMobileTerminalFocusManager\b/);
  assert.match(terminalScript, /new TouchControlActivationGuard\(\)/);
  assert.match(terminalScript, /import\('\/static\/js\/clipboard-reader\.mjs'\)/);
  assert.match(terminalScript, /encodeMobileTerminalKey\(/);
  assert.match(terminalScript, /transformMobileTerminalInput\(/);
  assert.match(terminalScript, /this\.terminal\.modes\.applicationCursorKeysMode/);
  assert.match(terminalScript, /inputTerminalProgrammatically = \(data\)/);
  assert.match(terminalScript, /this\.terminal\.input\(data\)/);
  assert.match(terminalScript, /pasteTerminalProgrammatically = \(text\)/);
  assert.match(terminalScript, /this\.terminal\.paste\(text\)/);
  assert.match(terminalScript, /this\.programmaticInputDepth > 0 \? \{\} : this\.mobileModifiers/);
  assert.match(terminalScript, /readClipboardContent\(navigator\.clipboard\)/);
  assert.match(terminalScript, /this\.pasteTerminalProgrammatically\(clipboardContent\.text\)/);
  assert.match(
    terminalScript,
    /await this\.uploadClipboardImage\(\s*clipboardContent\.image,\s*clipboardContent\.contentType,/s,
  );
  const pasteRequest = terminalScript.slice(
    terminalScript.indexOf('requestClipboardPaste ='),
    terminalScript.indexOf('applyClipboardContent ='),
  );
  assert.ok(
    pasteRequest.indexOf('readClipboardContent(navigator.clipboard)')
      < pasteRequest.indexOf('this.enqueueClipboardOperation'),
    'clipboard permission must be requested synchronously before ordered application',
  );
  assert.match(terminalScript, /this\.clipboardOperationQueue = this\.clipboardOperationQueue\s*\.then/);
  assert.doesNotMatch(pasteRequest, /this\.terminal\.focus\(\)/);

  const modifierToggle = terminalScript.slice(
    terminalScript.indexOf('toggleMobileModifier ='),
    terminalScript.indexOf('clearMobileModifiers ='),
  );
  assert.match(
    modifierToggle,
    /const opensKeyboard = mobileModifierOpensKeyboard\(\s*modifier,\s*this\.mobileModifiers\[modifier\],\s*\);/,
  );
  assert.match(
    modifierToggle,
    /const updateModifier = \(\) => \{[\s\S]*this\.mobileModifiers\[modifier\] = !this\.mobileModifiers\[modifier\][\s\S]*updateMobileTerminalControls\(\);\s*\};/,
  );
  assert.match(
    modifierToggle,
    /if \(manageKeyboard && opensKeyboard\) \{\s*this\.mobileFocus\.transitionKeyboard\(\(\) => \{\s*updateModifier\(\);\s*return true;\s*\}\);\s*return;/s,
  );
  assert.match(modifierToggle, /updateModifier\(\);/);
  assert.match(
    terminalScript,
    /this\.mobileModifiers = \{ ctrl: false, shift: false, alt: false \}/,
  );
  assert.match(
    terminalScript,
    /this\.mobileModifiers\.shift\s*&& \(action === 'page-up' \|\| action === 'page-down'\)[\s\S]*this\.terminal\.scrollPages\(/,
  );

  const inputHandler = terminalScript.slice(
    terminalScript.indexOf('this.inputDisposable ='),
    terminalScript.indexOf('this.binaryDisposable ='),
  );
  assert.ok(
    inputHandler.indexOf('this.mobileFocus.shouldSuppressInput(data)')
      < inputHandler.indexOf('transformMobileTerminalInput'),
    'internal focus reports must be dropped before modifier transformation and send',
  );
  assert.match(
    inputHandler,
    /this\.send\([^;]+;\s*if \(transformedInput\.consumed\) \{[^}]*this\.clearMobileModifiers\(\);[^}]*this\.closeMobileKeyboard\(\);/s,
  );
  assert.match(terminalScript, /resetMobileInput\(\{ closeKeyboard: mobileLayoutQuery\.matches \}\)/);
  assert.match(terminalScript, /touchControlActivation\.invalidate\(\)/);
  assert.match(terminalScript, /mobileTerminalControls\.hidden = !hasActiveTerminal/);
  assert.match(terminalScript, /button\.disabled = !controlsEnabled/);
  assert.doesNotMatch(terminalScript, /TerminalTextareaInputNormalizer/);
  assert.doesNotMatch(terminalScript, /handleTerminalBeforeInput|handleTerminalInput/);
  assert.match(terminalScript, /mobileLayoutQuery\.addEventListener\('change'/);
});

test('mobile controls preserve focus and activate one matched click per touch', () => {
  const terminalScript = fs.readFileSync(terminalScriptPath, 'utf8');
  const controlHandlers = terminalScript.slice(
    terminalScript.indexOf("document.addEventListener('pointerdown'"),
    terminalScript.indexOf("mobileLayoutQuery.addEventListener('change'"),
  );

  assert.match(controlHandlers, /document\.addEventListener\('pointerdown'/);
  assert.match(controlHandlers, /document\.addEventListener\('pointermove'/);
  assert.match(controlHandlers, /document\.addEventListener\('pointerup'/);
  assert.match(controlHandlers, /document\.addEventListener\('pointercancel'/);
  assert.match(controlHandlers, /document\.addEventListener\('mousedown'/);
  assert.match(controlHandlers, /document\.addEventListener\('click'/);
  assert.match(
    controlHandlers,
    /touchControlActivation\.start\(\s*event\.pointerId,\s*action,\s*activeController,\s*event\.clientX,\s*event\.clientY,/s,
  );
  const pointerDown = controlHandlers.slice(
    0,
    controlHandlers.indexOf("document.addEventListener('pointermove'"),
  );
  assert.match(pointerDown, /event\.preventDefault\(\)/);
  assert.match(controlHandlers, /touchControlActivation\.move\(event\.pointerId/);
  assert.match(controlHandlers, /document\.elementFromPoint\(event\.clientX, event\.clientY\)/);
  assert.match(
    controlHandlers,
    /touchControlActivation\.end\(\s*event\.pointerId,\s*mobileControlTargetAction\(releaseTarget\),\s*event\.timeStamp,/s,
  );
  const pointerUp = controlHandlers.slice(
    controlHandlers.indexOf("document.addEventListener('pointerup'"),
    controlHandlers.indexOf("document.addEventListener('pointercancel'"),
  );
  assert.doesNotMatch(pointerUp, /event\.preventDefault\(\)/);
  assert.match(controlHandlers, /touchControlActivation\.cancel\(event\.pointerId, event\.timeStamp\)/);
  assert.match(controlHandlers, /touchControlActivation\.consumeClick\(\{/);
  assert.match(controlHandlers, /event\.stopPropagation\(\)/);
  assert.match(
    controlHandlers,
    /activateMobileControl\(\s*touchClick\.action,\s*touchClick\.context,\s*\{ manageKeyboard: true \},\s*\)/,
  );
  assert.match(
    controlHandlers,
    /touchClick\.kind === 'activate'[\s\S]*&& activateMobileControl\([\s\S]*\)\s*\) \{\s*showMobileControlFeedback\(event\.target, touchClick\.action\);/,
  );
  assert.match(controlHandlers, /const isNonPointingActivation = event\.detail === 0/);
  assert.match(controlHandlers, /manageKeyboard: !isNonPointingActivation/);
  assert.match(
    controlHandlers,
    /if \(activateMobileControl\(action, activeController,[\s\S]*\)\) \{\s*showMobileControlFeedback\(event\.target, action\);/,
  );
  assert.match(
    terminalScript,
    /const showMobileControlFeedback = \(target, action\) => \{[\s\S]*button\.dataset\.terminalModifier[\s\S]*button\.classList\.remove\('is-feedback-active'\);[\s\S]*button\.classList\.add\('is-feedback-active'\);/,
  );
  assert.match(
    terminalScript,
    /const clearMobileControlFeedback = \(event\) => \{[\s\S]*mobile-terminal-key-feedback[\s\S]*classList\.remove\('is-feedback-active'\);/,
  );
  assert.match(
    terminalScript,
    /mobileTerminalControls\.addEventListener\('animationend', clearMobileControlFeedback\);/,
  );
  assert.match(
    terminalScript,
    /mobileTerminalControls\.addEventListener\('animationcancel', clearMobileControlFeedback\);/,
  );
});

test('terminal uses compact mobile text and refits across the breakpoint', () => {
  const terminalScript = fs.readFileSync(terminalScriptPath, 'utf8');

  assert.match(terminalScript, /const desktopTerminalFontSize = 14;/);
  assert.match(terminalScript, /const mobileTerminalFontSize = 12;/);
  assert.match(
    terminalScript,
    /fontSize:\s*mobileLayoutQuery\.matches\s*\? mobileTerminalFontSize\s*:\s*desktopTerminalFontSize/s,
  );
  assert.match(
    terminalScript,
    /updateTerminalFontSize\(isMobile\)[\s\S]*this\.terminal\.options\.fontSize = fontSize;[\s\S]*this\.fitAndNotify\(\);/,
  );
  assert.match(
    terminalScript,
    /mobileLayoutQuery\.addEventListener\('change',[\s\S]*activeController\.updateTerminalFontSize\(event\.matches\);/,
  );
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
  assert.match(touchHandlers, /if \(event\.defaultPrevented/);
  assert.ok(
    touchHandlers.indexOf('event.defaultPrevented')
      < touchHandlers.indexOf('this.touchScrollGesture.start'),
    'xterm-owned pointer events must be rejected before mobile pointer capture',
  );
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
  assert.match(
    touchHandlers,
    /const outcome = this\.touchScrollGesture\.end\(event\.pointerId\)/,
  );
  assert.match(
    touchHandlers,
    /if \(outcome === 'gesture'\)[\s\S]*event\.preventDefault\(\);[\s\S]*this\.armTouchScrollClickSuppression\(\);[\s\S]*return;/,
  );
  assert.match(
    touchHandlers,
    /if \(outcome === 'tap' && this\.ready\) \{\s*this\.mobileFocus\.focusFromTerminalTap\(\);\s*\}/,
  );
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

  const readyHandler = terminalScript.slice(
    terminalScript.indexOf("if (message.type === 'ready')"),
    terminalScript.indexOf("if (message.type === 'exit')"),
  );
  assert.match(
    readyHandler,
    /if \(!mobileLayoutQuery\.matches\) \{\s*this\.terminal\.focus\(\);\s*\}/,
  );
});
