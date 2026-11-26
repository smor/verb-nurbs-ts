import { Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { TriMesh } from "../solid/TriMesh.js";

// Wall thickness of a shelled solid, measured on its mesh: how close the inside faces come to the outside faces.
export class Wall {

    // The smallest distance from a vertex of the `from` triangles to the `to` triangles, looking no further than
    // `reach` (returns `reach` when nothing is that close). The triangles are binned in a uniform grid of cells of
    // size `reach`, so each vertex looks at the 27 cells around it: linear in the size of the mesh.
    public static thinnest( mesh : TriMesh, from : Array<number>, to : Array<number>, reach : number ) : { distance : number, at : Point | null } {
        const V = mesh.vertices, T = mesh.triangles;
        const cell = (x : number) => Math.floor( x / reach );
        const key = (i : number, j : number, k : number) => i + "," + j + "," + k;
        const grid = new Map<string, Array<number>>();
        for (const t of to) {
            const a = V[T[t][0]], b = V[T[t][1]], c = V[T[t][2]];
            const lo = [0, 1, 2].map( d => cell( Math.min( a[d], b[d], c[d] ) ) );
            const hi = [0, 1, 2].map( d => cell( Math.max( a[d], b[d], c[d] ) ) );
            for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
                const id = key( i, j, k );
                let bin = grid.get( id );
                if (bin == null) grid.set( id, bin = [] );
                bin.push( t );
            }
        }
        const seen = new Set<number>();
        let best = reach, at : Point | null = null;
        for (const t of from) for (const vi of T[t]) {
            if (seen.has( vi )) continue;
            seen.add( vi );
            const p = V[vi], c = p.map( cell );
            for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
                const bin = grid.get( key( c[0] + i, c[1] + j, c[2] + k ) );
                if (bin == null) continue;
                for (const u of bin) {
                    const d = Vec.dist( p, Wall.closest( p, V[T[u][0]], V[T[u][1]], V[T[u][2]] ) );
                    if (d < best) { best = d; at = p; }
                }
            }
        }
        return { distance : best, at : at };
    }

    // The point of triangle abc closest to p (C. Ericson, Real-Time Collision Detection, 2005, 5.1.5).
    public static closest( p : Point, a : Point, b : Point, c : Point ) : Point {
        const ab = Vec.sub( b, a ), ac = Vec.sub( c, a ), ap = Vec.sub( p, a );
        const d1 = Vec.dot( ab, ap ), d2 = Vec.dot( ac, ap );
        if (d1 <= 0 && d2 <= 0) return a;
        const bp = Vec.sub( p, b ), d3 = Vec.dot( ab, bp ), d4 = Vec.dot( ac, bp );
        if (d3 >= 0 && d4 <= d3) return b;
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) return Vec.add( a, Vec.mul( d1 / (d1 - d3), ab ) );
        const cp = Vec.sub( p, c ), d5 = Vec.dot( ab, cp ), d6 = Vec.dot( ac, cp );
        if (d6 >= 0 && d5 <= d6) return c;
        const vb = d5 * d2 - d1 * d6;
        if (vb <= 0 && d2 >= 0 && d6 <= 0) return Vec.add( a, Vec.mul( d2 / (d2 - d6), ac ) );
        const va = d3 * d6 - d5 * d4;
        if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return Vec.add( b, Vec.mul( (d4 - d3) / ((d4 - d3) + (d5 - d6)), Vec.sub( c, b ) ) );
        const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
        return Vec.add( a, Vec.add( Vec.mul( v, ab ), Vec.mul( w, ac ) ) );
    }
}
