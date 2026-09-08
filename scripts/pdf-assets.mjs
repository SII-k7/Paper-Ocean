import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function pdfAssetsPlugin() {
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  let filesPromise;
  let building = false;
  const files = () => filesPromise ??= (async () => {
    const result = new Map();
    for (const folder of ["cmaps", "standard_fonts", "iccs", "wasm"]) {
      for (const item of await fs.readdir(path.join(root, folder), { withFileTypes: true })) {
        if (item.isFile()) result.set(`pdfjs/${folder}/${item.name}`, path.join(root, folder, item.name));
      }
    }
    return result;
  })();
  return {
    name: "paper-ocean-offline-pdf-assets",
    configResolved(config) { building = config.command === "build"; },
    async buildStart() {
      if (!building) return;
      for (const [fileName, filePath] of await files()) this.emitFile({ type: "asset", fileName, source: await fs.readFile(filePath) });
    },
    async configureServer(server) {
      const inventory = await files();
      server.middlewares.use(async (request, response, next) => {
        const filename = String(request.url || "").split("?")[0].replace(/^\//, "");
        const file = inventory.get(filename);
        if (!file) return next();
        try {
          response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream");
          response.end(await fs.readFile(file));
        } catch (error) { next(error); }
      });
    },
  };
}
