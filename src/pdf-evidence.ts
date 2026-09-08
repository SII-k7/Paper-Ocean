import { pdfjs, pdfResourceOptions } from "./pdf-runtime";
import type { OpenedPaper } from "./types";

export async function renderEvidencePage(paper: OpenedPaper, pageNumber: number): Promise<string> {
  const binary = atob(paper.dataBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const task = pdfjs.getDocument({ ...pdfResourceOptions(), data: bytes });
  const canvas = document.createElement("canvas");
  try {
    const document = await task.promise;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) throw new Error("取证页码无效");
    const page = await document.getPage(pageNumber);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(1.5, 1600 / natural.width, 2000 / natural.height) });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法生成原文页图");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    await task.destroy();
  }
}
