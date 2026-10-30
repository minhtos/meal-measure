// Camera / file photo -> upright, downscaled JPEG. The server sees exactly these pixels, so the
// mask coordinates it returns line up with the preview shown here.
const MAX_SIDE = 1600;

export async function prepareImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * k);
  const height = Math.round(bmp.height * k);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bmp, 0, 0, width, height);
  bmp.close?.();
  const blob = await new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('could not read that photo'))), 'image/jpeg', 0.86));
  const base64 = await new Promise((ok) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.readAsDataURL(blob);
  });
  return { base64, url: URL.createObjectURL(blob), width, height };
}
