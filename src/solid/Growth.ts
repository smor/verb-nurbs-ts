import { Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Implicit } from "./Implicit.js";
import { TriMesh } from "./TriMesh.js";

/**
 * Where and how a sheet grows. Distances are measured on the sheet as it was laid out (its material coordinates),
 * so a zone stays on the same stretch of material however the sheet buckles.
 *
 * * `edge`: along the sheet's free boundary, fading over `reach` (ruffles, like lettuce or kale)
 * * `point`: round the points `at`, fading over `reach` (blisters, cups)
 * * `line`: along the polyline `at`, fading over `reach` (a fasciated ridge)
 * * `everywhere`: the whole sheet (crumpling)
 *
 * `direction` makes growth anisotropic: an edge grows by the rate times the squared cosine of its angle to the
 * direction (in material coordinates), so the sheet lengthens one way and not the other (a stretching frill).
 */
export interface GrowthZone {
    kind : "edge" | "point" | "line" | "everywhere";
    /** relative growth of rest lengths per step at the zone's heart */
    rate : number;
    /** how far from the zone the rate falls to e^-1 (a Gaussian falloff; default: a tenth of the sheet's size) */
    reach? : number;
    /** points (`point`) or a polyline (`line`), in material coordinates */
    at? : Array<Point>;
    /** grow only along this direction (material coordinates) */
    direction? : Point;
}

/** Options of `Growth.grow`. */
export interface GrowthOptions {
    zones : Array<GrowthZone>;
    /** steps to run (default 200) */
    steps? : number;
    /** edges longer than this at rest are split (default: 1.5 times the sheet's mean edge) */
    split? : number;
    /** how close two vertices not joined by an edge may come: keeps the sheet from passing through itself, and the
     * walls of a thickened sheet apart. Above the longest edge, so no triangle slips between two vertices (default:
     * 1.35 times the split length) */
    collision? : number;
    /** how strongly the sheet resists bending, 0 to 1 (default 0.08) */
    bending? : number;
    /** material points held still, e.g. a stem (default: none) */
    pin? : (material : Point) => boolean;
    /** stop when the sheet has this many vertices (default 6000) */
    maxVertices? : number;
    /** relaxation rounds per step (default 10) */
    iterations? : number;
}

/** A grown sheet. */
export interface GrowthResult {
    /** the sheet: an open triangle mesh */
    mesh : TriMesh;
    /** each vertex's material point: where it was on the sheet as laid out */
    material : Array<Point>;
    steps : number;
    /** the sheet's area now, over its area laid out */
    areaGrowth : number;
    /** the closest two vertices not joined by an edge come (at least about the collision distance when nothing passed through) */
    minGap : number;
}

/** A grown sheet made solid: a closed mesh of the sheet thickened, and what limits it. */
export interface GrownSolid {
    mesh : TriMesh;
    thickness : number;
    /** whether the sheet's folds stayed apart: the solid is one piece with the genus a thickened copy of the sheet
     * has (1 - its Euler characteristic: 0 for a disc), so no two folds fused and no fold passed through another */
    separate : boolean;
    /** the solid's genus, and the genus it should have */
    genus : number | null;
    expectedGenus : number;
}

/**
 * Differential growth of sheets: organic ruffles, frills and folds, as in Nervous System's Floraform (Rosenkrantz and
 * Louis-Rosenberg, 2014, after the growth of leaves and flowers studied by Liang and Mahadevan, PNAS 2009).
 *
 * A sheet whose parts grow at different rates cannot stay flat: the excess length has to go somewhere, and it buckles
 * out of plane. Here each edge of a triangle mesh is a spring with a rest length; growth lengthens the rest lengths
 * where the zones say, and a position-based relaxation (Müller et al., "Position based dynamics", 2007) moves the
 * vertices to match:
 *
 * 1. **Grow**: each edge's rest length times 1 + the rate at its midpoint (in material coordinates).
 * 2. **Split**: an edge longer than `split` at rest is cut in two at its middle, with the two triangles beside it, so
 *    the mesh keeps its resolution as it grows (Nervous System split the longest edges the same way).
 * 3. **Relax**: a few rounds of edge-length projection, a bending term (each vertex pulled a little toward its
 *    neighbours' mean, against its normal only, which resists folding without shrinking the sheet), and collision:
 *    vertices not joined by an edge are pushed apart to the collision distance, found through a spatial hash.
 *
 * Pinned material points stay where they are. Growth that falls off over distance makes partial growth: the rest of
 * the sheet keeps its shape and holds the growing part.
 *
 * **Makeable.** `thicken` turns the sheet into a solid: the set within half a thickness of it, meshed by marching
 * tetrahedra from its distance field and relaxed (`Implicit`), so the result is always a closed 2-manifold with
 * rounded rims. Collision keeps folds at least the collision distance apart, so walls do not fuse when the thickness
 * is below it; `separate` says whether that held. `Makeable.check` then gives the verdict for a machine (SLS nylon
 * or a cast, as Nervous System print theirs).
 */
export class Growth {

    /** A flat disc sheet in the xy plane: rings of vertices about `edge` apart. */
    public static disc( radius : number, edge : number ) : TriMesh {
        const m = new TriMesh(), rings = Math.max( 1, Math.round( radius / edge ) );
        m.addVertex( [0, 0, 0] );
        let prev = [0];
        for (let r = 1; r <= rings; r++) {
            const n = 6 * r, ring : Array<number> = [];
            for (let k = 0; k < n; k++) {
                const a = 2 * Math.PI * k / n;
                ring.push( m.addVertex( [radius * r / rings * Math.cos( a ), radius * r / rings * Math.sin( a ), 0] ) );
            }
            // stitch the ring to the one inside, walking both by angle (all counter-clockwise seen from +z)
            if (r == 1) for (let i = 0; i < n; i++) m.addTriangle( prev[0], ring[i], ring[(i + 1) % n] );
            else {
                const np = prev.length;
                let i = 0, j = 0;
                while (i < n || j < np) {
                    if (i < n && (j >= np || (i + 1) / n <= (j + 1) / np)) { m.addTriangle( prev[j % np], ring[i], ring[(i + 1) % n] ); i++; }
                    else { m.addTriangle( prev[j], ring[i % n], prev[(j + 1) % np] ); j++; }
                }
            }
            prev = ring;
        }
        return m;
    }

    /** A flat rectangular sheet [0, w] × [0, h] in the xy plane, its triangles about `edge` across. */
    public static rectangle( w : number, h : number, edge : number ) : TriMesh {
        const m = new TriMesh(), nu = Math.max( 1, Math.round( w / edge ) ), nv = Math.max( 1, Math.round( h / edge ) );
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) m.addVertex( [w * i / nu, h * j / nv, 0] );
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
            const a = i + j * (nu + 1), b = a + 1, c = a + nu + 1, d = c + 1;
            if ((i + j) % 2 == 0) { m.addTriangle( a, b, d ); m.addTriangle( a, d, c ); } else { m.addTriangle( a, b, c ); m.addTriangle( b, d, c ); }
        }
        return m;
    }

    /** Grows a sheet (an open triangle mesh, left unchanged). */
    public static grow( sheet : TriMesh, options : GrowthOptions ) : GrowthResult {
        const V : Array<Point> = sheet.vertices.map( p => [p[0], p[1], p[2]] );
        const X : Array<Point> = sheet.vertices.map( p => [p[0], p[1], p[2]] );
        const T : Array<Array<number>> = sheet.triangles.map( t => t.slice() );
        const key = (a : number, b : number) => a < b ? a * 4194304 + b : b * 4194304 + a;
        const rest = new Map<number, number>();
        for (const t of T) for (let k = 0; k < 3; k++) {
            const a = t[k], b = t[(k + 1) % 3], e = key( a, b );
            if (!rest.has( e )) rest.set( e, Vec.dist( V[a], V[b] ) );
        }
        let mean = 0;
        rest.forEach( l => { mean += l; } );
        mean /= Math.max( 1, rest.size );
        const split = options.split ?? 1.5 * mean, gap = options.collision ?? 1.35 * split;
        const bending = options.bending ?? 0.08, steps = options.steps ?? 200, maxV = options.maxVertices ?? 6000;
        // the boundary as laid out, for edge zones; and the sheet's size, for default reaches
        const uses = new Map<number, number>();
        for (const t of T) for (let k = 0; k < 3; k++) { const e = key( t[k], t[(k + 1) % 3] ); uses.set( e, (uses.get( e ) ?? 0) + 1 ); }
        const border : Array<[Point, Point]> = [];
        for (const t of T) for (let k = 0; k < 3; k++) if (uses.get( key( t[k], t[(k + 1) % 3] ) ) == 1) border.push( [X[t[k]], X[t[(k + 1) % 3]]] );
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const p of X) for (let k = 0; k < 3; k++) { lo[k] = Math.min( lo[k], p[k] ); hi[k] = Math.max( hi[k], p[k] ); }
        const size = Math.hypot( hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2] );
        // each zone's weight at a material point (the falloff from the zone), kept per vertex
        const weights = (m : Point) : Array<number> => options.zones.map( z => {
            if (z.kind == "everywhere") return 1;
            const reach = z.reach ?? 0.1 * size;
            let d = Infinity;
            if (z.kind == "edge") for (const sg of border) d = Math.min( d, Implicit.segmentDistance( m, sg[0], sg[1] ) );
            else if (z.kind == "point") for (const q of z.at ?? []) d = Math.min( d, Vec.dist( q, m ) );
            else { const at = z.at ?? []; for (let k = 0; k + 1 < at.length; k++) d = Math.min( d, Implicit.segmentDistance( m, at[k], at[k + 1] ) ); }
            return Math.exp( -(d / reach) * (d / reach) );
        } );
        const W = X.map( weights );
        // an edge's growth: each zone's rate at its ends' mean weight, times its alignment where the zone has a direction
        const rate = (a : number, b : number) : number => {
            let r = 0;
            options.zones.forEach( (z, k) => {
                let w = 0.5 * (W[a][k] + W[b][k]);
                if (z.direction != null) {
                    const dir = Vec.sub( X[b], X[a] ), ld = Vec.norm( dir ), lz = Vec.norm( z.direction );
                    const c = ld > 0 && lz > 0 ? Vec.dot( dir, z.direction ) / (ld * lz) : 0;
                    w *= c * c;
                }
                r += z.rate * w;
            } );
            return r;
        };
        // a flat sheet is a balance that growth alone never tips: a small, fixed (seeded) ruffle across its plane lets
        // it buckle; the same sheet and options always grow the same way
        let seed = 12345;
        const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
        {
            const n0 = Growth.normals( V, T );
            V.forEach( (p, i) => { const r = 0.02 * mean * random(); for (let k = 0; k < 3; k++) p[k] += r * n0[i][k]; } );
        }
        const pinned = (i : number) => options.pin != null && options.pin( X[i] );
        const fixed : Array<boolean> = X.map( (_, i) => pinned( i ) );
        let step = 0;
        for (; step < steps && V.length < maxV; step++) {
            // 1. grow
            for (const [e, l] of rest) {
                const a = Math.floor( e / 4194304 ), b = e - a * 4194304;
                rest.set( e, l * (1 + rate( a, b )) );
            }
            // 2. split edges long at rest, the longest first
            const long = Array.from( rest.entries() ).filter( e => e[1] > split ).sort( (p, q) => q[1] - p[1] );
            if (long.length > 0) {
                const triOf = new Map<number, Array<number>>();
                T.forEach( (t, k) => { for (let i = 0; i < 3; i++) { const e = key( t[i], t[(i + 1) % 3] ); let l = triOf.get( e ); if (l == null) triOf.set( e, l = [] ); l.push( k ); } } );
                const touched = new Set<number>();
                for (const [e] of long) {
                    if (V.length >= maxV) break;
                    const tris = triOf.get( e ) ?? [];
                    if (tris.some( k => touched.has( k ) )) continue;
                    const a = Math.floor( e / 4194304 ), b = e - a * 4194304, L = rest.get( e ) as number;
                    const m = V.length;
                    V.push( Vec.lerp( 0.5, V[a], V[b] ) ); X.push( Vec.lerp( 0.5, X[a], X[b] ) ); W.push( W[a].map( (x, k) => 0.5 * (x + W[b][k]) ) ); fixed.push( fixed[a] && fixed[b] );
                    rest.delete( e );
                    rest.set( key( a, m ), 0.5 * L ); rest.set( key( m, b ), 0.5 * L );
                    for (const k of tris) {
                        touched.add( k );
                        const t = T[k], i = t.findIndex( (v, s) => key( v, t[(s + 1) % 3] ) == e );
                        const p0 = t[i], p1 = t[(i + 1) % 3], c = t[(i + 2) % 3];
                        // the new edge to the opposite vertex: its rest length from the two halves' rest geometry
                        const ra = rest.get( key( p0, c ) ) ?? Vec.dist( V[p0], V[c] ), rb = rest.get( key( p1, c ) ) ?? Vec.dist( V[p1], V[c] );
                        const median = Math.sqrt( Math.max( 0, 0.5 * ra * ra + 0.5 * rb * rb - 0.25 * L * L ) );
                        rest.set( key( m, c ), Math.max( median, 1e-6 * L ) );
                        T[k] = [p0, m, c];
                        T.push( [m, p1, c] );
                        touched.add( T.length - 1 );
                    }
                }
            }
            // 3. relax
            const ring : Array<Array<number>> = V.map( () => [] );
            for (const e of rest.keys()) { const a = Math.floor( e / 4194304 ), b = e - a * 4194304; ring[a].push( b ); ring[b].push( a ); }
            for (let it = 0; it < (options.iterations ?? 10); it++) {
                for (const [e, l] of rest) {
                    const a = Math.floor( e / 4194304 ), b = e - a * 4194304;
                    const d = Vec.sub( V[b], V[a] ), len = Vec.norm( d );
                    if (len < 1e-12) continue;
                    const wa = fixed[a] ? 0 : 1, wb = fixed[b] ? 0 : 1;
                    if (wa + wb == 0) continue;
                    // move the ends along the edge to its rest length, shared by the free ends
                    const c = (len - l) / len / (wa + wb);
                    for (let k = 0; k < 3; k++) { V[a][k] += wa * c * d[k]; V[b][k] -= wb * c * d[k]; }
                }
                // bending: toward the neighbours' mean, along the normal only
                const N = Growth.normals( V, T );
                for (let i = 0; i < V.length; i++) {
                    if (fixed[i] || ring[i].length == 0) continue;
                    const c : Point = [0, 0, 0];
                    for (const j of ring[i]) for (let k = 0; k < 3; k++) c[k] += V[j][k] / ring[i].length;
                    const d = Vec.dot( Vec.sub( c, V[i] ), N[i] );
                    for (let k = 0; k < 3; k++) V[i][k] += bending * d * N[i][k];
                }
                Growth.collide( V, ring, fixed, gap );
            }
        }
        const mesh = new TriMesh();
        mesh.vertices = V; mesh.triangles = T;
        const flat = sheet.area();
        return { mesh : mesh, material : X, steps : step, areaGrowth : flat > 0 ? mesh.area() / flat : 1, minGap : Growth.minGap( V, T ) };
    }

    /**
     * The sheet made solid: every point within half the thickness of it, as a closed mesh (`Implicit.mesh`, then
     * `Implicit.relax`), on a grid of `size` (default a third of the thickness).
     */
    public static thicken( grown : GrowthResult, thickness : number, size? : number ) : GrownSolid {
        const h = size ?? thickness / 3;
        const dist = Implicit.meshDistance( grown.mesh, thickness + 2 * h );
        const field = { value : (p : Point) => dist.unsigned( p ) - 0.5 * thickness };
        const box = grown.mesh.boundingBox(), pad = thickness + 2 * h;
        const lo : Point = [box.min[0] - pad, box.min[1] - pad, box.min[2] - pad], hi : Point = [box.max[0] + pad, box.max[1] + pad, box.max[2] + pad];
        const mesh = Implicit.relax( Implicit.mesh( field, lo, hi, h ), field, 3, h );
        const S = grown.mesh, edges = new Set<number>();
        for (const t of S.triangles) for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; edges.add( a < b ? a * 4194304 + b : b * 4194304 + a ); }
        const expected = 1 - (S.vertices.length - edges.size + S.triangles.length);
        const report = mesh.checkClosedManifold();
        return { mesh : mesh, thickness : thickness, separate : report.closedManifold && report.genus === expected && mesh.components() == 1,
                 genus : report.genus, expectedGenus : expected };
    }

    // ---------- helpers ----------

    private static normals( V : Array<Point>, T : Array<Array<number>> ) : Array<Point> {
        const N : Array<Point> = V.map( () => [0, 0, 0] );
        for (const t of T) {
            const n = Vec.cross( Vec.sub( V[t[1]], V[t[0]] ), Vec.sub( V[t[2]], V[t[0]] ) );
            for (const i of t) for (let k = 0; k < 3; k++) N[i][k] += n[k];
        }
        return N.map( n => { const l = Vec.norm( n ); return l > 0 ? Vec.mul( 1 / l, n ) : [0, 0, 1]; } );
    }

    // Push apart vertices closer than the gap that no edge joins (neighbours of neighbours are left alone too: the
    // sheet's own triangles hold them), through a spatial hash of cells of the gap's size.
    private static collide( V : Array<Point>, ring : Array<Array<number>>, fixed : Array<boolean>, gap : number ) : void {
        const cell = (p : Point) => [Math.floor( p[0] / gap ), Math.floor( p[1] / gap ), Math.floor( p[2] / gap )];
        const hash = (c : Array<number>) => ((c[0] * 73856093) ^ (c[1] * 19349663) ^ (c[2] * 83492791)) | 0;
        const grid = new Map<number, Array<number>>();
        V.forEach( (p, i) => { const h = hash( cell( p ) ); let l = grid.get( h ); if (l == null) grid.set( h, l = [] ); l.push( i ); } );
        const near = (i : number) => { const s = new Set( ring[i] ); for (const j of ring[i]) for (const k of ring[j]) s.add( k ); return s; };
        for (let i = 0; i < V.length; i++) {
            const c = cell( V[i] );
            let skip : Set<number> | null = null;
            for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
                const l = grid.get( hash( [c[0] + a, c[1] + b, c[2] + d] ) );
                if (l == null) continue;
                for (const j of l) {
                    if (j <= i) continue;
                    const v = Vec.sub( V[j], V[i] ), len = Vec.norm( v );
                    if (len >= gap) continue;
                    if (skip == null) skip = near( i );
                    if (skip.has( j )) continue;
                    const wi = fixed[i] ? 0 : 1, wj = fixed[j] ? 0 : 1;
                    if (wi + wj == 0) continue;
                    const u = len > 1e-12 ? Vec.mul( 1 / len, v ) : [0, 0, 1] as Point;
                    const push = (gap - len) / (wi + wj);
                    for (let k = 0; k < 3; k++) { V[i][k] -= wi * push * u[k]; V[j][k] += wj * push * u[k]; }
                }
            }
        }
    }

    // The closest two vertices come that are not within two edges of each other.
    private static minGap( V : Array<Point>, T : Array<Array<number>> ) : number {
        const ring : Array<Set<number>> = V.map( () => new Set() );
        for (const t of T) for (let k = 0; k < 3; k++) { ring[t[k]].add( t[(k + 1) % 3] ); ring[t[(k + 1) % 3]].add( t[k] ); }
        let mean = 0, n = 0;
        for (const t of T) { mean += Vec.dist( V[t[0]], V[t[1]] ); n++; }
        const h = 4 * Math.max( mean / Math.max( n, 1 ), 1e-9 );
        const grid = new Map<string, Array<number>>();
        const cell = (p : Point) => [Math.floor( p[0] / h ), Math.floor( p[1] / h ), Math.floor( p[2] / h )];
        V.forEach( (p, i) => { const k = cell( p ).join( "," ); let l = grid.get( k ); if (l == null) grid.set( k, l = [] ); l.push( i ); } );
        let best = Infinity;
        V.forEach( (p, i) => {
            const c = cell( p ), near = new Set( ring[i] );
            for (const j of ring[i]) for (const k of ring[j]) near.add( k );
            for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
                for (const j of grid.get( [c[0] + a, c[1] + b, c[2] + d].join( "," ) ) ?? []) {
                    if (j <= i || near.has( j )) continue;
                    best = Math.min( best, Vec.dist( p, V[j] ) );
                }
            }
        } );
        return best;
    }
}
