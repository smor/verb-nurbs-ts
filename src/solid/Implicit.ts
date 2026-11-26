import { Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { MeshBVH } from "./MeshBVH.js";
import { TriMesh } from "./TriMesh.js";

/**
 * A scalar field over space whose negative set is a solid: `value(p) < 0` inside, `> 0` outside. Fields here are
 * distances, or close to them (an error that shrinks near the surface), so that `value(p) - w` grows a solid by `w`.
 */
export interface Field {
    value( p : Point ) : number;
}

/** A thickness that may vary over space (graded lattices): a number, or a function of the point. */
export type Grade = number | ((p : Point) => number);

/** The lattices `Implicit.lattice` builds. The first three are sheets on triply periodic minimal surfaces (TPMS). */
export type LatticePattern = "gyroid" | "schwarz-p" | "diamond" | "bcc" | "octet" | "cubic";

/**
 * Solids given by fields, and their meshes.
 *
 * The mesh is the zero set of the field, found by marching tetrahedra on a regular grid split into six tetrahedra per
 * cube around the cube's main diagonal (Freudenthal's split; the split is the same in every cube, so neighbouring tets
 * share faces). Every grid sample is strictly inside or outside (a zero counts as outside), so within each tet the
 * zero set is one triangle or one quad, and the triangles of all the tets join along shared tet edges and faces into
 * a closed 2-manifold. Each vertex is then moved along its tet edge to the field's root there (Illinois regula falsi,
 * on the field itself, not on the grid's linear interpolation), which keeps it on the edge: every triangle stays
 * inside its tet, so the mesh cannot cross itself. This is the reason to prefer tetrahedra over marching cubes,
 * whose ambiguous cases need extra rules to stay manifold (Doi and Koide, "An efficient method of triangulating
 * equi-valued surfaces by using tetrahedral cells", IEICE Trans. E74(1), 1991).
 *
 * Triply periodic minimal surfaces are Schoen's gyroid and Schwarz's P and D surfaces in their usual level-set
 * approximations; a sheet of thickness `w` is the set where |g| / |grad g| < w / 2, the first-order distance to the
 * surface (as in nTopology and in Al-Ketan and Abu Al-Rub, "MSLattice", Material Design & Processing Comm. 2021).
 */
export class Implicit {

    // ---------- fields ----------

    /** A field from a function. */
    public static of( f : (p : Point) => number ) : Field { return { value : f }; }

    /** The solid's complement. */
    public static not( a : Field ) : Field { return { value : p => -a.value( p ) }; }

    /** Union: the smaller value; with `k` > 0, a smooth union that fillets the joint with a radius of about `k`
     * (Quílez's polynomial smooth minimum). */
    public static union( fields : Array<Field>, k : number = 0 ) : Field {
        return { value : p => {
            let v = fields[0].value( p );
            for (let i = 1; i < fields.length; i++) v = Implicit.smin( v, fields[i].value( p ), k );
            return v;
        } };
    }

    /** Intersection: the larger value (smoothly with `k` > 0). */
    public static intersection( fields : Array<Field>, k : number = 0 ) : Field {
        return { value : p => {
            let v = fields[0].value( p );
            for (let i = 1; i < fields.length; i++) v = -Implicit.smin( -v, -fields[i].value( p ), k );
            return v;
        } };
    }

    /** a less b (smoothly with `k` > 0). */
    public static difference( a : Field, b : Field, k : number = 0 ) : Field {
        return Implicit.intersection( [a, Implicit.not( b )], k );
    }

    /** The field shifted by `d`: the solid grown by `d` (shrunk where negative). */
    public static offset( a : Field, d : Grade ) : Field {
        return { value : p => a.value( p ) - (typeof d == "number" ? d : d( p )) };
    }

    /** The wall of thickness `t` just inside the solid's surface: the points within `t` of it, inside. */
    public static skin( a : Field, t : Grade ) : Field {
        return { value : p => { const v = a.value( p ); return Math.max( v, -v - (typeof t == "number" ? t : t( p )) ); } };
    }

    /** The smooth minimum of two values: min(a, b), rounded over a band of width k. */
    public static smin( a : number, b : number, k : number ) : number {
        if (k <= 0) return Math.min( a, b );
        const h = Math.max( k - Math.abs( a - b ), 0 ) / k;
        return Math.min( a, b ) - h * h * k * 0.25;
    }

    /** A box. */
    public static box( min : Point, max : Point ) : Field {
        return { value : p => {
            let out = 0, inn = -Infinity;
            for (let c = 0; c < 3; c++) {
                const d = Math.max( min[c] - p[c], p[c] - max[c] );
                if (d > 0) out += d * d;
                inn = Math.max( inn, d );
            }
            return out > 0 ? Math.sqrt( out ) : inn;
        } };
    }

    /** A ball. */
    public static ball( centre : Point, radius : number ) : Field {
        return { value : p => Vec.dist( p, centre ) - radius };
    }

    /** A capsule: the points within `radius` of the segment ab. */
    public static capsule( a : Point, b : Point, radius : Grade ) : Field {
        return { value : p => Implicit.segmentDistance( p, a, b ) - (typeof radius == "number" ? radius : radius( p )) };
    }

    // ---------- lattices ----------

    /**
     * A lattice filling all of space, with cubic cells of side `cell`: a TPMS sheet of thickness `wall`, or struts
     * of diameter `wall` along the edges of the cell's graph (BCC: body diagonals; octet: face diagonals and edges;
     * cubic: edges). `wall` may vary over space, for a graded lattice.
     */
    public static lattice( pattern : LatticePattern, cell : number, wall : Grade ) : Field {
        const w = (p : Point) => typeof wall == "number" ? wall : wall( p );
        const k = 2 * Math.PI / cell;
        const sheet = (g : (x : number, y : number, z : number) => [number, number, number, number]) : Field => ({
            value : p => {
                // the distance to the surface: the point projected onto it by Newton steps along the gradient
                // (q - g grad g / |grad g|^2); the first-order estimate |g| / |grad g| alone is short of the distance
                // by up to a tenth at the walls' surfaces, which would make walls thinner than asked
                let x = k * p[0], y = k * p[1], z = k * p[2];
                const first = (r : [number, number, number, number]) => Math.abs( r[0] ) / Math.max( Math.hypot( r[1], r[2], r[3] ), 0.25 );
                const r0 = g( x, y, z );
                const d0 = first( r0 );
                // far from the surface the steps would wander: the estimate is enough to say so
                if (d0 > 0.6 * Math.PI) return d0 / k - 0.5 * w( p );
                let r = r0;
                for (let it = 0; it < 4; it++) {
                    const g2 = r[1] * r[1] + r[2] * r[2] + r[3] * r[3];
                    if (g2 < 1e-4) return d0 / k - 0.5 * w( p );
                    const step = r[0] / g2;
                    x -= step * r[1]; y -= step * r[2]; z -= step * r[3];
                    r = g( x, y, z );
                }
                const d = Math.hypot( x - k * p[0], y - k * p[1], z - k * p[2] );
                return d / k - 0.5 * w( p );
            }
        });
        switch (pattern) {
            case "gyroid" : return sheet( (x, y, z) => {
                const sx = Math.sin( x ), cx = Math.cos( x ), sy = Math.sin( y ), cy = Math.cos( y ), sz = Math.sin( z ), cz = Math.cos( z );
                return [sx * cy + sy * cz + sz * cx, cx * cy - sz * sx, -sx * sy + cy * cz, -sy * sz + cz * cx];
            } );
            case "schwarz-p" : return sheet( (x, y, z) =>
                [Math.cos( x ) + Math.cos( y ) + Math.cos( z ), -Math.sin( x ), -Math.sin( y ), -Math.sin( z )] );
            case "diamond" : return sheet( (x, y, z) => {
                const sx = Math.sin( x ), cx = Math.cos( x ), sy = Math.sin( y ), cy = Math.cos( y ), sz = Math.sin( z ), cz = Math.cos( z );
                return [sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz,
                        cx * sy * sz + cx * cy * cz - sx * sy * cz - sx * cy * sz,
                        sx * cy * sz - sx * sy * cz + cx * cy * cz - cx * sy * sz,
                        sx * sy * cz - sx * cy * sz - cx * sy * sz + cx * cy * cz];
            } );
            default : return Implicit.struts( Implicit.STRUTS[pattern], cell, w );
        }
    }

    // the struts of one unit cell, in cell units (a cell spans [0, 1]^3); neighbouring cells repeat them
    private static STRUTS : { [k : string] : Array<[Point, Point]> } = (() => {
        const corners : Array<Point> = [];
        for (let i = 0; i < 8; i++) corners.push( [i & 1, (i >> 1) & 1, (i >> 2) & 1] );
        const edges : Array<[Point, Point]> = [];
        for (const a of corners) for (let c = 0; c < 3; c++) if (a[c] == 0) { const b = a.slice() as Point; b[c] = 1; edges.push( [a, b] ); }
        const bcc = corners.map( a => [a, [0.5, 0.5, 0.5]] as [Point, Point] );
        const faces : Array<[Point, Point]> = [];
        for (let c = 0; c < 3; c++) for (const v of [0, 1]) {
            const u = (c + 1) % 3, w = (c + 2) % 3;
            const q = (a : number, b : number) => { const p : Point = [0, 0, 0]; p[c] = v; p[u] = a; p[w] = b; return p; };
            faces.push( [q( 0, 0 ), q( 1, 1 )], [q( 1, 0 ), q( 0, 1 )] );
        }
        return { bcc : bcc, octet : faces.concat( edges ), cubic : edges };
    })();

    // A strut lattice: the distance to the nearest strut of the cell the point is in, or of a neighbour, less the
    // strut's radius.
    private static struts( unit : Array<[Point, Point]>, cell : number, w : (p : Point) => number ) : Field {
        return { value : p => {
            const c = p.map( x => Math.floor( x / cell ) );
            const q = p.map( (x, i) => x / cell - c[i] );
            let best = Infinity;
            for (const s of unit) best = Math.min( best, Implicit.segmentDistance( q, s[0], s[1] ) );
            for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
                if (i == 0 && j == 0 && k == 0) continue;
                // a neighbour's struts lie in the neighbour: skip it when the point is further from it than the best
                const gx = i < 0 ? q[0] : i > 0 ? 1 - q[0] : 0, gy = j < 0 ? q[1] : j > 0 ? 1 - q[1] : 0, gz = k < 0 ? q[2] : k > 0 ? 1 - q[2] : 0;
                if (gx * gx + gy * gy + gz * gz >= best * best) continue;
                const o : Point = [q[0] - i, q[1] - j, q[2] - k];
                for (const s of unit) best = Math.min( best, Implicit.segmentDistance( o, s[0], s[1] ) );
            }
            return best * cell - 0.5 * w( p );
        } };
    }

    /** The distance from p to the segment ab. */
    public static segmentDistance( p : Point, a : Point, b : Point ) : number {
        const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
        const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
        const l2 = abx * abx + aby * aby + abz * abz;
        const t = l2 > 0 ? Math.max( 0, Math.min( 1, (apx * abx + apy * aby + apz * abz) / l2 ) ) : 0;
        const dx = apx - t * abx, dy = apy - t * aby, dz = apz - t * abz;
        return Math.sqrt( dx * dx + dy * dy + dz * dz );
    }

    // ---------- the signed distance to a closed mesh ----------

    /**
     * The signed distance to a closed mesh (negative inside), exact within `band` of the surface and clamped to
     * `band` beyond it (which is all a skin or an infill of thickness below `band` needs). Triangles are binned in a
     * grid of cells of size `band`, so a query looks at 27 cells; inside or outside is decided by ray parity
     * (`MeshBVH.contains`).
     */
    public static meshDistance( mesh : TriMesh, band : number ) : Field & { unsigned( p : Point ) : number, inside( p : Point ) : boolean, triangle() : number } {
        const V = mesh.vertices, T = mesh.triangles;
        const bvh = new MeshBVH( mesh );
        const tree = Implicit.boxTree( mesh );
        const normals = Implicit.pseudonormals( mesh );
        // the nearest point within the band: its squared distance, triangle and feature (`closestFeature`)
        let near = { d : 0, t : -1, feature : 0, c : [0, 0, 0] as Point };
        const nearest = (p : Point) => {
            let best = band * band, bt = -1, bf = 0, bc : Point = [0, 0, 0];
            const stack = [0];
            while (stack.length > 0) {
                const id = stack.pop() as number;
                if (Implicit.boxDistance2( tree.box, id, p ) >= best) continue;
                const l = tree.child[2 * id];
                if (l < 0) {
                    const st = tree.span[2 * id], n = tree.span[2 * id + 1];
                    for (let k = st; k < st + n; k++) {
                        const t = T[tree.order[k]];
                        const r = Implicit.closestFeature( p, V[t[0]], V[t[1]], V[t[2]] );
                        const c = r.point, dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2], d = dx * dx + dy * dy + dz * dz;
                        if (d < best) { best = d; bt = tree.order[k]; bf = r.feature; bc = c; }
                    }
                    continue;
                }
                const r = tree.child[2 * id + 1];
                const dl = Implicit.boxDistance2( tree.box, l, p ), dr = Implicit.boxDistance2( tree.box, r, p );
                if (dl < dr) { stack.push( r ); stack.push( l ); } else { stack.push( l ); stack.push( r ); }
            }
            near = { d : Math.sqrt( best ), t : bt, feature : bf, c : bc };
        };
        // inside or out, for points beyond the band, by ray parity, cached per cube of side band / sqrt 3: such a cube
        // lies within the band of any of its points, so when one of them is beyond the band, no surface crosses it
        const cube = band / Math.sqrt( 3 ), signs = new Map<string, boolean>();
        const farInside = (p : Point) => {
            const key = Math.floor( p[0] / cube ) + "," + Math.floor( p[1] / cube ) + "," + Math.floor( p[2] / cube );
            let got = signs.get( key );
            if (got == null) signs.set( key, got = bvh.contains( p ) );
            return got;
        };
        const value = (p : Point) => {
            nearest( p );
            if (near.t < 0) return farInside( p ) ? -band : band;
            // the side of the nearest feature, by its angle-weighted pseudonormal (Baerentzen and Aanaes, "Signed
            // distance computation using the angle weighted pseudonormal", IEEE TVCG 11(3), 2005): exact for a closed,
            // consistently oriented mesh
            const t = T[near.t], f = near.feature;
            const n = f == 0 ? normals.face[near.t] : f <= 3 ? normals.vertex[t[f - 1]]
                    : normals.edge.get( Implicit.edgeKey( t[[0, 0, 1][f - 4]], t[[1, 2, 2][f - 4]], V.length ) ) as Point;
            const side = (p[0] - near.c[0]) * n[0] + (p[1] - near.c[1]) * n[1] + (p[2] - near.c[2]) * n[2];
            return side < 0 ? -near.d : near.d;
        };
        return { value : value,
                 unsigned : p => { nearest( p ); return near.d; },
                 inside : p => value( p ) < 0,
                 // the nearest triangle of the last query, -1 when none was within the band
                 triangle : () => near.t };
    }

    private static edgeKey( a : number, b : number, n : number ) : number { return a < b ? a * n + b : b * n + a; }

    // Each face's unit normal; each vertex's normal, the faces' weighted by their angles there; and each edge's, the
    // sum of its two faces'.
    private static pseudonormals( mesh : TriMesh ) : { face : Array<Point>, vertex : Array<Point>, edge : Map<number, Point> } {
        const V = mesh.vertices, n = V.length;
        const vertex : Array<Point> = V.map( () => [0, 0, 0] as Point );
        const edge = new Map<number, Point>();
        const face = mesh.triangles.map( t => {
            const nr = Vec.cross( Vec.sub( V[t[1]], V[t[0]] ), Vec.sub( V[t[2]], V[t[0]] ) );
            const l = Vec.norm( nr );
            const u = l > 0 ? Vec.mul( 1 / l, nr ) : [0, 0, 0] as Point;
            for (let k = 0; k < 3; k++) {
                const a = t[k], b = t[(k + 1) % 3], c = t[(k + 2) % 3];
                const e1 = Vec.sub( V[b], V[a] ), e2 = Vec.sub( V[c], V[a] );
                const l1 = Vec.norm( e1 ), l2 = Vec.norm( e2 );
                const ang = l1 > 0 && l2 > 0 ? Math.acos( Math.max( -1, Math.min( 1, Vec.dot( e1, e2 ) / (l1 * l2) ) ) ) : 0;
                vertex[a] = Vec.add( vertex[a], Vec.mul( ang, u ) );
                const key = Implicit.edgeKey( a, b, n );
                edge.set( key, Vec.add( edge.get( key ) ?? [0, 0, 0], u ) );
            }
            return u;
        } );
        return { face : face, vertex : vertex, edge : edge };
    }

    // The point of triangle abc closest to p, and the feature it lies on: 0 the face, 1-3 the vertices a, b, c,
    // 4-6 the edges ab, ac, bc.
    private static closestFeature( p : Point, a : Point, b : Point, c : Point ) : { point : Point, feature : number } {
        const ab = Vec.sub( b, a ), ac = Vec.sub( c, a ), ap = Vec.sub( p, a );
        const d1 = Vec.dot( ab, ap ), d2 = Vec.dot( ac, ap );
        if (d1 <= 0 && d2 <= 0) return { point : a, feature : 1 };
        const bp = Vec.sub( p, b ), d3 = Vec.dot( ab, bp ), d4 = Vec.dot( ac, bp );
        if (d3 >= 0 && d4 <= d3) return { point : b, feature : 2 };
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) return { point : Vec.add( a, Vec.mul( d1 / (d1 - d3), ab ) ), feature : 4 };
        const cp = Vec.sub( p, c ), d5 = Vec.dot( ab, cp ), d6 = Vec.dot( ac, cp );
        if (d6 >= 0 && d5 <= d6) return { point : c, feature : 3 };
        const vb = d5 * d2 - d1 * d6;
        if (vb <= 0 && d2 >= 0 && d6 <= 0) return { point : Vec.add( a, Vec.mul( d2 / (d2 - d6), ac ) ), feature : 5 };
        const va = d3 * d6 - d5 * d4;
        if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return { point : Vec.add( b, Vec.mul( (d4 - d3) / ((d4 - d3) + (d5 - d6)), Vec.sub( c, b ) ) ), feature : 6 };
        const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
        return { point : Vec.add( a, Vec.add( Vec.mul( v, ab ), Vec.mul( w, ac ) ) ), feature : 0 };
    }

    // An axis-aligned box tree over a mesh's triangles, split at the median of the longest axis, for nearest-point
    // queries (`MeshBVH` serves rays).
    private static boxTree( mesh : TriMesh ) : { box : Float64Array, child : Int32Array, span : Int32Array, order : Int32Array } {
        const V = mesh.vertices, T = mesh.triangles, n = T.length;
        const order = new Int32Array( n );
        for (let i = 0; i < n; i++) order[i] = i;
        const cen = T.map( t => Implicit.centroid( [V[t[0]], V[t[1]], V[t[2]]] ) );
        const cap = Math.max( 1, 2 * n );
        const box = new Float64Array( 6 * cap ), child = new Int32Array( 2 * cap ), span = new Int32Array( 2 * cap );
        let nodes = 0;
        const build = (st : number, cnt : number) : number => {
            const id = nodes++;
            const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
            for (let k = st; k < st + cnt; k++) for (const v of T[order[k]]) for (let c = 0; c < 3; c++) {
                b[c] = Math.min( b[c], V[v][c] ); b[3 + c] = Math.max( b[3 + c], V[v][c] );
            }
            for (let c = 0; c < 6; c++) box[6 * id + c] = b[c];
            span[2 * id] = st; span[2 * id + 1] = cnt;
            if (cnt <= 4) { child[2 * id] = -1; child[2 * id + 1] = -1; return id; }
            let axis = 0;
            for (let c = 1; c < 3; c++) if (b[3 + c] - b[c] > b[3 + axis] - b[axis]) axis = c;
            const part = Array.from( order.subarray( st, st + cnt ) ).sort( (x, y) => cen[x][axis] - cen[y][axis] );
            for (let k = 0; k < cnt; k++) order[st + k] = part[k];
            const half = cnt >> 1;
            const l = build( st, half ), r = build( st + half, cnt - half );
            child[2 * id] = l; child[2 * id + 1] = r;
            return id;
        };
        if (n > 0) build( 0, n );
        return { box : box, child : child, span : span, order : order };
    }

    private static boxDistance2( box : Float64Array, id : number, p : Point ) : number {
        let d = 0;
        for (let c = 0; c < 3; c++) {
            const lo = box[6 * id + c], hi = box[6 * id + 3 + c];
            const e = p[c] < lo ? lo - p[c] : p[c] > hi ? p[c] - hi : 0;
            d += e * e;
        }
        return d;
    }

    /** The point of triangle abc closest to p (C. Ericson, Real-Time Collision Detection, 2005, 5.1.5). */
    public static closestOnTriangle( p : Point, a : Point, b : Point, c : Point ) : Point {
        return Implicit.closestFeature( p, a, b, c ).point;
    }

    /**
     * A closed mesh's solid made light: a skin of thickness `skin` (0: none, the lattice cut off at the surface) round
     * a lattice core that fuses with it. The core is the lattice within the solid, reaching half the skin's thickness
     * into it, joined with a smooth union of radius `blend` (0: a sharp joint). Meshed on a grid of side `size`
     * (default: an eighth of the cell, two thirds of the skin or a third of the wall, whichever is least; a grid
     * coarser than half the wall can break the walls through). Where the nearest triangle of the solid is `open` (one flag per triangle), there is no skin and the lattice runs
     * out to the surface: a TPMS sheet parts space into two labyrinths, and a closed skin seals both in, so the
     * resin or powder of a printer could not drain; opening a face lets it.
     */
    public static infill( solid : TriMesh, options : { pattern : LatticePattern, cell : number, wall : Grade, skin? : number, blend? : number, size? : number, open? : ArrayLike<boolean> } ) : TriMesh {
        const skin = options.skin ?? 0, blend = options.blend ?? 0;
        const size = options.size ?? Math.min( options.cell / 8, skin > 0 ? skin / 1.5 : Infinity, typeof options.wall == "number" ? options.wall / 3 : Infinity );
        const band = Math.max( skin, 0 ) + 3 * size + blend;
        const s = Implicit.meshDistance( solid, band );
        const lattice = Implicit.lattice( options.pattern, options.cell, options.wall );
        // the opening: the points within the skin's thickness (and a step) of the open faces, by the distance to
        // them alone, so the skin's edge round an opening is a smooth offset of the faces' boundary, not a grid step
        let opening : ((p : Point) => number) | null = null;
        if (options.open != null) {
            const sub = new TriMesh();
            sub.vertices = solid.vertices;
            sub.triangles = solid.triangles.filter( (_, k) => (options.open as ArrayLike<boolean>)[k] );
            if (sub.triangles.length > 0) {
                const o = Implicit.meshDistance( sub, band );
                opening = p => o.unsigned( p ) - (skin + size);
            }
        }
        const field : Field = skin > 0 ? { value : p => {
            const v = s.value( p );
            const op = opening == null ? band : opening( p );
            // the skin, less the opening; the lattice deeper than half the skin, or within the opening
            const sk = Math.max( v, -v - skin, -op );
            const L = lattice.value( p );
            const core = Math.min( Math.max( v + 0.5 * skin, L ), Math.max( v, L, op ) );
            // the blend rounds the joints inside; nothing comes out past the solid's surface
            return Math.max( Implicit.smin( sk, core, blend ), v );
        } } : Implicit.intersection( [s, lattice] );
        const bb = solid.boundingBox(), m = 2 * size;
        return Implicit.mesh( field, Vec.sub( bb.min, [m, m, m] ), Vec.add( bb.max, [m, m, m] ), size );
    }

    // ---------- meshing ----------

    // the six tets of a cube, as corner indices (bit 0: +x, bit 1: +y, bit 2: +z), all around the diagonal 0-7
    private static TETS : Array<[number, number, number, number]> = [
        [0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]
    ];

    /**
     * The closed, oriented (outward) triangle mesh of the field's zero set within the box [min, max], on a grid of
     * cubes of side about `size`. The box should hold the solid with a margin: the grid's outer layer is taken as
     * outside, so the mesh is closed even where the solid reaches the box.
     */
    public static mesh( field : Field, min : Point, max : Point, size : number ) : TriMesh {
        const n = [0, 1, 2].map( c => Math.max( 1, Math.ceil( (max[c] - min[c]) / size ) ) );
        const h = [0, 1, 2].map( c => (max[c] - min[c]) / n[c] );
        const nx = n[0] + 1, ny = n[1] + 1, nz = n[2] + 1;
        const at = (i : number, j : number, k : number) : Point => [min[0] + i * h[0], min[1] + j * h[1], min[2] + k * h[2]];
        const f = new Float64Array( nx * ny * nz );
        const sample = (i : number, j : number, k : number) => {
            const id = i + nx * (j + ny * k);
            const border = i == 0 || j == 0 || k == 0 || i == nx - 1 || j == ny - 1 || k == nz - 1;
            const v = border ? Math.max( field.value( at( i, j, k ) ), Math.min( h[0], h[1], h[2] ) ) : field.value( at( i, j, k ) );
            // strictly signed: a zero (or NaN) counts as outside
            f[id] = v < 0 ? v : Math.max( v, 1e-300 ) || 1e-300;
        };
        for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sample( i, j, k );
        const pos = (id : number) : Point => { const i = id % nx, j = Math.floor( id / nx ) % ny, k = Math.floor( id / (nx * ny) ); return at( i, j, k ); };
        const mesh = new TriMesh();
        const verts = new Map<number, number>();
        const N = nx * ny * nz;
        // the vertex on the tet edge from an inside sample a to an outside sample b: the field's root there
        const vertex = (a : number, b : number) : number => {
            const key = a < b ? a * N + b : b * N + a;
            const got = verts.get( key );
            if (got != null) return got;
            const pa = pos( a ), pb = pos( b );
            let ta = 0, tb = 1, fa = f[a], fb = f[b], side = 0;
            let t = fa / (fa - fb);
            for (let it = 0; it < 12; it++) {
                t = (ta * fb - tb * fa) / (fb - fa);
                const ft = field.value( Vec.add( pa, Vec.mul( t, Vec.sub( pb, pa ) ) ) );
                if (!(Math.abs( ft ) > 1e-5 * size)) break;
                if (ft < 0) { ta = t; fa = ft; if (side == -1) fb *= 0.5; side = -1; }
                else { tb = t; fb = ft; if (side == 1) fa *= 0.5; side = 1; }
            }
            // kept off the samples, so no triangle collapses
            t = Math.min( 1 - 1e-6, Math.max( 1e-6, t ) );
            const v = mesh.addVertex( Vec.add( pa, Vec.mul( t, Vec.sub( pb, pa ) ) ) );
            verts.set( key, v );
            return v;
        };
        const tri = (a : number, b : number, c : number, inn : Point, out : Point) => {
            const A = mesh.vertices[a], B = mesh.vertices[b], C = mesh.vertices[c];
            const nrm = Vec.cross( Vec.sub( B, A ), Vec.sub( C, A ) );
            if (Vec.dot( nrm, Vec.sub( out, inn ) ) >= 0) mesh.addTriangle( a, b, c ); else mesh.addTriangle( a, c, b );
        };
        const corner = new Int32Array( 8 );
        for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
            for (let c = 0; c < 8; c++) corner[c] = (i + (c & 1)) + nx * ((j + ((c >> 1) & 1)) + ny * (k + ((c >> 2) & 1)));
            let any = 0, all = 1;
            for (let c = 0; c < 8; c++) { if (f[corner[c]] < 0) any = 1; else all = 0; }
            if (!any || all) continue;
            for (const tet of Implicit.TETS) {
                const ids = tet.map( c => corner[c] );
                const ins = ids.filter( id => f[id] < 0 ), outs = ids.filter( id => f[id] >= 0 );
                if (ins.length == 0 || outs.length == 0) continue;
                const ci = Implicit.centroid( ins.map( pos ) ), co = Implicit.centroid( outs.map( pos ) );
                if (ins.length == 1) tri( vertex( ins[0], outs[0] ), vertex( ins[0], outs[1] ), vertex( ins[0], outs[2] ), ci, co );
                else if (ins.length == 3) tri( vertex( ins[0], outs[0] ), vertex( ins[1], outs[0] ), vertex( ins[2], outs[0] ), ci, co );
                else {
                    const p = vertex( ins[0], outs[0] ), q = vertex( ins[0], outs[1] ), r = vertex( ins[1], outs[1] ), s = vertex( ins[1], outs[0] );
                    tri( p, q, r, ci, co );
                    tri( p, r, s, ci, co );
                }
            }
        }
        return mesh;
    }

    private static centroid( ps : Array<Point> ) : Point {
        return Vec.mul( 1 / ps.length, ps.reduce( (a, p) => Vec.add( a, p ), [0, 0, 0] as Point ) );
    }
}
