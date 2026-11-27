import { Point, UV } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "../eval/Analyze.js";
import { Eval } from "../eval/Eval.js";
import { BrepShell, Projector, ShellBuilder } from "./BrepShell.js";
import { BrepSolid } from "./Brep.js";
import { ShellMesher } from "./ShellMesher.js";
import { TriMesh } from "./TriMesh.js";

/** A closest point on a shell: the point, the shell face it lies on, its parameters there and the face's outward normal. */
export interface ClearanceWitness {
    point : Point;
    face : number;
    name : string;
    uv : UV;
    normal : Point;
}

/**
 * The clearance between two solids.
 *
 * `distance` is the least distance between them, realised by the witnesses `a` and `b` (exact points on their faces,
 * so it is an upper bound on the true distance that Newton's method has brought to rounding), and `normal` the unit
 * direction from `a` to `b` (the contact normal, also where a witness is on an edge, whose faces' normals differ).
 * `lower` is a lower bound on it from the meshes searched: their least distance less their deviations from the faces.
 * When the solids overlap, `overlap` is true, `distance` is 0 and there are no witnesses.
 */
export interface ClearanceResult {
    distance : number;
    overlap : boolean;
    a : ClearanceWitness | null;
    b : ClearanceWitness | null;
    normal : Point | null;
    lower : number;
}

/** Options for `Clearance.between`: the chordal tolerance of the search meshes (default 0.02, the print preset). */
export interface ClearanceOptions {
    chordal? : number;
}

// A face prepared for projection: its surface's projector, its loops as polygons in its parameters (for the inside
// test) and its edges (for the nearest point on its boundary).
interface PreparedFace {
    project : Projector;
    loops : Array<Array<UV>>;
    edges : Array<{ edge : number, forward : boolean }>;
    sameSense : boolean;
}

/**
 * The exact clearance between two closed shells, in one frame (#150, ask 1).
 *
 * The search runs on meshes, the answer on the faces. Both shells are meshed by tolerance (`ShellMesher`), and the
 * nearest triangle pairs found through a bounding-box tree over each mesh. A triangle pair closer than the least
 * mesh distance plus both meshes' deviations may hold the faces' nearest points, so each face pair with such a
 * triangle pair (its few nearest, spread apart) is refined on the exact faces by alternating projections (von
 * Neumann's method: Bauschke and Borwein, "On projection algorithms for solving convex feasibility problems", SIAM
 * Review 38(3), 1996): the point on one face nearest the other's point, then back, until neither moves. A projection
 * that lands outside its face's loops is replaced by the nearest point on the face's edges, so the witnesses lie on
 * the trimmed faces and may sit on an edge or a vertex. The least distance found over the face pairs is the answer.
 * Overlap is decided on the meshes: triangles that cross, or a vertex of one mesh inside the other.
 */
export class Clearance {

    public static between( A : BrepShell, B : BrepShell, options : ClearanceOptions = {} ) : ClearanceResult {
        const T = { chordal : options.chordal ?? 0.02 };
        const ma = ShellMesher.mesh( A, T ), mb = ShellMesher.mesh( B, T );
        const ta = Clearance.tree( ma.mesh ), tb = Clearance.tree( mb.mesh );
        const slack = ma.deviation + mb.deviation;
        // the least distance between the meshes, then every triangle pair within it plus the meshes' deviations
        let best = Infinity, crossing = false;
        Clearance.pairs( ta, tb, () => best, (i, j) => {
            const d = Clearance.triTri( ta.tri( i ), tb.tri( j ) );
            if (d == 0) crossing = true;
            if (d < best) best = d;
        } );
        const overlapping = crossing || Clearance.inside( ma.mesh, mb.mesh ) || Clearance.inside( mb.mesh, ma.mesh );
        if (overlapping) return { distance : 0, overlap : true, a : null, b : null, normal : null, lower : 0 };
        const bound = best + 2 * slack;
        const size = Math.max( Vec.dist( ta.box( 0 )[0], ta.box( 0 )[1] ), Vec.dist( tb.box( 0 )[0], tb.box( 0 )[1] ) );
        const spread = 0.05 * size;
        const seeds = new Map<string, Array<{ d : number, p : Point, q : Point, fa : number, fb : number }>>();
        Clearance.pairs( ta, tb, () => bound, (i, j) => {
            const x = ta.tri( i ), y = tb.tri( j );
            const d = Clearance.triTri( x, y );
            if (d > bound) return;
            const fa = ma.faceOf[i], fb = mb.faceOf[j], key = fa + "," + fb;
            const p = Clearance.centroid( x ), q = Clearance.centroid( y );
            let list = seeds.get( key );
            if (list == null) seeds.set( key, list = [] );
            // a few seeds per face pair, apart from one another: the nearest of each neighbourhood
            const near = list.findIndex( s => Vec.dist( s.p, p ) < spread && Vec.dist( s.q, q ) < spread );
            if (near >= 0) { if (d < list[near].d) list[near] = { d, p, q, fa, fb }; return; }
            list.push( { d, p, q, fa, fb } );
            list.sort( (s, t) => s.d - t.d );
            if (list.length > 4) list.pop();
        } );
        const prepA = new Map<number, PreparedFace>(), prepB = new Map<number, PreparedFace>();
        const prep = (S : BrepShell, cache : Map<number, PreparedFace>, f : number) => {
            let P = cache.get( f );
            if (P == null) cache.set( f, P = Clearance.prepare( S, f ) );
            return P;
        };
        let out : { d : number, x : { p : Point, uv : UV, f : number }, y : { p : Point, uv : UV, f : number } } | null = null;
        for (const list of seeds.values()) for (const s of list) {
            const FA = prep( A, prepA, s.fa ), FB = prep( B, prepB, s.fb );
            let x = Clearance.nearestOn( A, FA, s.p, null, s.fa ), y = Clearance.nearestOn( B, FB, x.p, null, s.fb );
            for (let it = 0; it < 200; it++) {
                const x1 = Clearance.nearestOn( A, FA, y.p, x.uv, s.fa ), y1 = Clearance.nearestOn( B, FB, x1.p, y.uv, s.fb );
                const moved = Vec.dist( x1.p, x.p ) + Vec.dist( y1.p, y.p );
                x = x1; y = y1;
                if (moved <= 1e-13 * size) break;
            }
            const d = Vec.dist( x.p, y.p );
            if (out == null || d < out.d) out = { d, x : { ...x, f : s.fa }, y : { ...y, f : s.fb } };
        }
        if (out == null) throw new Error( "Clearance: no face pair to refine" );
        const witness = (S : BrepShell, F : PreparedFace, w : { p : Point, uv : UV, f : number }) : ClearanceWitness => {
            const s = S.faces[w.f].surface, D = Eval.rationalSurfaceDerivatives( s, w.uv[0], w.uv[1], 1 );
            const n = Vec.normalized( Vec.cross( D[1][0], D[0][1] ) );
            return { point : w.p, face : w.f, name : S.faces[w.f].name, uv : w.uv, normal : F.sameSense ? n : Vec.neg( n ) };
        };
        return {
            distance : out.d, overlap : false,
            a : witness( A, prep( A, prepA, out.x.f ), out.x ), b : witness( B, prep( B, prepB, out.y.f ), out.y ),
            normal : out.d > 0 ? Vec.mul( 1 / out.d, Vec.sub( out.y.p, out.x.p ) ) : null,
            lower : Math.max( 0, best - slack ),
        };
    }

    // The face's projector, its loops as polygons in its parameters (each edge's p-curve sampled through its knot
    // spans) and its edges.
    private static prepare( S : BrepShell, f : number ) : PreparedFace {
        const F = S.faces[f];
        const loops : Array<Array<UV>> = [], edges : Array<{ edge : number, forward : boolean }> = [];
        for (const loop of F.loops) {
            const poly : Array<UV> = [];
            for (const [ei, fwd] of loop.edges) {
                edges.push( { edge : ei, forward : fwd } );
                const pc = S.edges[ei].pcurves[fwd ? 0 : 1];
                const ks = Array.from( new Set( pc.knots ) ).sort( (x, y) => x - y );
                const ts : Array<number> = [];
                for (let i = 0; i + 1 < ks.length; i++) for (let k = 0; k < 8; k++) ts.push( ks[i] + (ks[i + 1] - ks[i]) * k / 8 );
                if (!fwd) ts.reverse();
                // (a backward edge runs from its end: start just after it so the loop's points stay in order)
                if (!fwd) { ts.unshift( ks[ks.length - 1] ); ts.pop(); }
                for (const t of ts) { const q = Eval.rationalCurvePoint( pc, t ); poly.push( [q[0], q[1]] ); }
            }
            loops.push( poly );
        }
        return { project : Clearance.projector( S, f ), loops : loops, edges : edges, sameSense : F.sameSense };
    }

    // The point of a face nearest p: its surface's nearest point when that lies inside the face's loops, else the
    // nearest point of the face's edges (with its parameters from the edge's p-curve at the same parameter).
    private static nearestOn( S : BrepShell, F : PreparedFace, p : Point, hint : UV | null, f : number ) : { p : Point, uv : UV } {
        const r = F.project( p, hint ?? undefined );
        if (F.loops.length == 0 || BrepSolid.insideTrims( F.loops, r.uv )) return { p : r.p, uv : r.uv };
        let best : { p : Point, uv : UV } | null = null, bd = Infinity;
        for (const { edge, forward } of F.edges) {
            // the edge's curve finds the parameter; the point is the face's own at the edge's p-curve there (the curve
            // is fitted within the shell's tolerance, the surface is exact)
            const e = S.edges[edge], t = Analyze.rationalCurveClosestParam( e.curve, p );
            const w = Eval.rationalCurvePoint( e.pcurves[forward ? 0 : 1], t ), uv : UV = [w[0], w[1]];
            let q = Eval.rationalSurfacePoint( S.faces[f].surface, uv[0], uv[1] ), quv = uv;
            // onto both faces' surfaces, where they meet exactly (the p-curves too are within the shell's tolerance:
            // a cylinder's rim on its cap would stand out from the tube by a few hundred-thousandths)
            const other = e.left == f ? e.right : e.left;
            if (other != f) {
                const P = Clearance.projector( S, f ), Q = Clearance.projector( S, other );
                let a = P( q, uv ), b = Q( a.p );
                for (let k = 0; k < 8; k++) { a = P( b.p, a.uv ); b = Q( a.p, b.uv ); }
                if (Vec.dist( a.p, q ) < 10 * S.tolerance) { q = a.p; quv = a.uv; }
            }
            const d = Vec.dist( q, p );
            if (d < bd) { bd = d; best = { p : q, uv : quv }; }
        }
        return best ?? { p : r.p, uv : r.uv };
    }

    /**
     * The deepest point of a closed mesh (an interference): the centre of the largest ball inside it, and that ball's
     * radius. A grid of 16 steps across its box seeds the search, which then climbs the distance to the boundary by
     * a pattern search, halving its step down to 1e-6 of the box. The distance is to the mesh, so it is within the
     * mesh's deviation from the exact faces.
     */
    public static deepest( m : TriMesh ) : { point : Point, depth : number } | null {
        const tree = new BoxTree( m );
        const [lo, hi] = tree.box( 0 );
        const depth = (p : Point) => m.containsPoint( p ) ? tree.nearest( p ) : -1;
        let best : Point | null = null, bd = 0;
        const g = 16;
        for (let i = 0; i <= g; i++) for (let j = 0; j <= g; j++) for (let k = 0; k <= g; k++) {
            const p : Point = [lo[0] + (hi[0] - lo[0]) * i / g, lo[1] + (hi[1] - lo[1]) * j / g, lo[2] + (hi[2] - lo[2]) * k / g];
            const d = depth( p );
            if (d > bd) { bd = d; best = p; }
        }
        if (best == null) {
            // thinner than the grid: the centroid of the vertices, if inside
            const c = Vec.mul( 1 / m.vertices.length, m.vertices.reduce( (a, v) => Vec.add( a, v ), [0, 0, 0] ) );
            const d = depth( c );
            if (d <= 0) return null;
            best = c; bd = d;
        }
        const size = Vec.dist( lo, hi );
        const dirs : Array<Point> = [];
        for (let a = 0; a < 3; a++) for (const sg of [-1, 1]) { const e = [0, 0, 0]; e[a] = sg; dirs.push( e ); }
        for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) dirs.push( Vec.mul( 1 / Math.sqrt( 3 ), [x, y, z] ) );
        for (let step = size / g; step > 1e-6 * size; ) {
            let moved = false;
            for (const e of dirs) {
                const q = Vec.add( best, Vec.mul( step, e ) ), d = depth( q );
                if (d > bd) { bd = d; best = q; moved = true; }
            }
            if (!moved) step *= 0.5;
        }
        return { point : best, depth : bd };
    }

    // Each face's projector, made once per shell.
    private static projectors = new WeakMap<BrepShell, Map<number, Projector>>();
    private static projector( S : BrepShell, f : number ) : Projector {
        let m = Clearance.projectors.get( S );
        if (m == null) Clearance.projectors.set( S, m = new Map() );
        let P = m.get( f );
        if (P == null) m.set( f, P = ShellBuilder.projector( S.faces[f].surface ) );
        return P;
    }

    // Whether a vertex of `a` lies inside the closed mesh `b` (one vertex decides once no triangles cross).
    private static inside( a : TriMesh, b : TriMesh ) : boolean {
        return a.vertices.length > 0 && b.containsPoint( a.vertices[0] );
    }

    private static centroid( t : Array<Point> ) : Point {
        return Vec.mul( 1 / 3, Vec.add( Vec.add( t[0], t[1] ), t[2] ) );
    }

    // ---- the meshes' search ----

    // A bounding-box tree over a mesh's triangles: nodes in an array, leaves of up to four triangles.
    private static tree( m : TriMesh ) : BoxTree {
        return new BoxTree( m );
    }

    // Every pair of triangles of the two trees whose boxes come within `bound()` of each other, nearer pairs first
    // (so a shrinking bound prunes the rest): a branch-and-bound descent over node pairs.
    private static pairs( a : BoxTree, b : BoxTree, bound : () => number, visit : (i : number, j : number) => void ) : void {
        const stack : Array<[number, number]> = [[0, 0]];
        while (stack.length > 0) {
            const [na, nb] = stack.pop() as [number, number];
            if (BoxTree.gap( a.box( na ), b.box( nb ) ) > bound()) continue;
            const la = a.leaf( na ), lb = b.leaf( nb );
            if (la && lb) {
                for (const i of a.items( na )) for (const j of b.items( nb )) visit( i, j );
                continue;
            }
            // split the larger node (or the one that is not a leaf)
            const splitA = !la && (lb || a.size( na ) >= b.size( nb ));
            const kids : Array<[number, number]> = splitA ? a.children( na ).map( c => [c, nb] as [number, number] ) : b.children( nb ).map( c => [na, c] as [number, number] );
            // the nearer child last, so it is visited first
            kids.sort( (x, y) => BoxTree.gap( b.box( y[1] ), a.box( y[0] ) ) - BoxTree.gap( b.box( x[1] ), a.box( x[0] ) ) );
            for (const k of kids) stack.push( k );
        }
    }

    // ---- triangle distances ----

    /**
     * The distance between two triangles: 0 when they cross or touch, otherwise the least of the distances from each
     * one's vertices to the other triangle and between their edges (the closest points of two disjoint triangles
     * are a vertex and a face or two edges: Ericson, "Real-Time Collision Detection", Morgan Kaufmann, 2005, §5.1.9).
     */
    public static triTri( a : Array<Point>, b : Array<Point> ) : number {
        for (let i = 0; i < 3; i++) {
            if (Clearance.segmentCrossesTriangle( a[i], a[(i + 1) % 3], b )) return 0;
            if (Clearance.segmentCrossesTriangle( b[i], b[(i + 1) % 3], a )) return 0;
        }
        let d = Infinity;
        for (let i = 0; i < 3; i++) {
            d = Math.min( d, Clearance.pointToTriangle( a[i], b ), Clearance.pointToTriangle( b[i], a ) );
            for (let j = 0; j < 3; j++) d = Math.min( d, Clearance.segmentSegment( a[i], a[(i + 1) % 3], b[j], b[(j + 1) % 3] ) );
        }
        return d;
    }

    // Whether the segment pq passes through the triangle (Möller and Trumbore, "Fast, minimum storage ray-triangle
    // intersection", Journal of Graphics Tools 2(1), 1997, on the segment's parameter in [0, 1]).
    private static segmentCrossesTriangle( p : Point, q : Point, t : Array<Point> ) : boolean {
        const d = Vec.sub( q, p ), e1 = Vec.sub( t[1], t[0] ), e2 = Vec.sub( t[2], t[0] );
        const h = Vec.cross( d, e2 ), det = Vec.dot( e1, h );
        if (Math.abs( det ) < 1e-300) return false; // parallel: the edge and vertex distances decide
        const s = Vec.sub( p, t[0] ), u = Vec.dot( s, h ) / det;
        if (u < 0 || u > 1) return false;
        const qv = Vec.cross( s, e1 ), v = Vec.dot( d, qv ) / det;
        if (v < 0 || u + v > 1) return false;
        const w = Vec.dot( e2, qv ) / det;
        return w >= 0 && w <= 1;
    }

    /** The distance from p to a triangle (Ericson, §5.1.5: the region of the triangle's plane p projects into). */
    public static pointToTriangle( p : Point, t : Array<Point> ) : number {
        const [a, b, c] = t;
        const ab = Vec.sub( b, a ), ac = Vec.sub( c, a ), ap = Vec.sub( p, a );
        const d1 = Vec.dot( ab, ap ), d2 = Vec.dot( ac, ap );
        if (d1 <= 0 && d2 <= 0) return Vec.dist( p, a );
        const bp = Vec.sub( p, b ), d3 = Vec.dot( ab, bp ), d4 = Vec.dot( ac, bp );
        if (d3 >= 0 && d4 <= d3) return Vec.dist( p, b );
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) return Vec.dist( p, Vec.add( a, Vec.mul( d1 / (d1 - d3), ab ) ) );
        const cp = Vec.sub( p, c ), d5 = Vec.dot( ab, cp ), d6 = Vec.dot( ac, cp );
        if (d6 >= 0 && d5 <= d6) return Vec.dist( p, c );
        const vb = d5 * d2 - d1 * d6;
        if (vb <= 0 && d2 >= 0 && d6 <= 0) return Vec.dist( p, Vec.add( a, Vec.mul( d2 / (d2 - d6), ac ) ) );
        const va = d3 * d6 - d5 * d4;
        if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return Vec.dist( p, Vec.add( b, Vec.mul( (d4 - d3) / ((d4 - d3) + (d5 - d6)), Vec.sub( c, b ) ) ) );
        const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
        return Vec.dist( p, Vec.add( a, Vec.add( Vec.mul( v, ab ), Vec.mul( w, ac ) ) ) );
    }

    // The distance between segments p1q1 and p2q2 (Ericson, §5.1.9, clamped to both segments).
    private static segmentSegment( p1 : Point, q1 : Point, p2 : Point, q2 : Point ) : number {
        const d1 = Vec.sub( q1, p1 ), d2 = Vec.sub( q2, p2 ), r = Vec.sub( p1, p2 );
        const a = Vec.dot( d1, d1 ), e = Vec.dot( d2, d2 ), f = Vec.dot( d2, r );
        let s = 0, t = 0;
        if (a <= 1e-300 && e <= 1e-300) return Vec.dist( p1, p2 );
        if (a <= 1e-300) t = Math.max( 0, Math.min( 1, f / e ) );
        else {
            const c = Vec.dot( d1, r );
            if (e <= 1e-300) s = Math.max( 0, Math.min( 1, -c / a ) );
            else {
                const b = Vec.dot( d1, d2 ), den = a * e - b * b;
                s = den > 0 ? Math.max( 0, Math.min( 1, (b * f - c * e) / den ) ) : 0;
                t = (b * s + f) / e;
                if (t < 0) { t = 0; s = Math.max( 0, Math.min( 1, -c / a ) ); }
                else if (t > 1) { t = 1; s = Math.max( 0, Math.min( 1, (b - c) / a ) ); }
            }
        }
        return Vec.dist( Vec.add( p1, Vec.mul( s, d1 ) ), Vec.add( p2, Vec.mul( t, d2 ) ) );
    }
}

// A bounding-box tree over a mesh's triangles, split at the middle of the widest spread of their centroids.
class BoxTree {
    private tris : Array<Array<Point>>;
    private boxes : Array<[Point, Point]> = [];
    private kids : Array<[number, number] | null> = [];
    private spans : Array<Array<number>> = [];

    constructor( m : TriMesh ) {
        this.tris = m.triangles.map( t => [m.vertices[t[0]], m.vertices[t[1]], m.vertices[t[2]]] );
        this.build( this.tris.map( (_, i) => i ) );
    }

    public tri( i : number ) : Array<Point> { return this.tris[i]; }
    public box( n : number ) : [Point, Point] { return this.boxes[n]; }
    public leaf( n : number ) : boolean { return this.kids[n] == null; }
    public items( n : number ) : Array<number> { return this.spans[n]; }
    public children( n : number ) : Array<number> { const k = this.kids[n]; return k == null ? [] : [k[0], k[1]]; }
    public size( n : number ) : number { const b = this.boxes[n]; return Vec.dist( b[0], b[1] ); }

    // The distance from p to the nearest triangle, by branch and bound over the boxes.
    public nearest( p : Point ) : number {
        let best = Infinity;
        const pb : [Point, Point] = [p, p];
        const stack = [0];
        while (stack.length > 0) {
            const n = stack.pop() as number;
            if (BoxTree.gap( this.boxes[n], pb ) >= best) continue;
            const k = this.kids[n];
            if (k == null) { for (const i of this.spans[n]) best = Math.min( best, Clearance.pointToTriangle( p, this.tris[i] ) ); continue; }
            const [l, r] = BoxTree.gap( this.boxes[k[0]], pb ) < BoxTree.gap( this.boxes[k[1]], pb ) ? [k[1], k[0]] : [k[0], k[1]];
            stack.push( l, r );
        }
        return best;
    }

    public static gap( a : [Point, Point], b : [Point, Point] ) : number {
        let s = 0;
        for (let k = 0; k < 3; k++) { const g = Math.max( 0, a[0][k] - b[1][k], b[0][k] - a[1][k] ); s += g * g; }
        return Math.sqrt( s );
    }

    private build( items : Array<number> ) : number {
        const id = this.boxes.length;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const i of items) for (const p of this.tris[i]) for (let k = 0; k < 3; k++) { lo[k] = Math.min( lo[k], p[k] ); hi[k] = Math.max( hi[k], p[k] ); }
        this.boxes.push( [lo, hi] ); this.kids.push( null ); this.spans.push( items );
        if (items.length <= 4) return id;
        const cen = items.map( i => Vec.mul( 1 / 3, Vec.add( Vec.add( this.tris[i][0], this.tris[i][1] ), this.tris[i][2] ) ) );
        const clo = [Infinity, Infinity, Infinity], chi = [-Infinity, -Infinity, -Infinity];
        for (const c of cen) for (let k = 0; k < 3; k++) { clo[k] = Math.min( clo[k], c[k] ); chi[k] = Math.max( chi[k], c[k] ); }
        let axis = 0;
        for (let k = 1; k < 3; k++) if (chi[k] - clo[k] > chi[axis] - clo[axis]) axis = k;
        const mid = 0.5 * (clo[axis] + chi[axis]);
        let left = items.filter( (_, k) => cen[k][axis] < mid ), right = items.filter( (_, k) => cen[k][axis] >= mid );
        if (left.length == 0 || right.length == 0) { left = items.slice( 0, items.length >> 1 ); right = items.slice( items.length >> 1 ); }
        const l = this.build( left ), r = this.build( right );
        this.kids[id] = [l, r]; this.spans[id] = [];
        return id;
    }
}
