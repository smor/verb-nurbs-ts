// esbuild loads stylesheets as text (build.mjs: loader ".css": "text")
declare module "*.css" { const text : string; export default text; }
