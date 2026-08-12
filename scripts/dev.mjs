import { spawn } from "node:child_process";
import process from "node:process";
import { createServer } from "vite";

const server = await createServer({
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});

await server.listen();

const electronBinary = process.platform === "win32"
  ? new URL("../node_modules/electron/dist/electron.exe", import.meta.url).pathname.slice(1)
  : new URL("../node_modules/.bin/electron", import.meta.url).pathname;

const electron = spawn(electronBinary, ["."], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PAPER_OCEAN_DEV_URL: "http://127.0.0.1:5173",
  },
  stdio: "inherit",
});

const stop = async () => {
  if (!electron.killed) electron.kill();
  await server.close();
};

electron.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
