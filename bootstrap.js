import fs from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "fast-server.js");
const runtimePath = path.join(here, ".fast-server.runtime.mjs");

let source = await fs.readFile(sourcePath, "utf8");
const broken = `    strict: true\n\n];`;
const fixed = `    strict: true\n  },\n];`;

if (source.includes(broken)) {
  source = source.replace(broken, fixed);
  console.log("[bootstrap] Applied v0.4 LIFE_TOOLS syntax fix.");
}

await fs.writeFile(runtimePath, source, "utf8");
await import(`${pathToFileURL(runtimePath).href}?v=${Date.now()}`);
