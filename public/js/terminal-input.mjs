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

function modifierMask({ ctrl = false, alt = false } = {}) {
  return (alt ? 2 : 0) | (ctrl ? 4 : 0);
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
  const { ctrl = false, alt = false } = modifiers;
  const mask = modifierMask(modifiers);

  if (action === 'escape') {
    return `${alt ? ESC : ''}${ESC}`;
  }
  if (action === 'tab') {
    return '\t';
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
    if (ctrl) {
      return `${ESC}[${pageCode};${mask + 1}~`;
    }
    return `${ESC}[${pageCode}~`;
  }

  return null;
}

export function transformMobileTerminalInput(data, modifiers = {}) {
  const { ctrl = false, alt = false } = modifiers;
  if (!data || (!ctrl && !alt)) {
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
