import cdt2d from "cdt2d";
import { NurbsSurfaceData, Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Fit } from "./Fit.js";

// One side of an n-sided patch: its boundary curve as samples in order around the patch, and at each sample the
// derivative across the boundary into the patch, per unit of distance in the patch's domain (a regular polygon of
// side 1). Together they are the side's ribbon: R(s, d) = C(s) + d T(s), the surface the patch must touch along the
// side (G1 continuity with whatever lies on the other side of the boundary). With `second`, the second derivative
// across the boundary (per unit of distance squared) as well, the ribbon is R(s, d) = C(s) + d T(s) + d^2/2 K(s), and
// the patch matches the normal curvature across the side too (G2).
export interface Ribbon {
    points : Array<Point>;
    cross : Array<Point>;
    second? : Array<Point>;
}

// Transfinite n-sided patches: Kato's side-based interpolant over a regular polygon (S. Kato, "Generation of n-sided
// surface patches with holes", CAD 1991; in the form of P. Salvi, T. Várady, A. Rockwood, "Ribbon-based transfinite
// surfaces", CAGD 2014). Each side i has local coordinates in the polygon: d_i, the distance to the side, and s_i, the
// position along it, d_{i-1} / (d_{i-1} + d_{i+1}). The surface is the ribbons' blend
//
//     S(p) = sum_i R_i(s_i, d_i) B_i(p),   B_i = prod_{j != i} d_j^2 / sum_k prod_{j != k} d_j^2,
//
// which takes each side's boundary and its cross derivative exactly: B_i is 1 on side i, and all blends' first
// derivatives across a side vanish there. Corners need compatible ribbons (each side's end tangent the next side's
// cross derivative there) for the patch to be G1 at them as well.
//
// G2. When every ribbon has a second cross derivative K, the blends use cubes (prod_{j != i} d_j^3 ...), whose first
// and second derivatives across a side vanish there, and each ribbon carries a second-order term. That term is not
// simply K: s_i is not constant across side i (ds_i/dn = a(s) = (1 - 2s) cot(2 pi / n) on a regular n-gon), so
// following the patch straight across the side also moves along the ribbon, and the second derivative picks up
// a^2 C'' + 2 a T' + (ds_i/dn)' C'. The last is tangent to the boundary and leaves the curvature alone; the first two
// are subtracted, so that the second derivative across the side is K up to a tangential term:
//
//     R_i(s, d) = C(s) + d T(s) + d^2/2 (K(s) - a(s)^2 C''(s) - 2 a(s) T'(s)).
//
// (Salvi, Várady and Rockwood, above, discuss this parametrisation term for G^k ribbons.) For n = 4, a = 0 and the
// correction vanishes.
export class Transfinite {

    // The domain: a regular n-gon of side 1, its vertex i at the start of side i, counter-clockwise.
    public static polygon( n : number ) : Array<[number, number]> {
        const R = 0.5 / Math.sin( Math.PI / n );
        return Array.from( { length : n }, (_, i) => {
            const a = Math.PI / 2 + Math.PI / n + 2 * Math.PI * i / n;
            return [R * Math.cos( a ), R * Math.sin( a )] as [number, number];
        } );
    }

    // The patch at a point of the polygon.
    public static evaluate( ribbons : Array<Ribbon>, x : [number, number], poly? : Array<[number, number]> ) : Point {
        const n = ribbons.length;
        const P = poly != null ? poly : Transfinite.polygon( n );
        const d = Transfinite.distances( P, x );
        let nearest = 0;
        for (let i = 1; i < n; i++) if (d[i] < d[nearest]) nearest = i;
        // on a side: its boundary
        if (d[nearest] < 1e-13) {
            const a = d[(nearest + n - 1) % n], b = d[(nearest + 1) % n];
            return Transfinite.at( ribbons[nearest].points, a + b > 0 ? a / (a + b) : 0 );
        }
        const g2 = ribbons.every( r => r.second != null );
        const cot = 1 / Math.tan( 2 * Math.PI / n );
        let out : Point = [0, 0, 0], total = 0.0;
        for (let i = 0; i < n; i++) {
            let w = 1.0;
            for (let j = 0; j < n; j++) if (j != i) w *= g2 ? d[j] * d[j] * d[j] : d[j] * d[j];
            if (w == 0) continue;
            const a = d[(i + n - 1) % n], b = d[(i + 1) % n];
            const s = a + b > 0 ? a / (a + b) : 0;
            const rb = ribbons[i];
            let r = Vec.add( Transfinite.at( rb.points, s ), Vec.mul( d[i], Transfinite.at( rb.cross, s, rb.points ) ) );
            if (g2) {
                const dr = Transfinite.derivatives( rb );
                const as = (1 - 2 * s) * cot;
                const K = Vec.sub( Transfinite.at( rb.second as Array<Point>, s, rb.points ),
                    Vec.add( Vec.mul( as * as, Transfinite.at( dr.C2, s, rb.points ) ), Vec.mul( 2 * as, Transfinite.at( dr.T1, s, rb.points ) ) ) );
                r = Vec.add( r, Vec.mul( 0.5 * d[i] * d[i], K ) );
            }
            out = Vec.add( out, Vec.mul( w, r ) );
            total += w;
        }
        return Vec.mul( 1 / total, out );
    }

    // A triangle mesh of the patch: the boundary samples in order (sides' last samples are the next sides' first, given
    // once), then points inside on a triangular lattice of spacing about 1 / density in the polygon.
    public static mesh( ribbons : Array<Ribbon>, density? : number )
        : { points : Array<Point>, triangles : Array<[number, number, number]>, boundary : number, domain : Array<[number, number]> } {
        const n = ribbons.length;
        const P = Transfinite.polygon( n );
        const points : Array<Point> = [], xy : Array<[number, number]> = [];
        ribbons.forEach( (rb, i) => {
            const a = P[i], b = P[(i + 1) % n];
            const u = Transfinite.chord( rb.points );
            for (let k = 0; k + 1 < rb.points.length; k++) {
                points.push( rb.points[k] );
                xy.push( [a[0] + u[k] * (b[0] - a[0]), a[1] + u[k] * (b[1] - a[1])] );
            }
        } );
        const nb = points.length;
        const edges : Array<[number, number]> = points.map( (_, k) => [k, (k + 1) % nb] as [number, number] );
        const q = density != null ? density : Math.max( 2, Math.round( nb / n ) );
        const h = 1 / q, R = 0.5 / Math.sin( Math.PI / n );
        for (let j = -Math.ceil( R / h / 0.866 ) - 1; j <= Math.ceil( R / h / 0.866 ) + 1; j++) {
            for (let i = -Math.ceil( R / h ) - 2; i <= Math.ceil( R / h ) + 2; i++) {
                const x : [number, number] = [(i + 0.5 * (j & 1)) * h, j * h * 0.8660254037844386];
                const d = Transfinite.distances( P, x );
                if (Math.min( ...d ) < 0.45 * h) continue;
                points.push( Transfinite.evaluate( ribbons, x, P ) ); xy.push( x );
            }
        }
        const tris = cdt2d( xy, edges, { exterior : false } ) as Array<[number, number, number]>;
        return { points : points, triangles : tris, boundary : nb, domain : xy };
    }

    // The patch as n B-spline surfaces, the usual way to carry an n-sided patch in a four-sided world: the polygon is
    // split into n quadrilaterals, each from a vertex to the midpoints of its two sides and the centre, and each is the
    // image of the unit square by a bilinear map (smooth, unlike a radial map of one square onto the whole polygon,
    // whose kinks along the diagonals the fit would have to follow). Surface i has (0, 0) at vertex i, u along side i
    // to its midpoint, v along side i - 1 back to its midpoint; neighbours share their sides from a midpoint to the
    // centre, where both fit the same smooth patch, to within the tolerance.
    public static surfaces( ribbons : Array<Ribbon>, tolerance : number ) : Array<NurbsSurfaceData> {
        const n = ribbons.length;
        const P = Transfinite.polygon( n );
        const mid = P.map( (a, i) => { const b = P[(i + 1) % n]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number]; } );
        const knots = [0, 0, 0, 0, 0.5, 1, 1, 1, 1];
        return P.map( (v, i) => {
            const m1 = mid[i], m0 = mid[(i + n - 1) % n];
            const f = (u : number, w : number) : Point => {
                const x : [number, number] = [0, 1].map( k => (1 - u) * (1 - w) * v[k] + u * (1 - w) * m1[k] + u * w * 0 + (1 - u) * w * m0[k] ) as [number, number];
                return Transfinite.evaluate( ribbons, x, P );
            };
            return Fit.approximateSurface( f, 3, 3, knots, knots, tolerance, 6 ).surface;
        } );
    }

    // Which of the `surfaces` a point of the polygon lies on: the nearest vertex's.
    public static quadOf( n : number, x : [number, number] ) : number {
        const P = Transfinite.polygon( n );
        let best = 0;
        for (let i = 1; i < n; i++) if (Math.hypot( P[i][0] - x[0], P[i][1] - x[1] ) < Math.hypot( P[best][0] - x[0], P[best][1] - x[1] )) best = i;
        return best;
    }

    // Distances from x to each side's line, positive inside.
    public static distances( P : Array<[number, number]>, x : [number, number] ) : Array<number> {
        const n = P.length;
        return P.map( (a, i) => {
            const b = P[(i + 1) % n];
            const nx = a[1] - b[1], ny = b[0] - a[0], nl = Math.sqrt( nx * nx + ny * ny );
            return Math.max( 0, ((x[0] - a[0]) * nx + (x[1] - a[1]) * ny) / nl );
        } );
    }

    // A ribbon's C'' and T' with respect to s, by central differences over its samples (one-sided at the ends).
    private static derived = new WeakMap<Ribbon, { C2 : Array<Point>, T1 : Array<Point> }>();
    private static derivatives( rb : Ribbon ) : { C2 : Array<Point>, T1 : Array<Point> } {
        const known = Transfinite.derived.get( rb );
        if (known != null) return known;
        const u = Transfinite.chord( rb.points );
        const out = { C2 : Transfinite.diff( Transfinite.diff( rb.points, u ), u ), T1 : Transfinite.diff( rb.cross, u ) };
        Transfinite.derived.set( rb, out );
        return out;
    }

    // Normalised chord-length parameters of a polyline.
    private static cache = new WeakMap<Array<Point>, Array<number>>();
    private static chord( p : Array<Point> ) : Array<number> {
        const known = Transfinite.cache.get( p );
        if (known != null) return known;
        const u = [0];
        for (let k = 1; k < p.length; k++) u.push( u[k - 1] + Vec.dist( p[k], p[k - 1] ) );
        const L = u[u.length - 1];
        const out = u.map( x => L > 0 ? x / L : 0 );
        Transfinite.cache.set( p, out );
        return out;
    }

    // Samples at a fraction of their polyline's length (of `by`'s length, when given: cross derivatives are
    // parametrised by their boundary), by cubic Hermite interpolation with central-difference tangents, so that the
    // ribbons are smooth (C1) in s: the G2 terms above differentiate them.
    private static at( p : Array<Point>, s : number, by? : Array<Point> ) : Point {
        const u = Transfinite.chord( by != null ? by : p );
        let k = 0;
        while (k + 2 < u.length && u[k + 1] < s) k++;
        const du = u[k + 1] - u[k];
        if (!(du > 1e-15)) return p[k];
        const t = Math.max( 0, Math.min( 1, (s - u[k]) / du ) ), t2 = t * t, t3 = t2 * t;
        const m = Transfinite.slopes( p, u );
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        return Vec.add( Vec.add( Vec.mul( h00, p[k] ), Vec.mul( h10 * du, m[k] ) ), Vec.add( Vec.mul( h01, p[k + 1] ), Vec.mul( h11 * du, m[k + 1] ) ) );
    }

    // Derivatives of samples with respect to their parameters u: central differences, one-sided at the ends.
    private static slopeCache = new WeakMap<Array<Point>, Array<Point>>();
    private static slopes( v : Array<Point>, u : Array<number> ) : Array<Point> {
        const known = Transfinite.slopeCache.get( v );
        if (known != null && known.length == v.length) return known;
        const out = Transfinite.diff( v, u );
        Transfinite.slopeCache.set( v, out );
        return out;
    }

    private static diff( v : Array<Point>, u : Array<number> ) : Array<Point> {
        return v.map( (_, k) => {
            const lo = Math.max( 0, k - 1 ), hi = Math.min( v.length - 1, k + 1 );
            const du = u[hi] - u[lo];
            return du > 1e-15 ? Vec.mul( 1 / du, Vec.sub( v[hi], v[lo] ) ) : [0, 0, 0] as Point;
        } );
    }
}
