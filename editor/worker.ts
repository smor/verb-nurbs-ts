// Evaluates graph documents off the UI thread. One Graph lives here, so its cache survives between edits.
// A request names one output (`output`), or asks for every output (`shelf`): then each is sent as soon as it is built.
// Every solid is sent twice: first its analysis mesh (the Booleans' own, at once), then its view mesh (tessellated from
// the exact shell within 0.1 mm, with far fewer triangles), unless a newer request has arrived in between. Both carry a
// face name per triangle. The work stops early when a newer request arrives.
import { Graph } from "../src/index.js";
import type { GraphDocument, GraphResult } from "../src/index.js";
import { analysis, view as viewOf, printStl } from "./meshes.js";

const graph = new Graph();
// the looks of a result, each with the names of the faces it covers (a mesh's faces are named, in any order)
const looksOf = ( r : GraphResult ) => r.looks?.map( l => ({ ...l, faces : l.faces.map( i => r.faceNames[i] ) }) );
let latest = 0;

const post = ( msg : object, transfer : Array<ArrayBuffer> = [] ) => (self as unknown as Worker).postMessage( msg, transfer );
// let a newer request in; true when one came, and this work is stale
const superseded = async ( seq : number ) => { await new Promise( res => setTimeout( res, 0 ) ); return latest != seq; };

self.onmessage = async ( e : MessageEvent<{ seq : number, doc : GraphDocument, output? : string, shelf? : boolean, stl? : string }> ) => {
    const { seq, doc, output, shelf, stl } = e.data;
    // a print file: the output's STL, apart from the evaluations (it neither starts nor stops one)
    if (stl != null) {
        try {
            const r = graph.evaluate( doc, { output } ), f = printStl( graph, r, stl );
            post( { stl, ok : true, data : f.data, triangles : f.triangles, deviation : f.deviation, verdict : r.verdict.kind }, [f.data] );
        } catch (err) { post( { stl, ok : false, error : (err as Error).message } ); }
        return;
    }
    latest = seq;
    const t = performance.now();
    if (!shelf) {
        let r : GraphResult;
        try { r = graph.evaluate( doc, { output } ); }
        catch (err) { post( { seq, ok : false, error : (err as Error).message, ms : performance.now() - t } ); return; }
        const a = analysis( r );
        post( { seq, ok : true, pos : a.pos, idx : a.idx, face : a.face, names : a.names, normal : a.normal, ms : performance.now() - t, volume : r.result.report.volume,
            faces : r.faceNames.length, verdict : { kind : r.verdict.kind, reasons : r.verdict.reasons }, nodes : r.nodes, model : r.model, params : r.parameters, looks : looksOf( r ) }, a.transfer );
        if (await superseded( seq )) return;
        const v = viewOf( graph, r );
        if (v != null) post( { seq, refine : true, pos : v.pos, idx : v.idx, face : v.face, names : v.names, normal : v.normal, deviation : v.deviation }, v.transfer );
        return;
    }
    // the shelf: every output, one message each, then a summary, then the view meshes
    const names = Object.keys( doc.outputs ?? {} );
    const nodes : Record<string, string> = {}, failed : Array<string> = [], off : Array<string> = [], built : Array<[string, GraphResult]> = [];
    let params : Record<string, number> = {};
    let volume = 0, buildable = 0;
    for (const name of names) {
        if (await superseded( seq )) return;
        try {
            const r = graph.evaluate( doc, { output : name } );
            const a = analysis( r );
            for (const [k, v] of Object.entries( r.nodes )) if (v != "unused" && nodes[k] != "built") nodes[k] = v;
            volume += r.result.report.volume;
            params = { ...params, ...r.parameters };
            if (r.verdict.kind == "buildable") buildable++;
            built.push( [name, r] );
            post( { seq, part : name, pos : a.pos, idx : a.idx, face : a.face, names : a.names, normal : a.normal, verdict : r.verdict.kind, looks : looksOf( r ) }, a.transfer );
        } catch (err) {
            // an output switched off is left off the shelf, not a failure
            if (/is switched off/.test( (err as Error).message )) off.push( name ); else failed.push( `${name}: ${(err as Error).message}` );
        }
    }
    post( { seq, ok : failed.length == 0, shelf : true, off, ms : performance.now() - t, volume, faces : 0, nodes, params,
        verdict : { kind : buildable == names.length - off.length ? "buildable" : "visual",
            reasons : [`${buildable} of ${names.length - off.length} outputs buildable`, ...(off.length ? [`switched off: ${off.join( ", " )}`] : []), ...failed] },
        error : failed.length > 0 ? failed.join( "; " ) : undefined } );
    for (const [name, r] of built) {
        if (await superseded( seq )) return;
        const v = viewOf( graph, r );
        if (v != null) post( { seq, part : name, refine : true, pos : v.pos, idx : v.idx, face : v.face, names : v.names, normal : v.normal, verdict : r.verdict.kind, looks : looksOf( r ) }, v.transfer );
    }
};
