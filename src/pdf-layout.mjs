export const MIN_PDF_ZOOM = 0.25;
export const MAX_PDF_ZOOM = 4;

export function pdfCanvasSize(width, height, devicePixelRatio = 1) {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) throw new Error("PDF 页面尺寸无效。");
  // Extremely tall pages and HiDPI zoom must not allocate an unbounded bitmap.
  const ratio = Math.min(Math.max(Number(devicePixelRatio) || 1, 1), 2, Math.sqrt(16_000_000 / (width * height)), 8192 / width, 8192 / height);
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), ratio };
}

export function calculateFitZoom({
  stageWidth,
  paddingLeft = 0,
  paddingRight = 0,
  pageWidth,
  minimum = MIN_PDF_ZOOM,
  maximum = MAX_PDF_ZOOM,
}) {
  const safePageWidth = Number(pageWidth);
  if (!Number.isFinite(safePageWidth) || safePageWidth <= 0) return minimum;

  const availableWidth = Math.max(
    Number(stageWidth || 0) - Number(paddingLeft || 0) - Number(paddingRight || 0) - 2,
    1,
  );
  return Math.min(maximum, Math.max(minimum, availableWidth / safePageWidth));
}
