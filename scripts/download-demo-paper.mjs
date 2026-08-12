import path from "node:path";
import { downloadArxivPaper } from "../electron/paper-services.mjs";
import { windowsSystemFetch } from "../electron/windows-fetch.mjs";

const outputDir = path.join(process.cwd(), "output", "playwright");
const paper = await downloadArxivPaper("1706.03762", outputDir, windowsSystemFetch);
console.log(paper.path);
