// Phone cameras produce photos far larger than an agent needs and than the 10 MiB image store
// accepts. Re-encoding through a canvas also applies EXIF orientation and drops metadata such as
// GPS location.
export const PHOTO_MAX_EDGE = 2048;
export const PHOTO_JPEG_QUALITY = 0.85;

export function scaledPhotoSize(width, height, maxEdge = PHOTO_MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function preparePhoto(file, {
  decode = (blob) => globalThis.createImageBitmap(blob, { imageOrientation: 'from-image' }),
  createCanvas = () => globalThis.document.createElement('canvas'),
} = {}) {
  const bitmap = await decode(file);
  try {
    const { width, height } = scaledPhotoSize(bitmap.width, bitmap.height);
    const canvas = createCanvas();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    // JPEG has no alpha channel; transparent pixels would otherwise turn black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Unable to encode the photo.'));
      }, 'image/jpeg', PHOTO_JPEG_QUALITY);
    });
  } finally {
    bitmap.close();
  }
}
