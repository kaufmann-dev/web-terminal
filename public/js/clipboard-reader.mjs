const supportedImageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

function clipboardTypes(items) {
  return items.flatMap((item) => Array.from(item.types || []));
}

export async function readClipboardContent(clipboard) {
  if (!clipboard) {
    return { kind: 'unavailable' };
  }

  if (typeof clipboard.read === 'function') {
    let items;
    try {
      items = await clipboard.read();
    } catch (error) {
      return { kind: 'denied', error };
    }

    for (const item of items) {
      const imageType = Array.from(item.types || []).find((type) => (
        supportedImageTypes.has(type)
      ));
      if (imageType) {
        return {
          kind: 'image',
          image: await item.getType(imageType),
          contentType: imageType,
        };
      }
    }

    for (const item of items) {
      if (!Array.from(item.types || []).includes('text/plain')) {
        continue;
      }
      const text = await (await item.getType('text/plain')).text();
      return text ? { kind: 'text', text } : { kind: 'empty' };
    }

    return clipboardTypes(items).length > 0
      ? { kind: 'unsupported' }
      : { kind: 'empty' };
  }

  if (typeof clipboard.readText !== 'function') {
    return { kind: 'unavailable' };
  }

  try {
    const text = await clipboard.readText();
    return text ? { kind: 'text', text } : { kind: 'empty' };
  } catch (error) {
    return { kind: 'denied', error };
  }
}
