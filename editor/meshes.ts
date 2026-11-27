// Meshes for the 3D view, as transferable arrays, with a face name per triangle and the exact surface normal at each
// triangle corner. Pure (no DOM, no worker globals), so the tests run it in Node.
import { Eval, ShellBuilder } from "../src/index.js";
import type { Graph, GraphResult, TriMesh } from "../src/index.js";

/** The display mesh's tolerance: the "view" preset, 0.1 mm and normals within 20 degrees between neighbours. */
export const DISPLAY = "view";
// how far a view mesh vertex may be from its projection on its face (mm): its chordal tolerance is 0.1 at most between
// vertices, and vertices lie on the faces
export const ON_FACE = 0.05;

// A mesh as transferable arrays: positions, triangles, for each triangle the index of its face name in `names`, and
// for each triangle corner the exact normal of its face's surface there (0, 0, 0 where none could be had: the viewer
// then averages the triangles'). `at(t, k)` gives the normal at corner k of triangle t, or null.
export type Normal = ( t : number, k : number ) => Array<number> | null;
export const pack = ( m : TriMesh, faceNames : Array<string>, at : Normal ) => {
    const pos = new Float32Array( m.vertices.length * 3 ), idx = new Uint32Array( m.triangles.length * 3 ), face = new Uint32Array( m.triangles.length );
    const normal = new Float32Array( m.triangles.length * 9 );
    m.vertices.forEach( (v, i) => { pos[3 * i] = v[0]; pos[3 * i + 1] = v[1]; pos[3 * i + 2] = v[2]; } );
    m.triangles.forEach( (q, i) => {
        idx[3 * i] = q[0]; idx[3 * i + 1] = q[1]; idx[3 * i + 2] = q[2];
        // the triangle's own normal, to point each surface normal outward (a face may run against its surface)
        const a = m.vertices[q[0]], b = m.vertices[q[1]], c = m.vertices[q[2]];
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const tn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        for (let k = 0; k < 3; k++) {
            const n = at( i, k );
            if (n == null) continue;
            const len = Math.hypot( n[0], n[1], n[2] );
            if (!(len > 1e-12)) continue;
            const sign = n[0] * tn[0] + n[1] * tn[1] + n[2] * tn[2] < 0 ? -1 / len : 1 / len;
            normal[9 * i + 3 * k] = n[0] * sign; normal[9 * i + 3 * k + 1] = n[1] * sign; normal[9 * i + 3 * k + 2] = n[2] * sign;
        }
    } );
    const names : Array<string> = [], ix = new Map<string, number>();
    faceNames.forEach( ( n, i ) => {
        let k = ix.get( n );
        if (k == null) { k = names.length; names.push( n ); ix.set( n, k ); }
        face[i] = k;
    } );
    return { pos, idx, face, names, normal, transfer : [pos.buffer, idx.buffer, face.buffer, normal.buffer] as Array<ArrayBuffer> };
};
// A surface's normal, or null where it has none: at a point the surface collapses to (the centre of a turned cap),
// whose normal is then taken at the triangle's middle instead.
const DEGENERATE = 1e-12;
const normalAt = ( s : Parameters<typeof Eval.rationalSurfaceNormal>[0], uv : ArrayLike<number> ) : Array<number> | null => {
    const n = Eval.rationalSurfaceNormal( s, uv[0], uv[1] );
    return Math.hypot( n[0], n[1], n[2] ) > DEGENERATE ? n : null;
};
// the analysis mesh: the Booleans keep each corner's parameters on its face's surface
export const analysis = ( r : GraphResult ) => {
    const R = r.result;
    return pack( R.mesh, R.faceOf.map( f => r.faceNames[f] ), ( t, k ) => {
        const uv = R.cornerUV[t], s = R.faces[R.faceOf[t]].surface;
        if (uv == null) return null;
        return normalAt( s, uv[k] ) ?? normalAt( s, [(uv[0][0] + uv[1][0] + uv[2][0]) / 3, (uv[0][1] + uv[1][1] + uv[2][1]) / 3] );
    } );
};
// the view mesh, or null when the exact shell cannot be meshed (the analysis mesh then stays). Its vertices lie on the
// exact faces: each is projected on its face's surface, from the last one's parameters, for the normal there
export const view = ( graph : Graph, r : GraphResult ) => {
    let e;
    try { e = graph.exportMesh( r, DISPLAY ); } catch { return null; }
    const proj = new Map<number, ReturnType<typeof ShellBuilder.projector>>(), last = new Map<number, [number, number]>(), done = new Map<string, Array<number>>();
    const m = e.mesh;
    return { ...pack( m, e.faceNames, ( t, k ) => {
        // by the face itself, not its name: two faces can share one (the halves of a circle's side, #122)
        const f = e!.faceOf?.[t];
        if (f == null || r.result.faces[f] == null) return null;
        const v = m.triangles[t][k], key = f + "/" + v;
        const known = done.get( key );
        if (known != null) return known;
        const s = r.result.faces[f].surface;
        let P = proj.get( f );
        if (P == null) { P = ShellBuilder.projector( s ); proj.set( f, P ); }
        // from the last vertex's parameters, which is fast; from the surface's own seeds when that lands elsewhere
        // (the vertex lies on the face, to the mesh's tolerance)
        const p = m.vertices[v];
        let hit = P( p, last.get( f ) );
        if (Math.hypot( hit.p[0] - p[0], hit.p[1] - p[1], hit.p[2] - p[2] ) > ON_FACE) hit = P( p );
        last.set( f, hit.uv as [number, number] );
        const n = normalAt( s, hit.uv );
        if (n == null) {
            // a pole: the normal at the triangle's centroid, projected on the face (not kept for the vertex's other
            // triangles, which have centroids of their own)
            const q = m.triangles[t], c = [0, 1, 2].map( j => (m.vertices[q[0]][j] + m.vertices[q[1]][j] + m.vertices[q[2]][j]) / 3 );
            return normalAt( s, P( c ).uv );
        }
        done.set( key, n );
        return n;
    } ), deviation : e.deviation };
};

/**
 * A mesh as a binary STL file (little-endian: an 80-byte header, the triangle count, then per triangle its unit normal
 * from its corners, its three corners as 32-bit floats and a zero attribute word), in millimetres as slicers assume.
 */
export const stl = ( m : TriMesh, header = "verb-nurbs-ts" ) : ArrayBuffer => {
    const n = m.triangles.length, buf = new ArrayBuffer( 84 + 50 * n ), v = new DataView( buf );
    const h = new TextEncoder().encode( header.slice( 0, 80 ) );
    new Uint8Array( buf, 0, h.length ).set( h );
    v.setUint32( 80, n, true );
    m.triangles.forEach( ( q, i ) => {
        const a = m.vertices[q[0]], b = m.vertices[q[1]], c = m.vertices[q[2]];
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot( nn[0], nn[1], nn[2] ) || 1;
        let o = 84 + 50 * i;
        for (const x of [nn[0] / l, nn[1] / l, nn[2] / l, ...a, ...b, ...c]) { v.setFloat32( o, x, true ); o += 4; }
        v.setUint16( o, 0, true );
    } );
    return buf;
};

/** The print mesh of a result as STL: the export mesh within 0.02 mm of the exact faces, the analysis mesh failing that. */
export const printStl = ( graph : Graph, r : GraphResult, name : string ) : { data : ArrayBuffer, triangles : number, deviation : number | null } => {
    let m : TriMesh = r.result.mesh, deviation : number | null = null;
    try { const e = graph.exportMesh( r, "print" ); m = e.mesh; deviation = e.deviation; } catch { /* the analysis mesh, closed too */ }
    return { data : stl( m, `${name}, from verb-nurbs-ts` ), triangles : m.triangles.length, deviation };
};
