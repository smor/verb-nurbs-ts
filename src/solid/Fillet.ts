import { NurbsCurveData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { Make } from "../eval/Make.js";
import { BrepFace, BrepSolid, FaceCut } from "./Brep.js";
import { IntersectionCurve, SurfaceDomain, SurfaceIntersect } from "./SurfaceIntersect.js";

// How one face of an edge takes part in the result: the sign that turns dS/du x dS/dv into the result's outward
// normal, and the side of the edge (in the face) that is kept.
export interface FilletSide {
    face : BrepFace;
    // +1 or -1: the result's outward normal is sign * (dS/du x dS/dv) / |...|
    sign : number;
    // whether the part of this face kept next to the edge lies inside the other face's solid
    keptInsideOther : boolean;
}

// One section of a rolling-ball blend: the ball's centre and the points where it touches the two faces.
export interface FilletSection {
    centre : Point;
    a : UV;
    b : UV;
    pa : Point;
    pb : Point;
    seamA : number;
    seamB : number;
}

// A fillet's radius: constant, or a function of the position along the edge (0 at its start, 1 at its end, by length;
// on a closed edge, 0 and 1 are the same point, so give the same radius there).
export type FilletRadius = number | ((t : number) => number);

// The shape of a blend's cross-section between its two contact points: "circular", the rolling ball's arc (tangent to
// both faces, G1), or "curvature", a quintic that also matches each face's normal curvature where it meets it (G2), so
// the reflections flow across the joint with no jump in curvature; or "chamfer", the straight line between the contact
// points, a bevel (on a square edge, cut back by the radius on both faces; on others, where the ball would touch). All
// use the ball's contact curves.
export type FilletShape = "circular" | "curvature" | "chamfer";

export interface FilletResult {
    sections : Array<FilletSection>;
    // +1 when the ball rolls outside the material (a concave edge, which the fillet fills),
    // -1 when it rolls inside (a convex edge, which the fillet rounds off)
    side : number;
    // the contact curves, as cuts of the two faces (split at seams)
    cutA : Array<FaceCut>;
    cutB : Array<FaceCut>;
    // the blend surface (u: across the edge, from face A to face B; v: along the edge) and its triangles
    surface : NurbsSurfaceData;
    points : Array<Point>;
    triangles : Array<[number, number, number]>;
    // true when the blend's outward normal is -(dS/du x dS/dv)
    reversed : boolean;
    // false for a blend along an open edge, ended at corners
    closed : boolean;
}

// Rolling-ball fillets (constant-radius blends) along an intersection edge.
//
// The blend is the envelope of a ball of radius r that rolls in contact with both faces (Choi and Ju, "Constant-radius
// blending in surface modelling", CAD 21(4), 1989). Its centre runs along the intersection of the two faces offset by
// r, and each section is a circular arc from one contact point to the other. Each centre is found directly, by
// Newton's method on four unknowns (the contact parameters on both faces):
//
//     A(a) + s r nA(a) = B(b) + s r nB(b)          (both offsets reach the same centre)
//     (A(a) + s r nA(a) - p) . t = 0                (in the plane across the edge at p)
//
// where p and t are a point of the edge and its tangent, n the result's outward normals and s = +1 on a concave edge
// (the ball rolls in the air) or -1 on a convex one (it rolls in the material). Each section is an exact rational
// quadratic arc; the surface lofts them.
export class Fillet {

    // Sections of the blend along a closed intersection edge between faces A and B. Returns null where the ball cannot
    // be placed (radius too large for the faces, or a contact running off a face).
    public static rollingBall( A : FilletSide, B : FilletSide, edge : IntersectionCurve, radius : FilletRadius, tol : number = 1e-10, shape : FilletShape = "circular" ) : FilletResult | null {
        if (!edge.closed) return null;
        const found = Fillet.sections( A, B, edge, radius, tol );
        if (found == null) return null;
        const sections = found.sections, s = found.side;

        // the contact curves as face cuts
        const pa = sections.map( x => x.pa ), pb = sections.map( x => x.pb );
        const cutA = Fillet.pieces( A.face, sections.map( x => x.a ), sections.map( x => x.seamA ), pa );
        const cutB = Fillet.pieces( B.face, sections.map( x => x.b ), sections.map( x => x.seamB ), pb );

        // arcs, and the blend's triangles: contact points are shared with the cuts so the meshes weld
        const arcs = sections.map( x => Fillet.crossSection( A, B, x, shape ) );
        const m = Fillet.arcDivisions( sections, true );
        const points : Array<Point> = [];
        for (let k = 0; k < sections.length; k++) {
            points.push( sections[k].pa );
            for (let i = 1; i < m; i++) points.push( Eval.rationalCurvePoint( arcs[k], i / m ) );
            points.push( sections[k].pb );
        }
        const N = sections.length, W = m + 1;
        const triangles : Array<[number, number, number]> = [];
        for (let k = 0; k < N; k++) {
            const k1 = (k + 1) % N;
            for (let i = 0; i < m; i++) {
                const a = k * W + i, b = k * W + i + 1, c = k1 * W + i + 1, e = k1 * W + i;
                triangles.push( [a, b, c] ); triangles.push( [a, c, e] );
            }
        }
        const reversed = Fillet.orientTriangles( points, triangles, sections[0].centre, s );
        // the loop closed: the first arc again at the end, unless the sections already end where they began (a
        // repeated section would give the loft a step of zero length, and control points of NaN)
        const last = sections[N - 1], first = sections[0];
        const repeats = Vec.dist( last.pa, first.pa ) < 1e-9 && Vec.dist( last.pb, first.pb ) < 1e-9;
        const surface = Make.loftedSurface( repeats ? arcs : arcs.concat( [arcs[0]] ), 3 );
        return { sections : sections, side : s, cutA : cutA, cutB : cutB, surface : surface, points : points, triangles : triangles,
                 reversed : reversed, closed : true };
    }

    // Arc divisions for a blend: about as fine across as the sections are spaced along it.
    public static arcDivisions( sections : Array<FilletSection>, closed : boolean ) : number {
        const maxAngle = Math.max( ...sections.map( x => Vec.angleBetween( Vec.sub( x.pa, x.centre ), Vec.sub( x.pb, x.centre ) ) ) );
        const radius = Math.max( ...sections.map( x => Vec.dist( x.pa, x.centre ) ) );
        let step = closed ? Fillet.meanSpacing( sections.map( x => x.pa ) ) : 0.0;
        if (!closed) {
            for (let k = 1; k < sections.length; k++) step += Vec.dist( sections[k].pa, sections[k - 1].pa );
            step /= Math.max( 1, sections.length - 1 );
        }
        return Math.max( 4, Math.min( 32, Math.ceil( maxAngle * radius / Math.max( step, 1e-12 ) ) ) );
    }

    // Make the blend's triangles face out of the result: towards the ball's centre on a concave edge (the ball is in the
    // air), away from it on a convex one. Returns whether that is -(dS/du x dS/dv) for the triangles as given.
    public static orientTriangles( points : Array<Point>, triangles : Array<[number, number, number]>, centre : Point, side : number ) : boolean {
        const t0 = triangles[0];
        const nrm = Vec.cross( Vec.sub( points[t0[1]], points[t0[0]] ), Vec.sub( points[t0[2]], points[t0[0]] ) );
        const reversed = Vec.dot( nrm, Vec.sub( centre, points[t0[0]] ) ) * side < 0;
        if (reversed) for (const t of triangles) { const x = t[1]; t[1] = t[2]; t[2] = x; }
        return reversed;
    }

    // The sections of a blend along an edge, closed or open (an open edge keeps a section at each end). Returns null where
    // the ball cannot be placed, or where a contact curve folds.
    public static sections( A : FilletSide, B : FilletSide, edge : IntersectionCurve, radius : FilletRadius, tol : number = 1e-10 )
        : { sections : Array<FilletSection>, ts : Array<number>, side : number, before : Array<FilletSection>, after : Array<FilletSection> } | null {
        const closed = edge.closed;
        // an open edge ends on an edge of a face, where the ball's contact with the other face may lie a little past
        // that face's end: let it, on the surface carried on
        const slack = closed ? 0 : 0.15;
        const DA = BrepSolid.domainOf( A.face ), DB = BrepSolid.domainOf( B.face );
        const n = edge.points.length;
        const tangentAt = (k : number) : Point => closed ? Vec.normalized( Vec.sub( edge.points[(k + 1) % n], edge.points[(k - 1 + n) % n] ) )
            : Vec.normalized( Vec.sub( edge.points[Math.min( n - 1, k + 1 )], edge.points[Math.max( 0, k - 1 )] ) );
        // the edge at parameter t in [0, n) ([0, n - 1] when open): point, tangent and parameters on both faces
        const at = (t : number) => {
            let k = Math.floor( t ) % n, f = t - Math.floor( t ), k1 = (k + 1) % n;
            if (!closed && k >= n - 1) { k = n - 2; f = 1; k1 = n - 1; }
            const p = Vec.lerp( f, edge.points[k1], edge.points[k] );
            const tg = Vec.normalized( Vec.lerp( f, tangentAt( k1 ), tangentAt( k ) ) );
            return { p : p, t : tg,
                     a : SurfaceIntersect.lerpUV( DA, f, edge.uvA[k], edge.uvA[k1] ), b : SurfaceIntersect.lerpUV( DB, f, edge.uvB[k], edge.uvB[k1] ) };
        };

        // the radius at edge parameter t, from its position along the edge by length
        const lengths = [0];
        for (let k = 1; k <= (closed ? n : n - 1); k++) lengths.push( lengths[k - 1] + Vec.dist( edge.points[k % n], edge.points[k - 1] ) );
        const total = Math.max( lengths[lengths.length - 1], 1e-300 );
        const radiusAt = (t : number) : number => {
            if (typeof radius == "number") return radius;
            const k = Math.max( 0, Math.min( lengths.length - 2, Math.floor( t ) ) ), f = t - k;
            return radius( Math.max( 0, Math.min( 1, (lengths[k] + f * (lengths[k + 1] - lengths[k])) / total ) ) );
        };

        // concave or convex: does face A, moving away from the edge on its kept side, go below B's outward normal?
        const e0 = at( 0 );
        const s = Fillet.edgeSide( A, B, e0.a, e0.b, e0.t );
        if (s == 0) return null;

        const solve = (t : number, guess : { a : UV, b : UV } | null) : FilletSection | null => {
            const e = at( t );
            const starts : Array<{ a : UV, b : UV }> = [];
            const rr = radiusAt( t );
            starts.push( Fillet.initial( A, B, DA, DB, e.a, e.b, e.p, e.t, s * rr, slack ) );
            if (guess != null) starts.push( guess );
            for (const st of starts) {
                const r = Fillet.newton( A, B, DA, DB, st.a, st.b, e.p, e.t, s * rr, tol * Math.max( 1, rr ), slack );
                if (r != null) return r;
            }
            return null;
        };

        const ts : Array<number> = [];
        const sections : Array<FilletSection> = [];
        let prev : { a : UV, b : UV } | null = null;
        // one section per edge vertex, skipping vertices very close to the last one used (where the edge has a
        // near-duplicate vertex, the two sections' contacts could come out in the wrong order and fold the
        // contact curve back on itself)
        let spacing = 0.0;
        const segs = closed ? n : n - 1;
        for (let k = 0; k < segs; k++) spacing += Vec.dist( edge.points[k], edge.points[(k + 1) % n] );
        spacing /= segs;
        for (let k = 0; k < n; k++) {
            const last = !closed && k == n - 1;
            if (!last && sections.length > 0 && Vec.dist( edge.points[k], edge.points[ts[ts.length - 1]] ) < 0.3 * spacing) continue;
            if (closed && k == n - 1 && Vec.dist( edge.points[k], edge.points[ts[0]] ) < 0.3 * spacing) continue;
            // an open edge keeps its last vertex, in place of a section just before it
            if (last && sections.length > 1 && Vec.dist( edge.points[k], edge.points[ts[ts.length - 1]] ) < 0.3 * spacing) { ts.pop(); sections.pop(); }
            const sec = solve( k, prev );
            // at the ends of an open edge the ball can run off a face that ends there: stop just short of it
            if (sec == null && !closed && (k < 3 || k > n - 4)) continue;
            if (sec == null) return null;
            ts.push( k ); sections.push( sec ); prev = sec;
        }
        if (sections.length < 2) return null;
        // drop any section whose contacts step backwards along the edge
        for (let k = 1; k < sections.length; k++) {
            if (!closed && k == sections.length - 1 && sections.length <= 2) break;
            const tg = tangentAt( ts[k] );
            if (Vec.dot( Vec.sub( sections[k].pa, sections[k - 1].pa ), tg ) <= 0 || Vec.dot( Vec.sub( sections[k].pb, sections[k - 1].pb ), tg ) <= 0) {
                sections.splice( k, 1 ); ts.splice( k, 1 ); k--;
            }
        }

        // where a contact curve crosses a seam, put a section exactly on it
        const dA = SurfaceIntersect.domain( A.face.surface ), dB = SurfaceIntersect.domain( B.face.surface );
        const jump = (x : FilletSection, y : FilletSection) : [number, number] | null => {
            for (let side = 0; side < 2; side++) {
                const F = side == 0 ? A.face : B.face, d = side == 0 ? dA : dB;
                const p = side == 0 ? x.a : x.b, q = side == 0 ? y.a : y.b;
                for (let ax = 0; ax < 2; ax++) {
                    if (!F.periodic[ax]) continue;
                    // a section on the seam stands for both ends of the domain
                    if (((side == 0 ? x.seamA | y.seamA : x.seamB | y.seamB) & (1 << ax)) != 0) continue;
                    if (Math.abs( p[ax] - q[ax] ) > (d[2 * ax + 1] - d[2 * ax]) / 2) return [side, ax];
                }
            }
            return null;
        };
        let inserted = 0;
        for (let k = 0; k < (closed ? sections.length : sections.length - 1); k++) {
            const k1 = (k + 1) % sections.length;
            const j = jump( sections[k], sections[k1] );
            if (j == null) continue;
            if (++inserted > 16) return null; // each seam crossing needs one section, or two where seams meet
            const side = j[0], ax = j[1];
            const d = side == 0 ? dA : dB;
            let lo = ts[k], hi = k1 == 0 ? n : ts[k1];
            const ref = sections[k];
            let best = sections[k];
            const par = (x : FilletSection) => side == 0 ? x.a[ax] : x.b[ax];
            for (let it = 0; it < 50 && hi - lo > 1e-13; it++) {
                const mid = (lo + hi) / 2;
                const sec = solve( mid, ref );
                if (sec == null) return null;
                if (Math.abs( par( sec ) - par( ref ) ) < (d[2 * ax + 1] - d[2 * ax]) / 2) { lo = mid; best = sec; } else hi = mid;
            }
            // snap to the seam: the parameter becomes the start of the domain, flagged as standing for both ends
            const sec : FilletSection = { centre : best.centre, a : [best.a[0], best.a[1]], b : [best.b[0], best.b[1]],
                                        pa : best.pa, pb : best.pb, seamA : 0, seamB : 0 };
            if (side == 0) { sec.a[ax] = d[2 * ax]; sec.seamA = 1 << ax; sec.pa = Eval.rationalSurfacePoint( A.face.surface, sec.a[0], sec.a[1] ); }
            else { sec.b[ax] = d[2 * ax]; sec.seamB = 1 << ax; sec.pb = Eval.rationalSurfacePoint( B.face.surface, sec.b[0], sec.b[1] ); }
            // the other face's seam may cross at the same place (two surfaces of revolution about one axis, with their
            // seams at the same angle): if its contact jumps there too and the section sits on its seam, flag it as well
            const os = 1 - side, OF = os == 0 ? A.face : B.face, od = os == 0 ? dA : dB;
            for (let ax2 = 0; ax2 < 2; ax2++) {
                if (!OF.periodic[ax2]) continue;
                const period = od[2 * ax2 + 1] - od[2 * ax2];
                const p0 = os == 0 ? sections[k].a : sections[k].b, p1 = os == 0 ? sections[k1].a : sections[k1].b;
                const x = os == 0 ? sec.a : sec.b;
                if (Math.abs( p0[ax2] - p1[ax2] ) <= period / 2) continue;
                if (Math.abs( x[ax2] - od[2 * ax2] ) > 1e-7 * period && Math.abs( x[ax2] - od[2 * ax2 + 1] ) > 1e-7 * period) continue;
                x[ax2] = od[2 * ax2];
                if (os == 0) { sec.seamA |= 1 << ax2; sec.pa = Eval.rationalSurfacePoint( A.face.surface, sec.a[0], sec.a[1] ); }
                else { sec.seamB |= 1 << ax2; sec.pb = Eval.rationalSurfacePoint( B.face.surface, sec.b[0], sec.b[1] ); }
            }
            sections.splice( k + 1, 0, sec ); ts.splice( k + 1, 0, lo );
            // test the pair before the new section again (the other face may still jump between them), then the pair
            // after it
            k--;
        }

        // where the face narrows below the ball (the tip of a rib, say), the contact curve folds over itself or over the
        // edge: there is no blend of this radius, so leave the edge sharp
        for (let side = 0; side < 2; side++) {
            const F = side == 0 ? A.face : B.face, d = side == 0 ? dA : dB;
            const c = sections.map( x => side == 0 ? x.a : x.b ), e = side == 0 ? edge.uvA : edge.uvB;
            if (Fillet.crossing( c, c, F, d, closed ) || Fillet.crossing( c, e, F, d, closed )) return null;
        }
        // past the ends of an open edge, two more sections each, along the edge's end tangent: corners trim the blend a
        // little beyond its edge
        const extra = (end : number) : Array<FilletSection> => {
            const out : Array<FilletSection> = [];
            if (closed) return out;
            const k0 = end == 0 ? 0 : n - 1, k1 = end == 0 ? 1 : n - 2;
            const dir = Vec.normalized( Vec.sub( edge.points[k0], edge.points[k1] ) );
            let prev = sections[end == 0 ? 0 : sections.length - 1];
            for (let j = 1; j <= 2; j++) {
                const p = Vec.add( edge.points[k0], Vec.mul( j * spacing, dir ) );
                const rr = radiusAt( end == 0 ? 0 : n - 1 );
                const r = Fillet.newton( A, B, DA, DB, prev.a, prev.b, p, dir, s * rr, tol * Math.max( 1, rr ), 0.3 );
                if (r == null) break;
                out.push( r ); prev = r;
            }
            return out;
        };
        const bf = extra( 0 ).reverse(), af = extra( 1 );
        return { sections : sections, ts : ts, side : s, before : bf, after : af };
    }

    // +1 for a concave edge, -1 for a convex one, 0 if the faces are tangent there. a, b: parameters of an edge point
    // on both faces; t: the edge's tangent. A's kept part leaves the edge along wA, the direction in A's tangent plane
    // across the edge that goes into B's solid or out of it as `keptInsideOther` says; the edge is convex when wA runs
    // against B's result normal (A falls away behind B), as on the edge of a cube.
    public static edgeSide( A : FilletSide, B : FilletSide, a : UV, b : UV, t : Point ) : number {
        const nA = Fillet.normal( A, a ), nB = Fillet.normal( B, b );
        if (Vec.norm( Vec.cross( nA, nB ) ) < 1e-6) return 0;
        let wA = Vec.normalized( Vec.cross( nA, t ) );
        const db = Eval.rationalSurfaceDerivatives( B.face.surface, b[0], b[1], 1 );
        const outB = Vec.mul( B.face.reversed ? -1 : 1, Vec.cross( db[1][0], db[0][1] ) ); // B's own solid's outward normal
        if ((Vec.dot( wA, outB ) < 0) != A.keptInsideOther) wA = Vec.mul( -1, wA );
        return Vec.dot( wA, nB ) < 0 ? -1 : 1;
    }

    // The result's outward unit normal of a face side at (u, v).
    public static normal( F : FilletSide, uv : UV ) : Point {
        const d = Eval.rationalSurfaceDerivatives( F.face.surface, uv[0], uv[1], 1 );
        return Vec.mul( F.sign, Vec.normalized( Vec.cross( d[1][0], d[0][1] ) ) );
    }

    // Starting contact parameters: the centre that two tangent planes at p would give, and its feet on the planes.
    private static initial( A : FilletSide, B : FilletSide, DA : SurfaceDomain, DB : SurfaceDomain, a : UV, b : UV, p : Point, t : Point, sr : number, slack : number = 0 ) : { a : UV, b : UV } {
        const da = Eval.rationalSurfaceDerivatives( A.face.surface, a[0], a[1], 1 );
        const db = Eval.rationalSurfaceDerivatives( B.face.surface, b[0], b[1], 1 );
        const nA = Vec.mul( A.sign, Vec.normalized( Vec.cross( da[1][0], da[0][1] ) ) );
        const nB = Vec.mul( B.sign, Vec.normalized( Vec.cross( db[1][0], db[0][1] ) ) );
        let c : Point;
        try { c = Vec.add( p, Mat.solve( [nA, nB, t], [sr, sr, 0] ) ); } catch (e) { return { a : a, b : b }; }
        if (c.some( x => !isFinite( x ) )) return { a : a, b : b };
        const qa = Vec.sub( c, Vec.mul( sr, nA ) ), qb = Vec.sub( c, Vec.mul( sr, nB ) );
        const sa = Fillet.tangentStep( da[1][0], da[0][1], Vec.sub( qa, da[0][0] ) );
        const sb = Fillet.tangentStep( db[1][0], db[0][1], Vec.sub( qb, db[0][0] ) );
        return { a : Fillet.clampTo( DA, [a[0] + sa[0], a[1] + sa[1]], slack ), b : Fillet.clampTo( DB, [b[0] + sb[0], b[1] + sb[1]], slack ) };
    }

    private static newton( A : FilletSide, B : FilletSide, DA : SurfaceDomain, DB : SurfaceDomain, a : UV, b : UV, p : Point, t : Point, sr : number, tol : number, slack : number = 0 ) : FilletSection | null {
        const dA = SurfaceIntersect.domain( A.face.surface ), dB = SurfaceIntersect.domain( B.face.surface );
        const ha = [(dA[1] - dA[0]) * 1e-7, (dA[3] - dA[2]) * 1e-7], hb = [(dB[1] - dB[0]) * 1e-7, (dB[3] - dB[2]) * 1e-7];
        const off = (F : FilletSide, uv : UV) => {
            const d = Eval.rationalSurfaceDerivatives( F.face.surface, uv[0], uv[1], 1 );
            const nn = Vec.mul( F.sign, Vec.normalized( Vec.cross( d[1][0], d[0][1] ) ) );
            return Vec.add( d[0][0], Vec.mul( sr, nn ) );
        };
        const resid = (oa : Point, ob : Point) => {
            const r = Vec.sub( oa, ob );
            return [r[0], r[1], r[2], Vec.dot( Vec.sub( oa, p ), t )];
        };
        // a fitted periodic surface may not close exactly across its seam: near the seam Newton cannot do better than
        // that gap
        tol = Math.max( tol, 2 * Fillet.seamGap( A.face ), 2 * Fillet.seamGap( B.face ) );
        for (let it = 0; it < 40; it++) {
            const oa = off( A, a ), ob = off( B, b );
            const R = resid( oa, ob );
            const err = Math.sqrt( R[0] * R[0] + R[1] * R[1] + R[2] * R[2] + R[3] * R[3] );
            if (err < tol) {
                const pa = Eval.rationalSurfacePoint( A.face.surface, a[0], a[1] ), pb = Eval.rationalSurfacePoint( B.face.surface, b[0], b[1] );
                return { centre : Vec.mul( 0.5, Vec.add( oa, ob ) ), a : a, b : b, pa : pa, pb : pb, seamA : 0, seamB : 0 };
            }
            // Jacobian by forward differences (the offsets involve the normals' derivatives)
            const J : Array<Array<number>> = [[], [], [], []];
            const cols : Array<Array<number>> = [];
            for (let k = 0; k < 2; k++) {
                const q : UV = [a[0], a[1]]; q[k] += ha[k];
                const o = off( A, q );
                cols.push( [(o[0] - oa[0]) / ha[k], (o[1] - oa[1]) / ha[k], (o[2] - oa[2]) / ha[k], Vec.dot( Vec.sub( o, oa ), t ) / ha[k]] );
            }
            for (let k = 0; k < 2; k++) {
                const q : UV = [b[0], b[1]]; q[k] += hb[k];
                const o = off( B, q );
                cols.push( [-(o[0] - ob[0]) / hb[k], -(o[1] - ob[1]) / hb[k], -(o[2] - ob[2]) / hb[k], 0] );
            }
            for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) J[r][c] = cols[c][r];
            let step : Array<number>;
            try { step = Mat.solve( J, R.map( x => -x ) ); } catch (e) { return null; }
            if (step.some( x => !isFinite( x ) )) return null;
            // damp steps that would jump far across a face
            const big = Math.max( Math.abs( step[0] ) / (dA[1] - dA[0]), Math.abs( step[1] ) / (dA[3] - dA[2]), Math.abs( step[2] ) / (dB[1] - dB[0]), Math.abs( step[3] ) / (dB[3] - dB[2]) );
            const f = big > 0.1 ? 0.1 / big : 1;
            const na = Fillet.clampTo( DA, [a[0] + f * step[0], a[1] + f * step[1]], slack );
            const nb = Fillet.clampTo( DB, [b[0] + f * step[2], b[1] + f * step[3]], slack );
            a = na; b = nb;
        }
        return null;
    }

    // The largest distance between the two sides of a face's periodic seams (0 for a face that closes exactly).
    public static seamGap( F : BrepFace ) : number {
        let g = Fillet.gaps.get( F.surface );
        if (g != null) return g;
        g = 0;
        const d = SurfaceIntersect.domain( F.surface );
        for (let ax = 0; ax < 2; ax++) {
            if (!F.periodic[ax]) continue;
            for (let i = 0; i <= 32; i++) {
                const w = d[2 * (1 - ax)] + (d[2 * (1 - ax) + 1] - d[2 * (1 - ax)]) * i / 32;
                const p = ax == 0 ? Eval.rationalSurfacePoint( F.surface, d[0], w ) : Eval.rationalSurfacePoint( F.surface, w, d[2] );
                const q = ax == 0 ? Eval.rationalSurfacePoint( F.surface, d[1], w ) : Eval.rationalSurfacePoint( F.surface, w, d[3] );
                g = Math.max( g, Vec.dist( p, q ) );
            }
        }
        Fillet.gaps.set( F.surface, g );
        return g;
    }
    private static gaps = new WeakMap<object, number>();

    // Parameters brought into a face's domain: wrapped in periodic directions, and clamped in the others to the domain
    // widened by `slack` (a fraction of its span) on each side, where the surface's end spans carry on.
    public static clampTo( D : SurfaceDomain, uv : UV, slack : number ) : UV {
        if (slack <= 0) return SurfaceIntersect.toDomain( D, uv );
        const d = SurfaceIntersect.domain( D.surface ), p : [boolean, boolean] = D.periodic != null ? D.periodic : [false, false];
        const out = SurfaceIntersect.toDomain( { surface : D.surface, periodic : p }, uv );
        for (let k = 0; k < 2; k++) {
            if (p[k]) continue;
            const span = d[2 * k + 1] - d[2 * k];
            out[k] = Math.min( Math.max( uv[k], d[2 * k] - slack * span ), d[2 * k + 1] + slack * span );
        }
        return out;
    }

    // A section's curve from its contact on A to its contact on B: the ball's arc, or the curvature-matching quintic.
    public static crossSection( A : FilletSide, B : FilletSide, x : FilletSection, shape : FilletShape ) : NurbsCurveData {
        if (shape == "circular") return Fillet.arc( x.pa, x.centre, x.pb );
        if (shape == "chamfer") return Make.rationalBezierCurve( [x.pa, Vec.lerp( 0.5, x.pa, x.pb ), x.pb] );
        const g = Fillet.g2( A, x.a, x.pa, B, x.b, x.pb );
        return g != null ? g : Fillet.arc( x.pa, x.centre, x.pb );
    }

    // A quintic Bezier from p (on face A at a) to q (on face B at b), tangent to both faces in the plane of p, q and
    // the faces' normals, with the faces' normal curvatures in that plane at its ends (G2). Its control points lie on
    // the two tangent lines towards their meeting point V (at 0.35 and 0.7 of the way), the second ones lifted off the
    // tangent line by 5/4 k (0.35 |V - p|)^2, which gives the curvature k at the end. Null if the tangents do not meet
    // ahead of both points.
    public static g2( A : FilletSide, a : UV, p : Point, B : FilletSide, b : UV, q : Point ) : NurbsCurveData | null {
        const end = (F : FilletSide, uv : UV, from : Point, to : Point) => {
            const d = Eval.rationalSurfaceDerivatives( F.face.surface, uv[0], uv[1], 2 );
            const su = d[1][0], sv = d[0][1];
            const n = Vec.normalized( Vec.cross( su, sv ) );
            const w = Vec.sub( to, from );
            const t = Vec.normalized( Vec.sub( w, Vec.mul( Vec.dot( w, n ), n ) ) );
            // the normal curvature along t: II(t, t) / I(t, t), with t = du su + dv sv
            const st = Fillet.tangentStep( su, sv, t );
            const du = st[0], dv = st[1];
            const I = Vec.dot( Vec.add( Vec.mul( du, su ), Vec.mul( dv, sv ) ), Vec.add( Vec.mul( du, su ), Vec.mul( dv, sv ) ) );
            const II = du * du * Vec.dot( d[2][0], n ) + 2 * du * dv * Vec.dot( d[1][1], n ) + dv * dv * Vec.dot( d[0][2], n );
            return { t : t, n : n, k : I > 1e-300 ? II / I : 0 };
        };
        const ea = end( A, a, p, q ), eb = end( B, b, q, p );
        // where the tangent lines meet (closest points, as they may be off a common plane by rounding)
        const w0 = Vec.sub( p, q ), aa = Vec.dot( ea.t, ea.t ), bb = Vec.dot( ea.t, eb.t ), cc = Vec.dot( eb.t, eb.t );
        const dd = Vec.dot( ea.t, w0 ), ee = Vec.dot( eb.t, w0 ), den = aa * cc - bb * bb;
        if (Math.abs( den ) < 1e-12) return null;
        const sa = (bb * ee - cc * dd) / den, sb = (aa * ee - bb * dd) / den;
        if (!(sa > 0 && sb > 0)) return null;
        const la = 0.35 * sa, lb = 0.35 * sb;
        const pts : Array<Point> = [
            p,
            Vec.add( p, Vec.mul( la, ea.t ) ),
            Vec.add( Vec.add( p, Vec.mul( 2 * la, ea.t ) ), Vec.mul( 1.25 * ea.k * la * la, ea.n ) ),
            Vec.add( Vec.add( q, Vec.mul( 2 * lb, eb.t ) ), Vec.mul( 1.25 * eb.k * lb * lb, eb.n ) ),
            Vec.add( q, Vec.mul( lb, eb.t ) ),
            q,
        ];
        return Make.rationalBezierCurve( pts );
    }

    // A circular arc from p to q around c (the short way), as a rational quadratic.
    public static arc( p : Point, c : Point, q : Point ) : NurbsCurveData {
        const x = Vec.sub( p, c ), y = Vec.sub( q, c );
        const th = Vec.angleBetween( x, y );
        const mid = Vec.normalized( Vec.add( x, y ) );
        const r = (Vec.norm( x ) + Vec.norm( y )) / 2;
        const w = Math.cos( th / 2 );
        const m = Vec.add( c, Vec.mul( r / Math.max( w, 1e-9 ), mid ) );
        return Make.rationalBezierCurve( [p, m, q], [1, w, 1] );
    }

    // Whether two closed polylines in a face's (u, v) cross (or one crosses itself, when both are the same), leaving out
    // segments that jump across a seam and segments that share a vertex
    private static crossing( p : Array<UV>, q : Array<UV>, F : BrepFace, d : Array<number>, closed : boolean = true ) : boolean {
        const span = [d[1] - d[0], d[3] - d[2]];
        const jump = (a : UV, b : UV) => (F.periodic[0] && Math.abs( a[0] - b[0] ) > span[0] / 2) || (F.periodic[1] && Math.abs( a[1] - b[1] ) > span[1] / 2);
        const same = p === q;
        const n = p.length, m = q.length;
        const cross = (a : UV, b : UV, c : UV, e : UV) => {
            const o = (x : UV, y : UV, z : UV) => ((y[0] - x[0]) / span[0]) * ((z[1] - x[1]) / span[1]) - ((y[1] - x[1]) / span[1]) * ((z[0] - x[0]) / span[0]);
            const d1 = o( a, b, c ), d2 = o( a, b, e ), d3 = o( c, e, a ), d4 = o( c, e, b );
            return d1 * d2 < 0 && d3 * d4 < 0;
        };
        for (let i = 0; i < (closed ? n : n - 1); i++) {
            const a = p[i], b = p[(i + 1) % n];
            if (jump( a, b )) continue;
            for (let j = same ? i + 2 : 0; j < (closed ? m : m - 1); j++) {
                if (same && (j + 1) % m == i) continue;
                const c = q[j], e = q[(j + 1) % m];
                if (jump( c, e )) continue;
                if (cross( a, b, c, e )) return true;
            }
        }
        return false;
    }

    // A closed polyline on a face, split at seam vertices.
    private static pieces( f : BrepFace, uv : Array<UV>, seam : Array<number>, points : Array<Point> ) : Array<FaceCut> {
        const d = SurfaceIntersect.domain( f.surface );
        const n = uv.length;
        const first = seam.findIndex( m => m != 0 );
        if (first < 0) return [{ uv : uv.slice(), points : points.slice(), closed : true }];
        const closedLoop = true;
        // the parameters of a seam vertex as seen from its neighbours in one direction (+1 or -1): the first
        // neighbour not on that seam tells which end of the domain the vertex stands for
        const side = (k : number, dir : number) : UV => {
            const p : UV = [uv[k][0], uv[k][1]];
            for (let a = 0; a < 2; a++) {
                if ((seam[k] & (1 << a)) == 0) continue;
                const lo = d[2 * a], hi = d[2 * a + 1], eps = (hi - lo) * 1e-9;
                let nb = k;
                for (let step = 1; step < n; step++) {
                    let j = k + dir * step;
                    if (j < 0 || j >= n) { if (!closedLoop) break; j = ((j % n) + n) % n; }
                    nb = j;
                    if (Math.abs( uv[j][a] - lo ) > eps && Math.abs( uv[j][a] - hi ) > eps) break;
                }
                p[a] = uv[nb][a] > (lo + hi) / 2 ? hi : lo;
            }
            return p;
        };
        const out : Array<FaceCut> = [];
        let cur : FaceCut = { uv : [side( first, 1 )], points : [points[first]], closed : false };
        for (let s = 1; s <= n; s++) {
            const k = (first + s) % n;
            if (seam[k] != 0) {
                cur.uv.push( side( k, -1 ) ); cur.points.push( points[k] );
                if (cur.uv.length >= 2) out.push( cur );
                cur = { uv : [side( k, 1 )], points : [points[k]], closed : false };
            } else { cur.uv.push( uv[k] ); cur.points.push( points[k] ); }
        }
        return out;
    }

    private static tangentStep( su : Point, sv : Point, d : Point ) : UV {
        const a = Vec.dot( su, su ), b = Vec.dot( su, sv ), c = Vec.dot( sv, sv );
        const r0 = Vec.dot( su, d ), r1 = Vec.dot( sv, d );
        const det = a * c - b * b;
        if (Math.abs( det ) < 1e-300) return [0, 0];
        return [(c * r0 - b * r1) / det, (a * r1 - b * r0) / det];
    }

    private static meanSpacing( pts : Array<Point> ) : number {
        let s = 0.0;
        for (let k = 0; k < pts.length; k++) s += Vec.dist( pts[k], pts[(k + 1) % pts.length] );
        return s / pts.length;
    }
}
