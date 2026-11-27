// Dresses the pottery collection (editor/samples/ceramics, made by scripts/aippd.mjs) in looks: each vessel a material
// for its ware as AIPPD records it (impasto, fine clay, bucchero), its colour varied a little as firing varies it, and
// paint after its period's styles: incised meanders and zigzags on Early Iron Age impasto (filled with white, as many
// Villanovan ones were), painted bands and rays on fine wheelmade ware. AIPPD's profiles were drawn without their
// decoration, so the decoration illustrates the period's styles; it is not these vessels' own.
// `node scripts/ceramic-looks.mjs [file]` dresses a collection already made (again, replacing its looks).
import { readFileSync, writeFileSync } from "node:fs";

const CLOSED = new Set( ["jug", "jar", "necked_jar", "amphora", "mug"] );
// a number from 0 to 1, the same for the same text
const hash = ( s ) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt( 0 ); h = Math.imul( h, 16777619 ); } return (h >>> 0) / 4294967296; };
// a colour moved in lightness and warmth by up to `amount`, by the vessel's id
const vary = ( hex, id, amount ) => {
    const n = parseInt( hex.slice( 1 ), 16 ), t = (hash( id ) - 0.5) * 2 * amount, w = (hash( id + "w" ) - 0.5) * amount;
    const ch = ( v, k ) => Math.max( 0, Math.min( 255, Math.round( v * (1 + t) + 255 * w * k ) ) );
    return "#" + [ch( n >> 16, 0.6 ), ch( (n >> 8) & 255, 0.2 ), ch( n & 255, -0.3 )].map( v => v.toString( 16 ).padStart( 2, "0" ) ).join( "" );
};

// the looks of one vessel: [type, inputs] in order, the material first
export function looksFor( id, item, slug ) {
    const ware = item.ware ?? "", period = item.period ?? "", closed = CLOSED.has( slug );
    const out = [];
    if (ware == "Impasto") {
        // burnished from the Final Bronze Age on; dark, its colour mottled from brown to black by an uneven firing
        const burnished = ["FBA", "EIA1", "EIA2", "OP", "AP"].includes( period );
        out.push( ["look/material", { color : vary( hash( id + "f" ) < 0.5 ? "#3d2e24" : "#5a3f2c", id, 0.18 ), roughness : burnished ? 0.6 : 0.9, metalness : 0, clearcoat : burnished ? 0.08 : 0, grain : burnished ? 0.35 : 0.6 }] );
        if (period == "EIA1" || period == "EIA2") {
            // Villanovan: incised geometric friezes on the shoulder, filled with white
            out.push( ["look/motif", { motif : closed ? "meander" : "zigzag", color : "#cfc4ae", from : closed ? 0.58 : 0.72, to : closed ? 0.7 : 0.84, count : closed ? 14 : 18 }] );
            if (closed) out.push( ["look/motif", { motif : "zigzag", color : "#cfc4ae", from : 0.44, to : 0.5, count : 24 }] );
        } else if (period == "RBA" || period == "FBA") {
            if (closed) out.push( ["look/band", { color : "#2a201a", from : 0.62, to : 0.64 }], ["look/band", { color : "#2a201a", from : 0.66, to : 0.68 }] );
        }
    } else if (ware == "Argilla depurata") {
        // fine clay, wheelmade: buff, with painted bands; rays round the foot in the Archaic period
        out.push( ["look/material", { color : vary( "#d4ab82", id, 0.08 ), roughness : 0.8, metalness : 0, clearcoat : 0, grain : 0.15 }] );
        const paint = "#7a3520";
        out.push( ["look/band", { color : paint, from : 0.86, to : 1 }], ["look/band", { color : paint, from : 0.5, to : 0.53 }], ["look/band", { color : paint, from : 0.56, to : 0.58 }] );
        if (period == "AP" || period == "OP") out.push( ["look/motif", { motif : "rays", color : paint, from : 0.06, to : 0.3, count : 16 }] );
        else out.push( ["look/motif", { motif : "wave", color : paint, from : 0.64, to : 0.74, count : 10 }] );
    } else if (ware == "Bucchero") {
        // Etruscan bucchero: black through, polished to a gloss
        out.push( ["look/material", { color : vary( "#16120f", id, 0.1 ), roughness : 0.28, metalness : 0, clearcoat : 0.3, grain : 0.04 }] );
        if (closed) out.push( ["look/motif", { motif : "dots", color : "#2b2420", from : 0.6, to : 0.66, count : 30 }] );
    } else {
        out.push( ["look/material", { color : vary( "#b5653a", id, 0.1 ), roughness : 0.85, metalness : 0, clearcoat : 0, grain : 0.35 }] );
    }
    return out;
}

/** The collection with its looks: each vessel's chain of look nodes, its output through them. Its old looks go. */
export function dress( doc ) {
    // outputs back to their vessels, through the looks they had, and those looks gone
    for (const [name, ref] of Object.entries( doc.outputs )) {
        let id = ref.slice( 1 );
        while (doc.nodes[id]?.type.startsWith( "look/" )) id = String( doc.nodes[id].in.of ).slice( 1 );
        doc.outputs[name] = "@" + id;
    }
    for (const id of Object.keys( doc.nodes )) if (doc.nodes[id].type.startsWith( "look/" )) { delete doc.nodes[id]; delete doc.view?.nodes?.[id]; }
    const place = doc.view?.shelf?.place ?? {};
    for (const [name, ref] of Object.entries( doc.outputs )) {
        const id = ref.slice( 1 ).replace( /\..*/, "" );
        const node = doc.nodes[id];
        if (node?.type != "freeform/vessel") continue;
        // the canvas in the shelf's grid, a form per column and a period per row, wide enough for each vessel's looks
        const [period, form] = place[name] ?? [];
        const col = (doc.view?.shelf?.columns ?? []).findIndex( c => c.key == form ), line = (doc.view?.shelf?.rows ?? []).findIndex( r => r.key == period );
        const at = doc.view?.nodes && col >= 0 && line >= 0 ? (doc.view.nodes[id] = { x : col * 1500, y : line * 320 }) : null;
        let prev = "@" + id;
        looksFor( id, doc.meta.items[name] ?? {}, place[name]?.[1] ?? "" ).forEach( ( [type, inputs], k ) => {
            const lid = `${id}_${type == "look/material" ? "ware" : "paint" + k}`;
            doc.nodes[lid] = { type, in : { of : prev, ...inputs } };
            prev = "@" + lid;
            // after its vessel, in the vessel's row of the grid
            if (at != null) doc.view.nodes[lid] = { x : at.x + 300 * (k + 1), y : at.y };
        } );
        doc.outputs[name] = prev;
    }
    doc.meta.description = doc.meta.description.replace( / Materials follow.*$/, "" ) +
        " Materials follow each vessel's ware as AIPPD records it; the decoration illustrates its period's styles, not the vessel's own.";
    return doc;
}

if (process.argv[1] && import.meta.url.endsWith( process.argv[1].split( "/" ).pop() )) {
    const file = process.argv[2] ?? new URL( "../editor/samples/ceramics/italy-by-period.graph.json", import.meta.url ).pathname;
    const doc = dress( JSON.parse( readFileSync( file, "utf8" ) ) );
    writeFileSync( file, JSON.stringify( doc, null, 1 ) + "\n" );
    console.log( `dressed ${Object.keys( doc.outputs ).length} vessels in ${file}` );
}
