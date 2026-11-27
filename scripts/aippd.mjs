// Builds a ceramics collection graph from AIPPD, the Ancient Italy Pottery Profiles Dataset (Cardarelli, L. 2024,
// Morphological variability and standardisation of vessel shapes in the 2nd and first half of the 1st millennium BC in
// continental Italy, Adrias 18, Edipuglia, doi:10.4475/0840; data at doi:10.5281/zenodo.24249544, Apache 2.0).
//
//   node scripts/aippd.mjs <AIPPD folder> <out.graph.json>
//
// <AIPPD folder> is the unzipped repository (with data/aippd_profiles_256.npz unzipped into data/npz/). For each
// period and form, the vessel closest to the median height of its cell that builds a closed hollow solid whose cavity
// holds its documented capacity (within CAPACITY_TOLERANCE) becomes a `freeform/vessel` node, its documentation and
// source in `meta.items`, its place in a period × form grid in `view.shelf`. Run after `npm run build`.
import { readFileSync, writeFileSync } from "node:fs";
import { dress } from "./ceramic-looks.mjs";
import { execFileSync } from "node:child_process";
import { profile, densify } from "./aippd-profile.mjs";

const [dir, out] = process.argv.slice( 2 );
if (dir == null || out == null) { console.error( "usage: node scripts/aippd.mjs <AIPPD folder> <out.graph.json>" ); process.exit( 1 ); }
const { Graph } = await import( "../dist/index.js" );

// how far the cavity's volume may differ from the capacity the dataset gives (stacked cylinders on the drawing)
const CAPACITY_TOLERANCE = 0.12;
// candidates tried per cell before the cell is left empty
const TRIES = 8;

const PERIODS = [
    ["EBA", "Early Bronze Age", "2300–1700 BC"], ["MBA", "Middle Bronze Age", "1700–1350 BC"],
    ["RBA", "Recent Bronze Age", "1350–1150 BC"], ["FBA", "Final Bronze Age", "1150–950 BC"],
    ["EIA1", "Early Iron Age 1", "950–800 BC"], ["EIA2", "Early Iron Age 2", "800–725 BC"],
    ["OP", "Orientalising period", "725–580 BC"], ["AP", "Archaic period", "580–480 BC"],
];
const FORMS = [
    ["Tazza/Ciotola", "cup", "Cup, bowl"], ["Scodella", "bowl", "Deep bowl"], ["Coppa", "footed_cup", "Footed cup"],
    ["Boccale", "mug", "Mug"], ["Brocca/Orciolo", "jug", "Jug"], ["Olla", "jar", "Jar"],
    ["Vaso a collo/Biconico", "necked_jar", "Necked jar, biconical urn"], ["Anfora", "amphora", "Amphora"],
    ["Cratere", "krater", "Krater"], ["Kothon", "kothon", "Kothon"], ["Sostegno", "stand", "Stand"],
    ["Coperchio/Teglia", "lid", "Lid, pan"],
];

const npy = ( file ) => { const b = readFileSync( file ); const h = b.readUInt16LE( 8 ); return b.subarray( 10 + h ); };
function csv( text ) {
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c == '"') { if (text[i + 1] == '"') { f += '"'; i++; } else q = false; } else f += c; }
        else if (c == '"') q = true;
        else if (c == ",") { row.push( f ); f = ""; }
        else if (c == "\n") { row.push( f ); rows.push( row ); row = []; f = ""; }
        else if (c != "\r") f += c;
    }
    if (f != "" || row.length > 0) { row.push( f ); rows.push( row ); }
    const head = rows[0];
    return rows.slice( 1 ).filter( r => r.length == head.length ).map( r => Object.fromEntries( head.map( (h, k) => [h, r[k]] ) ) );
}

const masks = npy( `${dir}/data/npz/masks.npy` );
const meta = csv( readFileSync( `${dir}/data/aippd_metadata.csv`, "utf8" ) );
const bib = Object.fromEntries( csv( readFileSync( `${dir}/data/aippd_bibliography.csv`, "utf8" ) ).map( b => [b.bibliography_id, b] ) );
const mask = ( i ) => ( y, x ) => (masks[i * 8192 + y * 32 + (x >> 3)] >> (7 - (x & 7))) & 1;
const commit = (() => { try { return execFileSync( "git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding : "utf8" } ).trim(); } catch { return null; } })();

const r1 = ( x ) => Math.round( x * 10 ) / 10;
const text = ( pts ) => densify( pts ).map( ([r, z]) => `${r1( r )} ${r1( z )}` ).join( "; " );
const nodes = {}, outputs = {}, items = {}, place = {};

let built = 0;
for (const [period] of PERIODS) for (const [form, slug] of FORMS) {
    const cell = meta.map( ( m, i ) => ({ m, i }) ).filter( c => c.m.period == period && c.m.form == form && +c.m.height_cm > 0 && +c.m.capacity_l > 0 );
    if (cell.length == 0) continue;
    const hs = cell.map( c => +c.m.height_cm ).sort( (a, b) => a - b ), median = hs[Math.floor( hs.length / 2 )];
    cell.sort( (a, b) => Math.abs( +a.m.height_cm - median ) - Math.abs( +b.m.height_cm - median ) || (a.m.id < b.m.id ? -1 : 1) );
    const id = `${period}_${slug}`;
    let chosen = null;
    for (const c of cell.slice( 0, TRIES )) {
        const p = profile( mask( c.i ), +c.m.height_cm );
        if (p.cavity == null) continue;
        const node = { type : "freeform/vessel", label : `${c.m.id}`, in : { outer : text( p.outer ), cavity : text( p.cavity ), foot : p.foot ? text( p.foot ) : "" } };
        const doc = { version : 2, nodes : { [id] : node }, outputs : { [id] : "@" + id } };
        try {
            const graph = new Graph(), r = graph.evaluate( doc );
            const m = r.result.report.manifold;
            if (!m.closedManifold || m.genus != 0 || r.verdict.kind != "buildable") continue;
            const cavity = graph.evaluate( { version : 1, features : { c : Graph.compile( doc ).features[id + "/cavity"] }, output : "c" } ).result.report.volume / 1e6;
            if (Math.abs( cavity - +c.m.capacity_l ) > CAPACITY_TOLERANCE * +c.m.capacity_l) continue;
            chosen = { c, node, cavity };
            break;
        } catch { continue; }
    }
    if (chosen == null) { console.log( `${id}: no candidate built` ); continue; }
    const { c, node, cavity } = chosen, m = c.m, b = bib[m.bibliography_id];
    nodes[id] = node;
    outputs[id] = "@" + id;
    place[id] = [period, slug];
    items[id] = {
        aippd_id : m.id, form : m.form, period : m.period, subperiod : m.subperiod || null, site : m.context, region : m.region || null,
        facies : m.facies || null, context_type : m.context_type, funerary_function : m.funerary_function || null, grave : m.grave || null,
        technique : m.manufacturing_technique, ware : m.material, height_cm : +m.height_cm, max_width_cm : +m.max_width_cm,
        rim_diameter_cm : +m.rim_diameter_cm, capacity_l : +m.capacity_l, cavity_l : Math.round( cavity * 1000 ) / 1000,
        source : [b?.short ?? `bibliography ${m.bibliography_id}`, m.page && `p. ${m.page}`, m.figure_or_plate && `fig./pl. ${m.figure_or_plate}`, m.item_number && `no. ${m.item_number}`].filter( Boolean ).join( ", " ),
        reference : b?.reference ?? null,
    };
    built++;
    console.log( `${id}: ${m.id} ${m.height_cm} cm, cavity ${cavity.toFixed( 3 )} l / ${m.capacity_l} l` );
}

const doc = {
    version : 2,
    meta : {
        name : "Pottery of ancient Italy, one vessel of each form per period",
        description : "Vessels of continental Italy from the Early Bronze Age to the Archaic period (2300–480 BC), each turned from its drawn section at its real size. Handles and decoration are not in the data: the profiles were drawn without them.",
        source : "AIPPD, Ancient Italy Pottery Profiles Dataset v0.1 (Cardarelli 2024, Appendix A), doi:10.5281/zenodo.24249544, Apache License 2.0" + (commit ? ` (commit ${commit})` : ""),
        book : "Cardarelli, L. 2024. Morphological variability and standardisation of vessel shapes in the 2nd and first half of the 1st millennium BC in continental Italy. Adrias 18. Bari: Edipuglia. doi:10.4475/0840",
        items,
    },
    nodes,
    outputs,
    view : {
        // the canvas in the same grid: a column per form, a row per period
        nodes : Object.fromEntries( Object.entries( place ).map( ([id, [p, f]]) =>
            [id, { x : FORMS.findIndex( x => x[1] == f ) * 300, y : PERIODS.findIndex( x => x[0] == p ) * 200 }] ) ),
        shelf : {
            rows : PERIODS.filter( ([k]) => Object.values( place ).some( p => p[0] == k ) ).map( ([key, label, dates]) => ({ key, label, note : dates }) ),
            columns : FORMS.filter( ([, s]) => Object.values( place ).some( p => p[1] == s ) ).map( ([, key, label]) => ({ key, label }) ),
            place,
        },
    },
};
writeFileSync( out, JSON.stringify( dress( doc ), null, 1 ) + "\n" );
console.log( `wrote ${out}: ${built} vessels` );
