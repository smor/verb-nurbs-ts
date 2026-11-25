import cdt2d from "cdt2d";
import { NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { Make } from "../eval/Make.js";
import { Ribbon, Transfinite } from "../eval/Transfinite.js";
import { BrepBoolean } from "./BrepBoolean.js";
import { BrepFace, BrepSolid, FaceCut } from "./Brep.js";
import { Fillet, FilletResult, FilletSection, FilletShape, FilletSide } from "./Fillet.js";
import { IntersectionCurve, SurfaceIntersect } from "./SurfaceIntersect.js";

// A point where a blend along an open edge is trimmed: its position across the blend (t, 0 on face A's side and 1 on
// face B's) and along it (s, the distance along the edge), and, at t = 0 or 1, its parameters on that face.
export interface TrimPoint {
    point : Point;
    s : number;
    t : number;
    uv? : UV;
}

// A blend along an open edge, before it is trimmed at its two corners. Rows are the sections' arcs sampled at m + 1
// points (from A's contact to B's), plus two rows extrapolated past each end, so a corner can trim a little beyond
// the last section.
// One blend's end at a corner: the rows near it, which face is the shared face b, and the s of X.
interface Corner { F : OpenBlend; e : number; b : number; n : Array<number>; sX : number; }
// Where a contact curve goes through another blend.
interface Crossing { point : Point; sOwn : number; sOther : number; tOther : number; uv : UV; }
// A ball corner's side whose section is not the ball's arc: its departure from the arc (shift) at fractions of the
// arc's angle (from foot i to foot j).
interface Bend { i : number; j : number; total : number; angle : Array<number>; shift : Array<Point>; }
// Where a contact curve reaches the third edge.
interface Reach { point : Point; s : number; uv : UV; f : number | null; isA1 : boolean; }

// The patch that closes a corner where three blends meet.
export interface CornerPatch {
    kind : "ball" | "setback";
    points : Array<Point>;
    triangles : Array<[number, number, number]>;
    reversed : boolean;
    surface : NurbsSurfaceData;
    centre : Point;
    radius : number;
    // a patch carried by several surfaces (a setback corner's six four-sided pieces): each with its triangles
    parts? : Array<{ surface : NurbsSurfaceData, triangles : Array<[number, number, number]> }>;
    // a setback corner's sides, as the transfinite patch's ribbons (`Transfinite.evaluate` gives the exact patch), and
    // each point's position in the patch's polygon
    ribbons? : Array<Ribbon>;
    domain? : Array<[number, number]>;
}

export interface OpenBlend {
    A : FilletSide;
    B : FilletSide;
    radius : number;
    side : number;
    sections : Array<FilletSection>;
    shape : FilletShape;
    // rows: sections across the blend at s along it, their points at even parameters of the section curve, with the
    // section's derivatives there (`tangents`, along the section, from A to B)
    rows : Array<{ s : number, points : Array<Point>, tangents : Array<Point>, uvA : UV, uvB : UV, seamA : number, seamB : number, centre : Point }>;
    m : number;
    // the trims at the start and at the end, ordered by t from 0 to 1
    trims : [Array<TrimPoint> | null, Array<TrimPoint> | null];
    // more cuts of the blend's faces (0: A, 1: B), where another blend runs on into them past this one
    extra : Array<{ side : number, uv : Array<UV>, points : Array<Point> }>;
}

// The edge between the two faces a corner's blends do not share: either an edge of one solid's faces (a side of both
// faces' domains) or an intersection branch between them (a run of a curve that ends at the corner).
export type ThirdEdge =
    { kind : "boundary", a1 : BrepFace, a2 : BrepFace, axis1 : number, value1 : number, axis2 : number, value2 : number } |
    { kind : "curve", curve : IntersectionCurve, a1IsA : boolean, a1 : BrepFace, a2 : BrepFace, atStart : boolean };

// Corners where two rolling-ball blends meet. Where two filleted edges that share a face (b) come together at a sharp
// edge between their other faces (a1 and a2), the blends run into each other: each is trimmed by the other along a
// mitre, a crease from the point where their contact curves on b cross (X) to a point on the sharp edge (Q), which
// carries the sharp edge on across the corner. On a box corner with equal radii the mitre is the quarter ellipse
// where the two cylinders meet, in the plane that bisects them.
export class FilletCorner {

    // After a successful `mitre` on a third edge that is a branch: the function that puts the mitre's end into the
    // branch, to call once both blends are built.
    public static pending : (() => void) | null = null;

    // An open blend's rows, from the sections of `Fillet.sections`.
    public static open( A : FilletSide, B : FilletSide, found : { sections : Array<FilletSection>, side : number, before : Array<FilletSection>, after : Array<FilletSection> },
                        shape : FilletShape = "circular" ) : OpenBlend {
        const sections = found.sections, side = found.side;
        const m = Fillet.arcDivisions( sections, false );
        // the largest radius (a variable fillet's radius changes along it)
        const radius = Math.max( ...sections.map( x => Vec.dist( x.pa, x.centre ) ) );
        const rows : OpenBlend["rows"] = [];
        let s = 0.0;
        // sections solved past the ends where the faces carry on; extrapolated rows where they do not
        const all = found.before.length == 2 && found.after.length == 2 ? found.before.concat( sections, found.after ) : sections;
        all.forEach( (x, k) => {
            const arc = Fillet.crossSection( A, B, x, shape );
            const pts : Array<Point> = [x.pa];
            for (let i = 1; i < m; i++) pts.push( Eval.rationalCurvePoint( arc, i / m ) );
            pts.push( x.pb );
            const tangents = pts.map( (_, i) => Eval.rationalCurveDerivatives( arc, i / m, 1 )[1] );
            if (k > 0) s += Vec.dist( pts[m >> 1], rows[k - 1].points[m >> 1] );
            rows.push( { s : s, points : pts, tangents : tangents, uvA : x.a, uvB : x.b, seamA : x.seamA, seamB : x.seamB, centre : x.centre } );
        } );
        // two rows past each end, along the end rows' direction (the edge's ends are no further than a few steps out)
        const extend = (r0 : OpenBlend["rows"][0], r1 : OpenBlend["rows"][0], j : number) : OpenBlend["rows"][0] => {
            const d = Math.max( Math.abs( r0.s - r1.s ), 1e-12 );
            const move = (p : Point, q : Point) => Vec.add( p, Vec.mul( j, Vec.sub( p, q ) ) );
            const moveUV = (F : FilletSide, p : UV, q : UV) : UV => {
                const D = BrepSolid.domainOf( F.face ), dd = SurfaceIntersect.domain( F.face.surface );
                const qq : UV = [q[0], q[1]];
                for (let a = 0; a < 2; a++) {
                    // q on p's side of a seam
                    const span = dd[2 * a + 1] - dd[2 * a];
                    if (F.face.periodic[a] && Math.abs( qq[a] - p[a] ) > span / 2) qq[a] += qq[a] < p[a] ? span : -span;
                }
                const x : UV = [p[0] + j * (p[0] - qq[0]), p[1] + j * (p[1] - qq[1])];
                return FilletCorner.inside( F.face, x ) ? SurfaceIntersect.toDomain( D, x ) : x;
            };
            const pts = r0.points.map( (p, i) => move( p, r1.points[i] ) );
            const uvA = moveUV( A, r0.uvA, r1.uvA ), uvB = moveUV( B, r0.uvB, r1.uvB );
            // the contact points stay on their faces where the faces go on
            if (FilletCorner.inside( A.face, uvA )) pts[0] = Eval.rationalSurfacePoint( A.face.surface, uvA[0], uvA[1] );
            if (FilletCorner.inside( B.face, uvB )) pts[m] = Eval.rationalSurfacePoint( B.face.surface, uvB[0], uvB[1] );
            const tangents = r0.tangents.map( (t, i) => move( t, r1.tangents[i] ) );
            return { s : r0.s + j * (r0.s - r1.s) / d * d, points : pts, tangents : tangents, uvA : uvA, uvB : uvB, seamA : 0, seamB : 0, centre : move( r0.centre, r1.centre ) };
        };
        if (all !== sections) return { A : A, B : B, radius : radius, side : side, sections : sections, shape : shape, rows : rows, m : m, trims : [null, null], extra : [] };
        const n = rows.length;
        const before = [2, 1].map( j => extend( rows[0], rows[1], j ) );
        const after = [1, 2].map( j => extend( rows[n - 1], rows[n - 2], j ) );
        return { A : A, B : B, radius : radius, side : side, sections : sections, shape : shape, rows : before.concat( rows, after ), m : m, trims : [null, null], extra : [] };
    }

    // Trim blends F1 and F2 where they meet, at their ends e1 and e2 (0: start, 1: end). b1 and b2 say which face of
    // each blend is the shared face b (0: its face A, 1: its face B). False if the corner cannot be built.
    //
    // Where the corner is symmetric (a box corner) the mitre runs from X to the third edge. Otherwise one blend leans
    // over the other: the mitre reaches the other's contact curve with its own face (at Y) before the third edge, and
    // the leaning blend runs on into that face, which is cut along their intersection from Y to the third edge.
    public static mitre( F1 : OpenBlend, e1 : number, b1 : number, F2 : OpenBlend, e2 : number, b2 : number, third : ThirdEdge, tol : number ) : boolean {
        FilletCorner.pending = null;
        const bFace = b1 == 0 ? F1.A.face : F1.B.face;
        const n1 = FilletCorner.near( F1, e1 ), n2 = FilletCorner.near( F2, e2 );

        // X: where the contact curves on b cross
        // (the contact curves carried on past their ends: on a concave corner they cross beyond them)
        const l1 = FilletCorner.carriedOn( F1, n1, b1, 3 * Math.max( F1.radius, F2.radius ) ), l2 = FilletCorner.carriedOn( F2, n2, b2, 3 * Math.max( F1.radius, F2.radius ) );
        const cx = FilletCorner.polyCross( bFace, l1.uv, l2.uv );
        if (cx == null) return false;
        const D = BrepSolid.domainOf( bFace );
        const at1 = l1.at( cx[0] ), at2 = l2.at( cx[1] );
        const uvX = SurfaceIntersect.lerpUV( D, at1.f, FilletCorner.uvOn( F1, b1, at1.k0 ), FilletCorner.uvOn( F1, b1, at1.k1 ) );
        const X = Eval.rationalSurfacePoint( bFace.surface, uvX[0], uvX[1] );
        const c1 : Corner = { F : F1, e : e1, b : b1, n : n1, sX : at1.s }, c2 : Corner = { F : F2, e : e2, b : b2, n : n2, sX : at2.s };

        // where each blend's other contact curve reaches the third edge
        const r1 = FilletCorner.reach( c1, third, true, tol ), r2 = FilletCorner.reach( c2, third, false, tol );
        if (r1 == null || r2 == null) return false;
        // a contact curve that goes through the other blend before it reaches the third edge
        const y2 = FilletCorner.through( c2, c1 ), y1 = FilletCorner.through( c1, c2 );
        const r = Math.min( F1.radius, F2.radius );
        const far = (y : Crossing | null, q : Reach) => y != null && Vec.dist( y.point, q.point ) > 0.1 * r;
        let ok : boolean;
        if (far( y2, r2 )) ok = FilletCorner.lean( c1, c2, X, uvX, y2 as Crossing, r1, r2, third, tol );
        else if (far( y1, r1 )) ok = FilletCorner.lean( c2, c1, X, uvX, y1 as Crossing, r2, r1, third, tol );
        else ok = FilletCorner.even( c1, c2, X, uvX, r1, r2, third, tol );
        return ok;
    }

    // rows from the end inwards, as far as a few radii from the corner
    private static near( F : OpenBlend, e : number, radius : number = F.radius ) : Array<number> {
        const idx = F.rows.map( (_, k) => k );
        if (e == 1) idx.reverse();
        const s0 = F.rows[idx[0]].s, reach = 6 * radius;
        // and one row past the reach
        return idx.filter( (k, j) => j <= 4 || Math.abs( F.rows[idx[j - 1]].s - s0 ) <= reach );
    }

    // A contact curve near a corner (on side b of the rows idx, from the end inwards), carried on straight past the
    // end by a length: its parameters, and where a fractional index along them falls on the blend (the rows around it,
    // the fraction between them, negative past the end, and the s there).
    private static carriedOn( F : OpenBlend, idx : Array<number>, b : number, length : number ) {
        const uv = idx.map( k => FilletCorner.uvOn( F, b, k ) );
        const r0 = F.rows[idx[0]], r1 = F.rows[idx[1]], col = b == 0 ? 0 : F.m;
        const K = length / Math.max( Vec.dist( r0.points[col], r1.points[col] ), 1e-300 );
        const ext : UV = [uv[0][0] + K * (uv[0][0] - uv[1][0]), uv[0][1] + K * (uv[0][1] - uv[1][1])];
        const at = (z : number) : { k0 : number, k1 : number, f : number, s : number } => {
            if (z >= 1) return FilletCorner.lerpRow( F, idx, z - 1 );
            const f = -(1 - z) * K;
            return { k0 : idx[0], k1 : idx[1], f : f, s : r0.s + f * (r1.s - r0.s) };
        };
        return { uv : [ext].concat( uv ), at : at, s : (z : number) => at( z ).s };
    }

    private static uvOn( F : OpenBlend, side : number, k : number ) : UV { return side == 0 ? F.rows[k].uvA : F.rows[k].uvB; }

    // The symmetric corner: the mitre from X along the columns of F1 through F2, to Q on the third edge halfway
    // between where the two contact curves reach it.
    private static even( c1 : Corner, c2 : Corner, X : Point, uvX : UV, r1 : Reach, r2 : Reach, third : ThirdEdge, tol : number ) : boolean {
        const F1 = c1.F, F2 = c2.F;
        let Q : Point, uv1 : UV, uv2 : UV, insert : (() => void) | null = null;
        if (third.kind == "boundary") {
            const target = Vec.mul( 0.5, Vec.add( r1.point, r2.point ) );
            uv1 = FilletCorner.onSide( third.a1, r1.uv, third.axis1, target );
            Q = Eval.rationalSurfacePoint( third.a1.surface, uv1[0], uv1[1] );
            uv2 = FilletCorner.onSide( third.a2, r2.uv, third.axis2, Q );
        } else {
            const q = FilletCorner.onCurve( third, 0.5 * ((r1.f as number) + (r2.f as number)), tol );
            if (q == null) return false;
            Q = q.point; uv1 = q.uv1; uv2 = q.uv2; insert = q.insert;
        }
        const tb1 = c1.b == 0 ? 0 : 1, tb2 = c2.b == 0 ? 0 : 1;
        const mid1 : Array<TrimPoint> = [], mid2 : Array<TrimPoint> = [];
        const m1 = F1.m;
        let prev = X;
        for (let step = 1; step < m1; step++) {
            const i = c1.b == 0 ? step : m1 - step;
            const hit = FilletCorner.columnHit( F1, c1.n, i, F2, c2.n, prev );
            if (hit == null) continue; // near Q the column may graze F2's edge: leave it out
            mid1.push( { point : hit.point, s : hit.s1, t : i / m1 } );
            mid2.push( { point : hit.point, s : hit.s2, t : hit.t2 } );
            prev = hit.point;
        }
        if (!FilletCorner.monotone( mid2, tb2 )) return false;
        FilletCorner.setTrim( c1, [{ point : X, s : c1.sX, t : tb1, uv : uvX } as TrimPoint].concat( mid1, [{ point : Q, s : r1.s, t : 1 - tb1, uv : uv1 }] ) );
        FilletCorner.setTrim( c2, [{ point : X, s : c2.sX, t : tb2, uv : uvX } as TrimPoint].concat( mid2, [{ point : Q, s : r2.s, t : 1 - tb2, uv : uv2 }] ) );
        FilletCorner.pending = insert;
        return true;
    }

    // The leaning corner: blend L runs through the other blend O and on into O's other face (a_O), from Y (where O's
    // contact curve with a_O goes through L) to L's contact curve reaching the third edge (rL).
    private static lean( L : Corner, O : Corner, X : Point, uvX : UV, Y : Crossing, rL : Reach, rO : Reach, third : ThirdEdge, tol : number ) : boolean {
        const FL = L.F, FO = O.F;
        const tbL = L.b == 0 ? 0 : 1, tbO = O.b == 0 ? 0 : 1;
        const aOFace = O.b == 0 ? FO.B.face : FO.A.face;
        const lIsA1 = rL.isA1;
        // the end on the third edge, with its parameters on a_O
        let R : Point, uvL : UV, uvO : UV, insert : (() => void) | null = null;
        if (third.kind == "boundary") {
            R = rL.point; uvL = rL.uv;
            uvO = FilletCorner.onSide( aOFace, rO.uv, lIsA1 ? third.axis2 : third.axis1, R );
        } else {
            const q = FilletCorner.onCurve( third, rL.f as number, tol );
            if (q == null) return false;
            R = q.point; uvL = lIsA1 ? q.uv1 : q.uv2; uvO = lIsA1 ? q.uv2 : q.uv1; insert = q.insert;
        }
        const m = FL.m;
        const midL : Array<TrimPoint> = [], midO : Array<TrimPoint> = [], tail : Array<TrimPoint> = [];
        let prev = X, prevUV = Y.uv;
        const tY = Y.tOther; // Y's t on L
        for (let step = 1; step < m; step++) {
            const i = L.b == 0 ? step : m - step, t = i / m;
            const beforeY = L.b == 0 ? t < tY : t > tY;
            if (beforeY) {
                const hit = FilletCorner.columnHit( FL, L.n, i, FO, O.n, prev );
                if (hit == null) continue;
                midL.push( { point : hit.point, s : hit.s1, t : t } );
                midO.push( { point : hit.point, s : hit.s2, t : hit.t2 } );
                prev = hit.point;
            } else {
                const hit = FilletCorner.columnFace( FL, L.n, i, aOFace, prevUV );
                if (hit == null) continue;
                tail.push( { point : hit.point, s : hit.s, t : t, uv : hit.uv } );
                prevUV = hit.uv;
            }
        }
        if (!FilletCorner.monotone( midO, tbO )) return false;
        const yL : TrimPoint = { point : Y.point, s : Y.sOther, t : tY };
        FilletCorner.setTrim( L, [{ point : X, s : L.sX, t : tbL, uv : uvX } as TrimPoint].concat( midL, [yL], tail.map( x => ({ point : x.point, s : x.s, t : x.t }) ),
                              [{ point : R, s : rL.s, t : 1 - tbL, uv : uvL }] ) );
        FilletCorner.setTrim( O, [{ point : X, s : O.sX, t : tbO, uv : uvX } as TrimPoint].concat( midO, [{ point : Y.point, s : Y.sOwn, t : 1 - tbO, uv : Y.uv }] ) );
        // a_O loses the part beyond L, from Y to R
        FO.extra.push( { side : 1 - O.b, uv : [Y.uv].concat( tail.map( x => x.uv as UV ), [uvO] ), points : [Y.point].concat( tail.map( x => x.point ), [R] ) } );
        FilletCorner.pending = insert;
        return true;
    }

    // Store a trim (given from the b side to the a side) at a blend's end, ordered by t from 0 to 1.
    private static setTrim( c : Corner, trim : Array<TrimPoint> ) : void {
        if (trim[0].t == 1) trim.reverse();
        c.F.trims[c.e] = trim;
    }

    // Whether crossings run from the b side (t = tb) to the other side.
    private static monotone( mid : Array<TrimPoint>, tb : number ) : boolean {
        for (let k = 0; k < mid.length; k++) {
            const tPrev = k == 0 ? tb : mid[k - 1].t;
            if ((mid[k].t - tPrev) * (tb == 0 ? 1 : -1) < -1e-9) return false;
        }
        return true;
    }

    // Where corner c's contact curve with its own a face (its row points on that side, from the corner inwards) goes
    // through the other corner's blend: the point, s on c, (s, t) on the other, and the parameters on the a face.
    private static through( c : Corner, o : Corner ) : Crossing | null {
        const F = c.F, side = 1 - c.b, col = side == 0 ? 0 : F.m;
        const face = side == 0 ? F.A.face : F.B.face;
        for (let a = 0; a + 1 < c.n.length; a++) {
            const r0 = F.rows[c.n[a]], r1 = F.rows[c.n[a + 1]];
            const hit = FilletCorner.segBlend( r0.points[col], r1.points[col], o.F, o.n );
            if (hit == null) continue;
            const uv = SurfaceIntersect.lerpUV( BrepSolid.domainOf( face ), hit.f, side == 0 ? r0.uvA : r0.uvB, side == 0 ? r1.uvA : r1.uvB );
            return { point : hit.point, sOwn : r0.s + hit.f * (r1.s - r0.s), sOther : hit.s, tOther : hit.t, uv : uv };
        }
        return null;
    }

    // Where corner c's contact curve with its own a face reaches the third edge: the point, the s there, the
    // parameters on that face, and for a branch the fractional index along it (from the corner).
    private static reach( c : Corner, third : ThirdEdge, isA1 : boolean, _tol : number ) : Reach | null {
        const F = c.F, side = 1 - c.b;
        const face = isA1 ? third.a1 : third.a2;
        const poly = c.n.map( k => FilletCorner.uvOn( F, side, k ) );
        const D = BrepSolid.domainOf( face );
        if (third.kind == "boundary") {
            const axis = isA1 ? third.axis1 : third.axis2, value = isA1 ? third.value1 : third.value2;
            for (let i = 0; i + 1 < poly.length; i++) {
                const x = poly[i][axis] - value, y = poly[i + 1][axis] - value;
                if (x != 0 && x * y > 0) continue;
                const f = x == 0 ? 0 : x / (x - y);
                const at = FilletCorner.lerpRow( F, c.n, i + f );
                const uv = SurfaceIntersect.lerpUV( D, at.f, FilletCorner.uvOn( F, side, at.k0 ), FilletCorner.uvOn( F, side, at.k1 ) );
                uv[axis] = value;
                return { point : Eval.rationalSurfacePoint( face.surface, uv[0], uv[1] ), s : at.s, uv : uv, f : null, isA1 : isA1 };
            }
            return null;
        }
        const e = third.curve;
        const order = e.points.map( (_, k) => k );
        if (!third.atStart) order.reverse();
        const own = (third.a1IsA == isA1) ? e.uvA : e.uvB;
        const x = FilletCorner.polyCross( face, poly, order.map( k => own[k] ) );
        if (x == null) return null;
        const at = FilletCorner.lerpRow( F, c.n, x[0] );
        const uv = SurfaceIntersect.lerpUV( D, at.f, FilletCorner.uvOn( F, side, at.k0 ), FilletCorner.uvOn( F, side, at.k1 ) );
        return { point : Eval.rationalSurfacePoint( face.surface, uv[0], uv[1] ), s : at.s, uv : uv, f : x[1], isA1 : isA1 };
    }

    // The point at a fractional index along a third edge that is a branch (counted from the corner), refined onto both
    // faces, and a function that puts it into the branch.
    private static onCurve( third : ThirdEdge, f : number, tol : number ) : { point : Point, uv1 : UV, uv2 : UV, insert : () => void } | null {
        if (third.kind != "curve") return null;
        const e = third.curve;
        const order = e.points.map( (_, k) => k );
        if (!third.atStart) order.reverse();
        const i = Math.min( order.length - 2, Math.floor( f ) ), fr = f - i;
        const k0 = order[i], k1 = order[i + 1];
        const fa = third.a1IsA ? third.a1 : third.a2, fb = third.a1IsA ? third.a2 : third.a1;
        const DA = BrepSolid.domainOf( fa ), DB = BrepSolid.domainOf( fb );
        const r = SurfaceIntersect.refine( DA, DB, SurfaceIntersect.lerpUV( DA, fr, e.uvA[k0], e.uvA[k1] ), SurfaceIntersect.lerpUV( DB, fr, e.uvB[k0], e.uvB[k1] ), tol );
        if (r == null) return null;
        const res = r, p0 = e.points[k0], p1 = e.points[k1];
        const insert = () => {
            // between the same two vertices (found again: another corner may have put a point into the branch since)
            const j0 = e.points.indexOf( p0 ), j1 = e.points.indexOf( p1 );
            if (j0 < 0 || j1 < 0) return;
            // the segment between them nearest to the point
            let lo = Math.min( j0, j1 ), best = Infinity;
            for (let j = Math.min( j0, j1 ); j < Math.max( j0, j1 ); j++) {
                const a = e.points[j], ab = Vec.sub( e.points[j + 1], a ), l2 = Math.max( Vec.dot( ab, ab ), 1e-300 );
                const t = Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( res.point, a ), ab ) / l2 ) );
                const dd = Vec.dist( res.point, Vec.add( a, Vec.mul( t, ab ) ) );
                if (dd < best) { best = dd; lo = j; }
            }
            e.points.splice( lo + 1, 0, res.point ); e.uvA.splice( lo + 1, 0, res.uvA ); e.uvB.splice( lo + 1, 0, res.uvB );
            e.seamA.splice( lo + 1, 0, 0 ); e.seamB.splice( lo + 1, 0, 0 );
        };
        return { point : r.point, uv1 : third.a1IsA ? r.uvA : r.uvB, uv2 : third.a1IsA ? r.uvB : r.uvA, insert : insert };
    }

    // Where segment p-q goes through blend F's triangles (its rows idx): the point, the fraction along p-q, and (s, t)
    // on F.
    private static segBlend( p : Point, q : Point, F : OpenBlend, idx : Array<number> ) : { point : Point, f : number, s : number, t : number } | null {
        const m = F.m;
        let best : { point : Point, f : number, s : number, t : number } | null = null;
        for (let b = 0; b + 1 < idx.length; b++) {
            const R0 = F.rows[idx[b]], R1 = F.rows[idx[b + 1]];
            for (let j = 0; j < m; j++) {
                const quad = [R0.points[j], R0.points[j + 1], R1.points[j + 1], R1.points[j]];
                const st = [[R0.s, j / m], [R0.s, (j + 1) / m], [R1.s, (j + 1) / m], [R1.s, j / m]];
                for (const tri of [[0, 1, 2], [0, 2, 3]]) {
                    const h = FilletCorner.segTri( p, q, quad[tri[0]], quad[tri[1]], quad[tri[2]] );
                    if (h == null || (best != null && h.f >= best.f)) continue;
                    const w0 = 1 - h.u - h.v;
                    best = { point : Vec.add( p, Vec.mul( h.f, Vec.sub( q, p ) ) ), f : h.f,
                             s : w0 * st[tri[0]][0] + h.u * st[tri[1]][0] + h.v * st[tri[2]][0],
                             t : w0 * st[tri[0]][1] + h.u * st[tri[1]][1] + h.v * st[tri[2]][1] };
                }
            }
        }
        return best;
    }

    // Where column i of F (across its rows idx, from the corner inwards) goes through a face: the first crossing, by
    // Newton's method on S(u, v) = p + f (q - p) from the parameters given.
    private static columnFace( F : OpenBlend, idx : Array<number>, i : number, face : BrepFace, uv0 : UV ) : { point : Point, s : number, uv : UV } | null {
        const D = BrepSolid.domainOf( face );
        for (let a = 0; a + 1 < idx.length; a++) {
            const r0 = F.rows[idx[a]], r1 = F.rows[idx[a + 1]];
            const p = r0.points[i], q = r1.points[i], d = Vec.sub( q, p );
            let uv : UV = [uv0[0], uv0[1]], f = 0.5;
            let ok = false;
            for (let it = 0; it < 30; it++) {
                const ds = Eval.rationalSurfaceDerivatives( face.surface, uv[0], uv[1], 1 );
                const res = Vec.sub( ds[0][0], Vec.add( p, Vec.mul( f, d ) ) );
                if (Vec.norm( res ) < 1e-10 * Math.max( 1, F.radius )) { ok = true; break; }
                const J = [0, 1, 2].map( k => [ds[1][0][k], ds[0][1][k], -d[k]] );
                let step : Array<number>;
                try { step = Mat.solve( J, Vec.mul( -1, res ) ); } catch (e) { break; }
                if (step.some( x => !isFinite( x ) )) break;
                uv = Fillet.clampTo( D, [uv[0] + step[0], uv[1] + step[1]], 0.3 );
                f += step[2];
                if (Math.abs( f ) > 4) break;
            }
            if (!ok || f < -1e-9 || f > 1 + 1e-9) continue;
            const pt = Eval.rationalSurfacePoint( face.surface, uv[0], uv[1] );
            return { point : pt, s : r0.s + f * (r1.s - r0.s), uv : uv };
        }
        return null;
    }

    // A ball corner: three blends of one radius, all convex or all concave, between three faces that meet at a point.
    // The ball that touches all three faces stops each blend at the section through its centre c; the corner is the
    // spherical triangle on that ball between the three end arcs, and each face's two contact curves meet at the
    // ball's foot on it. Returns the corner patch, or null where the ball cannot be placed.
    public static ball( ends : Array<{ F : OpenBlend, e : number, keys : [string, string] }>, tol : number )
        : CornerPatch | null {
        if (ends.length != 3) return null;
        // the radius at each blend's end (a variable fillet's radius changes along it)
        const endRadius = (x : typeof ends[0]) => { const s = x.F.sections[x.e == 0 ? 0 : x.F.sections.length - 1]; return Vec.dist( s.pa, s.centre ); };
        const r = endRadius( ends[0] ), side = ends[0].F.side;
        if (ends.some( x => Math.abs( endRadius( x ) - r ) > 1e-6 * Math.max( 1, r ) || x.F.side != side )) return null;
        const shape = ends[0].F.shape;
        if (ends.some( x => x.F.shape != shape )) return null;
        // the three faces, each with its side as some blend sees it and a starting guess from that blend's end row
        const keys : Array<string> = [];
        for (const x of ends) for (const k of x.keys) if (!keys.includes( k )) keys.push( k );
        if (keys.length != 3) return null;
        const faces = keys.map( k => {
            const x = ends.find( y => y.keys.includes( k ) ) as typeof ends[0];
            const a = x.keys[0] == k ? 0 : 1;
            const row = x.F.rows[x.e == 0 ? 2 : x.F.rows.length - 3];
            return { key : k, side : a == 0 ? x.F.A : x.F.B, uv : (a == 0 ? row.uvA : row.uvB).slice() as UV };
        } );
        // Newton on the six parameters: the three offsets reach one centre
        const sr = side * r;
        const off = (i : number, uv : UV) => {
            const d = Eval.rationalSurfaceDerivatives( faces[i].side.face.surface, uv[0], uv[1], 1 );
            const nn = Vec.mul( faces[i].side.sign, Vec.normalized( Vec.cross( d[1][0], d[0][1] ) ) );
            return Vec.add( d[0][0], Vec.mul( sr, nn ) );
        };
        let uv = faces.map( f => f.uv );
        const D = faces.map( f => BrepSolid.domainOf( f.side.face ) );
        const spans = faces.map( f => { const d = SurfaceIntersect.domain( f.side.face.surface ); return [d[1] - d[0], d[3] - d[2]]; } );
        let ok = false;
        for (let it = 0; it < 50; it++) {
            const o = [0, 1, 2].map( i => off( i, uv[i] ) );
            const R = Vec.sub( o[0], o[1] ).concat( Vec.sub( o[0], o[2] ) );
            if (Vec.norm( R ) < tol * Math.max( 1, r )) { ok = true; break; }
            const J : Array<Array<number>> = [0, 1, 2, 3, 4, 5].map( _ => [0, 0, 0, 0, 0, 0] );
            for (let i = 0; i < 3; i++) for (let k = 0; k < 2; k++) {
                const h = spans[i][k] * 1e-7;
                const q : UV = [uv[i][0], uv[i][1]]; q[k] += h;
                const dO = Vec.mul( 1 / h, Vec.sub( off( i, q ), o[i] ) );
                for (let row = 0; row < 3; row++) {
                    // R1 = o0 - o1, R2 = o0 - o2
                    if (i == 0) { J[row][2 * i + k] = dO[row]; J[3 + row][2 * i + k] = dO[row]; }
                    else if (i == 1) J[row][2 * i + k] = -dO[row];
                    else J[3 + row][2 * i + k] = -dO[row];
                }
            }
            let step : Array<number>;
            try { step = Mat.solve( J, R.map( x => -x ) ); } catch (e) { return null; }
            if (step.some( x => !isFinite( x ) )) return null;
            const big = Math.max( ...[0, 1, 2].map( i => Math.max( Math.abs( step[2 * i] ) / spans[i][0], Math.abs( step[2 * i + 1] ) / spans[i][1] ) ) );
            const f = big > 0.1 ? 0.1 / big : 1;
            uv = [0, 1, 2].map( i => Fillet.clampTo( D[i], [uv[i][0] + f * step[2 * i], uv[i][1] + f * step[2 * i + 1]], 0.3 ) );
        }
        if (!ok) return null;
        const c = Vec.mul( 1 / 3, Vec.add( off( 0, uv[0] ), Vec.add( off( 1, uv[1] ), off( 2, uv[2] ) ) ) );
        const feet = [0, 1, 2].map( i => Eval.rationalSurfacePoint( faces[i].side.face.surface, uv[i][0], uv[i][1] ) );
        // the centre must lie near the corner, within reach of each blend's rows
        const arcs : Array<Array<Point>> = [];
        const bends : Array<Bend> = [];
        for (const x of ends) {
            const F = x.F, ia = keys.indexOf( x.keys[0] ), ib = keys.indexOf( x.keys[1] );
            // where the blend's centres pass the ball's centre
            let best = Infinity, sAt = 0;
            for (let k = 0; k + 1 < F.rows.length; k++) {
                const a = F.rows[k].centre, b = F.rows[k + 1].centre, ab = Vec.sub( b, a ), l2 = Math.max( Vec.dot( ab, ab ), 1e-300 );
                const t = Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( c, a ), ab ) / l2 ) );
                const dd = Vec.dist( c, Vec.add( a, Vec.mul( t, ab ) ) );
                if (dd < best) { best = dd; sAt = F.rows[k].s + t * (F.rows[k + 1].s - F.rows[k].s); }
            }
            if (best > 0.25 * r) return null;
            let arc = shape == "chamfer" ? Fillet.crossSection( faces[ia].side, faces[ib].side, { centre : c, a : uv[ia], b : uv[ib], pa : feet[ia], pb : feet[ib], seamA : 0, seamB : 0 }, shape )
                                         : Fillet.arc( feet[ia], c, feet[ib] );
            if (shape == "curvature") {
                const g = Fillet.g2( faces[ia].side, uv[ia], feet[ia], faces[ib].side, uv[ib], feet[ib] );
                if (g == null) return null;
                // the end section's curve, and how far it lies from the ball's arc, by angle along the arc
                const samples = Array.from( { length : 65 }, (_, k) => k / 64 );
                const ap = samples.map( t => Eval.rationalCurvePoint( arc, t ) ), gp = samples.map( t => Eval.rationalCurvePoint( g, t ) );
                const total = Vec.angleBetween( Vec.sub( feet[ia], c ), Vec.sub( feet[ib], c ) );
                bends.push( { i : ia, j : ib, total : total,
                              angle : ap.map( q => FilletCorner.angle( Vec.sub( feet[ia], c ), Vec.sub( q, c ) ) / total ),
                              shift : ap.map( (q, k) => Vec.sub( gp[k], q ) ) } );
                arc = g;
            }
            const pts : Array<Point> = [feet[ia]];
            for (let i = 1; i < F.m; i++) pts.push( Eval.rationalCurvePoint( arc, i / F.m ) );
            pts.push( feet[ib] );
            F.trims[x.e] = pts.map( (p, i) => ({ point : p, s : sAt, t : i / F.m, uv : i == 0 ? uv[ia] : i == F.m ? uv[ib] : undefined }) );
            arcs.push( pts );
        }
        const patch = FilletCorner.sphereTriangle( c, r, feet, arcs, side, bends, shape == "chamfer" );
        return patch == null ? null : Object.assign( patch, { kind : "ball" as const, centre : c, radius : r } );
    }

    // How far a setback corner stops each blend short of where its contact curves meet the others', in radii.
    public static setbackFactor = 0.6;

    // A setback vertex blend: three blends of any radii and kinds (convex, concave or mixed), between three faces that
    // meet at a point. Each blend stops a setback short of where its contact curves cross its neighbours' (on the face they
    // share); on each face a curve tangent to the two contact curves joins their ends, and cuts the face; the corner is
    // the six-sided patch between the three end sections and the three face curves, a transfinite surface that meets
    // the blends and the faces with G1 continuity along its sides (T. Várady, A. Rockwood, "Geometric construction for
    // setback vertex blending", Computer-Aided Design 29(6), 1997; Kato's side-based patch, `Transfinite`). Returns the patch, or null.
    public static setback( ends : Array<{ F : OpenBlend, e : number, keys : [string, string] }>, _tol : number )
        : CornerPatch | null {
        if (ends.length != 3) return null;
        const keys : Array<string> = [];
        for (const x of ends) for (const k of x.keys) if (!keys.includes( k )) keys.push( k );
        if (keys.length != 3) return null;
        // the two ends on each face, and which side of each blend that face is (0: its face A)
        const touch = keys.map( k => ends.map( (x, i) => ({ i : i, b : x.keys.indexOf( k ) }) ).filter( y => y.b >= 0 ) );
        if (touch.some( t => t.length != 2 )) return null;
        const faceOf = (i : number, b : number) => b == 0 ? ends[i].F.A : ends[i].F.B;
        const endRadius = (x : typeof ends[0]) => { const s = x.F.sections[x.e == 0 ? 0 : x.F.sections.length - 1]; return Vec.dist( s.pa, s.centre ); };
        const rMax = Math.max( ...ends.map( endRadius ) );
        const near = ends.map( x => FilletCorner.near( x.F, x.e, rMax ) );
        // where each face's two contact curves cross: the s on both blends
        const sX : Array<Array<number>> = ends.map( _ => [] as Array<number> );
        for (const t of touch) {
            const [p, q] = t;
            const face = faceOf( p.i, p.b ).face;
            // the contact curves, carried on straight past their ends by a few radii: a blend much smaller than its
            // neighbour stops before its contact meets the neighbour's
            const line = (x : { i : number, b : number }) => FilletCorner.carriedOn( ends[x.i].F, near[x.i], x.b, 3 * rMax );
            const lp = line( p ), lq = line( q );
            const cx = FilletCorner.polyCross( face, lp.uv, lq.uv );
            if (cx == null) return null;
            sX[p.i].push( lp.s( cx[0] ) );
            sX[q.i].push( lq.s( cx[1] ) );
        }
        // each blend's end section, a setback short of its crossings
        // (on a short edge, no more than a quarter of the room left to its other end, which may have a corner too)
        const cut = ends.map( (x, i) => {
            const F = x.F, n = F.rows.length;
            const inner = x.e == 1 ? Math.min( ...sX[i] ) : Math.max( ...sX[i] );
            const room = x.e == 1 ? inner - F.rows[2].s : F.rows[n - 3].s - inner;
            const back = Math.min( FilletCorner.setbackFactor * rMax, 0.25 * room );
            const s = x.e == 1 ? inner - back : inner + back;
            if (s < F.rows[2].s || s > F.rows[n - 3].s) return null;
            return FilletCorner.rowAt( F, s, x.e == 1 ? 1 : -1 );
        } );
        if (cut.some( c => c == null )) return null;
        const rows = cut as Array<NonNullable<ReturnType<typeof FilletCorner.rowAt>>>;
        ends.forEach( (x, i) => {
            const r = rows[i], m = x.F.m;
            x.F.trims[x.e] = r.points.map( (p, k) => ({ point : p, s : r.s, t : k / m, uv : k == 0 ? r.uvA : k == m ? r.uvB : undefined }) );
        } );
        // the domain's scale: world length per unit of the patch's polygon, the sides' mean length
        const arcLen = (p : Array<Point>) => { let l = 0; for (let k = 1; k < p.length; k++) l += Vec.dist( p[k], p[k - 1] ); return l; };
        // the face curves, from blend p's foot to blend q's
        const foot = (i : number, b : number) => { const r = rows[i]; return { point : r.points[b == 0 ? 0 : r.points.length - 1], uv : b == 0 ? r.uvA : r.uvB }; };
        const curves = touch.map( t => {
            const [p, q] = t;
            const S = faceOf( p.i, p.b ), D = BrepSolid.domainOf( S.face );
            const fp = foot( p.i, p.b ), fq = foot( q.i, q.b );
            const L = Vec.dist( fp.point, fq.point );
            // the contact curves' directions towards the corner, in parameters per unit of length
            const dir = (i : number, b : number) => {
                const r = rows[i], col = b == 0 ? 0 : r.points.length - 1;
                const speed = Math.max( Vec.norm( r.dP[col] ), 1e-300 );
                return (b == 0 ? r.duvA : r.duvB).map( v => v / speed );
            };
            const m0 = dir( p.i, p.b ).map( v => v * L ), m1 = dir( q.i, q.b ).map( v => -v * L );
            const chamfer = ends[0].F.shape == "chamfer";
            const a = fp.uv;
            // the end unwrapped next to the start across a seam
            const span = SurfaceIntersect.domain( S.face.surface );
            const b2 : UV = [fq.uv[0], fq.uv[1]];
            for (let k = 0; k < 2; k++) if (S.face.periodic[k]) {
                const per = span[2 * k + 1] - span[2 * k];
                while (b2[k] - a[k] > per / 2) b2[k] -= per;
                while (a[k] - b2[k] > per / 2) b2[k] += per;
            }
            const N = Math.max( 4, ends[p.i].F.m );
            const uv : Array<UV> = [], points : Array<Point> = [], tangents : Array<Point> = [];
            for (let k = 0; k <= N; k++) {
                const t = k / N, t2 = t * t, t3 = t2 * t;
                const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
                const g00 = 6 * t2 - 6 * t, g10 = 3 * t2 - 4 * t + 1, g01 = -6 * t2 + 6 * t, g11 = 3 * t2 - 2 * t;
                // a chamfer's corner is cut straight across each face
                const w : UV = [0, 1].map( c => chamfer ? a[c] + t * (b2[c] - a[c]) : h00 * a[c] + h10 * m0[c] + h01 * b2[c] + h11 * m1[c] ) as UV;
                const dw : UV = [0, 1].map( c => chamfer ? b2[c] - a[c] : g00 * a[c] + g10 * m0[c] + g01 * b2[c] + g11 * m1[c] ) as UV;
                const wd = k == 0 ? fp.uv : k == N ? fq.uv : SurfaceIntersect.toDomain( D, w );
                const ds = Eval.rationalSurfaceDerivatives( S.face.surface, wd[0], wd[1], 1 );
                uv.push( wd );
                points.push( k == 0 ? fp.point : k == N ? fq.point : ds[0][0] );
                tangents.push( Vec.add( Vec.mul( dw[0], ds[1][0] ), Vec.mul( dw[1], ds[0][1] ) ) );
            }
            return { uv : uv, points : points, tangents : tangents, side : S };
        } );
        // the six sides in order round the corner: face curve, end section, face curve, ...
        const order : Array<{ kind : "face", f : number, reverse : boolean } | { kind : "end", i : number, fromB : boolean }> = [];
        let f = 0, cur = touch[0][0].i;
        for (let n = 0; n < 3; n++) {
            const t = touch[f];
            const p = t[0].i == cur ? t[0] : t[1], q = t[0].i == cur ? t[1] : t[0];
            order.push( { kind : "face", f : f, reverse : p !== t[0] } );
            // q's end section, from its foot on f to its foot on its other face
            order.push( { kind : "end", i : q.i, fromB : q.b == 1 } );
            const other = ends[q.i].keys[1 - q.b];
            f = keys.indexOf( other ); cur = q.i;
        }
        if (cur != touch[0][0].i || f != 0) return null;
        const sides = order.map( o => {
            if (o.kind == "face") { const c = curves[o.f]; return o.reverse ? c.points.slice().reverse() : c.points; }
            const r = rows[o.i];
            return o.fromB ? r.points.slice().reverse() : r.points;
        } );
        // the sides' derivatives along them, in their order round the corner
        const along = order.map( o => {
            if (o.kind == "face") { const c = curves[o.f]; return o.reverse ? c.tangents.map( v => Vec.mul( -1, v ) ).reverse() : c.tangents; }
            const r = rows[o.i];
            return o.fromB ? r.tangents.map( v => Vec.mul( -1, v ) ).reverse() : r.tangents;
        } );
        const lambda = sides.reduce( (a, p) => a + arcLen( p ), 0 ) / sides.length;
        // the cross derivatives: along each blend, onwards into the corner; on each face, across its curve in the face's
        // tangent plane, the way the blends' sections leave the face
        const ribbons = order.map( (o, j) => {
            const pts = sides[j];
            if (o.kind == "end") {
                const r = rows[o.i];
                const d = r.dP.map( v => Vec.mul( lambda, v ) );
                return { points : pts, tangents : along[j], cross : o.fromB ? d.reverse() : d };
            }
            const c = curves[o.f];
            const uvs = o.reverse ? c.uv.slice().reverse() : c.uv;
            const fs = c.side;
            // the section leaving the face at the first foot
            const t0 = touch[o.f].find( y => (o.reverse ? y === touch[o.f][1] : y === touch[o.f][0]) ) as { i : number, b : number };
            const r0 = rows[t0.i], m = r0.points.length - 1;
            const leave = t0.b == 0 ? Vec.sub( r0.points[1], r0.points[0] ) : Vec.sub( r0.points[m - 1], r0.points[m] );
            const cross = pts.map( (p, k) => {
                const uv = uvs[k];
                const d = Eval.rationalSurfaceDerivatives( fs.face.surface, uv[0], uv[1], 1 );
                const nrm = Vec.normalized( Vec.cross( d[1][0], d[0][1] ) );
                const tan = Vec.normalized( along[j][k] );
                return Vec.normalized( Vec.cross( nrm, tan ) );
            } );
            const sign = Vec.dot( cross[0], leave ) >= 0 ? 1 : -1;
            return { points : pts, tangents : along[j], cross : cross.map( v => Vec.mul( sign * lambda, v ) ) };
        } );
        if (ends.every( x => x.F.shape == "curvature" )) {
            // curvature-continuous blends get a curvature-continuous corner (G2): each ribbon also carries the second
            // derivative across its side, along the blend (from its rows) or of the face along the cross direction
            ribbons.forEach( (rb, j) => {
                const o = order[j];
                if (o.kind == "end") {
                    const k2 = FilletCorner.rowSecond( ends[o.i].F, rows[o.i].s ).map( v => Vec.mul( lambda * lambda, v ) );
                    (rb as Ribbon).second = o.fromB ? k2.reverse() : k2;
                    return;
                }
                const c = curves[o.f];
                const uvs = o.reverse ? c.uv.slice().reverse() : c.uv;
                (rb as Ribbon).second = rb.cross.map( (w, k) => FilletCorner.faceSecond( c.side.face.surface, uvs[k], w ) );
            } );
        }
        if (ends[0].F.shape == "chamfer") {
            // a chamfer's corner is a facet: each side's cross derivative lies in the plane that best fits the six
            // sides (Newell's normal, oriented by the loop), square to the side, inwards
            const loop = ([] as Array<Point>).concat( ...sides.map( p => p.slice( 0, p.length - 1 ) ) );
            let nn : Point = [0, 0, 0];
            loop.forEach( (p, k) => { const q = loop[(k + 1) % loop.length]; nn = Vec.add( nn, Vec.cross( p, q ) ); } );
            const n = Vec.normalized( nn );
            ribbons.forEach( rb => {
                const pts = rb.points;
                rb.cross = pts.map( (_, k) => {
                    const t = Vec.sub( pts[Math.min( k + 1, pts.length - 1 )], pts[Math.max( k - 1, 0 )] );
                    const c = Vec.cross( n, t );
                    return Vec.mul( lambda, Vec.normalized( Vec.sub( c, Vec.mul( Vec.dot( c, n ), n ) ) ) );
                } );
            } );
        }
        FilletCorner.contain( ribbons, touch.map( t => faceOf( t[0].i, t[0].b ) ), curves.map( c => c.uv[0] ),
                              Vec.mul( 1 / 3, rows.reduce( (a, r) => Vec.add( a, r.centre ), [0, 0, 0] as Point ) ), rMax,
                              Math.max( 2, Math.round( ends[0].F.m / 1.5 ) ) );
        const m = Transfinite.mesh( ribbons, Math.max( 2, Math.round( ends[0].F.m / 1.5 ) ) );
        // outward, with the faces: the triangles turned one way in the polygon, then all flipped if the one at the
        // patch's first boundary point (on the first face curve, where the patch is tangent to that face) faces against
        // the face's outward normal. (A convex and a concave corner both follow, and a mixed one too.)
        const c = Vec.mul( 1 / 3, rows.reduce( (a, r) => Vec.add( a, r.centre ), [0, 0, 0] as Point ) );
        const ccw = m.triangles.map( t => {
            const a = m.domain[t[0]], b = m.domain[t[1]], d = m.domain[t[2]];
            const o = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
            return (o > 0 ? [t[0], t[1], t[2]] : [t[0], t[2], t[1]]) as [number, number, number];
        } );
        const first = ccw.find( t => t.includes( 0 ) ) as [number, number, number];
        const o0 = order[0] as { kind : "face", f : number, reverse : boolean }, c0 = curves[o0.f];
        const uv0 = o0.reverse ? c0.uv[c0.uv.length - 1] : c0.uv[0];
        const n0 = Vec.cross( Vec.sub( m.points[first[1]], m.points[first[0]] ), Vec.sub( m.points[first[2]], m.points[first[0]] ) );
        const flip = Vec.dot( n0, Fillet.normal( c0.side, uv0 ) ) < 0;
        const triangles = ccw.map( t => (flip ? [t[0], t[2], t[1]] : t) as [number, number, number] );
        // the face curves cut their faces, as more cuts of the first blend on each
        touch.forEach( (t, k) => {
            const F = ends[t[0].i].F, cv = curves[k];
            F.extra.push( { side : t[0].b, uv : cv.uv, points : cv.points } );
        } );
        // six four-sided B-spline surfaces, each carrying the triangles in its part of the polygon
        const surfaces = Transfinite.surfaces( ribbons, 1e-3 * rMax );
        const part = m.triangles.map( t => {
            const x = m.domain[t[0]], y = m.domain[t[1]], z = m.domain[t[2]];
            return Transfinite.quadOf( ribbons, [(x[0] + y[0] + z[0]) / 3, (x[1] + y[1] + z[1]) / 3] );
        } );
        return { kind : "setback", points : m.points, triangles : triangles, reversed : false, surface : surfaces[0], centre : c, radius : rMax,
                 parts : surfaces.map( (srf, k) => ({ surface : srf, triangles : triangles.filter( (_, j) => part[j] == k ) }) ),
                 ribbons : ribbons, domain : m.domain };
    }

    // Keep a setback corner on the blends' side of the three faces it rounds. The patch takes its boundary and its
    // cross derivatives' directions from the blends and the faces, but their length is free: it sets how full the
    // patch is (the "fullness" of Salvi, Várady and Rockwood's ribbon-based patches), and the transfinite blend
    // carries each ribbon on, straight, well into the patch. One length for all six sides, the sides' mean, overshoots
    // where they are uneven: a corner of a box then bulges past the box's faces (by 0.17 for radii 3, 4 and 5 on
    // a 40 x 28 x 20 box). So the lengths are scaled down, by bisection, to the fullest patch that crosses none of the
    // faces: at no sample of the polygon is a point on the other side of a face from the blends' centres. Second
    // derivatives scale with the square, which keeps a G2 patch G2. Deterministic, and a no-op where nothing crosses.
    private static contain( ribbons : Array<Ribbon>, faces : Array<FilletSide>, uv0 : Array<UV>, centre : Point, size : number, density : number ) : void {
        const base = ribbons.map( r => ({ cross : r.cross, second : r.second }) );
        const scale = (f : number) => ribbons.forEach( (r, j) => {
            r.cross = base[j].cross.map( v => Vec.mul( f, v ) );
            if (base[j].second != null) r.second = (base[j].second as Array<Point>).map( v => Vec.mul( f * f, v ) );
        } );
        // samples of the polygon: the inner vertices of the patch's mesh (they do not depend on the lengths)
        const m = Transfinite.mesh( ribbons, density );
        const samples = m.domain.slice( m.boundary );
        const tol = 1e-6 * size;
        const sideOf = faces.map( (F, k) => FilletCorner.signedDistance( F, centre, uv0[k] ).d < 0 ? -1 : 1 );
        // how far the patch crosses the faces, at worst (0: not at all)
        const crossing = () => {
            let worst = 0.0;
            for (const x of samples) {
                const p = Transfinite.evaluate( ribbons, x );
                faces.forEach( (F, k) => { worst = Math.max( worst, -sideOf[k] * FilletCorner.signedDistance( F, p, uv0[k] ).d ); } );
            }
            return worst > tol ? worst : 0;
        };
        if (crossing() == 0) return;
        // the fullest length that does not cross (bisection between the steps of a coarse scan); where every length
        // crosses (the boundary itself curves out, which no length undoes), the one that crosses least
        let best = 1.0, least = Infinity, lo = -1;
        // (a curvature-continuous patch keeps its fullness above 0.6: below, the second-order terms that make it G2
        // dominate the shrinking first-order ones, and its curvature across the sides drifts)
        const floor = base.every( b => b.second != null ) ? 0.55 : 0.05;
        for (let f = 0.9; f > floor; f -= 0.1) {
            scale( f );
            const c = crossing();
            if (c == 0) { lo = f; break; }
            if (c < least) { least = c; best = f; }
        }
        if (lo < 0) { scale( best ); return; }
        let hi = lo + 0.1;
        for (let it = 0; it < 7; it++) {
            const mid = 0.5 * (lo + hi);
            scale( mid );
            if (crossing() > 0) hi = mid; else lo = mid;
        }
        scale( lo );
    }

    // The signed distance from a point to a face, along the face's normal (as Fillet orients it), at the point's
    // projection on the face: Newton steps from uv0, clamped to the domain.
    private static signedDistance( F : FilletSide, p : Point, uv0 : UV ) : { d : number, uv : UV } {
        const s = F.face.surface, dom = SurfaceIntersect.domain( s );
        let uv : UV = [uv0[0], uv0[1]];
        for (let it = 0; it < 20; it++) {
            const e = Eval.rationalSurfaceDerivatives( s, uv[0], uv[1], 1 );
            const r = Vec.sub( p, e[0][0] ), su = e[1][0], sv = e[0][1];
            const a = Vec.dot( su, su ), b = Vec.dot( su, sv ), c = Vec.dot( sv, sv );
            const det = a * c - b * b;
            if (Math.abs( det ) < 1e-300) break;
            const f = Vec.dot( r, su ), g = Vec.dot( r, sv );
            const du = (c * f - b * g) / det, dv = (a * g - b * f) / det;
            const next = SurfaceIntersect.toDomain( { surface : s, periodic : F.face.periodic }, [uv[0] + du, uv[1] + dv] );
            const moved = Math.abs( next[0] - uv[0] ) + Math.abs( next[1] - uv[1] );
            uv = next;
            if (moved < 1e-14 * (dom[1] - dom[0] + dom[3] - dom[2])) break;
        }
        const q = Eval.rationalSurfacePoint( s, uv[0], uv[1] );
        return { d : Vec.dot( Vec.sub( p, q ), Fillet.normal( F, uv ) ), uv : uv };
    }

    // A blend's section at s, between its rows: points across it, parameters of its feet, the derivatives of its points
    // and of its feet's parameters along the blend (per unit of s, times dir), and its ball's centre.
    private static rowAt( F : OpenBlend, s : number, dir : number ) {
        let k = 0;
        while (k + 2 < F.rows.length && F.rows[k + 1].s < s) k++;
        const r0 = F.rows[k], r1 = F.rows[k + 1];
        const ds = Math.max( r1.s - r0.s, 1e-300 ), f = Math.max( 0, Math.min( 1, (s - r0.s) / ds ) );
        const DA = BrepSolid.domainOf( F.A.face ), DB = BrepSolid.domainOf( F.B.face );
        const uvA = SurfaceIntersect.lerpUV( DA, f, r0.uvA, r1.uvA ), uvB = SurfaceIntersect.lerpUV( DB, f, r0.uvB, r1.uvB );
        const points = r0.points.map( (p, i) => Vec.add( Vec.mul( 1 - f, p ), Vec.mul( f, r1.points[i] ) ) );
        const tangents = r0.tangents.map( (t, i) => Vec.add( Vec.mul( 1 - f, t ), Vec.mul( f, r1.tangents[i] ) ) );
        const m = points.length - 1;
        points[0] = Eval.rationalSurfacePoint( F.A.face.surface, uvA[0], uvA[1] );
        points[m] = Eval.rationalSurfacePoint( F.B.face.surface, uvB[0], uvB[1] );
        const dP = r0.points.map( (p, i) => Vec.mul( dir / ds, Vec.sub( r1.points[i], p ) ) );
        const duv = (D : ReturnType<typeof BrepSolid.domainOf>, a : UV, b : UV) : UV => {
            const bb = SurfaceIntersect.lerpUV( D, 1, a, b ), dd = SurfaceIntersect.domain( D.surface );
            // lerpUV wraps into the domain: undo the wrap
            const out : UV = [bb[0] - a[0], bb[1] - a[1]];
            for (let c = 0; c < 2; c++) if (D.periodic != null && D.periodic[c]) {
                const per = dd[2 * c + 1] - dd[2 * c];
                while (out[c] > per / 2) out[c] -= per;
                while (out[c] < -per / 2) out[c] += per;
            }
            return [out[0] * dir / ds, out[1] * dir / ds];
        };
        return { s : s, points : points, tangents : tangents, uvA : uvA, uvB : uvB, dP : dP, duvA : duv( DA, r0.uvA, r1.uvA ), duvB : duv( DB, r0.uvB, r1.uvB ),
                 centre : Vec.add( Vec.mul( 1 - f, r0.centre ), Vec.mul( f, r1.centre ) ) };
    }

    // The second derivative of a blend's sections along it at s (per unit of s squared), point by point across: a
    // second difference of the three rows around s.
    private static rowSecond( F : OpenBlend, s : number ) : Array<Point> {
        const n = F.rows.length;
        let j = 1;
        for (let k = 1; k < n - 1; k++) if (Math.abs( F.rows[k].s - s ) < Math.abs( F.rows[j].s - s )) j = k;
        const a = F.rows[j - 1], b = F.rows[j], c = F.rows[j + 1];
        const h0 = Math.max( b.s - a.s, 1e-300 ), h1 = Math.max( c.s - b.s, 1e-300 );
        return b.points.map( (p, i) => Vec.mul( 2 / (h0 + h1),
            Vec.sub( Vec.mul( 1 / h1, Vec.sub( c.points[i], p ) ), Vec.mul( 1 / h0, Vec.sub( p, a.points[i] ) ) ) ) );
    }

    // The second derivative of a surface along a curve on it through uv with velocity w (w in its tangent plane):
    // S_uu du^2 + 2 S_uv du dv + S_vv dv^2, where w = S_u du + S_v dv. Its normal part is |w|^2 times the normal
    // curvature in w's direction, which is what a G2 ribbon must match.
    private static faceSecond( surface : NurbsSurfaceData, uv : UV, w : Point ) : Point {
        const d = Eval.rationalSurfaceDerivatives( surface, uv[0], uv[1], 2 );
        const Su = d[1][0], Sv = d[0][1];
        const E = Vec.dot( Su, Su ), Fm = Vec.dot( Su, Sv ), G = Vec.dot( Sv, Sv ), det = E * G - Fm * Fm;
        if (!(Math.abs( det ) > 1e-300)) return [0, 0, 0];
        const a = Vec.dot( w, Su ), b = Vec.dot( w, Sv );
        const du = (G * a - Fm * b) / det, dv = (E * b - Fm * a) / det;
        return Vec.add( Vec.add( Vec.mul( du * du, d[2][0] ), Vec.mul( 2 * du * dv, d[1][1] ) ), Vec.mul( dv * dv, d[0][2] ) );
    }

    // The triangle on a sphere bounded by three arcs between three feet (each arc's points given from one foot to
    // another, in any direction): a constrained triangulation of its gnomonic projection, with points inside.
    // Flat: the plane triangle between the feet (a chamfer's corner).
    private static sphereTriangle( c : Point, r : number, feet : Array<Point>, arcs : Array<Array<Point>>, side : number, bends : Array<Bend> = [], flat : boolean = false )
        : { points : Array<Point>, triangles : Array<[number, number, number]>, reversed : boolean, surface : NurbsSurfaceData } | null {
        // chain the arcs into one loop: foot 0 -> ... -> back to foot 0
        const loop : Array<Point> = [];
        const left = arcs.slice();
        let at = feet[0];
        while (left.length > 0) {
            const k = left.findIndex( a => a[0] === at || a[a.length - 1] === at );
            if (k < 0) return null;
            let a = left.splice( k, 1 )[0];
            if (a[0] !== at) a = a.slice().reverse();
            loop.push( ...a.slice( 0, a.length - 1 ) );
            at = a[a.length - 1];
        }
        if (at !== feet[0]) return null;
        const d = feet.map( f => Vec.normalized( Vec.sub( f, c ) ) );
        const axis = Vec.normalized( Vec.add( d[0], Vec.add( d[1], d[2] ) ) );
        const e1 = Vec.normalized( Vec.cross( axis, Math.abs( axis[0] ) < 0.9 ? [1, 0, 0] : [0, 1, 0] ) ), e2 = Vec.cross( axis, e1 );
        const project = (p : Point) : [number, number] => { const x = Vec.sub( p, c ), z = Vec.dot( x, axis ); return [Vec.dot( x, e1 ) / z, Vec.dot( x, e2 ) / z]; };
        const points = loop.slice(), xy = loop.map( project );
        const n = loop.length;
        const edges : Array<[number, number]> = loop.map( (_, k) => [k, (k + 1) % n] as [number, number] );
        // inside: a barycentric grid of the three directions, pushed onto the sphere
        const g = Math.max( 2, Math.round( n / 3 ) );
        for (let i = 1; i < g; i++) for (let j = 1; i + j < g; j++) {
            const w = [i / g, j / g, 1 - (i + j) / g];
            let p = flat ? Vec.add( Vec.mul( w[0], feet[0] ), Vec.add( Vec.mul( w[1], feet[1] ), Vec.mul( w[2], feet[2] ) ) )
                         : Vec.add( c, Vec.mul( r, Vec.normalized( Vec.add( Vec.mul( w[0], d[0] ), Vec.add( Vec.mul( w[1], d[1] ), Vec.mul( w[2], d[2] ) ) ) ) ) );
            // curvature-continuous sides: carry their departure from the ball's arcs inside, each side's weighted by
            // (w_j w_k)^2 (Nielsen's side-vertex weights: 1 on that side, 0 on the others)
            if (bends.length == 3) {
                let sum = 0.0, shift : Point = [0, 0, 0];
                for (const b of bends) sum += Math.pow( w[b.i] * w[b.j], 2 );
                for (const b of bends) {
                    const wt = Math.pow( w[b.i] * w[b.j], 2 ) / sum;
                    const dir = Vec.add( Vec.mul( w[b.i], d[b.i] ), Vec.mul( w[b.j], d[b.j] ) );
                    const phi = FilletCorner.angle( d[b.i], dir ) / b.total;
                    shift = Vec.add( shift, Vec.mul( wt, FilletCorner.lookup( b, phi ) ) );
                }
                p = Vec.add( p, shift );
            }
            points.push( p ); xy.push( project( p ) );
        }
        const tris = cdt2d( xy, edges, { exterior : false } ) as Array<[number, number, number]>;
        if (tris.length == 0) return null;
        // outward: away from the centre on a convex corner (the ball is in the material), towards it on a concave one
        const triangles = tris.map( t => {
            const nrm = Vec.cross( Vec.sub( points[t[1]], points[t[0]] ), Vec.sub( points[t[2]], points[t[0]] ) );
            const out = Vec.dot( nrm, Vec.sub( points[t[0]], c ) ) * -side > 0;
            return (out ? [t[0], t[1], t[2]] : [t[0], t[2], t[1]]) as [number, number, number];
        } );
        // a chamfer's corner lies on the plane of its feet: a parallelogram round the triangle
        const surface = flat ? Make.fourPointSurface( feet[0], feet[1], Vec.add( feet[1], Vec.sub( feet[2], feet[0] ) ), feet[2], 1 )
                           : Make.sphericalSurface( c, axis, e1, r );
        return { points : points, triangles : triangles, reversed : false, surface : surface };
    }

    // The angle between two vectors, robust where they are parallel.
    private static angle( a : Point, b : Point ) : number {
        return Math.atan2( Vec.norm( Vec.cross( a, b ) ), Vec.dot( a, b ) );
    }

    // A side's departure from the ball's arc at a fraction of the arc's angle, interpolated from its samples.
    private static lookup( b : Bend, phi : number ) : Point {
        let k = 0;
        while (k + 2 < b.angle.length && b.angle[k + 1] < phi) k++;
        const a0 = b.angle[k], a1 = b.angle[k + 1];
        const f = a1 - a0 > 1e-15 ? Math.max( 0, Math.min( 1, (phi - a0) / (a1 - a0) ) ) : 0;
        return Vec.add( Vec.mul( 1 - f, b.shift[k] ), Vec.mul( f, b.shift[k + 1] ) );
    }

    // The blend between its two trims: triangles over a constrained triangulation of its (s, t) rectangle, and its
    // contact curves as face cuts. Null if the trims overlap.
    public static build( F : OpenBlend ) : FilletResult | null {
        const t0 = F.trims[0], t1 = F.trims[1];
        if (t0 == null || t1 == null) return null;
        const m = F.m;
        let W = 0.0;
        for (const r of F.rows) W += Vec.dist( r.points[0], r.points[m >> 1] ) + Vec.dist( r.points[m >> 1], r.points[m] );
        W /= F.rows.length;
        const ds = (F.rows[F.rows.length - 1].s - F.rows[0].s) / (F.rows.length - 1);
        const margin = 0.3 * Math.min( ds, W / m );
        // the trims' s at any t, by linear interpolation along them
        const sAt = (trim : Array<TrimPoint>, t : number) => {
            for (let k = 1; k < trim.length; k++) {
                const a = trim[k - 1], b = trim[k];
                if (t <= b.t + 1e-12 || k == trim.length - 1) {
                    const f = b.t - a.t > 1e-12 ? Math.max( 0, Math.min( 1, (t - a.t) / (b.t - a.t) ) ) : 0;
                    return a.s + f * (b.s - a.s);
                }
            }
            return trim[0].s;
        };
        for (let i = 0; i <= m; i++) if (sAt( t1, i / m ) - sAt( t0, i / m ) < 2 * margin) return null;

        const pts : Array<Point> = [], xy : Array<[number, number]> = [];
        const add = (p : Point, s : number, t : number) => { pts.push( p ); xy.push( [s, t * W] ); return pts.length - 1; };
        const inRange = (s : number, t : number) => s > sAt( t0, t ) + margin && s < sAt( t1, t ) - margin;
        // the boundary: A's contact, the end trim, B's contact backwards, the start trim backwards
        const boundary : Array<number> = [];
        const side = (col : number) => {
            const out : Array<{ id : number, k : number }> = [];
            F.rows.forEach( (r, k) => { if (inRange( r.s, col / m )) out.push( { id : add( r.points[col], r.s, col / m ), k : k } ); } );
            return out;
        };
        const start0 = add( t0[0].point, t0[0].s, 0 );
        const sideA = side( 0 );
        const end : Array<number> = t1.map( p => add( p.point, p.s, p.t ) );
        const sideB = side( m );
        const start : Array<number> = [];
        for (let k = t0.length - 1; k >= 1; k--) start.push( add( t0[k].point, t0[k].s, t0[k].t ) );
        boundary.push( start0, ...sideA.map( x => x.id ), ...end, ...sideB.slice().reverse().map( x => x.id ), ...start );
        const edges : Array<[number, number]> = boundary.map( (id, k) => [id, boundary[(k + 1) % boundary.length]] as [number, number] );
        for (let k = 0; k < F.rows.length; k++) for (let i = 1; i < m; i++) {
            const r = F.rows[k];
            if (inRange( r.s, i / m )) add( r.points[i], r.s, i / m );
        }
        const tris = cdt2d( xy, edges, { exterior : false } ) as Array<[number, number, number]>;
        if (tris.length == 0) return null;
        // counter-clockwise in (s, t), with s along the edge and t from A to B, as the closed blends' (k, i) grid
        const triangles : Array<[number, number, number]> = tris.map( tr => {
            const a = xy[tr[0]], b = xy[tr[1]], c = xy[tr[2]];
            const o = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            return (o < 0 ? [tr[0], tr[1], tr[2]] : [tr[0], tr[2], tr[1]]) as [number, number, number];
        } );
        // the centre of the row nearest the first triangle
        const s0 = xy[triangles[0][0]][0];
        let near = F.rows[0];
        for (const r of F.rows) if (Math.abs( r.s - s0 ) < Math.abs( near.s - s0 )) near = r;
        const reversed = Fillet.orientTriangles( pts, triangles, near.centre, F.side );

        // the contact curves, from the start trim to the end trim
        const contact = (col : number, list : Array<{ id : number, k : number }>, face : BrepFace) : Array<FaceCut> => {
            const first = col == 0 ? t0[0] : t0[t0.length - 1], last = col == 0 ? t1[0] : t1[t1.length - 1];
            const uv : Array<UV> = [first.uv as UV], points : Array<Point> = [first.point], seam : Array<number> = [0];
            for (const x of list) {
                const r = F.rows[x.k];
                uv.push( col == 0 ? r.uvA : r.uvB ); points.push( pts[x.id] ); seam.push( col == 0 ? r.seamA : r.seamB );
            }
            uv.push( last.uv as UV ); points.push( last.point ); seam.push( 0 );
            return BrepBoolean.facePieces( face, uv, seam, points, false );
        };
        const real = F.rows.slice( 2, F.rows.length - 2 );
        const arcs = real.map( (r, k) => Fillet.crossSection( F.A, F.B, F.sections[Math.min( k, F.sections.length - 1 )], F.shape ) );
        const surface = Make.loftedSurface( arcs, Math.min( 3, arcs.length - 1 ) );
        const cutA = contact( 0, sideA, F.A.face ), cutB = contact( m, sideB, F.B.face );
        for (const x of F.extra) {
            const face = x.side == 0 ? F.A.face : F.B.face;
            (x.side == 0 ? cutA : cutB).push( ...BrepBoolean.facePieces( face, x.uv, x.uv.map( _ => 0 ), x.points, false ) );
        }
        return { sections : F.sections, side : F.side, cutA : cutA, cutB : cutB,
                 surface : surface, points : pts, triangles : triangles, reversed : reversed, closed : false };
    }

    // Where the polyline p crosses the polyline q, both in a face's parameters: the first crossing, as fractional vertex
    // indices along each.
    private static polyCross( F : BrepFace, p : Array<UV>, q : Array<UV> ) : [number, number] | null {
        const d = SurfaceIntersect.domain( F.surface );
        const span = [d[1] - d[0], d[3] - d[2]];
        const jump = (a : UV, b : UV) => (F.periodic[0] && Math.abs( a[0] - b[0] ) > span[0] / 2) || (F.periodic[1] && Math.abs( a[1] - b[1] ) > span[1] / 2);
        let best : [number, number] | null = null;
        for (let i = 0; i + 1 < p.length; i++) {
            if (jump( p[i], p[i + 1] )) continue;
            for (let j = 0; j + 1 < q.length; j++) {
                if (jump( q[j], q[j + 1] )) continue;
                const st = FilletCorner.segCross( p[i], p[i + 1], q[j], q[j + 1], span );
                if (st == null) continue;
                if (best == null || i + j + st[0] + st[1] < best[0] + best[1]) best = [i + st[0], j + st[1]];
            }
        }
        return best;
    }

    // Parameters (s, t) in [0, 1] where segments p0-p1 and q0-q1 cross.
    private static segCross( p0 : UV, p1 : UV, q0 : UV, q1 : UV, span : Array<number> ) : [number, number] | null {
        const ax = (p1[0] - p0[0]) / span[0], ay = (p1[1] - p0[1]) / span[1];
        const bx = (q1[0] - q0[0]) / span[0], by = (q1[1] - q0[1]) / span[1];
        const cx = (q0[0] - p0[0]) / span[0], cy = (q0[1] - p0[1]) / span[1];
        const den = ax * by - ay * bx;
        if (Math.abs( den ) < 1e-18) return null;
        const s = (cx * by - cy * bx) / den, t = (cx * ay - cy * ax) / den;
        if (s < 0 || s > 1 || t < 0 || t > 1) return null;
        return [s, t];
    }

    // A fractional index along a list of rows: the two rows around it, the fraction between them, and the s there.
    private static lerpRow( F : OpenBlend, idx : Array<number>, x : number ) : { k0 : number, k1 : number, f : number, s : number } {
        const i = Math.min( idx.length - 2, Math.floor( x ) ), f = x - i;
        const k0 = idx[i], k1 = idx[i + 1];
        return { k0 : k0, k1 : k1, f : f, s : F.rows[k0].s + f * (F.rows[k1].s - F.rows[k0].s) };
    }

    // Whether parameters lie in a face's domain (periodic directions always do).
    private static inside( F : BrepFace, uv : UV ) : boolean {
        const d = SurfaceIntersect.domain( F.surface );
        for (let a = 0; a < 2; a++) {
            if (F.periodic[a]) continue;
            if (uv[a] < d[2 * a] - 1e-12 || uv[a] > d[2 * a + 1] + 1e-12) return false;
        }
        return true;
    }

    // The point of a face's domain side (parameter `axis` fixed at uv's value) nearest to a target, from uv.
    private static onSide( F : BrepFace, uv : UV, axis : number, target : Point ) : UV {
        const other = 1 - axis;
        const d = SurfaceIntersect.domain( F.surface );
        let w = uv[other];
        for (let it = 0; it < 30; it++) {
            const ds = Eval.rationalSurfaceDerivatives( F.surface, axis == 0 ? uv[0] : w, axis == 0 ? w : uv[1], 2 );
            const p = ds[0][0];
            const t = other == 0 ? ds[1][0] : ds[0][1], tt = other == 0 ? ds[2][0] : ds[0][2];
            const r = Vec.sub( p, target );
            const g = Vec.dot( r, t ), h = Vec.dot( t, t ) + Vec.dot( r, tt );
            if (Math.abs( h ) < 1e-300) break;
            const step = -g / (h > 0 ? h : Vec.dot( t, t ));
            w += step;
            if (F.periodic[other]) { const span = d[2 * other + 1] - d[2 * other]; while (w < d[2 * other]) w += span; while (w > d[2 * other + 1]) w -= span; }
            else w = Math.max( d[2 * other], Math.min( d[2 * other + 1], w ) );
            if (Math.abs( step ) < 1e-14 * (d[2 * other + 1] - d[2 * other])) break;
        }
        const out : UV = [uv[0], uv[1]];
        out[other] = w;
        return out;
    }

    // Where column i of F1 (its points across all its rows near the corner) goes through F2's triangles near the corner:
    // the point, the s on F1 and the (s, t) on F2. Of several, the one nearest to `prev`.
    private static columnHit( F1 : OpenBlend, n1 : Array<number>, i : number, F2 : OpenBlend, n2 : Array<number>, prev : Point )
        : { point : Point, s1 : number, s2 : number, t2 : number } | null {
        let best : { point : Point, s1 : number, s2 : number, t2 : number } | null = null, bestD = Infinity;
        const m2 = F2.m;
        for (let a = 0; a + 1 < n1.length; a++) {
            const r0 = F1.rows[n1[a]], r1 = F1.rows[n1[a + 1]];
            const p = r0.points[i], q = r1.points[i];
            for (let b = 0; b + 1 < n2.length; b++) {
                const R0 = F2.rows[n2[b]], R1 = F2.rows[n2[b + 1]];
                for (let j = 0; j < m2; j++) {
                    const quad = [R0.points[j], R0.points[j + 1], R1.points[j + 1], R1.points[j]];
                    // (s, t) of the quad's corners on F2
                    const st = [[R0.s, j / m2], [R0.s, (j + 1) / m2], [R1.s, (j + 1) / m2], [R1.s, j / m2]];
                    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
                        const h = FilletCorner.segTri( p, q, quad[tri[0]], quad[tri[1]], quad[tri[2]] );
                        if (h == null) continue;
                        const x = Vec.add( p, Vec.mul( h.f, Vec.sub( q, p ) ) );
                        const dd = Vec.dist( x, prev );
                        if (dd >= bestD) continue;
                        bestD = dd;
                        const w0 = 1 - h.u - h.v;
                        best = { point : x, s1 : r0.s + h.f * (r1.s - r0.s),
                                 s2 : w0 * st[tri[0]][0] + h.u * st[tri[1]][0] + h.v * st[tri[2]][0],
                                 t2 : w0 * st[tri[0]][1] + h.u * st[tri[1]][1] + h.v * st[tri[2]][1] };
                    }
                }
            }
        }
        return best;
    }

    // Segment p-q through triangle a-b-c (Moller and Trumbore): the fraction along the segment and the barycentric
    // weights of b and c.
    private static segTri( p : Point, q : Point, a : Point, b : Point, c : Point ) : { f : number, u : number, v : number } | null {
        const d = Vec.sub( q, p ), e1 = Vec.sub( b, a ), e2 = Vec.sub( c, a );
        const h = Vec.cross( d, e2 ), det = Vec.dot( e1, h );
        if (Math.abs( det ) < 1e-300) return null;
        const inv = 1 / det, sv = Vec.sub( p, a );
        const u = inv * Vec.dot( sv, h );
        const eps = 1e-9;
        if (u < -eps || u > 1 + eps) return null;
        const qv = Vec.cross( sv, e1 );
        const v = inv * Vec.dot( d, qv );
        if (v < -eps || u + v > 1 + eps) return null;
        const f = inv * Vec.dot( e2, qv );
        if (f < -eps || f > 1 + eps) return null;
        return { f : Math.max( 0, Math.min( 1, f ) ), u : u, v : v };
    }
}
