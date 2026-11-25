#!/usr/bin/env node
// Architecture check: every import in src/ must respect the layering in docs/packages.md, so the library can be split
// into packages (nurbs, mesh, brep, recipes, inspect) without untangling cycles first. Run by `npm run check` and CI.
//
// To change a rule, change docs/packages.md first, then this table, in the same pull request.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";

const SRC = resolve( dirname( new URL( import.meta.url ).pathname ), "..", "src" );

// folder -> folders it may import from (besides itself)
const ALLOWED = {
    core : ["eval"],              // core and eval import each other (upstream verb); one package, "nurbs"
    eval : ["core"],
    exe : [],
    geom : ["core", "eval", "exe"],
    solid : ["core", "eval"],
    recipes : ["core", "eval", "solid"],
    view : ["core", "eval", "solid"],
    io : ["core", "eval", "solid"],    // file formats (STEP); a package of its own, "io"

    types : [],
};
// the mesh package: these files may only import these modules, so they can serve any mesh, not just B-reps
const MESH = ["solid/TriMesh.ts", "solid/MeshBVH.ts", "solid/Makeable.ts"];
const MESH_ALLOWED = ["core/Data.ts", "core/Vec.ts", ...MESH];

function files( dir ) {
    return readdirSync( dir ).flatMap( f => {
        const p = join( dir, f );
        return statSync( p ).isDirectory() ? files( p ) : p.endsWith( ".ts" ) ? [p] : [];
    } );
}

const errors = [];
for (const file of files( SRC )) {
    const rel = relative( SRC, file ).split( "\\" ).join( "/" );
    if (rel == "index.ts") continue; // the entry point re-exports everything
    const layer = rel.split( "/" )[0];
    const src = readFileSync( file, "utf8" );
    for (const m of src.matchAll( /^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gms )) {
        const spec = m[1];
        if (!spec.startsWith( "." )) continue; // packages: checked by package.json, not here
        const target = relative( SRC, resolve( dirname( file ), spec ) ).split( "\\" ).join( "/" ).replace( /\.js$/, ".ts" );
        const to = target.split( "/" )[0];
        const line = src.slice( 0, m.index ).split( "\n" ).length;
        if (to != layer && !(ALLOWED[layer] ?? []).includes( to ))
            errors.push( `${rel}:${line} imports ${target}: "${layer}" may not depend on "${to}" (docs/packages.md)` );
        if (MESH.includes( rel ) && !MESH_ALLOWED.includes( target ))
            errors.push( `${rel}:${line} imports ${target}: the mesh modules may only use ${MESH_ALLOWED.join( ", " )}` );
    }
}
if (errors.length > 0) {
    console.error( errors.join( "\n" ) );
    console.error( `\n${errors.length} layering violation(s).` );
    process.exit( 1 );
}
console.log( "Layering: every import in src/ follows docs/packages.md." );
