const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const terminalInputModule = import(pathToFileURL(
  path.join(__dirname, '..', 'public', 'js', 'terminal-input.mjs'),
));

test('mobile terminal keys follow normal and application cursor modes', async () => {
  const { encodeMobileTerminalKey } = await terminalInputModule;

  assert.equal(encodeMobileTerminalKey('escape', false), '\u001b');
  assert.equal(encodeMobileTerminalKey('tab', false), '\t');
  assert.equal(encodeMobileTerminalKey('enter', false), '\r');
  assert.equal(encodeMobileTerminalKey('arrow-left', false), '\u001b[D');
  assert.equal(encodeMobileTerminalKey('arrow-up', true), '\u001bOA');
  assert.equal(encodeMobileTerminalKey('arrow-down', false), '\u001b[B');
  assert.equal(encodeMobileTerminalKey('arrow-right', true), '\u001bOC');
  assert.equal(encodeMobileTerminalKey('home', false), '\u001b[H');
  assert.equal(encodeMobileTerminalKey('home', true), '\u001bOH');
  assert.equal(encodeMobileTerminalKey('end', false), '\u001b[F');
  assert.equal(encodeMobileTerminalKey('end', true), '\u001bOF');
  assert.equal(encodeMobileTerminalKey('page-up', false), '\u001b[5~');
  assert.equal(encodeMobileTerminalKey('page-down', false), '\u001b[6~');
  assert.equal(encodeMobileTerminalKey('unknown', false), null);
});

test('mobile terminal keys encode Ctrl, Shift, and Alt like xterm', async () => {
  const { encodeMobileTerminalKey } = await terminalInputModule;

  assert.equal(
    encodeMobileTerminalKey('tab', false, { shift: true }),
    '\u001b[Z',
  );
  assert.equal(
    encodeMobileTerminalKey('arrow-right', false, { shift: true }),
    '\u001b[1;2C',
  );
  assert.equal(
    encodeMobileTerminalKey('arrow-left', false, { ctrl: true }),
    '\u001b[1;5D',
  );
  assert.equal(
    encodeMobileTerminalKey('arrow-up', true, { alt: true }),
    '\u001b[1;3A',
  );
  assert.equal(
    encodeMobileTerminalKey('end', true, { ctrl: true, shift: true, alt: true }),
    '\u001b[1;8F',
  );
  assert.equal(
    encodeMobileTerminalKey('page-up', false, { ctrl: true }),
    '\u001b[5;5~',
  );
  assert.equal(
    encodeMobileTerminalKey('page-down', false, { ctrl: true, alt: true }),
    '\u001b[6;7~',
  );
  assert.equal(
    encodeMobileTerminalKey('page-down', false, { alt: true }),
    '\u001b[6~',
  );
  assert.equal(
    encodeMobileTerminalKey('escape', false, { alt: true }),
    '\u001b\u001b',
  );
  assert.equal(
    encodeMobileTerminalKey('enter', false, { alt: true }),
    '\u001b\r',
  );
  assert.equal(
    encodeMobileTerminalKey('enter', false, { ctrl: true, shift: true }),
    '\r',
  );
  assert.equal(
    encodeMobileTerminalKey('page-up', false, { shift: true }),
    null,
  );
});

test('one-shot modifiers transform the next typed character', async () => {
  const { transformMobileTerminalInput } = await terminalInputModule;

  assert.deepEqual(
    transformMobileTerminalInput('c', { ctrl: true }),
    { data: '\u0003', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('C', { ctrl: true }),
    { data: '\u0003', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('v', { alt: true }),
    { data: '\u001bv', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('c', { ctrl: true, alt: true }),
    { data: '\u001b\u0003', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('ab', { ctrl: true }),
    { data: '\u0001b', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('é', { ctrl: true }),
    { data: 'é', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('é', { alt: true }),
    { data: '\u001bé', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('#', { shift: true }),
    { data: '#', consumed: true },
  );
  assert.deepEqual(
    transformMobileTerminalInput('plain text'),
    { data: 'plain text', consumed: false },
  );
});

test('Ctrl input supports xterm control-character aliases', async () => {
  const { transformMobileTerminalInput } = await terminalInputModule;
  const expectedControls = new Map([
    [' ', '\u0000'],
    ['@', '\u0000'],
    ['3', '\u001b'],
    ['4', '\u001c'],
    ['5', '\u001d'],
    ['6', '\u001e'],
    ['7', '\u001f'],
    ['8', '\u007f'],
    ['[', '\u001b'],
    ['\\', '\u001c'],
    [']', '\u001d'],
    ['^', '\u001e'],
    ['_', '\u001f'],
  ]);

  for (const [input, expected] of expectedControls) {
    assert.deepEqual(
      transformMobileTerminalInput(input, { ctrl: true }),
      { data: expected, consumed: true },
    );
  }
});

test('terminal protocol reports bypass armed mobile modifiers', async () => {
  const { transformMobileTerminalInput } = await terminalInputModule;
  const modifiers = { ctrl: true, shift: true, alt: true };

  assert.deepEqual(
    transformMobileTerminalInput('\u001b[I', modifiers),
    { data: '\u001b[I', consumed: false },
  );
  assert.deepEqual(
    transformMobileTerminalInput('\u001b[O', modifiers),
    { data: '\u001b[O', consumed: false },
  );
  assert.deepEqual(
    transformMobileTerminalInput('\u001b[<0;12;8M', modifiers),
    { data: '\u001b[<0;12;8M', consumed: false },
  );
  assert.deepEqual(
    transformMobileTerminalInput('\u001b[200~pasted\u001b[201~', modifiers),
    { data: '\u001b[200~pasted\u001b[201~', consumed: true },
  );
});

test('terminal focus reports are recognized exactly', async () => {
  const { isTerminalFocusReport } = await terminalInputModule;

  assert.equal(isTerminalFocusReport('\u001b[I'), true);
  assert.equal(isTerminalFocusReport('\u001b[O'), true);
  assert.equal(isTerminalFocusReport('\u001b[Iextra'), false);
  assert.equal(isTerminalFocusReport('\u001b[1;2I'), false);
  assert.equal(isTerminalFocusReport(''), false);
});

test('only arming Ctrl or Alt opens the mobile keyboard', async () => {
  const { mobileModifierOpensKeyboard } = await terminalInputModule;

  assert.equal(mobileModifierOpensKeyboard('shift', false), false);
  assert.equal(mobileModifierOpensKeyboard('shift', true), false);
  assert.equal(mobileModifierOpensKeyboard('ctrl', false), true);
  assert.equal(mobileModifierOpensKeyboard('ctrl', true), false);
  assert.equal(mobileModifierOpensKeyboard('alt', false), true);
  assert.equal(mobileModifierOpensKeyboard('alt', true), false);
});

test('mobile layout follows the unzoomed visual viewport above the software keyboard', async () => {
  const { mobileVisualViewportHeight } = await terminalInputModule;

  assert.equal(
    mobileVisualViewportHeight({ height: 844, offsetTop: 0, scale: 1 }, 844),
    844,
  );
  assert.equal(
    mobileVisualViewportHeight({ height: 475.25, offsetTop: 0, scale: 1 }, 844),
    475.25,
  );
  assert.equal(
    mobileVisualViewportHeight({ height: 430.25, offsetTop: 45, scale: 1 }, 844),
    475.25,
  );
  assert.equal(
    mobileVisualViewportHeight({ height: 422, offsetTop: 0, scale: 2 }, 844),
    844,
  );
  assert.equal(mobileVisualViewportHeight(null, 700), 700);
  assert.equal(mobileVisualViewportHeight({ height: 0, scale: 1 }, null), null);
});

test('mobile keyboard focus changes suppress only their synchronous xterm reports', async () => {
  const { MobileTerminalFocusManager } = await terminalInputModule;
  const textarea = {};
  const buffer = { x: 17, y: 4, ydisp: 9 };
  const calls = [];
  const forwarded = [];
  let activeElement = null;
  let focusManager;
  const emit = (data) => {
    if (!focusManager.shouldSuppressInput(data)) {
      forwarded.push(data);
    }
  };
  const terminal = {
    textarea,
    buffer,
    blur() {
      calls.push('blur');
      if (activeElement === textarea) {
        activeElement = null;
        emit('\u001b[O');
      }
    },
    focus() {
      calls.push('focus');
      if (activeElement !== textarea) {
        activeElement = textarea;
        emit('\u001b[I');
      }
    },
  };
  focusManager = new MobileTerminalFocusManager(terminal, () => activeElement);
  const originalBuffer = { ...buffer };

  focusManager.openKeyboard();
  assert.equal(activeElement, textarea);
  assert.deepEqual(calls, ['focus']);
  assert.deepEqual(forwarded, []);

  calls.length = 0;
  focusManager.openKeyboard();
  assert.equal(activeElement, textarea);
  assert.deepEqual(calls, ['blur', 'focus']);
  assert.deepEqual(forwarded, []);

  calls.length = 0;
  focusManager.closeKeyboard();
  assert.equal(activeElement, null);
  assert.deepEqual(calls, ['blur']);
  assert.deepEqual(forwarded, []);

  calls.length = 0;
  focusManager.focusFromTerminalTap();
  assert.equal(activeElement, textarea);
  assert.deepEqual(calls, ['focus']);
  assert.deepEqual(forwarded, ['\u001b[I']);

  calls.length = 0;
  focusManager.focusFromTerminalTap();
  assert.deepEqual(calls, ['blur', 'focus']);
  assert.deepEqual(forwarded, ['\u001b[I']);
  assert.deepEqual(buffer, originalBuffer);

  assert.throws(
    () => focusManager.runInternalFocusChange(() => { throw new Error('focus failed'); }),
    /focus failed/,
  );
  assert.equal(focusManager.shouldSuppressInput('\u001b[I'), false);
});

test('mobile modifier taps preserve the keyboard except when arming Ctrl or Alt', async () => {
  const {
    MobileTerminalFocusManager,
    mobileModifierOpensKeyboard,
    transformMobileTerminalInput,
  } = await terminalInputModule;
  const textarea = {};
  const modifiers = { ctrl: false, shift: false, alt: false };
  const sent = [];
  let activeElement = null;
  let pendingInput = '';
  let retainFocusAfterPendingCommit = true;
  let blurCalls = 0;
  let focusManager;
  const emit = (data) => {
    if (focusManager.shouldSuppressInput(data)) {
      return;
    }
    const result = transformMobileTerminalInput(data, modifiers);
    sent.push(result.data);
    if (result.consumed) {
      modifiers.ctrl = false;
      modifiers.shift = false;
      modifiers.alt = false;
    }
  };
  const terminal = {
    textarea,
    blur() {
      blurCalls += 1;
      if (activeElement !== textarea) {
        return;
      }
      if (pendingInput) {
        const data = pendingInput;
        pendingInput = '';
        emit(data);
        if (retainFocusAfterPendingCommit) {
          retainFocusAfterPendingCommit = false;
          return;
        }
      }
      activeElement = null;
      emit('\u001b[O');
    },
    focus() {
      activeElement = textarea;
      emit('\u001b[I');
    },
  };
  focusManager = new MobileTerminalFocusManager(terminal, () => activeElement);
  const toggle = (modifier) => {
    const opensKeyboard = mobileModifierOpensKeyboard(modifier, modifiers[modifier]);
    const updateModifier = () => {
      modifiers[modifier] = !modifiers[modifier];
    };
    if (opensKeyboard) {
      return focusManager.transitionKeyboard(() => {
        updateModifier();
        return true;
      });
    }
    updateModifier();
    return false;
  };

  assert.equal(toggle('shift'), false);
  assert.equal(modifiers.shift, true);
  assert.equal(activeElement, null);
  assert.deepEqual(sent, []);
  assert.equal(blurCalls, 0);

  activeElement = textarea;
  assert.equal(toggle('shift'), false);
  assert.equal(modifiers.shift, false);
  assert.equal(activeElement, textarea);
  assert.deepEqual(sent, []);
  assert.equal(blurCalls, 0);

  pendingInput = 'a';
  assert.equal(toggle('ctrl'), true);
  assert.equal(modifiers.ctrl, true);
  assert.equal(activeElement, textarea);
  assert.deepEqual(sent, ['a']);
  assert.equal(blurCalls, 2);

  assert.equal(toggle('ctrl'), false);
  assert.equal(modifiers.ctrl, false);
  assert.equal(activeElement, textarea);
  assert.equal(blurCalls, 2);

  pendingInput = 'b';
  retainFocusAfterPendingCommit = true;
  assert.equal(toggle('alt'), true);
  assert.equal(modifiers.alt, true);
  assert.equal(activeElement, textarea);
  assert.deepEqual(sent, ['a', 'b']);
  assert.equal(blurCalls, 4);
});

test('touch scrolling activates after a predominantly vertical eight-pixel drag', async () => {
  const { TouchScrollGesture } = await terminalInputModule;
  const gesture = new TouchScrollGesture();

  assert.equal(gesture.start(3, 100, 100), true);
  assert.equal(gesture.start(4, 100, 100), false);
  assert.deepEqual(
    gesture.move(3, 104, 107, 10),
    { lines: 0, recognized: false },
  );
  assert.deepEqual(
    gesture.move(3, 102, 108, 10),
    { lines: 0, recognized: true },
  );
  assert.deepEqual(
    gesture.move(3, 102, 118, 10),
    { lines: -1, recognized: true },
  );
  assert.equal(gesture.end(3), 'gesture');
  assert.equal(gesture.activePointerId, null);
});

test('touch release distinguishes a tap from a gesture or unrelated pointer', async () => {
  const { TouchScrollGesture } = await terminalInputModule;
  const gesture = new TouchScrollGesture();

  gesture.start(5, 40, 60);
  assert.deepEqual(
    gesture.move(5, 44, 65, 10),
    { lines: 0, recognized: false },
  );
  assert.equal(gesture.end(6), null);
  assert.equal(gesture.activePointerId, 5);
  assert.equal(gesture.end(5), 'tap');
  assert.equal(gesture.activePointerId, null);
  assert.equal(gesture.end(5), null);
});

test('touch scrolling uses natural direction and retains fractional row travel', async () => {
  const { TouchScrollGesture } = await terminalInputModule;
  const gesture = new TouchScrollGesture();

  gesture.start(7, 0, 100);
  assert.deepEqual(
    gesture.move(7, 0, 125, 10),
    { lines: -2, recognized: true },
  );
  assert.deepEqual(
    gesture.move(7, 0, 130, 10),
    { lines: -1, recognized: true },
  );
  assert.equal(gesture.end(7), 'gesture');

  gesture.start(8, 0, 100);
  assert.deepEqual(
    gesture.move(8, 0, 75, 10),
    { lines: 2, recognized: true },
  );
  assert.deepEqual(
    gesture.move(8, 0, 70, 10),
    { lines: 1, recognized: true },
  );
});

test('touch scrolling locks horizontal gestures and ignores other pointers', async () => {
  const { TouchScrollGesture } = await terminalInputModule;
  const gesture = new TouchScrollGesture();

  gesture.start(11, 20, 20);
  assert.deepEqual(
    gesture.move(12, 20, 50, 10),
    { lines: 0, recognized: false },
  );
  assert.equal(gesture.end(12), null);
  assert.deepEqual(
    gesture.move(11, 30, 22, 10),
    { lines: 0, recognized: true },
  );
  assert.deepEqual(
    gesture.move(11, 30, 60, 10),
    { lines: 0, recognized: true },
  );
  assert.equal(gesture.cancel(12), false);
  assert.equal(gesture.cancel(11), true);
  assert.equal(gesture.activePointerId, null);
  assert.equal(gesture.cancel(), false);
});

test('touch control activation uses one matched touch click and suppresses duplicates', async () => {
  const { TouchControlActivationGuard } = await terminalInputModule;
  const activation = new TouchControlActivationGuard();
  const controller = {};

  assert.equal(activation.start(21, 'modifier-shift', controller, 10, 20), true);
  assert.equal(activation.end(21, 'modifier-shift', 100), true);
  assert.deepEqual(
    activation.consumeClick({
      action: 'modifier-shift',
      detail: 1,
      isControlTarget: true,
      pointerId: 21,
      pointerType: 'touch',
      timestamp: 100,
    }),
    { kind: 'activate', action: 'modifier-shift', context: controller },
  );
  for (const timestamp of [150, 400, 1100]) {
    assert.deepEqual(
      activation.consumeClick({
        action: 'modifier-shift',
        detail: 1,
        isControlTarget: true,
        pointerId: 21,
        pointerType: 'touch',
        timestamp,
      }),
      { kind: 'suppress' },
    );
  }
  assert.equal(activation.consumeClick({
    action: 'modifier-shift',
    detail: 1,
    isControlTarget: true,
    pointerId: 21,
    pointerType: 'touch',
    timestamp: 1101,
  }), null);
});

test('touch control activation rejects movement, release mismatch, and stale context', async () => {
  const { TouchControlActivationGuard } = await terminalInputModule;
  const activation = new TouchControlActivationGuard();
  const firstController = {};
  const secondController = {};

  assert.equal(activation.start(31, 'modifier-shift', firstController, 0, 0), true);
  assert.equal(activation.move(32, 20, 0), false);
  assert.equal(activation.move(31, 7, 0), false);
  assert.equal(activation.move(31, 8, 0), true);
  assert.equal(activation.end(31, 'modifier-shift', 100), true);
  assert.deepEqual(activation.consumeClick({
    action: 'modifier-shift',
    detail: 1,
    isControlTarget: true,
    pointerId: 31,
    pointerType: 'touch',
    timestamp: 100,
  }), { kind: 'suppress' });

  assert.equal(activation.start(32, 'modifier-shift', firstController, 0, 0), true);
  assert.equal(activation.end(32, 'modifier-ctrl', 150), true);
  assert.deepEqual(activation.consumeClick({
    action: 'modifier-ctrl',
    detail: 1,
    isControlTarget: true,
    pointerId: 32,
    pointerType: 'touch',
    timestamp: 150,
  }), { kind: 'suppress' });

  assert.equal(activation.start(33, 'modifier-alt', firstController, 0, 0), true);
  assert.equal(activation.cancel(34, 175), false);
  assert.equal(activation.cancel(33, 175), true);
  assert.deepEqual(activation.consumeClick({
    action: 'modifier-alt',
    detail: 1,
    isControlTarget: true,
    pointerId: 33,
    pointerType: 'touch',
    timestamp: 175,
  }), { kind: 'suppress' });

  assert.equal(activation.start(34, 'modifier-ctrl', firstController, 0, 0), true);
  assert.equal(activation.end(34, 'modifier-ctrl', 200), true);
  assert.equal(activation.start(35, 'modifier-alt', secondController, 0, 0), true);
  assert.equal(activation.end(35, 'modifier-alt', 250), true);
  assert.deepEqual(activation.consumeClick({
    action: null,
    detail: 1,
    isControlTarget: false,
    pointerId: 35,
    pointerType: 'touch',
    timestamp: 250,
  }), { kind: 'activate', action: 'modifier-alt', context: secondController });
  assert.equal(activation.consumeClick({
    action: 'modifier-ctrl',
    detail: 1,
    isControlTarget: true,
    pointerId: 34,
    pointerType: 'touch',
    timestamp: 251,
  }), null);

  activation.start(36, 'modifier-shift', firstController, 0, 0);
  activation.invalidate();
  assert.equal(activation.end(36, 'modifier-shift', 10000), false);
  assert.deepEqual(activation.consumeClick({
    action: 'modifier-shift',
    detail: 1,
    isControlTarget: true,
    pointerId: 36,
    pointerType: 'touch',
    timestamp: 10000,
  }), { kind: 'suppress' });
});

test('touch click fallback distinguishes legacy touch, real mouse, and accessibility', async () => {
  const { TouchControlActivationGuard } = await terminalInputModule;
  const activation = new TouchControlActivationGuard();
  const controller = {};

  activation.start(41, 'modifier-ctrl', controller, 0, 0);
  activation.end(41, 'modifier-ctrl', 300);
  assert.equal(activation.consumeClick({
    action: 'modifier-ctrl',
    detail: 0,
    isControlTarget: true,
    pointerId: -1,
    pointerType: '',
    timestamp: 301,
  }), null);
  assert.equal(activation.consumeClick({
    action: 'modifier-ctrl',
    detail: 1,
    firesTouchEvents: false,
    isControlTarget: true,
    pointerId: 1,
    pointerType: 'mouse',
    timestamp: 302,
  }), null);
  assert.deepEqual(activation.consumeClick({
    action: 'modifier-ctrl',
    detail: 1,
    isControlTarget: true,
    pointerId: null,
    pointerType: '',
    timestamp: 303,
  }), { kind: 'activate', action: 'modifier-ctrl', context: controller });

  activation.start(42, 'modifier-alt', controller, 0, 0);
  activation.end(42, 'modifier-alt', 400);
  assert.deepEqual(activation.consumeClick({
    action: 'modifier-alt',
    detail: 0,
    isControlTarget: true,
    pointerId: 42,
    pointerType: 'touch',
    timestamp: 400,
  }), { kind: 'activate', action: 'modifier-alt', context: controller });

  activation.start(43, 'modifier-shift', controller, 50, 60);
  activation.end(43, 'modifier-shift', 500, 50, 60);
  assert.deepEqual(activation.consumeClick({
    action: null,
    clientX: 51,
    clientY: 60,
    detail: 1,
    isControlTarget: false,
    pointerId: null,
    pointerType: '',
    timestamp: 501,
  }), { kind: 'activate', action: 'modifier-shift', context: controller });
});
