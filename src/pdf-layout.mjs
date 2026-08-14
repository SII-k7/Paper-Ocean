export const MIN_PDF_ZOOM = 0.65;
export const MAX_PDF_ZOOM = 4;

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
