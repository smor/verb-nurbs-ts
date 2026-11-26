import { Point } from "../../core/Data.js";
import { Vec } from "../../core/Vec.js";

// A polyhedron as plain data: its vertices, and its faces as cycles of vertex indices (counter-clockwise seen from
// outside, though `Primitives.polyhedron` orients the faces itself).
export interface PolyhedronData {
    vertices : Array<Point>;
    faces : Array<Array<number>>;
}

const PHI = (1 + Math.sqrt( 5 )) / 2;
const RT2 = Math.SQRT2;

// The Platonic, Archimedean and Catalan solids and the prism families, as exact vertex coordinates, and the Conway
// operators that derive polyhedra from others (dual, truncate, ambo, kis).
//
// Vertex coordinates are the standard ones (H. S. M. Coxeter, "Regular Polytopes", 3rd ed., Dover, 1973, and the
// Archimedean coordinates collected in P. R. Cromwell, "Polyhedra", Cambridge University Press, 1997); faces come
// from their convex hull. Every solid is scaled to a circumradius of 1.
export class Polyhedra {

    // ---- Platonic ----

    public static tetrahedron() : PolyhedronData {
        return Polyhedra.hull( [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]] );
    }

    public static cube() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.signs( [1, 1, 1] ) );
    }

    public static octahedron() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.perms( [1, 0, 0], true ) );
    }

    public static dodecahedron() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.signs( [1, 1, 1] ).concat( Polyhedra.cyclic( [0, 1 / PHI, PHI] ) ) );
    }

    public static icosahedron() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.cyclic( [0, 1, PHI] ) );
    }

    // ---- Archimedean ----

    public static truncatedTetrahedron() : PolyhedronData {
        // permutations of (3, 1, 1) with an even number of minus signs
        return Polyhedra.hull( Polyhedra.perms( [3, 1, 1], true ).filter( p => p.filter( x => x < 0 ).length % 2 == 0 ) );
    }

    public static cuboctahedron() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.perms( [1, 1, 0], true ) );
    }

    public static truncatedCube() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.perms( [RT2 - 1, 1, 1], true ) );
    }

    public static truncatedOctahedron() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.perms( [0, 1, 2], true ) );
    }

    public static rhombicuboctahedron() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.perms( [1, 1, 1 + RT2], true ) );
    }

    public static truncatedCuboctahedron() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.perms( [1, 1 + RT2, 1 + 2 * RT2], true ) );
    }

    public static snubCube() : PolyhedronData {
        // t: the tribonacci constant, the real root of t^3 = t^2 + t + 1. Even permutations of (±1, ±1/t, ±t) with an
        // even number of plus signs, and odd permutations with an odd number.
        const t = Polyhedra.root( x => x * x * x - x * x - x - 1, 1, 2 );
        const out : Array<Point> = [];
        for (const p of Polyhedra.signs( [1, 1 / t, t] )) {
            const plus = p.filter( x => x > 0 ).length;
            for (const q of Polyhedra.perms3( p, plus % 2 == 0 )) out.push( q );
        }
        return Polyhedra.hull( out );
    }

    public static icosidodecahedron() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.cyclic( [0, 0, PHI] ).concat( Polyhedra.cyclic( [0.5, PHI / 2, PHI * PHI / 2] ) ) );
    }

    public static truncatedDodecahedron() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.cyclic( [0, 1 / PHI, 2 + PHI] ).concat( Polyhedra.cyclic( [1 / PHI, PHI, 2 * PHI] ), Polyhedra.cyclic( [PHI, 2, PHI + 1] ) ) );
    }

    public static truncatedIcosahedron() : PolyhedronData {
        return Polyhedra.hull( Polyhedra.cyclic( [0, 1, 3 * PHI] ).concat( Polyhedra.cyclic( [1, 2 + PHI, 2 * PHI] ), Polyhedra.cyclic( [PHI, 2, 2 * PHI + 1] ) ) );
    }

    public static rhombicosidodecahedron() : PolyhedronData {
        const p3 = PHI * PHI * PHI, p2 = PHI * PHI;
        return Polyhedra.hull( Polyhedra.cyclic( [1, 1, p3] ).concat( Polyhedra.cyclic( [p2, PHI, 2 * PHI] ), Polyhedra.cyclic( [2 + PHI, 0, p2] ) ) );
    }

    public static truncatedIcosidodecahedron() : PolyhedronData {
        const f = 1 / PHI;
        return Polyhedra.hull( Polyhedra.cyclic( [f, f, 3 + PHI] ).concat(
            Polyhedra.cyclic( [2 * f, PHI, 1 + 2 * PHI] ), Polyhedra.cyclic( [f, PHI * PHI, 3 * PHI - 1] ),
            Polyhedra.cyclic( [2 * PHI - 1, 2, 2 + PHI] ), Polyhedra.cyclic( [PHI, 3, 2 * PHI] ) ) );
    }

    // The Archimedean solids by name (camelCase, as the methods above).
    public static ARCHIMEDEAN : Array<string> = ["truncatedTetrahedron", "cuboctahedron", "truncatedCube", "truncatedOctahedron",
        "rhombicuboctahedron", "truncatedCuboctahedron", "snubCube", "icosidodecahedron", "truncatedDodecahedron",
        "truncatedIcosahedron", "rhombicosidodecahedron", "truncatedIcosidodecahedron"];

    public static PLATONIC : Array<string> = ["tetrahedron", "cube", "octahedron", "dodecahedron", "icosahedron"];

    // A named Platonic or Archimedean solid, or the Catalan dual of one ("dual:cuboctahedron" is the rhombic
    // dodecahedron).
    public static named( name : string ) : PolyhedronData {
        if (name.startsWith( "dual:" )) return Polyhedra.dual( Polyhedra.named( name.slice( 5 ) ) );
        const table : { [k : string] : () => PolyhedronData } = {
            tetrahedron : Polyhedra.tetrahedron, cube : Polyhedra.cube, octahedron : Polyhedra.octahedron,
            dodecahedron : Polyhedra.dodecahedron, icosahedron : Polyhedra.icosahedron,
            truncatedTetrahedron : Polyhedra.truncatedTetrahedron, cuboctahedron : Polyhedra.cuboctahedron,
            truncatedCube : Polyhedra.truncatedCube, truncatedOctahedron : Polyhedra.truncatedOctahedron,
            rhombicuboctahedron : Polyhedra.rhombicuboctahedron, truncatedCuboctahedron : Polyhedra.truncatedCuboctahedron,
            snubCube : Polyhedra.snubCube, icosidodecahedron : Polyhedra.icosidodecahedron,
            truncatedDodecahedron : Polyhedra.truncatedDodecahedron, truncatedIcosahedron : Polyhedra.truncatedIcosahedron,
            rhombicosidodecahedron : Polyhedra.rhombicosidodecahedron, truncatedIcosidodecahedron : Polyhedra.truncatedIcosidodecahedron,
        };
        const f = table[name];
        if (f == null) throw new Error( `Polyhedra: no solid named "${name}"` );
        return f();
    }

    // ---- prism families ----

    // A prism over a regular n-gon: the n-gon of circumradius `radius` at z = 0 and z = height.
    public static prism( n : number, radius : number, height : number ) : PolyhedronData {
        const v : Array<Point> = [];
        for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; v.push( [radius * Math.cos( a ), radius * Math.sin( a ), 0] ); }
        for (let i = 0; i < n; i++) v.push( [v[i][0], v[i][1], height] );
        const faces = [Array.from( { length : n }, (_, i) => n - 1 - i ), Array.from( { length : n }, (_, i) => n + i )];
        for (let i = 0; i < n; i++) faces.push( [i, (i + 1) % n, n + (i + 1) % n, n + i] );
        return { vertices : v, faces : faces };
    }

    // An antiprism: two regular n-gons of circumradius `radius`, the top one turned by half a step, joined by
    // 2n triangles. Its height defaults to the one that makes the triangles equilateral.
    public static antiprism( n : number, radius : number, height? : number ) : PolyhedronData {
        if (height == null) {
            // equilateral: edge 2r sin(pi/n); the horizontal distance between neighbouring top and bottom vertices
            const e = 2 * radius * Math.sin( Math.PI / n ), d2 = 2 * radius * radius * (1 - Math.cos( Math.PI / n ));
            height = Math.sqrt( Math.max( 0, e * e - d2 ) );
        }
        const v : Array<Point> = [];
        for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; v.push( [radius * Math.cos( a ), radius * Math.sin( a ), 0] ); }
        for (let i = 0; i < n; i++) { const a = 2 * Math.PI * (i + 0.5) / n; v.push( [radius * Math.cos( a ), radius * Math.sin( a ), height] ); }
        const faces = [Array.from( { length : n }, (_, i) => n - 1 - i ), Array.from( { length : n }, (_, i) => n + i )];
        for (let i = 0; i < n; i++) { faces.push( [i, (i + 1) % n, n + i] ); faces.push( [(i + 1) % n, n + (i + 1) % n, n + i] ); }
        return { vertices : v, faces : faces };
    }

    // A bipyramid: a regular n-gon of circumradius `radius` at z = 0 with an apex `up` above and `down` below.
    public static bipyramid( n : number, radius : number, up : number, down : number ) : PolyhedronData {
        const v : Array<Point> = [];
        for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; v.push( [radius * Math.cos( a ), radius * Math.sin( a ), 0] ); }
        v.push( [0, 0, up], [0, 0, -down] );
        const faces : Array<Array<number>> = [];
        for (let i = 0; i < n; i++) { faces.push( [i, (i + 1) % n, n] ); faces.push( [(i + 1) % n, i, n + 1] ); }
        return { vertices : v, faces : faces };
    }

    // A trapezohedron (a d10 for n = 5): the dual of an antiprism, 2n kites.
    public static trapezohedron( n : number ) : PolyhedronData {
        const a = Polyhedra.antiprism( n, 1 );
        const c = Polyhedra.center( a.vertices );
        return Polyhedra.dual( { vertices : a.vertices.map( p => Vec.sub( p, c ) ), faces : a.faces } );
    }

    // ---- operators ----

    // The convex hull of points: one face per supporting plane, with every point on that plane as a vertex (so
    // coplanar points make one polygon, not a fan of triangles). Scaled to a circumradius of 1 about the centroid.
    // Brute force over triples, which is plenty for the at most 120 vertices of these solids.
    public static hull( points : Array<Point> ) : PolyhedronData {
        const c = Polyhedra.center( points );
        let pts = points.map( p => Vec.sub( p, c ) );
        const R = Math.max( ...pts.map( p => Vec.norm( p ) ) );
        pts = pts.map( p => Vec.mul( 1 / R, p ) );
        const n = pts.length, eps = 1e-9;
        const planes : Array<{ n : Point, d : number }> = [];
        const on = (pl : { n : Point, d : number }, p : Point) => Math.abs( Vec.dot( pl.n, p ) - pl.d ) < eps;
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
            if (planes.some( pl => on( pl, pts[i] ) && on( pl, pts[j] ) && on( pl, pts[k] ) )) continue;
            let nn = Vec.cross( Vec.sub( pts[j], pts[i] ), Vec.sub( pts[k], pts[i] ) );
            const len = Vec.norm( nn );
            if (len < 1e-9) continue;
            nn = Vec.mul( 1 / len, nn );
            let d = Vec.dot( nn, pts[i] );
            let above = 0, below = 0;
            for (const p of pts) { const s = Vec.dot( nn, p ) - d; if (s > eps) above++; else if (s < -eps) below++; }
            if (above > 0 && below > 0) continue;
            if (above > 0) { nn = Vec.mul( -1, nn ); d = -d; }
            planes.push( { n : nn, d : d } );
        }
        const faces = planes.map( pl => {
            const idx = pts.map( (_, i) => i ).filter( i => on( pl, pts[i] ) );
            const fc = Polyhedra.center( idx.map( i => pts[i] ) );
            const ax = Vec.normalized( Vec.sub( pts[idx[0]], fc ) ), ay = Vec.cross( pl.n, ax );
            return idx.sort( (a, b) => {
                const pa = Vec.sub( pts[a], fc ), pb = Vec.sub( pts[b], fc );
                return Math.atan2( Vec.dot( pa, ay ), Vec.dot( pa, ax ) ) - Math.atan2( Vec.dot( pb, ay ), Vec.dot( pb, ax ) );
            } );
        } );
        return { vertices : pts, faces : faces };
    }

    // The dual by polar reciprocation in the unit sphere: a vertex per face (the pole of the face's plane) and a
    // face per vertex. The origin must be inside. The dual of an Archimedean solid is the Catalan solid.
    public static dual( p : PolyhedronData ) : PolyhedronData {
        const poles = p.faces.map( f => {
            const pts = f.map( i => p.vertices[i] );
            const nrm = Polyhedra.faceNormal( pts );
            const d = Vec.dot( nrm, Polyhedra.center( pts ) );
            if (!(d > 1e-12)) throw new Error( "Polyhedra: the dual needs the origin inside the polyhedron" );
            return Vec.mul( 1 / d, nrm );
        } );
        return Polyhedra.hull( poles );
    }

    // Each vertex cut off at a fraction t of every edge (0 < t < 1/2): the faces keep their planes with twice the
    // sides, and every vertex becomes a face. For a convex polyhedron the result is the hull of the cut points.
    public static truncate( p : PolyhedronData, t : number ) : PolyhedronData {
        if (!(t > 0 && t < 0.5)) throw new Error( "Polyhedra: truncation takes 0 < t < 1/2 (1/2 is ambo)" );
        const pts : Array<Point> = [];
        for (const [a, b] of Polyhedra.edges( p )) {
            pts.push( Vec.lerp( 1 - t, p.vertices[a], p.vertices[b] ), Vec.lerp( t, p.vertices[a], p.vertices[b] ) );
        }
        return Polyhedra.hull( pts );
    }

    // Rectification: the hull of the midpoints of the edges (a cube's is the cuboctahedron).
    public static ambo( p : PolyhedronData ) : PolyhedronData {
        return Polyhedra.hull( Polyhedra.edges( p ).map( ([a, b]) => Vec.lerp( 0.5, p.vertices[a], p.vertices[b] ) ) );
    }

    // A pyramid on every face, its apex `h` above the face's centroid along its normal (h relative to the
    // circumradius). The result is convex only for small h; it is returned with its faces as built.
    public static kis( p : PolyhedronData, h : number ) : PolyhedronData {
        const v = p.vertices.slice(), faces : Array<Array<number>> = [];
        for (const f of p.faces) {
            const pts = f.map( i => p.vertices[i] );
            const apex = Vec.add( Polyhedra.center( pts ), Vec.mul( h, Polyhedra.faceNormal( pts ) ) );
            v.push( apex );
            for (let k = 0; k < f.length; k++) faces.push( [f[k], f[(k + 1) % f.length], v.length - 1] );
        }
        return { vertices : v, faces : faces };
    }

    // The undirected edges of a polyhedron.
    public static edges( p : PolyhedronData ) : Array<[number, number]> {
        const seen = new Set<string>(), out : Array<[number, number]> = [];
        for (const f of p.faces) for (let k = 0; k < f.length; k++) {
            const a = f[k], b = f[(k + 1) % f.length];
            const key = a < b ? a + ":" + b : b + ":" + a;
            if (!seen.has( key )) { seen.add( key ); out.push( [a, b] ); }
        }
        return out;
    }

    // ---- helpers ----

    public static center( pts : Array<Point> ) : Point {
        return Vec.mul( 1 / pts.length, pts.reduce( (s, p) => Vec.add( s, p ), [0, 0, 0] ) );
    }

    // The unit normal of a polygon by Newell's method, outward when the polygon turns counter-clockwise; flipped to
    // point away from the origin.
    public static faceNormal( pts : Array<Point> ) : Point {
        let n = [0, 0, 0];
        for (let i = 0; i < pts.length; i++) n = Vec.add( n, Vec.cross( pts[i], pts[(i + 1) % pts.length] ) );
        n = Vec.normalized( n );
        return Vec.dot( n, Polyhedra.center( pts ) ) < 0 ? Vec.mul( -1, n ) : n;
    }

    // every sign combination of the nonzero coordinates
    private static signs( p : Point ) : Array<Point> {
        let out : Array<Point> = [[]];
        for (const x of p) out = out.flatMap( q => x == 0 ? [q.concat( [0] )] : [q.concat( [x] ), q.concat( [-x] )] );
        return out;
    }

    // the three cyclic permutations of each sign combination
    private static cyclic( p : Point ) : Array<Point> {
        return Polyhedra.unique( Polyhedra.signs( p ).flatMap( q => [[q[0], q[1], q[2]], [q[1], q[2], q[0]], [q[2], q[0], q[1]]] ) );
    }

    // all permutations (of each sign combination, when `withSigns`)
    private static perms( p : Point, withSigns : boolean ) : Array<Point> {
        const base = withSigns ? Polyhedra.signs( p ) : [p];
        return Polyhedra.unique( base.flatMap( q => Polyhedra.perms3( q, true ).concat( Polyhedra.perms3( q, false ) ) ) );
    }

    // the even (or odd) permutations of three coordinates
    private static perms3( q : Point, even : boolean ) : Array<Point> {
        return even ? [[q[0], q[1], q[2]], [q[1], q[2], q[0]], [q[2], q[0], q[1]]] : [[q[1], q[0], q[2]], [q[0], q[2], q[1]], [q[2], q[1], q[0]]];
    }

    private static unique( pts : Array<Point> ) : Array<Point> {
        const seen = new Set<string>();
        return pts.filter( p => { const k = p.map( x => x.toFixed( 9 ) ).join( "," ); if (seen.has( k )) return false; seen.add( k ); return true; } );
    }

    // a root of f in [a, b] by bisection (f(a) and f(b) differ in sign)
    private static root( f : (x : number) => number, a : number, b : number ) : number {
        let fa = f( a );
        for (let i = 0; i < 200; i++) {
            const m = (a + b) / 2, fm = f( m );
            if ((fm < 0) == (fa < 0)) { a = m; fa = fm; } else b = m;
        }
        return (a + b) / 2;
    }
}
