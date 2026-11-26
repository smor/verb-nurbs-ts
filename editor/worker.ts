// Evaluates graph documents off the UI thread. One Graph lives here, so its cache survives between edits.
// A request names one output (`output`), or asks for every output (`shelf`): then each is sent as soon as it is built,
// and the work stops early when a newer request arrives.
import { Graph } from "../src/index.js";
import type { GraphDocument, GraphResult } from "../src/index.js";

const graph = new Graph();
let latest = 0;

const meshOf = ( r : GraphResult ) => {
    const m = r.result.mesh;
    const pos = new Float32Array( m.vertices.length * 3 ), idx = new Uint32Array( m.triangles.length * 3 );
    m.vertices.forEach( (v, i) => { pos[3 * i] = v[0]; pos[3 * i + 1] = v[1]; pos[3 * i + 2] = v[2]; } );
    m.triangles.forEach( (q, i) => { idx[3 * i] = q[0]; idx[3 * i + 1] = q[1]; idx[3 * i + 2] = q[2]; } );
    return { pos, idx };
};
const post = ( msg : object, transfer : Array<ArrayBuffer> = [] ) => (self as unknown as Worker).postMessage( msg, transfer );

self.onmessage = async ( e : MessageEvent<{ seq : number, doc : GraphDocument, output? : string, shelf? : boolean }> ) => {
    const { seq, doc, output, shelf } = e.data;
    latest = seq;
    const t = performance.now();
    if (!shelf) {
        try {
            const r = graph.evaluate( doc, { output } );
            const { pos, idx } = meshOf( r );
            post( { seq, ok : true, pos, idx, ms : performance.now() - t, volume : r.result.report.volume,
                faces : r.faceNames.length, verdict : { kind : r.verdict.kind, reasons : r.verdict.reasons }, nodes : r.nodes, model : r.model },
                [pos.buffer, idx.buffer] );
        } catch (err) {
            post( { seq, ok : false, error : (err as Error).message, ms : performance.now() - t } );
        }
        return;
    }
    // the shelf: every output, one message each, then a summary
    const names = Object.keys( doc.outputs ?? {} );
    const nodes : Record<string, string> = {}, failed : Array<string> = [];
    let volume = 0, buildable = 0;
    for (const name of names) {
        // let a newer request in; if one came, this shelf is stale
        await new Promise( res => setTimeout( res, 0 ) );
        if (latest != seq) return;
        try {
            const r = graph.evaluate( doc, { output : name } );
            const { pos, idx } = meshOf( r );
            for (const [k, v] of Object.entries( r.nodes )) if (v != "unused" && nodes[k] != "built") nodes[k] = v;
            volume += r.result.report.volume;
            if (r.verdict.kind == "buildable") buildable++;
            post( { seq, part : name, pos, idx, verdict : r.verdict.kind }, [pos.buffer, idx.buffer] );
        } catch (err) {
            failed.push( `${name}: ${(err as Error).message}` );
        }
    }
    post( { seq, ok : failed.length == 0, shelf : true, ms : performance.now() - t, volume, faces : 0, nodes,
        verdict : { kind : buildable == names.length ? "buildable" : "visual", reasons : [`${buildable} of ${names.length} outputs buildable`, ...failed] },
        error : failed.length > 0 ? failed.join( "; " ) : undefined } );
};
