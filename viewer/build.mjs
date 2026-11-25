// Bundle the viewer into a single self-contained HTML file: viewer/dist/index.html
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const worker = await build({ entryPoints: [here + "worker.ts"], bundle: true, format: "iife", minify: true, write: false, target: "es2020" });
const main = await build({
  entryPoints: [here + "main.ts"], bundle: true, format: "iife", minify: true, write: false, target: "es2020",
  define: { WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text) },
});
const js = main.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = readFileSync(here + "index.html", "utf8").replace("<!--BUNDLE-->", () => "<script>" + js + "</script>");
mkdirSync(here + "dist", { recursive: true });
writeFileSync(here + "dist/index.html", html);
console.log("viewer/dist/index.html", (html.length / 1024).toFixed(0) + " KB");
