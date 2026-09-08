import * as pdfjs from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

export function pdfResourceOptions() {
  const asset = (folder: string) => new URL(`${import.meta.env.BASE_URL}pdfjs/${folder}/`, window.location.href).href;
  return { cMapUrl: asset("cmaps"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts"), iccUrl: asset("iccs"), wasmUrl: asset("wasm") };
}

export { pdfjs };
