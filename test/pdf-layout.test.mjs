import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateFitZoom,
  MAX_PDF_ZOOM,
  MIN_PDF_ZOOM,
  pdfCanvasSize,
} from "../src/pdf-layout.mjs";

test("large and tall PDF pages keep raster allocation bounded while preserving logical zoom", () => {
  assert.deepEqual(pdfCanvasSize(612, 792, 2), { width: 1224, height: 1584, ratio: 2 });
  for (const [width, height] of [[2448, 3168], [1000, 100000], [100000, 100000]]) {
    const canvas = pdfCanvasSize(width, height, 3);
    assert.ok(canvas.width * canvas.height <= 16_000_000);
    assert.ok(canvas.width <= 8192 && canvas.height <= 8192);
    assert.ok(canvas.ratio > 0 && canvas.ratio <= 2);
  }
  assert.throws(() => pdfCanvasSize(Infinity, 1000), /无效/);
});

test("fit-width zoom uses the full reader width instead of the old 140% ceiling", () => {
  const zoom = calculateFitZoom({
    stageWidth: 1_372,
    paddingLeft: 44,
    paddingRight: 44,
    pageWidth: 612,
  });

  assert.ok(zoom > 2);
  assert.ok(zoom < 2.2);
  assert.equal(Math.round(612 * zoom), 1_282);
});

test("fit-width zoom accounts for stage padding and keeps safe bounds", () => {
  assert.equal(calculateFitZoom({
    stageWidth: 100,
    paddingLeft: 44,
    paddingRight: 44,
    pageWidth: 612,
  }), MIN_PDF_ZOOM);

  assert.equal(calculateFitZoom({
    stageWidth: 10_000,
    pageWidth: 612,
  }), MAX_PDF_ZOOM);
});
