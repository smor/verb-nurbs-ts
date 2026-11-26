import { NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Binomial } from "../core/Binomial.js";
import { Vec } from "../core/Vec.js";
import { Intersect } from "../eval/Intersect.js";
import { Eval } from "../eval/Eval.js";
import { Make } from "../eval/Make.js";
import { Modify } from "../eval/Modify.js";
import { IntersectionCurve, SurfaceDomain } from "./SurfaceIntersect.js";

/** The outcome of `IntersectionCertificate.check`. */
export interface IntersectionCertificateResult {
    /** every pair of cells resolved, and every crossing of their edges on a curve: no branch was missed */
    proven : boolean;
    /** leaf pairs of cells examined */
    pairs : number;
    /** pairs whose control-net boxes are apart: no intersection */
    apart : number;
    /** pairs whose normals cannot be parallel: no closed loop inside, every branch crosses their edges */
    noLoop : number;
    /** pairs at the depth limit whose normals may be parallel: a loop could hide there (tangency, a small loop) */
    unresolved : number;
    /** crossings of cell edges with the other surface that lie on no curve given: start points on missed branches */
    missed : Array<{ point : Point, uvA : UV, uvB : UV }>;
}

/** Options for `IntersectionCertificate.check`. */
export interface IntersectionCertificateOptions {
    /** cells per direction to start from (default 4) */
    cells? : number;
    /** how many times a pair may still be split (default 8) */
    depth? : number;
    /** how far from a curve a crossing may be and still lie on it (default 1e-6 x the surfaces' size) */
    tolerance? : number;
}

interface Patch { surface : NurbsSurfaceData, lo : UV, hi : UV, min : Point, max : Point, axis : Point, angle : number }

type Crossing = { point : Point, uvA : UV, uvB : UV };

/**
 * A certificate that an intersection of two surfaces is complete: that no branch, closed loops included, was missed.
 *
 * Marching finds the branches it has start points on; a branch smaller than the sampling, and above all a small closed
 * loop, can be missed. This proves, or fails to prove, that none was, after Sederberg and Meyers ("Loop detection in
 * surface patch intersections", CAGD 5(2), 1988) and Sinha's theorem (a closed loop of intersection encloses, on each
 * surface, a point where the two normals are parallel):
 *
 * 1. The two domains are split into cells, and pairs of cells are split further, the larger cell in four, while
 *    their control-net boxes meet and their normal cones admit parallel normals.
 * 2. Boxes and cones are rigorous, not sampled. Each cell is cut out of its surface and decomposed into Bézier patches.
 *    A patch lies in the box of its control points, weights being positive. Its normal is parallel to A_u x A_v, where
 *    A_u = w P_u - w_u P is a polynomial patch whose Bézier coefficients come from products of Bernstein polynomials.
 *    So the normal lies in the cone spanned by the cross products of the two nets' coefficients.
 * 3. In a pair whose normals cannot be parallel there is no closed loop and no tangency, so every branch inside it
 *    crosses one of the two cells' edges. The edges are intersected with the other cell's patch
 *    (`Intersect.curveAndSurface`). A crossing that lies on none of the given curves starts a missed branch.
 * 4. Pairs still unresolved at the depth limit are counted. Normals there may be parallel: the surfaces may be
 *    tangent, or a loop may hide. The certificate is then not a proof, and says so.
 *
 * `proven` is true when every pair is apart or loop-free, and every crossing of their edges lies on a curve.
 */
export class IntersectionCertificate {

    public static check( A : SurfaceDomain, B : SurfaceDomain, curves : Array<IntersectionCurve>, options? : IntersectionCertificateOptions ) : IntersectionCertificateResult {
        const n = options?.cells ?? 4, depth = options?.depth ?? 8;
        const pa = IntersectionCertificate.grid( A.surface, n ), pb = IntersectionCertificate.grid( B.surface, n );
        const size = Math.max( IntersectionCertificate.diagonal( pa ), IntersectionCertificate.diagonal( pb ), 1e-12 );
        const tol = options?.tolerance ?? 1e-6 * size;
        const out : IntersectionCertificateResult = { proven : true, pairs : 0, apart : 0, noLoop : 0, unresolved : 0, missed : [] };
        // the crossings of each isocurve of one surface with the whole other surface, found once
        const cache = new Map<string, Array<{ t : number, uv : UV, point : Point }>>();
        const along = (S : NurbsSurfaceData, O : NurbsSurfaceData, tag : string, value : number, useV : boolean) => {
            const key = tag + (useV ? "v" : "u") + value;
            let got = cache.get( key );
            if (got == null) {
                const iso = Make.surfaceIsocurve( S, value, useV );
                // keep only true crossings, at the curve's own point: the search can stop short of one, or report
                // a point beside the curve when the curve lies in the other surface
                got = Intersect.curveAndSurface( iso, O, 1e-9 * size ).map( x => ({ t : x.u, uv : x.uv as UV, point : Eval.rationalCurvePoint( iso, x.u ) }) )
                    .filter( x => Vec.dist( x.point, Eval.rationalSurfacePoint( O, x.uv[0], x.uv[1] ) ) <= 1e-7 * size );
                cache.set( key, got );
            }
            return got;
        };
        // the crossings of a cell's edges with the other cell
        const crossings = (a : Patch, b : Patch, aIsA : boolean) : Array<Crossing> => {
            const res : Array<Crossing> = [];
            const S = aIsA ? A.surface : B.surface, O = aIsA ? B.surface : A.surface;
            const inside = (uv : UV, c : Patch) => [0, 1].every( k => uv[k] >= c.lo[k] - 1e-12 && uv[k] <= c.hi[k] + 1e-12 );
            for (const [k, value] of [[0, a.lo[0]], [0, a.hi[0]], [1, a.lo[1]], [1, a.hi[1]]] as Array<[number, number]>) {
                const useV = k == 1, other = 1 - k;
                for (const x of along( S, O, aIsA ? "A" : "B", value, useV )) {
                    if (x.t < a.lo[other] - 1e-12 || x.t > a.hi[other] + 1e-12 || !inside( x.uv, b )) continue;
                    const uv : UV = useV ? [x.t, value] : [value, x.t];
                    res.push( aIsA ? { point : x.point, uvA : uv, uvB : x.uv } : { point : x.point, uvA : x.uv, uvB : uv } );
                }
            }
            return res;
        };
        const visit = (a : Patch, b : Patch, d : number) => {
            if (!IntersectionCertificate.boxesMeet( a, b )) { out.pairs++; out.apart++; return; }
            if (!IntersectionCertificate.parallelPossible( a, b )) {
                out.pairs++; out.noLoop++;
                for (const m of crossings( a, b, true ).concat( crossings( b, a, false ) )) {
                    if (curves.some( c => IntersectionCertificate.onCurve( c, m.point, tol ) )) continue;
                    if (out.missed.some( x => Vec.dist( x.point, m.point ) < 10 * tol )) continue;
                    out.missed.push( m );
                }
                return;
            }
            if (d == 0) { out.pairs++; out.unresolved++; return; }
            // split the cell whose normals turn most (they keep the cones from parting), unless it is already much
            // smaller than the other (a cell round a pole keeps a wide cone however small: then the boxes must part)
            const ea = Vec.dist( a.min, a.max ), eb = Vec.dist( b.min, b.max );
            const first = 2 * ea < eb ? false : 2 * eb < ea ? true : a.angle > b.angle + 1e-9 || (Math.abs( a.angle - b.angle ) <= 1e-9 && ea >= eb);
            if (first) for (const s of IntersectionCertificate.split( a )) visit( s, b, d - 1 );
            else for (const s of IntersectionCertificate.split( b )) visit( a, s, d - 1 );
        };
        for (const a of pa) for (const b of pb) visit( a, b, depth );
        out.proven = out.unresolved == 0 && out.missed.length == 0;
        return out;
    }

    // ---------- cells ----------

    private static grid( s : NurbsSurfaceData, n : number ) : Array<Patch> {
        const d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
        const out : Array<Patch> = [];
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
            out.push( IntersectionCertificate.patch( s, [d[0] + (d[1] - d[0]) * i / n, d[2] + (d[3] - d[2]) * j / n],
                                                       [d[0] + (d[1] - d[0]) * (i + 1) / n, d[2] + (d[3] - d[2]) * (j + 1) / n] ) );
        return out;
    }

    private static split( p : Patch ) : Array<Patch> {
        const mu = 0.5 * (p.lo[0] + p.hi[0]), mv = 0.5 * (p.lo[1] + p.hi[1]);
        const s = p.surface;
        return [[p.lo, [mu, mv]], [[mu, p.lo[1]], [p.hi[0], mv]], [[p.lo[0], mv], [mu, p.hi[1]]], [[mu, mv], p.hi]]
            .map( ([lo, hi]) => IntersectionCertificate.patch( s, lo as UV, hi as UV ) );
    }

    // The part of s over [lo, hi], with its rigorous box and normal cone, from its Bézier patches.
    private static patch( s : NurbsSurfaceData, lo : UV, hi : UV ) : Patch {
        const nets = IntersectionCertificate.beziers( s, lo, hi );
        const min : Point = [Infinity, Infinity, Infinity], max : Point = [-Infinity, -Infinity, -Infinity];
        for (const net of nets) for (const row of net) for (const h of row) for (let k = 0; k < 3; k++) {
            const x = h[k] / h[3];
            min[k] = Math.min( min[k], x ); max[k] = Math.max( max[k], x );
        }
        return { surface : s, lo : lo, hi : hi, min : min, max : max, ...IntersectionCertificate.union( nets.map( IntersectionCertificate.cone ) ) };
    }

    // The Bézier patches of s over [lo, hi]: every knot inside the domain, lo and hi among them, raised to the
    // degree's multiplicity; the patch over a knot span [u_i, u_i+1) then has the control points i - p .. i.
    private static beziers( s : NurbsSurfaceData, lo : UV, hi : UV ) : Array<Array<Array<Array<number>>>> {
        let r = s;
        for (const [k, useV] of [[0, false], [1, true]] as Array<[number, boolean]>) {
            const knots = useV ? r.knotsV : r.knotsU, p = useV ? r.degreeV : r.degreeU;
            const a = knots[0], b = knots[knots.length - 1], eps = 1e-13 * (b - a);
            const count = new Map<number, number>();
            for (const x of knots) if (x > a + eps && x < b - eps) count.set( x, (count.get( x ) ?? 0) + 1 );
            for (const x of [lo[k], hi[k]]) if (x > a + eps && x < b - eps && ![...count.keys()].some( y => Math.abs( y - x ) <= eps )) count.set( x, 0 );
            const add : Array<number> = [];
            for (const [x, m] of count) for (let i = m; i < p; i++) add.push( x );
            if (add.length > 0) r = Modify.surfaceKnotRefine( r, add.sort( (x, y) => x - y ), useV );
        }
        const spans = (knots : Array<number>, p : number, a : number, b : number) => {
            const out : Array<number> = [], eps = 1e-12 * (knots[knots.length - 1] - knots[0]);
            for (let i = p; i < knots.length - p - 1; i++)
                if (knots[i + 1] > knots[i] && knots[i] >= a - eps && knots[i + 1] <= b + eps) out.push( i );
            return out;
        };
        const p = r.degreeU, q = r.degreeV;
        const out : Array<Array<Array<Array<number>>>> = [];
        for (const i of spans( r.knotsU, p, lo[0], hi[0] )) for (const j of spans( r.knotsV, q, lo[1], hi[1] ))
            out.push( r.controlPoints.slice( i - p, i + 1 ).map( row => row.slice( j - q, j + 1 ) ) );
        return out;
    }

    // The cone of normals of a rational Bézier patch (homogeneous control points [wx, wy, wz, w]): the normal is
    // parallel to (w P_u - w_u P) x (w P_v - w_v P), where P is the homogeneous point, both factors polynomial patches;
    // their Bézier coefficients are found by multiplying Bernstein forms, and the normal lies in the cone spanned by
    // the cross products of the two sets of coefficients. Half-angle pi where that cone is not within a hemisphere.
    private static cone( H : Array<Array<Array<number>>> ) : { axis : Point, angle : number } {
        const au = IntersectionCertificate.hodograph( H, false ), av = IntersectionCertificate.hodograph( H, true );
        const gens : Array<Point> = [];
        for (const a of au) for (const b of av) {
            const c = Vec.cross( a, b ), l = Vec.norm( c );
            if (l > 0) gens.push( Vec.mul( 1 / l, c ) );
        }
        return IntersectionCertificate.bound( gens );
    }

    // Coefficients (as a flat list) of w P_u - w_u P (or the v version) in the Bernstein basis of degree (2p - 1, 2q).
    private static hodograph( H : Array<Array<Array<number>>>, inV : boolean ) : Array<Point> {
        // work along u; for v, transpose
        const G = inV ? H[0].map( (_, j) => H.map( row => row[j] ) ) : H;
        const p = G.length - 1, q = G[0].length - 1;
        if (p == 0) return [];
        const P = (i : number, j : number) : Point => [G[i][j][0], G[i][j][1], G[i][j][2]], w = (i : number, j : number) => G[i][j][3];
        // the derivative's coefficients, degree (p - 1, q)
        const dP = (i : number, j : number) => Vec.mul( p, Vec.sub( P( i + 1, j ), P( i, j ) ) );
        const dw = (i : number, j : number) => p * (w( i + 1, j ) - w( i, j ));
        const out : Array<Point> = [];
        const C = (n : number, k : number) => Binomial.get( n, k );
        for (let k = 0; k <= 2 * p - 1; k++) for (let l = 0; l <= 2 * q; l++) {
            let acc : Point = [0, 0, 0];
            for (let i = Math.max( 0, k - (p - 1) ); i <= Math.min( p, k ); i++) {
                const i2 = k - i;
                const cu = C( p, i ) * C( p - 1, i2 ) / C( 2 * p - 1, k );
                for (let j = Math.max( 0, l - q ); j <= Math.min( q, l ); j++) {
                    const j2 = l - j;
                    const c = cu * C( q, j ) * C( q, j2 ) / C( 2 * q, l );
                    acc = Vec.add( acc, Vec.mul( c, Vec.sub( Vec.mul( w( i, j ), dP( i2, j2 ) ), Vec.mul( dw( i2, j2 ), P( i, j ) ) ) ) );
                }
            }
            out.push( acc );
        }
        return out;
    }

    // A cone around unit vectors: half-angle pi unless they all lie well within a hemisphere around their mean.
    private static bound( gens : Array<Point> ) : { axis : Point, angle : number } {
        if (gens.length == 0) return { axis : [0, 0, 1], angle : Math.PI };
        let axis = gens.reduce( (a, g) => Vec.add( a, g ), [0, 0, 0] as Point );
        const l = Vec.norm( axis );
        if (l < 1e-12) return { axis : [0, 0, 1], angle : Math.PI };
        axis = Vec.mul( 1 / l, axis );
        let angle = 0;
        for (const g of gens) angle = Math.max( angle, Math.acos( Math.max( -1, Math.min( 1, Vec.dot( axis, g ) ) ) ) );
        // the positive combinations stay within the cone while it is narrower than a hemisphere
        return angle < 0.5 * Math.PI - 1e-9 ? { axis : axis, angle : angle + 1e-9 } : { axis : axis, angle : Math.PI };
    }

    private static union( cones : Array<{ axis : Point, angle : number }> ) : { axis : Point, angle : number } {
        if (cones.some( c => c.angle >= Math.PI )) return { axis : [0, 0, 1], angle : Math.PI };
        let axis = cones.reduce( (a, c) => Vec.add( a, c.axis ), [0, 0, 0] as Point );
        const l = Vec.norm( axis );
        if (l < 1e-12) return { axis : [0, 0, 1], angle : Math.PI };
        axis = Vec.mul( 1 / l, axis );
        let angle = 0;
        for (const c of cones) angle = Math.max( angle, Math.acos( Math.max( -1, Math.min( 1, Vec.dot( axis, c.axis ) ) ) ) + c.angle );
        return angle < 0.5 * Math.PI ? { axis : axis, angle : angle } : { axis : axis, angle : Math.PI };
    }

    private static boxesMeet( a : Patch, b : Patch ) : boolean {
        for (let k = 0; k < 3; k++) if (a.max[k] < b.min[k] || b.max[k] < a.min[k]) return false;
        return true;
    }

    // Whether a normal of a can be parallel (or opposite) to a normal of b.
    private static parallelPossible( a : Patch, b : Patch ) : boolean {
        if (a.angle >= Math.PI || b.angle >= Math.PI) return true;
        const c = Math.acos( Math.max( -1, Math.min( 1, Vec.dot( a.axis, b.axis ) ) ) );
        return c <= a.angle + b.angle || Math.PI - c <= a.angle + b.angle;
    }

    private static onCurve( c : IntersectionCurve, p : Point, tol : number ) : boolean {
        const n = c.points.length, m = c.closed ? n : n - 1;
        for (let i = 0; i < m; i++) {
            const a = c.points[i], b = c.points[(i + 1) % n];
            const ab = Vec.sub( b, a ), l2 = Vec.dot( ab, ab );
            const t = l2 > 0 ? Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( p, a ), ab ) / l2 ) ) : 0;
            // a chord of the curve may lie off it by its sagitta: allow a fraction of the chord's length
            if (Vec.dist( p, Vec.add( a, Vec.mul( t, ab ) ) ) <= tol + 0.05 * Math.sqrt( l2 )) return true;
        }
        return false;
    }

    private static diagonal( ps : Array<Patch> ) : number {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const p of ps) for (let k = 0; k < 3; k++) { min[k] = Math.min( min[k], p.min[k] ); max[k] = Math.max( max[k], p.max[k] ); }
        return Vec.dist( min, max );
    }
}
