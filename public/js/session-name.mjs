export function normalizeTerminalSessionNameInput(input) {
  const normalizedValue = input.value.replace(
    /[A-Z]/g,
    (letter) => letter.toLowerCase(),
  );
  if (normalizedValue === input.value) {
    return normalizedValue;
  }

  const selectionStart = input.selectionStart;
  const selectionEnd = input.selectionEnd;
  const selectionDirection = input.selectionDirection;
  input.value = normalizedValue;
  if (selectionStart !== null && selectionEnd !== null) {
    input.setSelectionRange(selectionStart, selectionEnd, selectionDirection || 'none');
  }
  return normalizedValue;
}

export function bindTerminalSessionNameNormalization(input) {
  const normalize = () => normalizeTerminalSessionNameInput(input);
  input.addEventListener('input', normalize);
  return normalize;
}
