// Bundle the node editor into a single self-contained HTML file: editor/dist/index.html
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const common = { bundle: true, minify: true, write: false, target: "es2020", logLevel: "error" };
const worker = await build({ ...common, entryPoints: [here + "worker.ts"], format: "iife" });
const main = await build({
  ...common, entryPoints: [here + "main.tsx"], format: "iife", jsx: "automatic", loader: { ".css": "text" },
  define: { WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text), "process.env.NODE_ENV": '"production"' },
});
const js = main.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = readFileSync(here + "index.html", "utf8").replace("<!--BUNDLE-->", () => "<script>" + js + "</script>");
mkdirSync(here + "dist", { recursive: true });
writeFileSync(here + "dist/index.html", html);
console.log("editor/dist/index.html", (html.length / 1024).toFixed(0) + " KB");
