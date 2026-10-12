const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

// Decodes an OSC 52 payload ("Pc;Pd", after the "52;" prefix) into the text a terminal
// program asked to place on the clipboard. Queries ("?") and malformed payloads return null:
// programs may write the clipboard, but never read it.
export function decodeOsc52ClipboardWrite(payload) {
  const separator = payload.indexOf(';');
  if (separator === -1) {
    return null;
  }
  const encoded = payload.slice(separator + 1);
  if (!encoded || encoded === '?') {
    return null;
  }
  try {
    const binary = atob(encoded);
    return utf8Decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}
