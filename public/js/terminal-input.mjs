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
      return false;
    }

    const recognized = this.axis !== 'pending';
    this.reset();
    return recognized;
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

  if (data === `${ESC}[I` || data === `${ESC}[O` || isMouseReport(data)) {
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
