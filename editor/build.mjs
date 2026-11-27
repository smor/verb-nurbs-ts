// Bundle the node editor into a single self-contained HTML file: editor/dist/index.html (or EDITOR_OUT).
// EDITOR_START=<graph.json> builds an editor that opens on that document (for a page shared with a project's team);
// a document in the link or autosaved in the browser still comes first.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const common = { bundle: true, minify: true, write: false, target: "es2020", logLevel: "error" };
const worker = await build({ ...common, entryPoints: [here + "worker.ts"], format: "iife" });
const main = await build({
  ...common, entryPoints: [here + "main.tsx"], format: "iife", jsx: "automatic", loader: { ".css": "text" },
  define: { WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text), "process.env.NODE_ENV": '"production"',
    START_DOC: JSON.stringify(process.env.EDITOR_START ? readFileSync(process.env.EDITOR_START, "utf8") : "") },
});
const js = main.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = readFileSync(here + "index.html", "utf8").replace("<!--BUNDLE-->", () => "<script>" + js + "</script>");
const out = process.env.EDITOR_OUT ?? here + "dist/index.html";
mkdirSync(out.replace(/[^/]*$/, ""), { recursive: true });
writeFileSync(out, html);
console.log(out, (html.length / 1024).toFixed(0) + " KB");
