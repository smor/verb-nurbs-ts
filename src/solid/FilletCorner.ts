import cdt2d from "cdt2d";
import { NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { Make } from "../eval/Make.js";
import { BrepBoolean } from "./BrepBoolean.js";
import { BrepFace, BrepSolid, FaceCut } from "./Brep.js";
import { Fillet, FilletResult, FilletSection, FilletSide } from "./Fillet.js";
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
// Where a contact curve reaches the third edge.
interface Reach { point : Point; s : number; uv : UV; f : number | null; isA1 : boolean; }

export interface OpenBlend {
    A : FilletSide;
    B : FilletSide;
    radius : number;
    side : number;
    sections : Array<FilletSection>;
    rows : Array<{ s : number, points : Array<Point>, uvA : UV, uvB : UV, seamA : number, seamB : number, centre : Point }>;
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
    public static open( A : FilletSide, B : FilletSide, found : { sections : Array<FilletSection>, side : number, before : Array<FilletSection>, after : Array<FilletSection> }, radius : number ) : OpenBlend {
        let sections = found.sections, side = found.side;
        let m = Fillet.arcDivisions( sections, radius, false );
        let rows : OpenBlend["rows"] = [];
        let s = 0.0;
        // sections solved past the ends where the faces carry on; extrapolated rows where they do not
        let all = found.before.length == 2 && found.after.length == 2 ? found.before.concat( sections, found.after ) : sections;
        all.forEach( (x, k) => {
            let arc = Fillet.arc( x.pa, x.centre, x.pb );
            let pts : Array<Point> = [x.pa];
            for (let i = 1; i < m; i++) pts.push( Eval.rationalCurvePoint( arc, i / m ) );
            pts.push( x.pb );
            if (k > 0) s += Vec.dist( pts[m >> 1], rows[k - 1].points[m >> 1] );
            rows.push( { s : s, points : pts, uvA : x.a, uvB : x.b, seamA : x.seamA, seamB : x.seamB, centre : x.centre } );
        } );
        // two rows past each end, along the end rows' direction (the edge's ends are no further than a few steps out)
        let extend = (r0 : OpenBlend["rows"][0], r1 : OpenBlend["rows"][0], j : number) : OpenBlend["rows"][0] => {
            let d = Math.max( Math.abs( r0.s - r1.s ), 1e-12 );
            let move = (p : Point, q : Point) => Vec.add( p, Vec.mul( j, Vec.sub( p, q ) ) );
            let moveUV = (F : FilletSide, p : UV, q : UV) : UV => {
                let D = BrepSolid.domainOf( F.face ), dd = SurfaceIntersect.domain( F.face.surface );
                let qq : UV = [q[0], q[1]];
                for (let a = 0; a < 2; a++) {
                    // q on p's side of a seam
                    let span = dd[2 * a + 1] - dd[2 * a];
                    if (F.face.periodic[a] && Math.abs( qq[a] - p[a] ) > span / 2) qq[a] += qq[a] < p[a] ? span : -span;
                }
                let x : UV = [p[0] + j * (p[0] - qq[0]), p[1] + j * (p[1] - qq[1])];
                return FilletCorner.inside( F.face, x ) ? SurfaceIntersect.toDomain( D, x ) : x;
            };
            let pts = r0.points.map( (p, i) => move( p, r1.points[i] ) );
            let uvA = moveUV( A, r0.uvA, r1.uvA ), uvB = moveUV( B, r0.uvB, r1.uvB );
            // the contact points stay on their faces where the faces go on
            if (FilletCorner.inside( A.face, uvA )) pts[0] = Eval.rationalSurfacePoint( A.face.surface, uvA[0], uvA[1] );
            if (FilletCorner.inside( B.face, uvB )) pts[m] = Eval.rationalSurfacePoint( B.face.surface, uvB[0], uvB[1] );
            return { s : r0.s + j * (r0.s - r1.s) / d * d, points : pts, uvA : uvA, uvB : uvB, seamA : 0, seamB : 0, centre : move( r0.centre, r1.centre ) };
        };
        if (all !== sections) return { A : A, B : B, radius : radius, side : side, sections : sections, rows : rows, m : m, trims : [null, null], extra : [] };
        let n = rows.length;
        let before = [2, 1].map( j => extend( rows[0], rows[1], j ) );
        let after = [1, 2].map( j => extend( rows[n - 1], rows[n - 2], j ) );
        return { A : A, B : B, radius : radius, side : side, sections : sections, rows : before.concat( rows, after ), m : m, trims : [null, null], extra : [] };
    }

    // Trim blends F1 and F2 where they meet, at their ends e1 and e2 (0: start, 1: end). b1 and b2 say which face of
    // each blend is the shared face b (0: its face A, 1: its face B). False if the corner cannot be built.
    //
    // Where the corner is symmetric (a box corner) the mitre runs from X to the third edge. Otherwise one blend leans
    // over the other: the mitre reaches the other's contact curve with its own face (at Y) before the third edge, and
    // the leaning blend runs on into that face, which is cut along their intersection from Y to the third edge.
    public static mitre( F1 : OpenBlend, e1 : number, b1 : number, F2 : OpenBlend, e2 : number, b2 : number, third : ThirdEdge, tol : number ) : boolean {
        FilletCorner.pending = null;
        let bFace = b1 == 0 ? F1.A.face : F1.B.face;
        let n1 = FilletCorner.near( F1, e1 ), n2 = FilletCorner.near( F2, e2 );

        // X: where the contact curves on b cross
        let cx = FilletCorner.polyCross( bFace, n1.map( k => FilletCorner.uvOn( F1, b1, k ) ), n2.map( k => FilletCorner.uvOn( F2, b2, k ) ) );
        if (cx == null) return false;
        let D = BrepSolid.domainOf( bFace );
        let at1 = FilletCorner.lerpRow( F1, n1, cx[0] ), at2 = FilletCorner.lerpRow( F2, n2, cx[1] );
        let uvX = SurfaceIntersect.lerpUV( D, at1.f, FilletCorner.uvOn( F1, b1, at1.k0 ), FilletCorner.uvOn( F1, b1, at1.k1 ) );
        let X = Eval.rationalSurfacePoint( bFace.surface, uvX[0], uvX[1] );
        let c1 : Corner = { F : F1, e : e1, b : b1, n : n1, sX : at1.s }, c2 : Corner = { F : F2, e : e2, b : b2, n : n2, sX : at2.s };

        // where each blend's other contact curve reaches the third edge
        let r1 = FilletCorner.reach( c1, third, true, tol ), r2 = FilletCorner.reach( c2, third, false, tol );
        if (r1 == null || r2 == null) return false;
        // a contact curve that goes through the other blend before it reaches the third edge
        let y2 = FilletCorner.through( c2, c1 ), y1 = FilletCorner.through( c1, c2 );
        let r = Math.min( F1.radius, F2.radius );
        let far = (y : Crossing | null, q : Reach) => y != null && Vec.dist( y.point, q.point ) > 0.1 * r;
        let ok : boolean;
        if (far( y2, r2 )) ok = FilletCorner.lean( c1, c2, X, uvX, y2 as Crossing, r1, r2, third, tol );
        else if (far( y1, r1 )) ok = FilletCorner.lean( c2, c1, X, uvX, y1 as Crossing, r2, r1, third, tol );
        else ok = FilletCorner.even( c1, c2, X, uvX, r1, r2, third, tol );
        return ok;
    }

    // rows from the end inwards, as far as a few radii from the corner
    private static near( F : OpenBlend, e : number ) : Array<number> {
        let idx = F.rows.map( (_, k) => k );
        if (e == 1) idx.reverse();
        let s0 = F.rows[idx[0]].s, reach = 6 * F.radius;
        return idx.filter( (k, j) => Math.abs( F.rows[k].s - s0 ) <= reach || j <= 4 );
    }

    private static uvOn( F : OpenBlend, side : number, k : number ) : UV { return side == 0 ? F.rows[k].uvA : F.rows[k].uvB; }

    // The symmetric corner: the mitre from X along the columns of F1 through F2, to Q on the third edge halfway
    // between where the two contact curves reach it.
    private static even( c1 : Corner, c2 : Corner, X : Point, uvX : UV, r1 : Reach, r2 : Reach, third : ThirdEdge, tol : number ) : boolean {
        let F1 = c1.F, F2 = c2.F;
        let Q : Point, uv1 : UV, uv2 : UV, insert : (() => void) | null = null;
        if (third.kind == "boundary") {
            let target = Vec.mul( 0.5, Vec.add( r1.point, r2.point ) );
            uv1 = FilletCorner.onSide( third.a1, r1.uv, third.axis1, target );
            Q = Eval.rationalSurfacePoint( third.a1.surface, uv1[0], uv1[1] );
            uv2 = FilletCorner.onSide( third.a2, r2.uv, third.axis2, Q );
        } else {
            let q = FilletCorner.onCurve( third, 0.5 * ((r1.f as number) + (r2.f as number)), tol );
            if (q == null) return false;
            Q = q.point; uv1 = q.uv1; uv2 = q.uv2; insert = q.insert;
        }
        let tb1 = c1.b == 0 ? 0 : 1, tb2 = c2.b == 0 ? 0 : 1;
        let mid1 : Array<TrimPoint> = [], mid2 : Array<TrimPoint> = [];
        let m1 = F1.m, prev = X;
        for (let step = 1; step < m1; step++) {
            let i = c1.b == 0 ? step : m1 - step;
            let hit = FilletCorner.columnHit( F1, c1.n, i, F2, c2.n, prev );
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
        let FL = L.F, FO = O.F;
        let tbL = L.b == 0 ? 0 : 1, tbO = O.b == 0 ? 0 : 1;
        let aOFace = O.b == 0 ? FO.B.face : FO.A.face;
        let lIsA1 = rL.isA1;
        // the end on the third edge, with its parameters on a_O
        let R : Point, uvL : UV, uvO : UV, insert : (() => void) | null = null;
        if (third.kind == "boundary") {
            R = rL.point; uvL = rL.uv;
            uvO = FilletCorner.onSide( aOFace, rO.uv, lIsA1 ? third.axis2 : third.axis1, R );
        } else {
            let q = FilletCorner.onCurve( third, rL.f as number, tol );
            if (q == null) return false;
            R = q.point; uvL = lIsA1 ? q.uv1 : q.uv2; uvO = lIsA1 ? q.uv2 : q.uv1; insert = q.insert;
        }
        let m = FL.m;
        let midL : Array<TrimPoint> = [], midO : Array<TrimPoint> = [], tail : Array<TrimPoint> = [];
        let prev = X, prevUV = Y.uv;
        let tY = Y.tOther; // Y's t on L
        for (let step = 1; step < m; step++) {
            let i = L.b == 0 ? step : m - step, t = i / m;
            let beforeY = L.b == 0 ? t < tY : t > tY;
            if (beforeY) {
                let hit = FilletCorner.columnHit( FL, L.n, i, FO, O.n, prev );
                if (hit == null) continue;
                midL.push( { point : hit.point, s : hit.s1, t : t } );
                midO.push( { point : hit.point, s : hit.s2, t : hit.t2 } );
                prev = hit.point;
            } else {
                let hit = FilletCorner.columnFace( FL, L.n, i, aOFace, prevUV );
                if (hit == null) continue;
                tail.push( { point : hit.point, s : hit.s, t : t, uv : hit.uv } );
                prevUV = hit.uv;
            }
        }
        if (!FilletCorner.monotone( midO, tbO )) return false;
        let yL : TrimPoint = { point : Y.point, s : Y.sOther, t : tY };
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
            let tPrev = k == 0 ? tb : mid[k - 1].t;
            if ((mid[k].t - tPrev) * (tb == 0 ? 1 : -1) < -1e-9) return false;
        }
        return true;
    }

    // Where corner c's contact curve with its own a face (its row points on that side, from the corner inwards) goes
    // through the other corner's blend: the point, s on c, (s, t) on the other, and the parameters on the a face.
    private static through( c : Corner, o : Corner ) : Crossing | null {
        let F = c.F, side = 1 - c.b, col = side == 0 ? 0 : F.m;
        let face = side == 0 ? F.A.face : F.B.face;
        for (let a = 0; a + 1 < c.n.length; a++) {
            let r0 = F.rows[c.n[a]], r1 = F.rows[c.n[a + 1]];
            let hit = FilletCorner.segBlend( r0.points[col], r1.points[col], o.F, o.n );
            if (hit == null) continue;
            let uv = SurfaceIntersect.lerpUV( BrepSolid.domainOf( face ), hit.f, side == 0 ? r0.uvA : r0.uvB, side == 0 ? r1.uvA : r1.uvB );
            return { point : hit.point, sOwn : r0.s + hit.f * (r1.s - r0.s), sOther : hit.s, tOther : hit.t, uv : uv };
        }
        return null;
    }

    // Where corner c's contact curve with its own a face reaches the third edge: the point, the s there, the
    // parameters on that face, and for a branch the fractional index along it (from the corner).
    private static reach( c : Corner, third : ThirdEdge, isA1 : boolean, tol : number ) : Reach | null {
        let F = c.F, side = 1 - c.b;
        let face = isA1 ? third.a1 : third.a2;
        let poly = c.n.map( k => FilletCorner.uvOn( F, side, k ) );
        let D = BrepSolid.domainOf( face );
        if (third.kind == "boundary") {
            let axis = isA1 ? third.axis1 : third.axis2, value = isA1 ? third.value1 : third.value2;
            for (let i = 0; i + 1 < poly.length; i++) {
                let x = poly[i][axis] - value, y = poly[i + 1][axis] - value;
                if (x != 0 && x * y > 0) continue;
                let f = x == 0 ? 0 : x / (x - y);
                let at = FilletCorner.lerpRow( F, c.n, i + f );
                let uv = SurfaceIntersect.lerpUV( D, at.f, FilletCorner.uvOn( F, side, at.k0 ), FilletCorner.uvOn( F, side, at.k1 ) );
                uv[axis] = value;
                return { point : Eval.rationalSurfacePoint( face.surface, uv[0], uv[1] ), s : at.s, uv : uv, f : null, isA1 : isA1 };
            }
            return null;
        }
        let e = third.curve;
        let order = e.points.map( (_, k) => k );
        if (!third.atStart) order.reverse();
        let own = (third.a1IsA == isA1) ? e.uvA : e.uvB;
        let x = FilletCorner.polyCross( face, poly, order.map( k => own[k] ) );
        if (x == null) return null;
        let at = FilletCorner.lerpRow( F, c.n, x[0] );
        let uv = SurfaceIntersect.lerpUV( D, at.f, FilletCorner.uvOn( F, side, at.k0 ), FilletCorner.uvOn( F, side, at.k1 ) );
        return { point : Eval.rationalSurfacePoint( face.surface, uv[0], uv[1] ), s : at.s, uv : uv, f : x[1], isA1 : isA1 };
    }

    // The point at a fractional index along a third edge that is a branch (counted from the corner), refined onto both
    // faces, and a function that puts it into the branch.
    private static onCurve( third : ThirdEdge, f : number, tol : number ) : { point : Point, uv1 : UV, uv2 : UV, insert : () => void } | null {
        if (third.kind != "curve") return null;
        let e = third.curve;
        let order = e.points.map( (_, k) => k );
        if (!third.atStart) order.reverse();
        let i = Math.min( order.length - 2, Math.floor( f ) ), fr = f - i;
        let k0 = order[i], k1 = order[i + 1];
        let fa = third.a1IsA ? third.a1 : third.a2, fb = third.a1IsA ? third.a2 : third.a1;
        let DA = BrepSolid.domainOf( fa ), DB = BrepSolid.domainOf( fb );
        let r = SurfaceIntersect.refine( DA, DB, SurfaceIntersect.lerpUV( DA, fr, e.uvA[k0], e.uvA[k1] ), SurfaceIntersect.lerpUV( DB, fr, e.uvB[k0], e.uvB[k1] ), tol );
        if (r == null) return null;
        let res = r, p0 = e.points[k0], p1 = e.points[k1];
        let insert = () => {
            // between the same two vertices (found again: another corner may have put a point into the branch since)
            let j0 = e.points.indexOf( p0 ), j1 = e.points.indexOf( p1 );
            if (j0 < 0 || j1 < 0) return;
            // the segment between them nearest to the point
            let lo = Math.min( j0, j1 ), best = Infinity;
            for (let j = Math.min( j0, j1 ); j < Math.max( j0, j1 ); j++) {
                let a = e.points[j], ab = Vec.sub( e.points[j + 1], a ), l2 = Math.max( Vec.dot( ab, ab ), 1e-300 );
                let t = Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( res.point, a ), ab ) / l2 ) );
                let dd = Vec.dist( res.point, Vec.add( a, Vec.mul( t, ab ) ) );
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
        let m = F.m;
        let best : { point : Point, f : number, s : number, t : number } | null = null;
        for (let b = 0; b + 1 < idx.length; b++) {
            let R0 = F.rows[idx[b]], R1 = F.rows[idx[b + 1]];
            for (let j = 0; j < m; j++) {
                let quad = [R0.points[j], R0.points[j + 1], R1.points[j + 1], R1.points[j]];
                let st = [[R0.s, j / m], [R0.s, (j + 1) / m], [R1.s, (j + 1) / m], [R1.s, j / m]];
                for (let tri of [[0, 1, 2], [0, 2, 3]]) {
                    let h = FilletCorner.segTri( p, q, quad[tri[0]], quad[tri[1]], quad[tri[2]] );
                    if (h == null || (best != null && h.f >= best.f)) continue;
                    let w0 = 1 - h.u - h.v;
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
        let D = BrepSolid.domainOf( face );
        for (let a = 0; a + 1 < idx.length; a++) {
            let r0 = F.rows[idx[a]], r1 = F.rows[idx[a + 1]];
            let p = r0.points[i], q = r1.points[i], d = Vec.sub( q, p );
            let uv : UV = [uv0[0], uv0[1]], f = 0.5;
            let ok = false;
            for (let it = 0; it < 30; it++) {
                let ds = Eval.rationalSurfaceDerivatives( face.surface, uv[0], uv[1], 1 );
                let res = Vec.sub( ds[0][0], Vec.add( p, Vec.mul( f, d ) ) );
                if (Vec.norm( res ) < 1e-10 * Math.max( 1, F.radius )) { ok = true; break; }
                let J = [0, 1, 2].map( k => [ds[1][0][k], ds[0][1][k], -d[k]] );
                let step : Array<number>;
                try { step = Mat.solve( J, Vec.mul( -1, res ) ); } catch (e) { break; }
                if (step.some( x => !isFinite( x ) )) break;
                uv = Fillet.clampTo( D, [uv[0] + step[0], uv[1] + step[1]], 0.3 );
                f += step[2];
                if (Math.abs( f ) > 4) break;
            }
            if (!ok || f < -1e-9 || f > 1 + 1e-9) continue;
            let pt = Eval.rationalSurfacePoint( face.surface, uv[0], uv[1] );
            return { point : pt, s : r0.s + f * (r1.s - r0.s), uv : uv };
        }
        return null;
    }

    // A ball corner: three blends of one radius, all convex or all concave, between three faces that meet at a point.
    // The ball that touches all three faces stops each blend at the section through its centre c; the corner is the
    // spherical triangle on that ball between the three end arcs, and each face's two contact curves meet at the
    // ball's foot on it. Returns the corner patch, or null where the ball cannot be placed.
    public static ball( ends : Array<{ F : OpenBlend, e : number, keys : [string, string] }>, tol : number )
        : { points : Array<Point>, triangles : Array<[number, number, number]>, reversed : boolean, surface : NurbsSurfaceData, centre : Point, radius : number } | null {
        if (ends.length != 3) return null;
        let r = ends[0].F.radius, side = ends[0].F.side;
        if (ends.some( x => Math.abs( x.F.radius - r ) > 1e-9 * Math.max( 1, r ) || x.F.side != side )) return null;
        // the three faces, each with its side as some blend sees it and a starting guess from that blend's end row
        let keys : Array<string> = [];
        for (let x of ends) for (let k of x.keys) if (!keys.includes( k )) keys.push( k );
        if (keys.length != 3) return null;
        let faces = keys.map( k => {
            let x = ends.find( y => y.keys.includes( k ) ) as typeof ends[0];
            let a = x.keys[0] == k ? 0 : 1;
            let row = x.F.rows[x.e == 0 ? 2 : x.F.rows.length - 3];
            return { key : k, side : a == 0 ? x.F.A : x.F.B, uv : (a == 0 ? row.uvA : row.uvB).slice() as UV };
        } );
        // Newton on the six parameters: the three offsets reach one centre
        let sr = side * r;
        let off = (i : number, uv : UV) => {
            let d = Eval.rationalSurfaceDerivatives( faces[i].side.face.surface, uv[0], uv[1], 1 );
            let nn = Vec.mul( faces[i].side.sign, Vec.normalized( Vec.cross( d[1][0], d[0][1] ) ) );
            return Vec.add( d[0][0], Vec.mul( sr, nn ) );
        };
        let uv = faces.map( f => f.uv );
        let D = faces.map( f => BrepSolid.domainOf( f.side.face ) );
        let spans = faces.map( f => { let d = SurfaceIntersect.domain( f.side.face.surface ); return [d[1] - d[0], d[3] - d[2]]; } );
        let ok = false;
        for (let it = 0; it < 50; it++) {
            let o = [0, 1, 2].map( i => off( i, uv[i] ) );
            let R = Vec.sub( o[0], o[1] ).concat( Vec.sub( o[0], o[2] ) );
            if (Vec.norm( R ) < tol * Math.max( 1, r )) { ok = true; break; }
            let J : Array<Array<number>> = [0, 1, 2, 3, 4, 5].map( _ => [0, 0, 0, 0, 0, 0] );
            for (let i = 0; i < 3; i++) for (let k = 0; k < 2; k++) {
                let h = spans[i][k] * 1e-7;
                let q : UV = [uv[i][0], uv[i][1]]; q[k] += h;
                let dO = Vec.mul( 1 / h, Vec.sub( off( i, q ), o[i] ) );
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
            let big = Math.max( ...[0, 1, 2].map( i => Math.max( Math.abs( step[2 * i] ) / spans[i][0], Math.abs( step[2 * i + 1] ) / spans[i][1] ) ) );
            let f = big > 0.1 ? 0.1 / big : 1;
            uv = [0, 1, 2].map( i => Fillet.clampTo( D[i], [uv[i][0] + f * step[2 * i], uv[i][1] + f * step[2 * i + 1]], 0.3 ) );
        }
        if (!ok) return null;
        let c = Vec.mul( 1 / 3, Vec.add( off( 0, uv[0] ), Vec.add( off( 1, uv[1] ), off( 2, uv[2] ) ) ) );
        let feet = [0, 1, 2].map( i => Eval.rationalSurfacePoint( faces[i].side.face.surface, uv[i][0], uv[i][1] ) );
        // the centre must lie near the corner, within reach of each blend's rows
        let arcs : Array<Array<Point>> = [];
        for (let x of ends) {
            let F = x.F, ia = keys.indexOf( x.keys[0] ), ib = keys.indexOf( x.keys[1] );
            // where the blend's centres pass the ball's centre
            let best = Infinity, sAt = 0;
            for (let k = 0; k + 1 < F.rows.length; k++) {
                let a = F.rows[k].centre, b = F.rows[k + 1].centre, ab = Vec.sub( b, a ), l2 = Math.max( Vec.dot( ab, ab ), 1e-300 );
                let t = Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( c, a ), ab ) / l2 ) );
                let dd = Vec.dist( c, Vec.add( a, Vec.mul( t, ab ) ) );
                if (dd < best) { best = dd; sAt = F.rows[k].s + t * (F.rows[k + 1].s - F.rows[k].s); }
            }
            if (best > 0.25 * r) return null;
            let arc = Fillet.arc( feet[ia], c, feet[ib] );
            let pts : Array<Point> = [feet[ia]];
            for (let i = 1; i < F.m; i++) pts.push( Eval.rationalCurvePoint( arc, i / F.m ) );
            pts.push( feet[ib] );
            F.trims[x.e] = pts.map( (p, i) => ({ point : p, s : sAt, t : i / F.m, uv : i == 0 ? uv[ia] : i == F.m ? uv[ib] : undefined }) );
            arcs.push( pts );
        }
        let patch = FilletCorner.sphereTriangle( c, r, feet, arcs, side );
        return patch == null ? null : Object.assign( patch, { centre : c, radius : r } );
    }

    // The triangle on a sphere bounded by three arcs between three feet (each arc's points given from one foot to
    // another, in any direction): a constrained triangulation of its gnomonic projection, with points inside.
    private static sphereTriangle( c : Point, r : number, feet : Array<Point>, arcs : Array<Array<Point>>, side : number )
        : { points : Array<Point>, triangles : Array<[number, number, number]>, reversed : boolean, surface : NurbsSurfaceData } | null {
        // chain the arcs into one loop: foot 0 -> ... -> back to foot 0
        let loop : Array<Point> = [];
        let left = arcs.slice(), at = feet[0];
        while (left.length > 0) {
            let k = left.findIndex( a => a[0] === at || a[a.length - 1] === at );
            if (k < 0) return null;
            let a = left.splice( k, 1 )[0];
            if (a[0] !== at) a = a.slice().reverse();
            loop.push( ...a.slice( 0, a.length - 1 ) );
            at = a[a.length - 1];
        }
        if (at !== feet[0]) return null;
        let d = feet.map( f => Vec.normalized( Vec.sub( f, c ) ) );
        let axis = Vec.normalized( Vec.add( d[0], Vec.add( d[1], d[2] ) ) );
        let e1 = Vec.normalized( Vec.cross( axis, Math.abs( axis[0] ) < 0.9 ? [1, 0, 0] : [0, 1, 0] ) ), e2 = Vec.cross( axis, e1 );
        let flat = (p : Point) : [number, number] => { let x = Vec.sub( p, c ), z = Vec.dot( x, axis ); return [Vec.dot( x, e1 ) / z, Vec.dot( x, e2 ) / z]; };
        let points = loop.slice(), xy = loop.map( flat );
        let n = loop.length;
        let edges : Array<[number, number]> = loop.map( (_, k) => [k, (k + 1) % n] as [number, number] );
        // inside: a barycentric grid of the three directions, pushed onto the sphere
        let g = Math.max( 2, Math.round( n / 3 ) );
        for (let i = 1; i < g; i++) for (let j = 1; i + j < g; j++) {
            let w = [i / g, j / g, 1 - (i + j) / g];
            let p = Vec.add( c, Vec.mul( r, Vec.normalized( Vec.add( Vec.mul( w[0], d[0] ), Vec.add( Vec.mul( w[1], d[1] ), Vec.mul( w[2], d[2] ) ) ) ) ) );
            points.push( p ); xy.push( flat( p ) );
        }
        let tris = cdt2d( xy, edges, { exterior : false } ) as Array<[number, number, number]>;
        if (tris.length == 0) return null;
        // outward: away from the centre on a convex corner (the ball is in the material), towards it on a concave one
        let triangles = tris.map( t => {
            let nrm = Vec.cross( Vec.sub( points[t[1]], points[t[0]] ), Vec.sub( points[t[2]], points[t[0]] ) );
            let out = Vec.dot( nrm, Vec.sub( points[t[0]], c ) ) * -side > 0;
            return (out ? [t[0], t[1], t[2]] : [t[0], t[2], t[1]]) as [number, number, number];
        } );
        let surface = Make.sphericalSurface( c, axis, e1, r );
        return { points : points, triangles : triangles, reversed : false, surface : surface };
    }

    // The blend between its two trims: triangles over a constrained triangulation of its (s, t) rectangle, and its
    // contact curves as face cuts. Null if the trims overlap.
    public static build( F : OpenBlend ) : FilletResult | null {
        let t0 = F.trims[0], t1 = F.trims[1];
        if (t0 == null || t1 == null) return null;
        let m = F.m;
        let W = 0.0;
        for (let r of F.rows) W += Vec.dist( r.points[0], r.points[m >> 1] ) + Vec.dist( r.points[m >> 1], r.points[m] );
        W /= F.rows.length;
        let ds = (F.rows[F.rows.length - 1].s - F.rows[0].s) / (F.rows.length - 1);
        let margin = 0.3 * Math.min( ds, W / m );
        // the trims' s at any t, by linear interpolation along them
        let sAt = (trim : Array<TrimPoint>, t : number) => {
            for (let k = 1; k < trim.length; k++) {
                let a = trim[k - 1], b = trim[k];
                if (t <= b.t + 1e-12 || k == trim.length - 1) {
                    let f = b.t - a.t > 1e-12 ? Math.max( 0, Math.min( 1, (t - a.t) / (b.t - a.t) ) ) : 0;
                    return a.s + f * (b.s - a.s);
                }
            }
            return trim[0].s;
        };
        for (let i = 0; i <= m; i++) if (sAt( t1, i / m ) - sAt( t0, i / m ) < 2 * margin) return null;

        let pts : Array<Point> = [], xy : Array<[number, number]> = [];
        let add = (p : Point, s : number, t : number) => { pts.push( p ); xy.push( [s, t * W] ); return pts.length - 1; };
        let inRange = (s : number, t : number) => s > sAt( t0, t ) + margin && s < sAt( t1, t ) - margin;
        // the boundary: A's contact, the end trim, B's contact backwards, the start trim backwards
        let boundary : Array<number> = [];
        let side = (col : number) => {
            let out : Array<{ id : number, k : number }> = [];
            F.rows.forEach( (r, k) => { if (inRange( r.s, col / m )) out.push( { id : add( r.points[col], r.s, col / m ), k : k } ); } );
            return out;
        };
        let start0 = add( t0[0].point, t0[0].s, 0 );
        let sideA = side( 0 );
        let end : Array<number> = t1.map( p => add( p.point, p.s, p.t ) );
        let sideB = side( m );
        let start : Array<number> = [];
        for (let k = t0.length - 1; k >= 1; k--) start.push( add( t0[k].point, t0[k].s, t0[k].t ) );
        boundary.push( start0, ...sideA.map( x => x.id ), ...end, ...sideB.slice().reverse().map( x => x.id ), ...start );
        let edges : Array<[number, number]> = boundary.map( (id, k) => [id, boundary[(k + 1) % boundary.length]] as [number, number] );
        for (let k = 0; k < F.rows.length; k++) for (let i = 1; i < m; i++) {
            let r = F.rows[k];
            if (inRange( r.s, i / m )) add( r.points[i], r.s, i / m );
        }
        let tris = cdt2d( xy, edges, { exterior : false } ) as Array<[number, number, number]>;
        if (tris.length == 0) return null;
        // counter-clockwise in (s, t), with s along the edge and t from A to B, as the closed blends' (k, i) grid
        let triangles : Array<[number, number, number]> = tris.map( tr => {
            let a = xy[tr[0]], b = xy[tr[1]], c = xy[tr[2]];
            let o = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            return (o < 0 ? [tr[0], tr[1], tr[2]] : [tr[0], tr[2], tr[1]]) as [number, number, number];
        } );
        // the centre of the row nearest the first triangle
        let s0 = xy[triangles[0][0]][0], near = F.rows[0];
        for (let r of F.rows) if (Math.abs( r.s - s0 ) < Math.abs( near.s - s0 )) near = r;
        let reversed = Fillet.orientTriangles( pts, triangles, near.centre, F.side );

        // the contact curves, from the start trim to the end trim
        let contact = (col : number, list : Array<{ id : number, k : number }>, face : BrepFace) : Array<FaceCut> => {
            let first = col == 0 ? t0[0] : t0[t0.length - 1], last = col == 0 ? t1[0] : t1[t1.length - 1];
            let uv : Array<UV> = [first.uv as UV], points : Array<Point> = [first.point], seam : Array<number> = [0];
            for (let x of list) {
                let r = F.rows[x.k];
                uv.push( col == 0 ? r.uvA : r.uvB ); points.push( pts[x.id] ); seam.push( col == 0 ? r.seamA : r.seamB );
            }
            uv.push( last.uv as UV ); points.push( last.point ); seam.push( 0 );
            return BrepBoolean.facePieces( face, uv, seam, points, false );
        };
        let real = F.rows.slice( 2, F.rows.length - 2 );
        let arcs = real.map( r => Fillet.arc( r.points[0], r.centre, r.points[m] ) );
        let surface = Make.loftedSurface( arcs, Math.min( 3, arcs.length - 1 ) );
        let cutA = contact( 0, sideA, F.A.face ), cutB = contact( m, sideB, F.B.face );
        for (let x of F.extra) {
            let face = x.side == 0 ? F.A.face : F.B.face;
            (x.side == 0 ? cutA : cutB).push( ...BrepBoolean.facePieces( face, x.uv, x.uv.map( _ => 0 ), x.points, false ) );
        }
        return { sections : F.sections, side : F.side, cutA : cutA, cutB : cutB,
                 surface : surface, points : pts, triangles : triangles, reversed : reversed, closed : false };
    }

    // Where the polyline p crosses the polyline q, both in a face's parameters: the first crossing, as fractional vertex
    // indices along each.
    private static polyCross( F : BrepFace, p : Array<UV>, q : Array<UV> ) : [number, number] | null {
        let d = SurfaceIntersect.domain( F.surface );
        let span = [d[1] - d[0], d[3] - d[2]];
        let jump = (a : UV, b : UV) => (F.periodic[0] && Math.abs( a[0] - b[0] ) > span[0] / 2) || (F.periodic[1] && Math.abs( a[1] - b[1] ) > span[1] / 2);
        let best : [number, number] | null = null;
        for (let i = 0; i + 1 < p.length; i++) {
            if (jump( p[i], p[i + 1] )) continue;
            for (let j = 0; j + 1 < q.length; j++) {
                if (jump( q[j], q[j + 1] )) continue;
                let st = FilletCorner.segCross( p[i], p[i + 1], q[j], q[j + 1], span );
                if (st == null) continue;
                if (best == null || i + j + st[0] + st[1] < best[0] + best[1]) best = [i + st[0], j + st[1]];
            }
        }
        return best;
    }

    // Parameters (s, t) in [0, 1] where segments p0-p1 and q0-q1 cross.
    private static segCross( p0 : UV, p1 : UV, q0 : UV, q1 : UV, span : Array<number> ) : [number, number] | null {
        let ax = (p1[0] - p0[0]) / span[0], ay = (p1[1] - p0[1]) / span[1];
        let bx = (q1[0] - q0[0]) / span[0], by = (q1[1] - q0[1]) / span[1];
        let cx = (q0[0] - p0[0]) / span[0], cy = (q0[1] - p0[1]) / span[1];
        let den = ax * by - ay * bx;
        if (Math.abs( den ) < 1e-18) return null;
        let s = (cx * by - cy * bx) / den, t = (cx * ay - cy * ax) / den;
        if (s < 0 || s > 1 || t < 0 || t > 1) return null;
        return [s, t];
    }

    // A fractional index along a list of rows: the two rows around it, the fraction between them, and the s there.
    private static lerpRow( F : OpenBlend, idx : Array<number>, x : number ) : { k0 : number, k1 : number, f : number, s : number } {
        let i = Math.min( idx.length - 2, Math.floor( x ) ), f = x - i;
        let k0 = idx[i], k1 = idx[i + 1];
        return { k0 : k0, k1 : k1, f : f, s : F.rows[k0].s + f * (F.rows[k1].s - F.rows[k0].s) };
    }

    // Whether parameters lie in a face's domain (periodic directions always do).
    private static inside( F : BrepFace, uv : UV ) : boolean {
        let d = SurfaceIntersect.domain( F.surface );
        for (let a = 0; a < 2; a++) {
            if (F.periodic[a]) continue;
            if (uv[a] < d[2 * a] - 1e-12 || uv[a] > d[2 * a + 1] + 1e-12) return false;
        }
        return true;
    }

    // The point of a face's domain side (parameter `axis` fixed at uv's value) nearest to a target, from uv.
    private static onSide( F : BrepFace, uv : UV, axis : number, target : Point ) : UV {
        let other = 1 - axis;
        let d = SurfaceIntersect.domain( F.surface );
        let w = uv[other];
        for (let it = 0; it < 30; it++) {
            let ds = Eval.rationalSurfaceDerivatives( F.surface, axis == 0 ? uv[0] : w, axis == 0 ? w : uv[1], 2 );
            let p = ds[0][0];
            let t = other == 0 ? ds[1][0] : ds[0][1], tt = other == 0 ? ds[2][0] : ds[0][2];
            let r = Vec.sub( p, target );
            let g = Vec.dot( r, t ), h = Vec.dot( t, t ) + Vec.dot( r, tt );
            if (Math.abs( h ) < 1e-300) break;
            let step = -g / (h > 0 ? h : Vec.dot( t, t ));
            w += step;
            if (F.periodic[other]) { let span = d[2 * other + 1] - d[2 * other]; while (w < d[2 * other]) w += span; while (w > d[2 * other + 1]) w -= span; }
            else w = Math.max( d[2 * other], Math.min( d[2 * other + 1], w ) );
            if (Math.abs( step ) < 1e-14 * (d[2 * other + 1] - d[2 * other])) break;
        }
        let out : UV = [uv[0], uv[1]];
        out[other] = w;
        return out;
    }

    // Where column i of F1 (its points across all its rows near the corner) goes through F2's triangles near the corner:
    // the point, the s on F1 and the (s, t) on F2. Of several, the one nearest to `prev`.
    private static columnHit( F1 : OpenBlend, n1 : Array<number>, i : number, F2 : OpenBlend, n2 : Array<number>, prev : Point )
        : { point : Point, s1 : number, s2 : number, t2 : number } | null {
        let best : { point : Point, s1 : number, s2 : number, t2 : number } | null = null, bestD = Infinity;
        let m2 = F2.m;
        for (let a = 0; a + 1 < n1.length; a++) {
            let r0 = F1.rows[n1[a]], r1 = F1.rows[n1[a + 1]];
            let p = r0.points[i], q = r1.points[i];
            for (let b = 0; b + 1 < n2.length; b++) {
                let R0 = F2.rows[n2[b]], R1 = F2.rows[n2[b + 1]];
                for (let j = 0; j < m2; j++) {
                    let quad = [R0.points[j], R0.points[j + 1], R1.points[j + 1], R1.points[j]];
                    // (s, t) of the quad's corners on F2
                    let st = [[R0.s, j / m2], [R0.s, (j + 1) / m2], [R1.s, (j + 1) / m2], [R1.s, j / m2]];
                    for (let tri of [[0, 1, 2], [0, 2, 3]]) {
                        let h = FilletCorner.segTri( p, q, quad[tri[0]], quad[tri[1]], quad[tri[2]] );
                        if (h == null) continue;
                        let x = Vec.add( p, Vec.mul( h.f, Vec.sub( q, p ) ) );
                        let dd = Vec.dist( x, prev );
                        if (dd >= bestD) continue;
                        bestD = dd;
                        let w0 = 1 - h.u - h.v;
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
        let d = Vec.sub( q, p ), e1 = Vec.sub( b, a ), e2 = Vec.sub( c, a );
        let h = Vec.cross( d, e2 ), det = Vec.dot( e1, h );
        if (Math.abs( det ) < 1e-300) return null;
        let inv = 1 / det, sv = Vec.sub( p, a );
        let u = inv * Vec.dot( sv, h );
        let eps = 1e-9;
        if (u < -eps || u > 1 + eps) return null;
        let qv = Vec.cross( sv, e1 );
        let v = inv * Vec.dot( d, qv );
        if (v < -eps || u + v > 1 + eps) return null;
        let f = inv * Vec.dot( e2, qv );
        if (f < -eps || f > 1 + eps) return null;
        return { f : Math.max( 0, Math.min( 1, f ) ), u : u, v : v };
    }
}
