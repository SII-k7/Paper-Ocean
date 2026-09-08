export declare const MIN_PDF_ZOOM: number;
export declare const MAX_PDF_ZOOM: number;
export function pdfCanvasSize(width: number, height: number, devicePixelRatio?: number): { width: number; height: number; ratio: number };

export declare function calculateFitZoom(input: {
  stageWidth: number;
  paddingLeft?: number;
  paddingRight?: number;
  pageWidth: number;
  minimum?: number;
  maximum?: number;
}): number;
