import process from "node:process";
import { createPaperOceanWebServer } from "../server/web-server.mjs";

const url = "http://127.0.0.1:5173";
const webServer = await createPaperOceanWebServer({
  host: "127.0.0.1",
  port: 5173,
});

await webServer.listen();

console.log("");
console.log("Paper Ocean Chrome 本地预览已启动：");
console.log(`  ${url}`);
console.log("");
console.log("请保持此终端窗口开启；代码更新会自动刷新页面。");
console.log("按 Ctrl+C 停止本地服务。");

let stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n收到 ${signal}，正在停止 Paper Ocean…`);

  try {
    await webServer.close();
  } catch (error) {
    console.error("停止本地服务时出现错误：", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
