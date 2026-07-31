const ESC = '\u001b';
const arrowCodes = Object.freeze({
  'arrow-down': 'B',
  'arrow-left': 'D',
  'arrow-right': 'C',
  'arrow-up': 'A',
});

const pageCodes = Object.freeze({
  'page-down': '6',
  'page-up': '5',
});

export class TouchScrollGesture {
  constructor(activationDistance = 8) {
    this.activationDistance = activationDistance;
    this.reset();
  }

  get activePointerId() {
    return this.pointerId;
  }

  start(pointerId, clientX, clientY) {
    if (this.pointerId !== null) {
      return false;
    }

    this.pointerId = pointerId;
    this.startX = clientX;
    this.startY = clientY;
    this.lastY = clientY;
    this.axis = 'pending';
    this.pixelRemainder = 0;
    return true;
  }

  move(pointerId, clientX, clientY, pixelsPerLine) {
    if (pointerId !== this.pointerId) {
      return { lines: 0, recognized: false };
    }

    if (this.axis === 'pending') {
      const horizontalDistance = Math.abs(clientX - this.startX);
      const verticalDistance = Math.abs(clientY - this.startY);
      if (Math.max(horizontalDistance, verticalDistance) < this.activationDistance) {
        return { lines: 0, recognized: false };
      }
      this.axis = verticalDistance >= horizontalDistance ? 'vertical' : 'horizontal';
    }

    if (this.axis !== 'vertical') {
      return { lines: 0, recognized: true };
    }

    const verticalMovement = clientY - this.lastY;
    this.lastY = clientY;
    if (!Number.isFinite(pixelsPerLine) || pixelsPerLine <= 0) {
      return { lines: 0, recognized: true };
    }

    this.pixelRemainder -= verticalMovement;
    const wholeLines = Math.trunc(this.pixelRemainder / pixelsPerLine);
    const lines = wholeLines === 0 ? 0 : wholeLines;
    this.pixelRemainder -= lines * pixelsPerLine;
    return { lines, recognized: true };
  }

  end(pointerId) {
    if (this.pointerId === null || pointerId !== this.pointerId) {
      return null;
    }

    const outcome = this.axis === 'pending' ? 'tap' : 'gesture';
    this.reset();
    return outcome;
  }

  cancel(pointerId = this.pointerId) {
    if (this.pointerId === null || pointerId !== this.pointerId) {
      return false;
    }

    this.reset();
    return true;
  }

  reset() {
    this.pointerId = null;
    this.startX = 0;
    this.startY = 0;
    this.lastY = 0;
    this.axis = 'pending';
    this.pixelRemainder = 0;
  }
}

export class TouchControlActivationGuard {
  constructor(compatibilityClickWindowMs = 1000, activationDistance = 8) {
    this.compatibilityClickWindowMs = compatibilityClickWindowMs;
    this.activationDistance = activationDistance;
    this.reset();
  }

  start(pointerId, action, context, clientX, clientY) {
    if (!action) {
      return false;
    }

    this.activeTouch = {
      pointerId,
      action,
      context,
      startX: clientX,
      startY: clientY,
      moved: false,
    };
    this.completedTouch = null;
    return true;
  }

  move(pointerId, clientX, clientY) {
    if (!this.activeTouch || pointerId !== this.activeTouch.pointerId) {
      return false;
    }

    if (Math.hypot(
      clientX - this.activeTouch.startX,
      clientY - this.activeTouch.startY,
    ) >= this.activationDistance) {
      this.activeTouch.moved = true;
    }
    return this.activeTouch.moved;
  }

  end(pointerId, releaseAction, timestamp, clientX, clientY) {
    if (!this.activeTouch || pointerId !== this.activeTouch.pointerId) {
      return false;
    }

    const touch = this.activeTouch;
    this.activeTouch = null;
    this.completedTouch = {
      pointerId: touch.pointerId,
      action: touch.action,
      context: touch.context,
      completedAt: timestamp,
      clientX,
      clientY,
      canActivate: !touch.moved && releaseAction === touch.action,
      handled: false,
      invalidated: false,
    };
    return true;
  }

  cancel(pointerId = this.activeTouch?.pointerId, timestamp = null) {
    if (!this.activeTouch || pointerId !== this.activeTouch.pointerId) {
      return false;
    }

    const touch = this.activeTouch;
    this.activeTouch = null;
    this.completedTouch = Number.isFinite(timestamp)
      ? {
        pointerId: touch.pointerId,
        action: touch.action,
        context: touch.context,
        completedAt: timestamp,
        clientX: touch.startX,
        clientY: touch.startY,
        canActivate: false,
        handled: false,
        invalidated: false,
      }
      : null;
    return true;
  }

  consumeClick({
    action,
    clientX,
    clientY,
    detail,
    firesTouchEvents,
    isControlTarget,
    pointerId,
    pointerType,
    timestamp,
  }) {
    const touch = this.completedTouch;
    if (!touch) {
      return null;
    }

    if (!touch.invalidated) {
      const elapsed = timestamp - touch.completedAt;
      if (elapsed < 0 || elapsed > this.compatibilityClickWindowMs) {
        this.completedTouch = null;
        return null;
      }
    }

    const hasMatchingTouchIdentity = pointerType === 'touch'
      && pointerId === touch.pointerId;
    if (detail === 0 && !hasMatchingTouchIdentity) {
      return null;
    }
    const matchesTouchPosition = Number.isFinite(clientX)
      && Number.isFinite(clientY)
      && Number.isFinite(touch.clientX)
      && Number.isFinite(touch.clientY)
      && Math.hypot(clientX - touch.clientX, clientY - touch.clientY)
        < this.activationDistance;
    const isLegacyTouchClick = detail !== 0
      && pointerType !== 'touch'
      && firesTouchEvents !== false
      && (firesTouchEvents === true || !pointerType)
      && (action === touch.action
        || matchesTouchPosition
        || (!touch.canActivate && isControlTarget));
    if (!hasMatchingTouchIdentity && !isLegacyTouchClick) {
      return null;
    }

    if (touch.handled || !touch.canActivate) {
      touch.handled = true;
      return { kind: 'suppress' };
    }

    touch.handled = true;
    return {
      kind: 'activate',
      action: touch.action,
      context: touch.context,
    };
  }

  invalidate() {
    if (this.activeTouch) {
      const touch = this.activeTouch;
      this.activeTouch = null;
      this.completedTouch = {
        pointerId: touch.pointerId,
        action: touch.action,
        context: touch.context,
        completedAt: null,
        clientX: touch.startX,
        clientY: touch.startY,
        canActivate: false,
        handled: false,
        invalidated: true,
      };
      return;
    }
    if (this.completedTouch) {
      this.completedTouch.canActivate = false;
      this.completedTouch.invalidated = true;
    }
  }

  reset() {
    this.activeTouch = null;
    this.completedTouch = null;
  }
}

function modifierMask({ ctrl = false, alt = false, shift = false } = {}) {
  return (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0);
}

function controlCharacter(character) {
  const codePoint = character.codePointAt(0);
  if ((codePoint >= 65 && codePoint <= 90) || (codePoint >= 97 && codePoint <= 122)) {
    return String.fromCodePoint(codePoint & 31);
  }

  if (character === ' ' || character === '@') {
    return '\u0000';
  }
  if (character >= '3' && character <= '7') {
    return String.fromCodePoint(character.codePointAt(0) - 24);
  }
  if (character === '8') {
    return '\u007f';
  }

  const punctuationControls = {
    '[': '\u001b',
    '\\': '\u001c',
    ']': '\u001d',
    '^': '\u001e',
    _: '\u001f',
  };
  return punctuationControls[character];
}

function isMouseReport(data) {
  return /^\u001b\[<\d+;\d+;\d+[Mm]$/.test(data)
    || /^\u001b\[\d+;\d+;\d+M$/.test(data)
    || /^\u001b\[M[\s\S]{3}$/.test(data);
}

export function isTerminalFocusReport(data) {
  return data === `${ESC}[I` || data === `${ESC}[O`;
}

export function mobileModifierOpensKeyboard(modifier, isActive) {
  return (modifier === 'ctrl' || modifier === 'alt') && !isActive;
}

export class MobileTerminalFocusManager {
  constructor(terminal, getActiveElement) {
    this.terminal = terminal;
    this.getActiveElement = getActiveElement;
    this.internalFocusDepth = 0;
  }

  shouldSuppressInput(data) {
    return this.internalFocusDepth > 0 && isTerminalFocusReport(data);
  }

  runInternalFocusChange(callback) {
    this.internalFocusDepth += 1;
    try {
      return callback();
    } finally {
      this.internalFocusDepth -= 1;
    }
  }

  transitionKeyboard(updateState) {
    return this.runInternalFocusChange(() => {
      const textarea = this.terminal.textarea;
      if (textarea) {
        for (
          let attempt = 0;
          attempt < 2 && this.getActiveElement() === textarea;
          attempt += 1
        ) {
          this.terminal.blur();
        }
      }
      const needsKeyboard = updateState();
      if (needsKeyboard) {
        this.terminal.focus();
      }
      return needsKeyboard;
    });
  }

  openKeyboard() {
    this.transitionKeyboard(() => true);
  }

  closeKeyboard() {
    this.transitionKeyboard(() => false);
  }

  focusFromTerminalTap() {
    const textarea = this.terminal.textarea;
    if (textarea && this.getActiveElement() === textarea) {
      this.openKeyboard();
      return;
    }
    this.terminal.focus();
  }
}

export function encodeMobileTerminalKey(
  action,
  applicationCursorKeysMode,
  modifiers = {},
) {
  const { ctrl = false, alt = false, shift = false } = modifiers;
  const mask = modifierMask(modifiers);

  if (action === 'escape') {
    return `${alt ? ESC : ''}${ESC}`;
  }
  if (action === 'tab') {
    return shift ? `${ESC}[Z` : '\t';
  }
  if (action === 'enter') {
    return `${alt ? ESC : ''}\r`;
  }

  const arrowCode = arrowCodes[action];
  if (arrowCode) {
    if (mask) {
      return `${ESC}[1;${mask + 1}${arrowCode}`;
    }
    return `${ESC}${applicationCursorKeysMode ? 'O' : '['}${arrowCode}`;
  }

  if (action === 'home' || action === 'end') {
    const keyCode = action === 'home' ? 'H' : 'F';
    if (mask) {
      return `${ESC}[1;${mask + 1}${keyCode}`;
    }
    return `${ESC}${applicationCursorKeysMode ? 'O' : '['}${keyCode}`;
  }

  const pageCode = pageCodes[action];
  if (pageCode) {
    if (shift) {
      return null;
    }
    if (ctrl) {
      return `${ESC}[${pageCode};${mask + 1}~`;
    }
    return `${ESC}[${pageCode}~`;
  }

  return null;
}

export function transformMobileTerminalInput(data, modifiers = {}) {
  const { ctrl = false, alt = false, shift = false } = modifiers;
  if (!data || (!ctrl && !alt && !shift)) {
    return { data, consumed: false };
  }

  if (isTerminalFocusReport(data) || isMouseReport(data)) {
    return { data, consumed: false };
  }

  if (data.startsWith(`${ESC}[200~`)) {
    return { data, consumed: true };
  }

  const [firstCharacter] = data;
  const remainder = data.slice(firstCharacter.length);
  const modifiedCharacter = ctrl
    ? controlCharacter(firstCharacter) ?? firstCharacter
    : firstCharacter;
  return {
    data: `${alt ? ESC : ''}${modifiedCharacter}${remainder}`,
    consumed: true,
  };
}
