// Evaluates graph documents off the UI thread. One Graph lives here, so its cache survives between edits.
import { Graph } from "../src/index.js";
import type { GraphDocument } from "../src/index.js";

const graph = new Graph();
self.onmessage = ( e : MessageEvent<{ seq : number, doc : GraphDocument }> ) => {
    const { seq, doc } = e.data;
    const t = performance.now();
    try {
        const r = graph.evaluate( doc );
        const m = r.result.mesh;
        const pos = new Float32Array( m.vertices.length * 3 ), idx = new Uint32Array( m.triangles.length * 3 );
        m.vertices.forEach( (v, i) => { pos[3 * i] = v[0]; pos[3 * i + 1] = v[1]; pos[3 * i + 2] = v[2]; } );
        m.triangles.forEach( (q, i) => { idx[3 * i] = q[0]; idx[3 * i + 1] = q[1]; idx[3 * i + 2] = q[2]; } );
        (self as unknown as Worker).postMessage( { seq, ok : true, pos, idx, ms : performance.now() - t, volume : r.result.report.volume,
            faces : r.faceNames.length, verdict : { kind : r.verdict.kind, reasons : r.verdict.reasons }, nodes : r.nodes, model : r.model },
            [pos.buffer, idx.buffer] );
    } catch (err) {
        (self as unknown as Worker).postMessage( { seq, ok : false, error : (err as Error).message, ms : performance.now() - t } );
    }
};
