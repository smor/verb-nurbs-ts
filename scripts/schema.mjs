// Writes schema/graph.v2.schema.json from the node registry (`Graph.schema`). Run after `npm run build`.
// docs/formats.md says when the checked-in schema may change: node types and ports may be added, never changed.
import { writeFileSync } from "node:fs";
import { Graph } from "../dist/index.js";

const file = new URL( "../schema/graph.v2.schema.json", import.meta.url );
writeFileSync( file, JSON.stringify( Graph.schema(), null, 2 ) + "\n" );
console.log( "wrote schema/graph.v2.schema.json" );
