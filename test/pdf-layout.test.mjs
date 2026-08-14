import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateFitZoom,
  MAX_PDF_ZOOM,
  MIN_PDF_ZOOM,
} from "../src/pdf-layout.mjs";

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
