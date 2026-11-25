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
    public static rollingBall( A : FilletSide, B : FilletSide, edge : IntersectionCurve, radius : number, tol : number = 1e-10 ) : FilletResult | null {
        if (!edge.closed) return null;
        let DA = BrepSolid.domainOf( A.face ), DB = BrepSolid.domainOf( B.face );
        let n = edge.points.length;
        let tangentAt = (k : number) : Point => Vec.normalized( Vec.sub( edge.points[(k + 1) % n], edge.points[(k - 1 + n) % n] ) );
        // the edge at parameter t in [0, n): point, tangent and parameters on both faces
        let at = (t : number) => {
            let k = Math.floor( t ) % n, f = t - Math.floor( t ), k1 = (k + 1) % n;
            let p = Vec.lerp( f, edge.points[k1], edge.points[k] );
            let tg = Vec.normalized( Vec.lerp( f, tangentAt( k1 ), tangentAt( k ) ) );
            return { p : p, t : tg,
                     a : SurfaceIntersect.lerpUV( DA, f, edge.uvA[k], edge.uvA[k1] ), b : SurfaceIntersect.lerpUV( DB, f, edge.uvB[k], edge.uvB[k1] ) };
        };

        // concave or convex: does face A, moving away from the edge on its kept side, go below B's outward normal?
        let e0 = at( 0 );
        let s = Fillet.edgeSide( A, B, e0.a, e0.b, e0.t );
        if (s == 0) return null;

        let solve = (t : number, guess : { a : UV, b : UV } | null) : FilletSection | null => {
            let e = at( t );
            let starts : Array<{ a : UV, b : UV }> = [];
            starts.push( Fillet.initial( A, B, DA, DB, e.a, e.b, e.p, e.t, s * radius ) );
            if (guess != null) starts.push( guess );
            for (let st of starts) {
                let r = Fillet.newton( A, B, DA, DB, st.a, st.b, e.p, e.t, s * radius, tol * Math.max( 1, radius ) );
                if (r != null) return r;
            }
            return null;
        };

        let ts : Array<number> = [];
        let sections : Array<FilletSection> = [];
        let prev : { a : UV, b : UV } | null = null;
        // one section per edge vertex, skipping vertices very close to the last one used (where the edge has a
        // near-duplicate vertex, the two sections' contacts could come out in the wrong order and fold the
        // contact curve back on itself)
        let spacing = 0.0;
        for (let k = 0; k < n; k++) spacing += Vec.dist( edge.points[k], edge.points[(k + 1) % n] );
        spacing /= n;
        for (let k = 0; k < n; k++) {
            if (sections.length > 0 && Vec.dist( edge.points[k], edge.points[ts[ts.length - 1]] ) < 0.3 * spacing) continue;
            if (k == n - 1 && Vec.dist( edge.points[k], edge.points[ts[0]] ) < 0.3 * spacing) continue;
            let sec = solve( k, prev );
            if (sec == null) return null;
            ts.push( k ); sections.push( sec ); prev = sec;
        }
        // drop any section whose contacts step backwards along the edge
        for (let k = 1; k < sections.length; k++) {
            let tg = tangentAt( ts[k] );
            if (Vec.dot( Vec.sub( sections[k].pa, sections[k - 1].pa ), tg ) <= 0 || Vec.dot( Vec.sub( sections[k].pb, sections[k - 1].pb ), tg ) <= 0) {
                sections.splice( k, 1 ); ts.splice( k, 1 ); k--;
            }
        }

        // where a contact curve crosses a seam, put a section exactly on it
        let dA = SurfaceIntersect.domain( A.face.surface ), dB = SurfaceIntersect.domain( B.face.surface );
        let jump = (x : FilletSection, y : FilletSection) : [number, number] | null => {
            for (let side = 0; side < 2; side++) {
                let F = side == 0 ? A.face : B.face, d = side == 0 ? dA : dB;
                let p = side == 0 ? x.a : x.b, q = side == 0 ? y.a : y.b;
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
        for (let k = 0; k < sections.length; k++) {
            let k1 = (k + 1) % sections.length;
            let j = jump( sections[k], sections[k1] );
            if (j == null) continue;
            if (++inserted > 16) return null; // each seam crossing needs one section, or two where seams meet
            let side = j[0], ax = j[1];
            let d = side == 0 ? dA : dB;
            let lo = ts[k], hi = k1 == 0 ? n : ts[k1];
            let ref = sections[k], best = sections[k];
            let par = (x : FilletSection) => side == 0 ? x.a[ax] : x.b[ax];
            for (let it = 0; it < 50 && hi - lo > 1e-13; it++) {
                let mid = (lo + hi) / 2;
                let sec = solve( mid, ref );
                if (sec == null) return null;
                if (Math.abs( par( sec ) - par( ref ) ) < (d[2 * ax + 1] - d[2 * ax]) / 2) { lo = mid; best = sec; } else hi = mid;
            }
            // snap to the seam: the parameter becomes the start of the domain, flagged as standing for both ends
            let sec : FilletSection = { centre : best.centre, a : [best.a[0], best.a[1]], b : [best.b[0], best.b[1]],
                                        pa : best.pa, pb : best.pb, seamA : 0, seamB : 0 };
            if (side == 0) { sec.a[ax] = d[2 * ax]; sec.seamA = 1 << ax; sec.pa = Eval.rationalSurfacePoint( A.face.surface, sec.a[0], sec.a[1] ); }
            else { sec.b[ax] = d[2 * ax]; sec.seamB = 1 << ax; sec.pb = Eval.rationalSurfacePoint( B.face.surface, sec.b[0], sec.b[1] ); }
            // the other face's seam may cross at the same place (two surfaces of revolution about one axis, with their
            // seams at the same angle): if its contact jumps there too and the section sits on its seam, flag it as well
            let os = 1 - side, OF = os == 0 ? A.face : B.face, od = os == 0 ? dA : dB;
            for (let ax2 = 0; ax2 < 2; ax2++) {
                if (!OF.periodic[ax2]) continue;
                let period = od[2 * ax2 + 1] - od[2 * ax2];
                let p0 = os == 0 ? sections[k].a : sections[k].b, p1 = os == 0 ? sections[k1].a : sections[k1].b;
                let x = os == 0 ? sec.a : sec.b;
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

        // the contact curves as face cuts
        let pa = sections.map( x => x.pa ), pb = sections.map( x => x.pb );
        let cutA = Fillet.pieces( A.face, sections.map( x => x.a ), sections.map( x => x.seamA ), pa );
        let cutB = Fillet.pieces( B.face, sections.map( x => x.b ), sections.map( x => x.seamB ), pb );

        // arcs, and the blend's triangles: contact points are shared with the cuts so the meshes weld
        let arcs = sections.map( x => Fillet.arc( x.pa, x.centre, x.pb ) );
        let maxAngle = Math.max( ...sections.map( x => Vec.angleBetween( Vec.sub( x.pa, x.centre ), Vec.sub( x.pb, x.centre ) ) ) );
        let step = Fillet.meanSpacing( pa );
        let m = Math.max( 4, Math.min( 32, Math.ceil( maxAngle * radius / Math.max( step, 1e-12 ) ) ) );
        let points : Array<Point> = [];
        for (let k = 0; k < sections.length; k++) {
            points.push( sections[k].pa );
            for (let i = 1; i < m; i++) points.push( Eval.rationalCurvePoint( arcs[k], i / m ) );
            points.push( sections[k].pb );
        }
        let N = sections.length, W = m + 1;
        let triangles : Array<[number, number, number]> = [];
        for (let k = 0; k < N; k++) {
            let k1 = (k + 1) % N;
            for (let i = 0; i < m; i++) {
                let a = k * W + i, b = k * W + i + 1, c = k1 * W + i + 1, e = k1 * W + i;
                triangles.push( [a, b, c] ); triangles.push( [a, c, e] );
            }
        }
        // outward: towards the centre on a concave edge (the ball is in the air), away from it on a convex one
        let t0 = triangles[0];
        let nrm = Vec.cross( Vec.sub( points[t0[1]], points[t0[0]] ), Vec.sub( points[t0[2]], points[t0[0]] ) );
        let reversed = Vec.dot( nrm, Vec.sub( sections[0].centre, points[t0[0]] ) ) * s < 0;
        if (reversed) for (let t of triangles) { let x = t[1]; t[1] = t[2]; t[2] = x; }

        let surface = Make.loftedSurface( arcs.concat( [arcs[0]] ), 3 );
        return { sections : sections, side : s, cutA : cutA, cutB : cutB, surface : surface, points : points, triangles : triangles, reversed : reversed };
    }

    // +1 for a concave edge, -1 for a convex one, 0 if the faces are tangent there. a, b: parameters of an edge point
    // on both faces; t: the edge's tangent. A's kept part leaves the edge along wA, the direction in A's tangent plane
    // across the edge that goes into B's solid or out of it as `keptInsideOther` says; the edge is convex when wA runs
    // against B's result normal (A falls away behind B), as on the edge of a cube.
    public static edgeSide( A : FilletSide, B : FilletSide, a : UV, b : UV, t : Point ) : number {
        let nA = Fillet.normal( A, a ), nB = Fillet.normal( B, b );
        if (Vec.norm( Vec.cross( nA, nB ) ) < 1e-6) return 0;
        let wA = Vec.normalized( Vec.cross( nA, t ) );
        let db = Eval.rationalSurfaceDerivatives( B.face.surface, b[0], b[1], 1 );
        let outB = Vec.mul( B.face.reversed ? -1 : 1, Vec.cross( db[1][0], db[0][1] ) ); // B's own solid's outward normal
        if ((Vec.dot( wA, outB ) < 0) != A.keptInsideOther) wA = Vec.mul( -1, wA );
        return Vec.dot( wA, nB ) < 0 ? -1 : 1;
    }

    // The result's outward unit normal of a face side at (u, v).
    public static normal( F : FilletSide, uv : UV ) : Point {
        let d = Eval.rationalSurfaceDerivatives( F.face.surface, uv[0], uv[1], 1 );
        return Vec.mul( F.sign, Vec.normalized( Vec.cross( d[1][0], d[0][1] ) ) );
    }

    // Starting contact parameters: the centre that two tangent planes at p would give, and its feet on the planes.
    private static initial( A : FilletSide, B : FilletSide, DA : SurfaceDomain, DB : SurfaceDomain, a : UV, b : UV, p : Point, t : Point, sr : number ) : { a : UV, b : UV } {
        let da = Eval.rationalSurfaceDerivatives( A.face.surface, a[0], a[1], 1 );
        let db = Eval.rationalSurfaceDerivatives( B.face.surface, b[0], b[1], 1 );
        let nA = Vec.mul( A.sign, Vec.normalized( Vec.cross( da[1][0], da[0][1] ) ) );
        let nB = Vec.mul( B.sign, Vec.normalized( Vec.cross( db[1][0], db[0][1] ) ) );
        let c : Point;
        try { c = Vec.add( p, Mat.solve( [nA, nB, t], [sr, sr, 0] ) ); } catch (e) { return { a : a, b : b }; }
        if (c.some( x => !isFinite( x ) )) return { a : a, b : b };
        let qa = Vec.sub( c, Vec.mul( sr, nA ) ), qb = Vec.sub( c, Vec.mul( sr, nB ) );
        let sa = Fillet.tangentStep( da[1][0], da[0][1], Vec.sub( qa, da[0][0] ) );
        let sb = Fillet.tangentStep( db[1][0], db[0][1], Vec.sub( qb, db[0][0] ) );
        return { a : SurfaceIntersect.toDomain( DA, [a[0] + sa[0], a[1] + sa[1]] ), b : SurfaceIntersect.toDomain( DB, [b[0] + sb[0], b[1] + sb[1]] ) };
    }

    private static newton( A : FilletSide, B : FilletSide, DA : SurfaceDomain, DB : SurfaceDomain, a : UV, b : UV, p : Point, t : Point, sr : number, tol : number ) : FilletSection | null {
        let dA = SurfaceIntersect.domain( A.face.surface ), dB = SurfaceIntersect.domain( B.face.surface );
        let ha = [(dA[1] - dA[0]) * 1e-7, (dA[3] - dA[2]) * 1e-7], hb = [(dB[1] - dB[0]) * 1e-7, (dB[3] - dB[2]) * 1e-7];
        let off = (F : FilletSide, uv : UV) => {
            let d = Eval.rationalSurfaceDerivatives( F.face.surface, uv[0], uv[1], 1 );
            let nn = Vec.mul( F.sign, Vec.normalized( Vec.cross( d[1][0], d[0][1] ) ) );
            return Vec.add( d[0][0], Vec.mul( sr, nn ) );
        };
        let resid = (oa : Point, ob : Point) => {
            let r = Vec.sub( oa, ob );
            return [r[0], r[1], r[2], Vec.dot( Vec.sub( oa, p ), t )];
        };
        for (let it = 0; it < 40; it++) {
            let oa = off( A, a ), ob = off( B, b );
            let R = resid( oa, ob );
            let err = Math.sqrt( R[0] * R[0] + R[1] * R[1] + R[2] * R[2] + R[3] * R[3] );
            if (err < tol) {
                let pa = Eval.rationalSurfacePoint( A.face.surface, a[0], a[1] ), pb = Eval.rationalSurfacePoint( B.face.surface, b[0], b[1] );
                return { centre : Vec.mul( 0.5, Vec.add( oa, ob ) ), a : a, b : b, pa : pa, pb : pb, seamA : 0, seamB : 0 };
            }
            // Jacobian by forward differences (the offsets involve the normals' derivatives)
            let J : Array<Array<number>> = [[], [], [], []];
            let cols : Array<Array<number>> = [];
            for (let k = 0; k < 2; k++) {
                let q : UV = [a[0], a[1]]; q[k] += ha[k];
                let o = off( A, q );
                cols.push( [(o[0] - oa[0]) / ha[k], (o[1] - oa[1]) / ha[k], (o[2] - oa[2]) / ha[k], Vec.dot( Vec.sub( o, oa ), t ) / ha[k]] );
            }
            for (let k = 0; k < 2; k++) {
                let q : UV = [b[0], b[1]]; q[k] += hb[k];
                let o = off( B, q );
                cols.push( [-(o[0] - ob[0]) / hb[k], -(o[1] - ob[1]) / hb[k], -(o[2] - ob[2]) / hb[k], 0] );
            }
            for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) J[r][c] = cols[c][r];
            let step : Array<number>;
            try { step = Mat.solve( J, R.map( x => -x ) ); } catch (e) { return null; }
            if (step.some( x => !isFinite( x ) )) return null;
            // damp steps that would jump far across a face
            let big = Math.max( Math.abs( step[0] ) / (dA[1] - dA[0]), Math.abs( step[1] ) / (dA[3] - dA[2]), Math.abs( step[2] ) / (dB[1] - dB[0]), Math.abs( step[3] ) / (dB[3] - dB[2]) );
            let f = big > 0.1 ? 0.1 / big : 1;
            let na = SurfaceIntersect.toDomain( DA, [a[0] + f * step[0], a[1] + f * step[1]] );
            let nb = SurfaceIntersect.toDomain( DB, [b[0] + f * step[2], b[1] + f * step[3]] );
            a = na; b = nb;
        }
        return null;
    }

    // A circular arc from p to q around c (the short way), as a rational quadratic.
    public static arc( p : Point, c : Point, q : Point ) : NurbsCurveData {
        let x = Vec.sub( p, c ), y = Vec.sub( q, c );
        let th = Vec.angleBetween( x, y );
        let mid = Vec.normalized( Vec.add( x, y ) );
        let r = (Vec.norm( x ) + Vec.norm( y )) / 2;
        let w = Math.cos( th / 2 );
        let m = Vec.add( c, Vec.mul( r / Math.max( w, 1e-9 ), mid ) );
        return Make.rationalBezierCurve( [p, m, q], [1, w, 1] );
    }

    // A closed polyline on a face, split at seam vertices.
    private static pieces( f : BrepFace, uv : Array<UV>, seam : Array<number>, points : Array<Point> ) : Array<FaceCut> {
        let d = SurfaceIntersect.domain( f.surface );
        let n = uv.length;
        let first = seam.findIndex( m => m != 0 );
        if (first < 0) return [{ uv : uv.slice(), points : points.slice(), closed : true }];
        let closedLoop = true;
        // the parameters of a seam vertex as seen from its neighbours in one direction (+1 or -1): the first
        // neighbour not on that seam tells which end of the domain the vertex stands for
        let side = (k : number, dir : number) : UV => {
            let p : UV = [uv[k][0], uv[k][1]];
            for (let a = 0; a < 2; a++) {
                if ((seam[k] & (1 << a)) == 0) continue;
                let lo = d[2 * a], hi = d[2 * a + 1], eps = (hi - lo) * 1e-9;
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
        let out : Array<FaceCut> = [];
        let cur : FaceCut = { uv : [side( first, 1 )], points : [points[first]], closed : false };
        for (let s = 1; s <= n; s++) {
            let k = (first + s) % n;
            if (seam[k] != 0) {
                cur.uv.push( side( k, -1 ) ); cur.points.push( points[k] );
                if (cur.uv.length >= 2) out.push( cur );
                cur = { uv : [side( k, 1 )], points : [points[k]], closed : false };
            } else { cur.uv.push( uv[k] ); cur.points.push( points[k] ); }
        }
        return out;
    }

    private static tangentStep( su : Point, sv : Point, d : Point ) : UV {
        let a = Vec.dot( su, su ), b = Vec.dot( su, sv ), c = Vec.dot( sv, sv );
        let r0 = Vec.dot( su, d ), r1 = Vec.dot( sv, d );
        let det = a * c - b * b;
        if (Math.abs( det ) < 1e-300) return [0, 0];
        return [(c * r0 - b * r1) / det, (a * r1 - b * r0) / det];
    }

    private static meanSpacing( pts : Array<Point> ) : number {
        let s = 0.0;
        for (let k = 0; k < pts.length; k++) s += Vec.dist( pts[k], pts[(k + 1) % pts.length] );
        return s / pts.length;
    }
}
