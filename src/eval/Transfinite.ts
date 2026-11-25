import cdt2d from "cdt2d";
import { NurbsSurfaceData, Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Fit } from "./Fit.js";

// One side of an n-sided patch: its boundary curve as samples in order around the patch, and at each sample the
// derivative across the boundary into the patch, per unit of distance in the patch's domain (a regular polygon of
// side 1). Together they are the side's ribbon: R(s, d) = C(s) + d T(s), the surface the patch must touch along the
// side (G1 continuity with whatever lies on the other side of the boundary).
export interface Ribbon {
    points : Array<Point>;
    cross : Array<Point>;
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
export class Transfinite {

    // The domain: a regular n-gon of side 1, its vertex i at the start of side i, counter-clockwise.
    public static polygon( n : number ) : Array<[number, number]> {
        let R = 0.5 / Math.sin( Math.PI / n );
        return Array.from( { length : n }, (_, i) => {
            let a = Math.PI / 2 + Math.PI / n + 2 * Math.PI * i / n;
            return [R * Math.cos( a ), R * Math.sin( a )] as [number, number];
        } );
    }

    // The patch at a point of the polygon.
    public static evaluate( ribbons : Array<Ribbon>, x : [number, number], poly? : Array<[number, number]> ) : Point {
        let n = ribbons.length;
        let P = poly != null ? poly : Transfinite.polygon( n );
        let d = Transfinite.distances( P, x );
        let nearest = 0;
        for (let i = 1; i < n; i++) if (d[i] < d[nearest]) nearest = i;
        // on a side: its boundary
        if (d[nearest] < 1e-13) {
            let a = d[(nearest + n - 1) % n], b = d[(nearest + 1) % n];
            return Transfinite.at( ribbons[nearest].points, a + b > 0 ? a / (a + b) : 0 );
        }
        let out : Point = [0, 0, 0], total = 0.0;
        for (let i = 0; i < n; i++) {
            let w = 1.0;
            for (let j = 0; j < n; j++) if (j != i) w *= d[j] * d[j];
            if (w == 0) continue;
            let a = d[(i + n - 1) % n], b = d[(i + 1) % n];
            let s = a + b > 0 ? a / (a + b) : 0;
            let r = Vec.add( Transfinite.at( ribbons[i].points, s ), Vec.mul( d[i], Transfinite.at( ribbons[i].cross, s, ribbons[i].points ) ) );
            out = Vec.add( out, Vec.mul( w, r ) );
            total += w;
        }
        return Vec.mul( 1 / total, out );
    }

    // A triangle mesh of the patch: the boundary samples in order (sides' last samples are the next sides' first, given
    // once), then points inside on a triangular lattice of spacing about 1 / density in the polygon.
    public static mesh( ribbons : Array<Ribbon>, density? : number )
        : { points : Array<Point>, triangles : Array<[number, number, number]>, boundary : number, domain : Array<[number, number]> } {
        let n = ribbons.length;
        let P = Transfinite.polygon( n );
        let points : Array<Point> = [], xy : Array<[number, number]> = [];
        ribbons.forEach( (rb, i) => {
            let a = P[i], b = P[(i + 1) % n];
            let u = Transfinite.chord( rb.points );
            for (let k = 0; k + 1 < rb.points.length; k++) {
                points.push( rb.points[k] );
                xy.push( [a[0] + u[k] * (b[0] - a[0]), a[1] + u[k] * (b[1] - a[1])] );
            }
        } );
        let nb = points.length;
        let edges : Array<[number, number]> = points.map( (_, k) => [k, (k + 1) % nb] as [number, number] );
        let q = density != null ? density : Math.max( 2, Math.round( nb / n ) );
        let h = 1 / q, R = 0.5 / Math.sin( Math.PI / n );
        for (let j = -Math.ceil( R / h / 0.866 ) - 1; j <= Math.ceil( R / h / 0.866 ) + 1; j++) {
            for (let i = -Math.ceil( R / h ) - 2; i <= Math.ceil( R / h ) + 2; i++) {
                let x : [number, number] = [(i + 0.5 * (j & 1)) * h, j * h * 0.8660254037844386];
                let d = Transfinite.distances( P, x );
                if (Math.min( ...d ) < 0.45 * h) continue;
                points.push( Transfinite.evaluate( ribbons, x, P ) ); xy.push( x );
            }
        }
        let tris = cdt2d( xy, edges, { exterior : false } ) as Array<[number, number, number]>;
        return { points : points, triangles : tris, boundary : nb, domain : xy };
    }

    // The patch as n B-spline surfaces, the usual way to carry an n-sided patch in a four-sided world: the polygon is
    // split into n quadrilaterals, each from a vertex to the midpoints of its two sides and the centre, and each is the
    // image of the unit square by a bilinear map (smooth, unlike a radial map of one square onto the whole polygon,
    // whose kinks along the diagonals the fit would have to follow). Surface i has (0, 0) at vertex i, u along side i
    // to its midpoint, v along side i - 1 back to its midpoint; neighbours share their sides from a midpoint to the
    // centre, where both fit the same smooth patch, to within the tolerance.
    public static surfaces( ribbons : Array<Ribbon>, tolerance : number ) : Array<NurbsSurfaceData> {
        let n = ribbons.length;
        let P = Transfinite.polygon( n );
        let mid = P.map( (a, i) => { let b = P[(i + 1) % n]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number]; } );
        let knots = [0, 0, 0, 0, 0.5, 1, 1, 1, 1];
        return P.map( (v, i) => {
            let m1 = mid[i], m0 = mid[(i + n - 1) % n];
            let f = (u : number, w : number) : Point => {
                let x : [number, number] = [0, 1].map( k => (1 - u) * (1 - w) * v[k] + u * (1 - w) * m1[k] + u * w * 0 + (1 - u) * w * m0[k] ) as [number, number];
                return Transfinite.evaluate( ribbons, x, P );
            };
            return Fit.approximateSurface( f, 3, 3, knots, knots, tolerance, 6 ).surface;
        } );
    }

    // Which of the `surfaces` a point of the polygon lies on: the nearest vertex's.
    public static quadOf( n : number, x : [number, number] ) : number {
        let P = Transfinite.polygon( n );
        let best = 0;
        for (let i = 1; i < n; i++) if (Math.hypot( P[i][0] - x[0], P[i][1] - x[1] ) < Math.hypot( P[best][0] - x[0], P[best][1] - x[1] )) best = i;
        return best;
    }

    // Distances from x to each side's line, positive inside.
    public static distances( P : Array<[number, number]>, x : [number, number] ) : Array<number> {
        let n = P.length;
        return P.map( (a, i) => {
            let b = P[(i + 1) % n];
            let nx = a[1] - b[1], ny = b[0] - a[0], nl = Math.sqrt( nx * nx + ny * ny );
            return Math.max( 0, ((x[0] - a[0]) * nx + (x[1] - a[1]) * ny) / nl );
        } );
    }

    // Normalised chord-length parameters of a polyline.
    private static cache = new WeakMap<Array<Point>, Array<number>>();
    private static chord( p : Array<Point> ) : Array<number> {
        let known = Transfinite.cache.get( p );
        if (known != null) return known;
        let u = [0];
        for (let k = 1; k < p.length; k++) u.push( u[k - 1] + Vec.dist( p[k], p[k - 1] ) );
        let L = u[u.length - 1];
        let out = u.map( x => L > 0 ? x / L : 0 );
        Transfinite.cache.set( p, out );
        return out;
    }

    // Samples at a fraction of their polyline's length (of `by`'s length, when given: cross derivatives are
    // parametrised by their boundary).
    private static at( p : Array<Point>, s : number, by? : Array<Point> ) : Point {
        let u = Transfinite.chord( by != null ? by : p );
        let k = 0;
        while (k + 2 < u.length && u[k + 1] < s) k++;
        let du = u[k + 1] - u[k];
        let f = du > 1e-15 ? Math.max( 0, Math.min( 1, (s - u[k]) / du ) ) : 0;
        return Vec.add( Vec.mul( 1 - f, p[k] ), Vec.mul( f, p[k + 1] ) );
    }
}
