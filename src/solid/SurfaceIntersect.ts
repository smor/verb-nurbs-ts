import { MeshData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { Intersect } from "../eval/Intersect.js";
import { SurfaceLoops, CriticalPoint } from "./SurfaceLoops.js";

// A surface with the information the intersection needs about its parameter domain: whether it closes on itself
// in u or in v (a periodic direction has a seam that intersection curves may cross).
export interface SurfaceDomain {
    surface : NurbsSurfaceData;
    periodic? : [boolean, boolean];
}

// One branch of the intersection of two surfaces, as a polyline whose every vertex lies on both surfaces (to the
// refinement tolerance) and carries its parameters on each.
export interface IntersectionCurve {
    points : Array<Point>;
    uvA : Array<UV>;
    uvB : Array<UV>;
    // per vertex, a bit mask of the seams of surface A (1: u seam, 2: v seam) that the vertex lies on; the vertex's
    // parameter in that direction is then stored as the start of the domain, and also stands for the end
    seamA : Array<number>;
    seamB : Array<number>;
    // true for a closed loop; the last vertex is then not a repeat of the first
    closed : boolean;
}

export interface SurfaceIntersectOptions {
    // grid resolution used to find the branches (default 48 x 48 per surface)
    divsA? : [number, number];
    divsB? : [number, number];
    // target distance between consecutive vertices (default: 1/100 of the smaller surface's size)
    step? : number;
    // refinement tolerance on the distance between the two surfaces (default 1e-9)
    tolerance? : number;
    // look for closed loops smaller than the grid, from the critical points of the distance between the surfaces
    // (`SurfaceLoops`); default true
    loops? : boolean;
    // cells per direction in which critical points are sought (default 8)
    loopCells? : number;
}

// The full result of an intersection: its branches, and the isolated points where the two surfaces touch without
// crossing (tangent contact), which produce no branch.
export interface SurfaceIntersection {
    curves : Array<IntersectionCurve>;
    touching : Array<CriticalPoint>;
    // branches along which the surfaces are tangent (a cylinder lying on a plane): they touch there without
    // crossing, so the branch separates nothing; left out of `curves`
    tangent : Array<IntersectionCurve>;
}

// Surface-surface intersection with parameters on both surfaces.
//
// The method is the usual one for general free-form surfaces (Patrikalakis and Maekawa, "Shape Interrogation for
// Computer Aided Design and Manufacturing", 2002, ch. 5; Barnhill and Kersey, "A marching method for parametric
// surface/surface intersection", CAGD 1990):
//
// 1. find a start point on every branch from an approximation, here the intersection of two grid triangulations,
//    which finds every branch that the grids resolve (branches smaller than a grid cell can be missed)
// 2. refine each point onto both surfaces with the three-plane Newton iteration (the point where the two tangent
//    planes and the plane normal to both meet), keeping the parameters on both surfaces, which trimming needs
// 3. densify the branch until consecutive points are `step` apart, refining every inserted point
// 4. insert an exact vertex wherever the branch crosses the seam of a periodic surface (isocurve/surface Newton),
//    so the trimmed faces can be split there
// 5. find the closed loops step 1 cannot resolve from the critical points of the distance between the surfaces
//    (`SurfaceLoops`, after Sinha's theorem), and trace each with a marching method (`trace`)

export class SurfaceIntersect {

    public static surfaces( A : SurfaceDomain, B : SurfaceDomain, options? : SurfaceIntersectOptions ) : Array<IntersectionCurve> {
        return SurfaceIntersect.analyze( A, B, options ).curves;
    }

    // The branches of the intersection and the points where the surfaces touch.
    public static analyze( A : SurfaceDomain, B : SurfaceDomain, options? : SurfaceIntersectOptions ) : SurfaceIntersection {
        const o = options != null ? options : {};
        const tol = o.tolerance != null ? o.tolerance : 1e-9;
        const a = A.surface, b = B.surface;
        const ma = SurfaceIntersect.gridMesh( a, o.divsA != null ? o.divsA : [48, 48] );
        const mb = SurfaceIntersect.gridMesh( b, o.divsB != null ? o.divsB : [48, 48] );
        const step = o.step != null ? o.step : Math.min( SurfaceIntersect.size( ma ), SurfaceIntersect.size( mb ) ) / 100;

        const out : Array<IntersectionCurve> = [];
        // surfaces that coincide over an area (two copies of a cylinder) have no branches there, only the sides of
        // one lying on the other (found below); their meshes would cross everywhere, at great cost, and for nothing
        const eps0 = Math.max( 1e3 * tol, 1e-7 * Math.max( SurfaceIntersect.size( ma ), SurfaceIntersect.size( mb ) ) );
        const coincide = SurfaceIntersect.coincide( a, b, eps0 );
        let edge = -1; // the longest mesh edge, found once when first needed
        const meshEdge = () => edge >= 0 ? edge : (edge = SurfaceIntersect.meshEdge( ma, mb ));
        if (!coincide) for (const pl of Intersect.meshes( ma, mb )) {
            const pts : Array<Point> = [], ua : Array<UV> = [], ub : Array<UV> = [];
            for (const ip of pl) {
                const r = SurfaceIntersect.refine( A, B, ip.uv0, ip.uv1, tol );
                if (r == null) continue;
                if (pts.length > 0 && Vec.dist( pts[pts.length - 1], r.point ) < step * 0.2) continue;
                pts.push( r.point ); ua.push( r.uvA ); ub.push( r.uvB );
            }
            if (pts.length < 2) continue;
            const gap = Vec.dist( pts[0], pts[pts.length - 1] );
            // ends close together close the branch, unless both lie on a side of a domain (an arc cut short by an
            // edge, such as a notch across a rim, whose ends can be nearer each other than a mesh edge)
            const bothOnSides = SurfaceIntersect.endOnSide( A, B, ua[0], ub[0] ) && SurfaceIntersect.endOnSide( A, B, ua[ua.length - 1], ub[ub.length - 1] );
            const closed = !bothOnSides && (gap < step * 2 || gap < meshEdge() * 1.5);
            if (closed && gap < step * 0.2) { pts.pop(); ua.pop(); ub.pop(); }
            let c : IntersectionCurve = { points : pts, uvA : ua, uvB : ub, seamA : pts.map( _ => 0 ), seamB : pts.map( _ => 0 ), closed : closed };
            // ends a few steps apart close the branch only if it does not run on, a short way, out of a domain at
            // both: a notch's arc across a disc's rim stops short of the rim on the meshes, with its ends nearer each
            // other than a mesh edge (#95); a loop's ends reach no side within a fraction of the gap between them
            if (closed && gap >= step * 2) {
                const open = SurfaceIntersect.extendToEdges( A, B, { ...c, closed : false }, Math.max( step, meshEdge() ) * 4, tol );
                const n = open.points.length - 1, m = pts.length - 1;
                const near = Vec.dist( open.points[0], pts[0] ) < 0.5 * gap && Vec.dist( open.points[n], pts[m] ) < 0.5 * gap;
                if (near && SurfaceIntersect.endOnSide( A, B, open.uvA[0], open.uvB[0] ) && SurfaceIntersect.endOnSide( A, B, open.uvA[n], open.uvB[n] )) c = open;
            }
            else if (!closed) c = SurfaceIntersect.extendToEdges( A, B, c, Math.max( step, meshEdge() ) * 4, tol );
            c = SurfaceIntersect.densify( A, B, c, step, tol );
            if (c.closed && c.points.length < SurfaceIntersect.MIN_LOOP_POINTS) {
                // a loop not much bigger than the step is too coarse to trim with: trace it again, finer
                const fine = SurfaceIntersect.retrace( A, B, c, tol );
                if (fine != null) c = fine;
            }
            c = SurfaceIntersect.insertSeams( A, B, c, tol );
            out.push( c );
        }
        // A branch ends only where it leaves a domain, or closes (the single-component count of Barton, Elber and
        // Hanniel: a branch crosses the boundary of the domain box at its ends). An open piece ending inside both
        // domains, or a piece lying on another, means the meshes' intersection broke up (their vertices on the branch:
        // a circle at a round fraction of a disc's radius, coaxial with a tube). Then the branches are traced again
        // from the pieces' points, each traced once (Barnhill and Kersey's marching, `trace`).
        if (SurfaceIntersect.broken( A, B, out )) {
            const seeds = ([] as Array<{ uvA : UV, uvB : UV }>).concat( ...out.map( c => c.points.map( (_, k) => ({ uvA : c.uvA[k], uvB : c.uvB[k] }) ) ) );
            const traced : Array<IntersectionCurve> = [];
            for (const sd of seeds) {
                const r = SurfaceIntersect.refine( A, B, sd.uvA, sd.uvB, tol );
                if (r == null || traced.some( c => SurfaceIntersect.onCurve( c, r.point ) )) continue;
                let c = SurfaceIntersect.trace( A, B, r, step, tol );
                if (c == null) continue;
                if (!c.closed) c = SurfaceIntersect.extendToEdges( A, B, c, 4 * step, tol );
                traced.push( SurfaceIntersect.insertSeams( A, B, c, tol ) );
            }
            out.length = 0;
            out.push( ...traced );
        }
        // a side of one domain lying on the other surface (a boss standing on a face, a tube ending on a plane): the
        // meshes touch there along a whole edge, which their intersection resolves poorly; the branch is that side,
        // exactly, and the branches found along it are dropped
        const eps = Math.max( 1e3 * tol, 1e-7 * Math.max( SurfaceIntersect.size( ma ), SurfaceIntersect.size( mb ) ) );
        // (a side along a side of the other, edge to edge, is no branch, but what the meshes found along it is dropped)
        const all = SurfaceIntersect.sidesOn( A, B, step, eps ).map( x => ({ c : x.c, side : x.side, edge : x.edge, a : true }) ).concat(
            SurfaceIntersect.sidesOn( B, A, step, eps ).map( x => ({ c : SurfaceIntersect.swap( x.c ), side : x.side, edge : x.edge, a : false }) ) );
        const sides = all.filter( x => !x.edge );
        if (all.length > 0) {
            const da = SurfaceIntersect.domain( a ), db = SurfaceIntersect.domain( b );
            const on = (c : IntersectionCurve) => all.some( x => {
                const d = x.a ? da : db, uv = x.a ? c.uvA : c.uvB, w = d[2 * x.side.axis + 1] - d[2 * x.side.axis];
                return uv.every( p => Math.abs( p[x.side.axis] - x.side.value ) < 1e-6 * w );
            } );
            for (let k = out.length - 1; k >= 0; k--) if (on( out[k] )) out.splice( k, 1 );
            // a side of each lying on the other (two faces meeting at a right angle along both their edges): once
            sides.forEach( (x, k) => {
                if (!x.a && sides.some( (y, j) => j < k && y.a && x.c.uvA.every( p => Math.abs( p[y.side.axis] - y.side.value ) < 1e-6 * (da[2 * y.side.axis + 1] - da[2 * y.side.axis]) ) )) return;
                out.push( SurfaceIntersect.insertSeams( A, B, x.c, tol ) );
            } );
        }
        const touching : Array<CriticalPoint> = [];
        if (o.loops !== false && !coincide) {
            const found = SurfaceLoops.seeds( A, B, { cells : o.loopCells } );
            touching.push( ...found.touching );
            for (const s of found.starts) {
                const r = SurfaceIntersect.refine( A, B, s.uvA, s.uvB, tol );
                if (r == null) continue;
                // a start point on a branch already found adds nothing
                if (out.some( c => SurfaceIntersect.onCurve( c, r.point ) )) continue;
                let c = SurfaceIntersect.trace( A, B, r, Math.min( step, Math.max( s.size / 12, 1e-6 * step ) ), tol );
                if (c == null) continue;
                if (!c.closed) c = SurfaceIntersect.extendToEdges( A, B, c, 4 * step, tol );
                c = SurfaceIntersect.insertSeams( A, B, c, tol );
                out.push( c );
            }
        }
        // a branch that does not get anywhere (where the surfaces touch, tracing stops at once) is no branch; one
        // along which the normals are parallel throughout is a line of contact, not of crossing
        const tangent : Array<IntersectionCurve> = [];
        for (let k = out.length - 1; k >= 0; k--) {
            const c = out[k];
            let reach = 0.0;
            for (const p of c.points) reach = Math.max( reach, Vec.dist( p, c.points[0] ) );
            if (!c.closed && reach < 0.5 * step) { out.splice( k, 1 ); continue; }
            let worst = 0.0;
            c.points.forEach( (_, i) => {
                const na = SurfaceIntersect.unitNormal( a, c.uvA[i] ), nb = SurfaceIntersect.unitNormal( b, c.uvB[i] );
                worst = Math.max( worst, Vec.norm( Vec.cross( na, nb ) ) );
            } );
            // (a tangent branch's points, refined to tol, have normals off by about sqrt(tol / radius): 2e-5 for a
            // cylinder of radius 3 on a plane; a small loop where two bumps barely cross, 1.4e-3)
            const parallel = worst < 1e-4;
            if (parallel) { tangent.push( c ); out.splice( k, 1 ); }
        }
        return { curves : out, touching : touching, tangent : tangent };
    }

    // A marching method (Barnhill and Kersey 1990): from a point on both surfaces, step along the intersection's
    // tangent (the cross product of the two normals) and refine each step onto both surfaces, both ways, until the
    // branch closes on its start or leaves a domain. The step is halved where the refinement fails.
    public static trace( A : SurfaceDomain, B : SurfaceDomain, start : { point : Point, uvA : UV, uvB : UV }, step : number,
                         tol : number, maxPoints : number = 20000 ) : IntersectionCurve | null {
        const halves : Array<Array<{ point : Point, uvA : UV, uvB : UV }>> = [];
        let closed = false;
        for (const dir of [1, -1]) {
            const run = [start];
            let cur = start;
            while (run.length < maxPoints) {
                const pa = Eval.rationalSurfaceDerivatives( A.surface, cur.uvA[0], cur.uvA[1], 1 );
                const pb = Eval.rationalSurfaceDerivatives( B.surface, cur.uvB[0], cur.uvB[1], 1 );
                const t = Vec.cross( Vec.cross( pa[1][0], pa[0][1] ), Vec.cross( pb[1][0], pb[0][1] ) );
                if (Vec.norm( t ) < 1e-14) break; // the surfaces are tangent here: the branch cannot be followed
                const dirT = Vec.mul( dir / Vec.norm( t ), t );
                let next : { point : Point, uvA : UV, uvB : UV } | null = null;
                let h = step;
                for (let tries = 0; tries < 5 && next == null; tries++, h /= 2) {
                    const ga = Vec.add( cur.uvA, SurfaceIntersect.tangentStep( pa[1][0], pa[0][1], Vec.mul( h, dirT ) ) );
                    const gb = Vec.add( cur.uvB, SurfaceIntersect.tangentStep( pb[1][0], pb[0][1], Vec.mul( h, dirT ) ) );
                    if (!SurfaceIntersect.within( A, ga ) || !SurfaceIntersect.within( B, gb )) break;
                    let r = SurfaceIntersect.refine( A, B, ga, gb, tol );
                    // across a knot where a surface's parameterisation changes speed (a profile's line running into its
                    // arc, joined with G1 but not C1), a step in parameters taken from the derivatives on one side
                    // lands too far or too near on the other: scale the step that was actually made to the length
                    // wanted (a secant step) and refine again
                    const got = r == null ? 0 : Vec.dist( r.point, cur.point );
                    if (r != null && (got >= 2 * h || got <= 0.2 * h) && got > 0) {
                        const k = h / got;
                        const sa = SurfaceIntersect.toDomain( A, Vec.add( cur.uvA, Vec.mul( k, SurfaceIntersect.delta( A, cur.uvA, r.uvA ) ) ) );
                        const sb = SurfaceIntersect.toDomain( B, Vec.add( cur.uvB, Vec.mul( k, SurfaceIntersect.delta( B, cur.uvB, r.uvB ) ) ) );
                        r = SurfaceIntersect.refine( A, B, sa, sb, tol );
                    }
                    if (r != null && Vec.dist( r.point, cur.point ) > 0.2 * h && Vec.dist( r.point, cur.point ) < 2 * h
                        && Vec.dot( Vec.sub( r.point, cur.point ), dirT ) > 0) next = r;
                }
                if (next == null) break;
                if (run.length > 3 && Vec.dist( next.point, start.point ) < 0.75 * step) { closed = true; break; }
                run.push( next ); cur = next;
            }
            halves.push( run );
            if (closed) break;
        }
        let pts = halves[0];
        if (!closed && halves.length > 1) pts = halves[1].slice( 1 ).reverse().concat( halves[0] );
        if (pts.length < 2) return null;
        return { points : pts.map( p => p.point ), uvA : pts.map( p => p.uvA ), uvB : pts.map( p => p.uvB ),
                 seamA : pts.map( () => 0 ), seamB : pts.map( () => 0 ), closed : closed };
    }

    // the fewest vertices a closed loop is given; smaller loops are traced again with a finer step
    public static MIN_LOOP_POINTS = 24;

    // Trace a closed loop again from its first vertex, with a step that gives it about 2 x MIN_LOOP_POINTS vertices.
    private static retrace( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, tol : number ) : IntersectionCurve | null {
        let perimeter = 0.0;
        for (let i = 0; i < c.points.length; i++) perimeter += Vec.dist( c.points[i], c.points[(i + 1) % c.points.length] );
        if (perimeter <= 0) return null;
        const r = SurfaceIntersect.refine( A, B, c.uvA[0], c.uvB[0], tol );
        if (r == null) return null;
        const t = SurfaceIntersect.trace( A, B, r, perimeter / (2 * SurfaceIntersect.MIN_LOOP_POINTS), tol );
        return t != null && t.closed && t.points.length >= SurfaceIntersect.MIN_LOOP_POINTS / 2 ? t : null;
    }

    // Whether a point of the intersection lies on a branch already found: closer to one of its vertices than about
    // half the length of the branch's segments there (an exact point between two vertices is at most that far).
    private static onCurve( c : IntersectionCurve, p : Point ) : boolean {
        const n = c.points.length;
        for (let i = 0; i < n; i++) {
            const a = c.points[i];
            const prev = i > 0 ? c.points[i - 1] : (c.closed ? c.points[n - 1] : null);
            const next = i + 1 < n ? c.points[i + 1] : (c.closed ? c.points[0] : null);
            let seg = 0.0;
            if (prev != null) seg = Math.max( seg, Vec.dist( prev, a ) );
            if (next != null) seg = Math.max( seg, Vec.dist( a, next ) );
            if (Vec.dist( a, p ) <= 0.6 * seg + 1e-9) return true;
        }
        return false;
    }

    // Whether a parameter pair is inside the domain (periodic directions always are).
    // Whether branches found from the meshes' intersection are broken up: an open one with an end inside both
    // domains (not on a side that is not a seam), or one whose points all lie on another.
    // Whether a parameter pair lies on a side of the domain that is not a seam.
    private static onSide( S : SurfaceDomain, uv : UV ) : boolean {
        const d = SurfaceIntersect.domain( S.surface ), p = S.periodic != null ? S.periodic : [false, false];
        for (let k = 0; k < 2; k++) {
            const w = d[2 * k + 1] - d[2 * k];
            if (!p[k] && (Math.abs( uv[k] - d[2 * k] ) < 1e-6 * w || Math.abs( uv[k] - d[2 * k + 1] ) < 1e-6 * w)) return true;
        }
        return false;
    }

    // Whether a point of a branch, given by its parameters on both surfaces, is on a side of either domain.
    private static endOnSide( A : SurfaceDomain, B : SurfaceDomain, uvA : UV, uvB : UV ) : boolean {
        return SurfaceIntersect.onSide( A, uvA ) || SurfaceIntersect.onSide( B, uvB );
    }

    private static broken( A : SurfaceDomain, B : SurfaceDomain, curves : Array<IntersectionCurve> ) : boolean {
        const onSide = (S : SurfaceDomain, uv : UV) => SurfaceIntersect.onSide( S, uv );
        for (const c of curves) {
            // a branch that turns straight back on itself: the meshes' intersection chained a piece to its own
            // copy (a branch crossing a wall at a fold, where the meshes cross at a grazing angle); a transversal
            // branch has no such cusp
            if (SurfaceIntersect.doublesBack( c )) return true;
            if (c.closed) continue;
            for (const k of [0, c.points.length - 1]) if (!onSide( A, c.uvA[k] ) && !onSide( B, c.uvB[k] )) return true;
        }
        return curves.some( (c, i) => curves.some( (e, j) => j != i && c.points.length <= e.points.length && c.points.every( p => SurfaceIntersect.onCurve( e, p ) ) ) );
    }

    // Whether a polyline turns back by more than 150 degrees at one of its vertices.
    private static doublesBack( c : IntersectionCurve ) : boolean {
        const n = c.points.length, m = c.closed ? n : n - 2;
        for (let i = 0; i < m; i++) {
            const a = c.points[i], b = c.points[(i + 1) % n], d = c.points[(i + 2) % n];
            const u = Vec.sub( b, a ), v = Vec.sub( d, b );
            const lu = Vec.norm( u ), lv = Vec.norm( v );
            if (lu > 0 && lv > 0 && Vec.dot( u, v ) < -0.866 * lu * lv) return true;
        }
        return false;
    }

    private static within( S : SurfaceDomain, uv : UV ) : boolean {
        const d = SurfaceIntersect.domain( S.surface );
        const p = S.periodic != null ? S.periodic : [false, false];
        for (let k = 0; k < 2; k++) if (!p[k] && (uv[k] < d[2 * k] - 1e-12 || uv[k] > d[2 * k + 1] + 1e-12)) return false;
        return true;
    }

    // The runs of the sides of A's domain that lie on B (not where the surfaces coincide), each as a branch with A's
    // parameters exactly on the side: a whole side (a tube ending on a plane) or a stretch of one (a plate's edge on
    // a disc it overlaps, ending where the disc does). Sampled at the step; a run's ends are found by bisection.
    public static sidesOn( A : SurfaceDomain, B : SurfaceDomain, step : number, eps : number ) : Array<{ c : IntersectionCurve, side : { axis : number, value : number }, edge : boolean }> {
        const a = A.surface, b = B.surface, d = SurfaceIntersect.domain( a );
        const box = SurfaceIntersect.box( b, eps );
        let seed : UV | undefined = undefined;
        const onB = (p : Point) : UV | null => {
            if (p.some( (c, k) => c < box.min[k] || c > box.max[k] )) return null;
            let uv = SurfaceIntersect.project( b, p, 12, seed );
            if (seed != null && Vec.dist( Eval.rationalSurfacePoint( b, uv[0], uv[1] ), p ) >= eps) uv = SurfaceIntersect.project( b, p );
            const ok = Vec.dist( Eval.rationalSurfacePoint( b, uv[0], uv[1] ), p ) < eps;
            seed = ok ? uv : undefined;
            return ok ? uv : null;
        };
        const normal = (s : NurbsSurfaceData, uv : UV) => {
            const x = Eval.rationalSurfaceDerivatives( s, uv[0], uv[1], 1 );
            return Vec.normalized( Vec.cross( x[1][0], x[0][1] ) );
        };
        const out : Array<{ c : IntersectionCurve, side : { axis : number, value : number }, edge : boolean }> = [];
        for (let axis = 0; axis < 2; axis++) {
            if (A.periodic != null && A.periodic[axis]) continue; // a seam is inside the face
            const other = 1 - axis, closed = A.periodic != null && A.periodic[other];
            const lo = d[2 * other], hi = d[2 * other + 1];
            for (const value of [d[2 * axis], d[2 * axis + 1]]) {
                const at = (t : number) : UV => axis == 0 ? [value, t] : [t, value];
                const P = (t : number) => { const uv = at( t < lo ? t + (hi - lo) : t ); return Eval.rationalSurfacePoint( a, uv[0], uv[1] ); };
                // quick rejection: the side's samples all outside B's box
                let len = 0, prev : Point | null = null, inBox = false;
                for (let k = 0; k <= 64; k++) {
                    const p = P( lo + (hi - lo) * k / 64 );
                    if (prev != null) len += Vec.dist( p, prev );
                    if (p.every( (c, x) => c >= box.min[x] && c <= box.max[x] )) inBox = true;
                    prev = p;
                }
                if (!inBox) continue;
                const n = Math.max( 16, Math.ceil( len / step ) );
                seed = undefined;
                const ts = Array.from( { length : n + 1 }, (_, k) => lo + (hi - lo) * k / n );
                const on = ts.map( t => onB( P( t ) ) );
                // the runs of consecutive samples on B (on a closed side, a run may wrap round)
                const runs : Array<[number, number]> = [];
                for (let k = 0; k <= n; k++) {
                    if (on[k] == null) continue;
                    if (runs.length > 0 && runs[runs.length - 1][1] == k - 1) runs[runs.length - 1][1] = k; else runs.push( [k, k] );
                }
                if (runs.length == 0) continue;
                const whole = runs.length == 1 && runs[0][0] == 0 && runs[0][1] == n;
                if (closed && !whole && runs.length > 1 && runs[0][0] == 0 && runs[runs.length - 1][1] == n) {
                    const last = runs.pop() as [number, number];
                    runs[0] = [last[0] - n, runs[0][1]]; // indices below 0 wrap
                }
                for (const run of runs) {
                    if (run[1] - run[0] < 1) continue; // a single point: a crossing, which the meshes find
                    const tOf = (k : number) => k < 0 ? ts[k + n] - (hi - lo) : ts[k];
                    // where the surfaces coincide next to the run, it is not an edge of their intersection
                    const tm = tOf( Math.round( 0.5 * (run[0] + run[1]) ) ), inner = at( tm );
                    inner[axis] = value + (axis == 0 ? (d[1] - d[0]) : (d[3] - d[2])) * (value == d[2 * axis] ? 0.01 : -0.01);
                    seed = undefined;
                    const qi = onB( Eval.rationalSurfacePoint( a, inner[0], inner[1] ) );
                    if (qi != null && Math.abs( Vec.dot( normal( a, inner ), normal( b, qi ) ) ) > 1 - 1e-6) continue;
                    // the run's ends, between the last sample on B and the first off it
                    const edge = (inT : number, outT : number) => {
                        for (let it = 0; it < 40; it++) { const m = 0.5 * (inT + outT); seed = undefined; if (onB( P( m ) ) != null) inT = m; else outT = m; }
                        return inT;
                    };
                    const isWhole = whole && !closed;
                    const t0 = closed && whole ? lo : isWhole ? lo : (run[0] == 0 && !closed ? lo : edge( tOf( run[0] ), tOf( run[0] - 1 ) ));
                    const t1 = closed && whole ? hi : isWhole ? hi : (run[1] == n && !closed ? hi : edge( tOf( run[1] ), tOf( run[1] + 1 ) ));
                    const m = Math.max( 2, Math.ceil( Math.abs( t1 - t0 ) / (hi - lo) * n ) );
                    const loop = closed && whole;
                    const pts : Array<Point> = [], ua : Array<UV> = [], ub : Array<UV> = [];
                    let ok = true;
                    seed = undefined;
                    for (let k = 0; k < (loop ? m : m + 1); k++) {
                        let t = t0 + (t1 - t0) * k / m;
                        if (t < lo) t += hi - lo;
                        const uv = at( t ), p = Eval.rationalSurfacePoint( a, uv[0], uv[1] ), q = onB( p );
                        if (q == null) { ok = false; break; }
                        pts.push( p ); ua.push( uv ); ub.push( q );
                    }
                    if (!ok || pts.length < 2) continue;
                    // along a side of B too, the faces meet edge to edge (two tubes end to end): not a crossing
                    const db = SurfaceIntersect.domain( b ), pb = B.periodic != null ? B.periodic : [false, false];
                    const edgeOfB = [0, 1].some( x => !pb[x] && [db[2 * x], db[2 * x + 1]].some( v => ub.every( q => Math.abs( q[x] - v ) < 1e-6 * (db[2 * x + 1] - db[2 * x]) ) ) );
                    // edge to edge over the whole of both sides (a tube ending on a copy's cap): no branch, and what the
                    // meshes found there is dropped; over a stretch of either (a box flush with a wider one's edge),
                    // the meshes' pieces stay: they cut the longer side where the shorter one ends
                    if (edgeOfB) {
                        const bWhole = loop || [0, 1].some( x => {
                            const w = db[2 * (1 - x) + 1] - db[2 * (1 - x)], t = ub.map( q => q[1 - x] );
                            return Math.max( ...t ) - Math.min( ...t ) > (1 - 1e-6) * w;
                        } );
                        if (!(whole && bWhole)) continue;
                    }
                    out.push( { c : { points : pts, uvA : ua, uvB : ub, seamA : pts.map( _ => 0 ), seamB : pts.map( _ => 0 ), closed : loop },
                                side : { axis : axis, value : value }, edge : edgeOfB } );
                }
            }
        }
        return out;
    }

    // Whether two surfaces coincide over an area: a 2 by 2 block of neighbouring samples of A, and its centre, all on
    // B with their normals parallel (a line of contact, where two surfaces touch, holds no such block).
    public static coincide( a : NurbsSurfaceData, b : NurbsSurfaceData, eps : number ) : boolean {
        const n = 8, d = SurfaceIntersect.domain( a ), box = SurfaceIntersect.box( b, eps );
        const at = (i : number, j : number) : UV => [d[0] + (d[1] - d[0]) * i / n, d[2] + (d[3] - d[2]) * j / n];
        const memo = new Map<number, boolean>();
        const on = (uv : UV) : boolean => {
            const p = Eval.rationalSurfacePoint( a, uv[0], uv[1] );
            if (p.some( (c, k) => c < box.min[k] || c > box.max[k] )) return false;
            const q = SurfaceIntersect.project( b, p );
            if (Vec.dist( Eval.rationalSurfacePoint( b, q[0], q[1] ), p ) > eps) return false;
            const na = Eval.rationalSurfaceDerivatives( a, uv[0], uv[1], 1 ), nb = Eval.rationalSurfaceDerivatives( b, q[0], q[1], 1 );
            const x = Vec.cross( na[1][0], na[0][1] ), y = Vec.cross( nb[1][0], nb[0][1] );
            const lx = Vec.norm( x ), ly = Vec.norm( y );
            return lx > 0 && ly > 0 && Math.abs( Vec.dot( x, y ) ) > (1 - 1e-9) * lx * ly;
        };
        const node = (i : number, j : number) => {
            const k = i * (n + 1) + j;
            let r = memo.get( k );
            if (r == null) { r = on( at( i, j ) ); memo.set( k, r ); }
            return r;
        };
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            if (!node( i, j ) || !node( i + 1, j ) || !node( i, j + 1 ) || !node( i + 1, j + 1 )) continue;
            if (on( at( i + 0.5, j + 0.5 ) )) return true;
        }
        return false;
    }

    // a surface's bounding box (of its control points, which hold it), grown by eps
    private static box( s : NurbsSurfaceData, eps : number ) : { min : Point, max : Point } {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const row of s.controlPoints) for (const h of row) {
            const w = h[3];
            for (let k = 0; k < 3; k++) { const c = h[k] / w; min[k] = Math.min( min[k], c - eps ); max[k] = Math.max( max[k], c + eps ); }
        }
        return { min : min, max : max };
    }

    // The parameters of the point of a surface nearest to p: the nearest of a grid of samples, then Newton steps on
    // the distance, clamped to the domain (a point beyond the surface's side ends on that side). Cheap enough to call
    // per point, unlike a closest point that tessellates.
    public static project( s : NurbsSurfaceData, p : Point, grid : number = 12, seed? : UV ) : UV {
        const d = SurfaceIntersect.domain( s );
        // a parameter in which the surface closes on itself (a cylinder's or a disc's angle) wraps round, rather than
        // stopping at the end of the domain: a point just short of the seam is reached from the grid node at its
        // start by stepping backwards
        const closed = SurfaceIntersect.closedness( s );
        const fit = ( x : number, lo : number, hi : number, wrap : boolean ) =>
            wrap ? lo + (((x - lo) % (hi - lo)) + (hi - lo)) % (hi - lo) : Math.min( hi, Math.max( lo, x ) );
        let best : UV = seed != null ? [seed[0], seed[1]] : [d[0], d[2]], bd = seed != null ? -1 : Infinity;
        if (seed == null) for (let i = 0; i <= grid; i++) for (let j = 0; j <= grid; j++) {
            const uv : UV = [d[0] + (d[1] - d[0]) * i / grid, d[2] + (d[3] - d[2]) * j / grid];
            const x = Vec.distSquared( Eval.rationalSurfacePoint( s, uv[0], uv[1] ), p );
            if (x < bd) { bd = x; best = uv; }
        }
        let uv = best;
        for (let it = 0; it < 30; it++) {
            const e = Eval.rationalSurfaceDerivatives( s, uv[0], uv[1], 2 );
            const r = Vec.sub( e[0][0], p ), su = e[1][0], sv = e[0][1];
            const f = Vec.dot( r, su ), g = Vec.dot( r, sv );
            const a = Vec.dot( su, su ) + Vec.dot( r, e[2][0] ), b = Vec.dot( su, sv ) + Vec.dot( r, e[1][1] ), c = Vec.dot( sv, sv ) + Vec.dot( r, e[0][2] );
            const det = a * c - b * b;
            if (Math.abs( det ) < 1e-300) break;
            const du = (c * f - b * g) / det, dv = (a * g - b * f) / det;
            const next : UV = [fit( uv[0] - du, d[0], d[1], closed[0] ), fit( uv[1] - dv, d[2], d[3], closed[1] )];
            const moved = Math.min( Math.abs( next[0] - uv[0] ), closed[0] ? Math.abs( Math.abs( next[0] - uv[0] ) - (d[1] - d[0]) ) : Infinity )
                + Math.min( Math.abs( next[1] - uv[1] ), closed[1] ? Math.abs( Math.abs( next[1] - uv[1] ) - (d[3] - d[2]) ) : Infinity );
            uv = next;
            if (moved < 1e-15 * (d[1] - d[0] + d[3] - d[2])) break;
        }
        return uv;
    }

    // Whether a surface closes on itself in u and in v: its two ends in that parameter coincide (to 1e-9 of its
    // size) all along. Cached per surface.
    private static closedCache = new WeakMap<NurbsSurfaceData, [boolean, boolean]>();
    public static closedness( s : NurbsSurfaceData ) : [boolean, boolean] {
        const known = SurfaceIntersect.closedCache.get( s );
        if (known != null) return known;
        const d = SurfaceIntersect.domain( s );
        const box = SurfaceIntersect.box( s, 0 );
        const size = Vec.dist( box.min, box.max );
        const same = ( a : (t : number) => Point, b : (t : number) => Point ) => {
            for (let k = 0; k <= 8; k++) if (Vec.dist( a( k / 8 ), b( k / 8 ) ) > 1e-9 * size) return false;
            return true;
        };
        const S = (u : number, v : number) => Eval.rationalSurfacePoint( s, u, v );
        const r : [boolean, boolean] = [
            same( t => S( d[0], d[2] + t * (d[3] - d[2]) ), t => S( d[1], d[2] + t * (d[3] - d[2]) ) ),
            same( t => S( d[0] + t * (d[1] - d[0]), d[2] ), t => S( d[0] + t * (d[1] - d[0]), d[3] ) ),
        ];
        SurfaceIntersect.closedCache.set( s, r );
        return r;
    }

    private static unitNormal( s : NurbsSurfaceData, uv : UV ) : Point {
        const x = Eval.rationalSurfaceDerivatives( s, uv[0], uv[1], 1 );
        return Vec.normalized( Vec.cross( x[1][0], x[0][1] ) );
    }

    // a branch with its surfaces swapped
    private static swap( c : IntersectionCurve ) : IntersectionCurve {
        return { points : c.points, uvA : c.uvB, uvB : c.uvA, seamA : c.seamB, seamB : c.seamA, closed : c.closed };
    }

    // Refine an estimate onto both surfaces. Periodic parameters are wrapped into the domain, others clamped.
    // Returns null when the iteration does not converge.
    public static refine( A : SurfaceDomain, B : SurfaceDomain, uvA : UV, uvB : UV, tol : number ) : { point : Point, uvA : UV, uvB : UV } | null {
        const a = A.surface, b = B.surface;
        uvA = SurfaceIntersect.toDomain( A, uvA ); uvB = SurfaceIntersect.toDomain( B, uvB );
        for (let it = 0; it < 30; it++) {
            const pds = Eval.rationalSurfaceDerivatives( a, uvA[0], uvA[1], 1 );
            const qds = Eval.rationalSurfaceDerivatives( b, uvB[0], uvB[1], 1 );
            const p = pds[0][0], pu = pds[1][0], pv = pds[0][1];
            const q = qds[0][0], qu = qds[1][0], qv = qds[0][1];
            if (Vec.dist( p, q ) < tol) return { point : Vec.lerp( 0.5, p, q ), uvA : uvA, uvB : uvB };
            const pn = Vec.normalized( Vec.cross( pu, pv ) );
            const qn = Vec.normalized( Vec.cross( qu, qv ) );
            let fn = Vec.cross( pn, qn );
            if (Vec.norm( fn ) < 1e-12) return null; // tangent surfaces
            fn = Vec.normalized( fn );
            const x = Intersect.threePlanes( pn, Vec.dot( pn, p ), qn, Vec.dot( qn, q ), fn, Vec.dot( fn, Vec.lerp( 0.5, p, q ) ) );
            if (x == null) return null;
            uvA = SurfaceIntersect.toDomain( A, Vec.add( uvA, SurfaceIntersect.tangentStep( pu, pv, Vec.sub( x, p ) ) ) );
            uvB = SurfaceIntersect.toDomain( B, Vec.add( uvB, SurfaceIntersect.tangentStep( qu, qv, Vec.sub( x, q ) ) ) );
        }
        return null;
    }

    // The parameter step from uv to w, the short way round a periodic direction.
    private static delta( S : SurfaceDomain, uv : UV, w : UV ) : UV {
        const d = SurfaceIntersect.domain( S.surface ), p = S.periodic != null ? S.periodic : [false, false];
        const out : UV = [w[0] - uv[0], w[1] - uv[1]];
        for (let k = 0; k < 2; k++) {
            if (!p[k]) continue;
            const per = d[2 * k + 1] - d[2 * k];
            if (out[k] > per / 2) out[k] -= per; else if (out[k] < -per / 2) out[k] += per;
        }
        return out;
    }

    // Least-squares parameter step [du, dv] with du * Su + dv * Sv = d
    private static tangentStep( su : Point, sv : Point, d : Point ) : UV {
        const a = Vec.dot( su, su ), b = Vec.dot( su, sv ), c = Vec.dot( sv, sv );
        const r0 = Vec.dot( su, d ), r1 = Vec.dot( sv, d );
        const det = a * c - b * b;
        if (Math.abs( det ) < 1e-300) return [0, 0];
        return [(c * r0 - b * r1) / det, (a * r1 - b * r0) / det];
    }

    public static domain( s : NurbsSurfaceData ) : [number, number, number, number] {
        return [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
    }

    public static toDomain( S : SurfaceDomain, uv : UV ) : UV {
        const d = SurfaceIntersect.domain( S.surface );
        const p = S.periodic != null ? S.periodic : [false, false];
        const out : UV = [uv[0], uv[1]];
        for (let k = 0; k < 2; k++) {
            const lo = d[2 * k], hi = d[2 * k + 1], per = hi - lo;
            if (p[k]) { out[k] = lo + ((((out[k] - lo) % per) + per) % per); }
            else out[k] = Math.min( Math.max( out[k], lo ), hi );
        }
        return out;
    }

    // The point between two parameters, taking the short way around periodic directions.
    public static lerpUV( S : SurfaceDomain, t : number, a : UV, b : UV ) : UV {
        const d = SurfaceIntersect.domain( S.surface );
        const p = S.periodic != null ? S.periodic : [false, false];
        const bb : UV = [b[0], b[1]];
        for (let k = 0; k < 2; k++) {
            if (!p[k]) continue;
            const per = d[2 * k + 1] - d[2 * k];
            if (bb[k] - a[k] > per / 2) bb[k] -= per;
            else if (a[k] - bb[k] > per / 2) bb[k] += per;
        }
        return SurfaceIntersect.toDomain( S, [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t] );
    }

    // An open branch leaves through an edge of one of the two faces. Put an exact vertex where it crosses that edge
    // (isocurve/surface Newton from the branch's last vertex), so the faces on both sides of the edge share it.
    // `reach` bounds how far the edge may be from the last vertex.
    public static extendToEdges( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, reach : number, tol : number ) : IntersectionCurve {
        const end = (k : number) => {
            const p = c.points[k];
            let best : { point : Point, uvA : UV, uvB : UV, d : number } | null = null;
            for (let side = 0; side < 2; side++) {
                const S = side == 0 ? A : B, O = side == 0 ? B : A;
                const uvS = side == 0 ? c.uvA[k] : c.uvB[k], uvO = side == 0 ? c.uvB[k] : c.uvA[k];
                const per = S.periodic != null ? S.periodic : [false, false];
                const d = SurfaceIntersect.domain( S.surface );
                for (let a = 0; a < 2; a++) {
                    if (per[a]) continue;
                    for (let e = 0; e < 2; e++) {
                        const value = d[2 * a + e];
                        const r = SurfaceIntersect.isocurveSurface( S.surface, a == 0, value, uvS[1 - a], O.surface, uvO, tol );
                        if (r == null) continue;
                        const dist = Vec.dist( r.point, p );
                        if (dist > reach || (best != null && dist >= best.d)) continue;
                        const onS : UV = a == 0 ? [value, r.t] : [r.t, value];
                        const onO = SurfaceIntersect.toDomain( O, r.uvB );
                        const od = SurfaceIntersect.domain( O.surface );
                        const op = O.periodic != null ? O.periodic : [false, false];
                        const off = [0, 1].some( q => !op[q] && (r.uvB[q] < od[2 * q] - 1e-9 || r.uvB[q] > od[2 * q + 1] + 1e-9) );
                        if (off) continue; // the crossing is off the other face
                        best = { point : r.point, uvA : side == 0 ? onS : onO, uvB : side == 0 ? onO : onS, d : dist };
                    }
                }
            }
            return best;
        };
        const pts = c.points.slice(), ua = c.uvA.slice(), ub = c.uvB.slice();
        const first = end( 0 ), last = end( c.points.length - 1 );
        if (first != null) {
            if (first.d < reach * 0.02) { pts[0] = first.point; ua[0] = first.uvA; ub[0] = first.uvB; }
            else { pts.unshift( first.point ); ua.unshift( first.uvA ); ub.unshift( first.uvB ); }
        }
        if (last != null) {
            const n = pts.length - 1;
            if (last.d < reach * 0.02) { pts[n] = last.point; ua[n] = last.uvA; ub[n] = last.uvB; }
            else { pts.push( last.point ); ua.push( last.uvA ); ub.push( last.uvB ); }
        }
        return { points : pts, uvA : ua, uvB : ub, seamA : pts.map( _ => 0 ), seamB : pts.map( _ => 0 ), closed : false };
    }

    // Insert refined midpoints wherever two consecutive vertices are more than `step` apart.
    public static densify( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, step : number, tol : number ) : IntersectionCurve {
        const pts = [c.points[0]], ua = [c.uvA[0]], ub = [c.uvB[0]];
        const n = c.points.length;
        const segs = c.closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
            const j = (i + 1) % n;
            const d = Vec.dist( c.points[i], c.points[j] );
            const k = Math.ceil( d / step );
            for (let s = 1; s < k; s++) {
                const t = s / k;
                const r = SurfaceIntersect.refine( A, B, SurfaceIntersect.lerpUV( A, t, c.uvA[i], c.uvA[j] ), SurfaceIntersect.lerpUV( B, t, c.uvB[i], c.uvB[j] ), tol );
                if (r == null) continue;
                pts.push( r.point ); ua.push( r.uvA ); ub.push( r.uvB );
            }
            if (j != 0) { pts.push( c.points[j] ); ua.push( c.uvA[j] ); ub.push( c.uvB[j] ); }
        }
        return { points : pts, uvA : ua, uvB : ub, seamA : pts.map( _ => 0 ), seamB : pts.map( _ => 0 ), closed : c.closed };
    }

    // Insert an exact vertex wherever the curve crosses a seam of either surface.
    public static insertSeams( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, tol : number ) : IntersectionCurve {
        const n = c.points.length;
        const segs = c.closed ? n : n - 1;
        const pts : Array<Point> = [], ua : Array<UV> = [], ub : Array<UV> = [], sa : Array<number> = [], sb : Array<number> = [];
        const push = (p : Point, a : UV, b : UV, ma : number, mb : number) => { pts.push( p ); ua.push( a ); ub.push( b ); sa.push( ma ); sb.push( mb ); };
        for (let i = 0; i < n; i++) {
            push( c.points[i], c.uvA[i], c.uvB[i], 0, 0 );
            if (i >= segs) continue;
            const j = (i + 1) % n;
            // crossings in order along the segment: [t, onA, dir]
            const crossings : Array<[number, boolean, number]> = [];
            for (let side = 0; side < 2; side++) {
                const S = side == 0 ? A : B;
                const uvs = side == 0 ? c.uvA : c.uvB;
                // (a face of a solid made from a shell is open, cut at its surface's seam, but a branch across that
                // seam crosses it all the same: a hole's wall in an extrusion, #104)
                const per = S.periodic != null ? S.periodic.map( (x, k) => x || SurfaceIntersect.closedness( S.surface )[k] ) : SurfaceIntersect.closedness( S.surface );
                const d = SurfaceIntersect.domain( S.surface );
                for (let k = 0; k < 2; k++) {
                    if (!per[k]) continue;
                    const len = d[2 * k + 1] - d[2 * k];
                    const x0 = uvs[i][k], x1 = uvs[j][k];
                    if (Math.abs( x1 - x0 ) > len / 2) {
                        // crosses the seam: fraction of the way along the segment, going the short way
                        const a0 = x0 > x1 ? d[2 * k + 1] - x0 : x0 - d[2 * k];
                        const a1 = x0 > x1 ? x1 - d[2 * k] : d[2 * k + 1] - x1;
                        crossings.push( [a0 / (a0 + a1), side == 0, k] );
                    }
                }
            }
            crossings.sort( (p, q) => p[0] - q[0] );
            for (const cr of crossings) {
                const t = cr[0], onA = cr[1], k = cr[2];
                const S = onA ? A : B, O = onA ? B : A;
                const d = SurfaceIntersect.domain( S.surface );
                const uvS = SurfaceIntersect.lerpUV( S, t, (onA ? c.uvA : c.uvB)[i], (onA ? c.uvA : c.uvB)[j] );
                const uvO = SurfaceIntersect.lerpUV( O, t, (onA ? c.uvB : c.uvA)[i], (onA ? c.uvB : c.uvA)[j] );
                let r = SurfaceIntersect.isocurveSurface( S.surface, k == 0, d[2 * k], uvS[1 - k], O.surface, uvO, tol );
                // where the curve runs along an edge of one surface lying on the other (a bore's end cap, whose rim lies
                // on a hole's wall of the same radius: bores that line up through stacked layers, #104), Newton has no
                // isolated crossing to find: the point on the seam at the estimate is on the other surface too, if its
                // projection there lands on it (from the grid if the estimate there lies across its own seam)
                if (r == null) {
                    const on : UV = k == 0 ? [d[0], uvS[1]] : [uvS[0], d[2]];
                    const P = Eval.rationalSurfacePoint( S.surface, on[0], on[1] );
                    let q = SurfaceIntersect.project( O.surface, P, 12, uvO );
                    if (Vec.dist( Eval.rationalSurfacePoint( O.surface, q[0], q[1] ), P ) >= 1e-7) q = SurfaceIntersect.project( O.surface, P, 24 );
                    const Q = Eval.rationalSurfacePoint( O.surface, q[0], q[1] );
                    if (Vec.dist( P, Q ) < 1e-7) r = { t : on[1 - k], uvB : q, point : Vec.lerp( 0.5, P, Q ) };
                }
                if (r == null) throw "SurfaceIntersect: could not place the seam crossing of an intersection curve";
                const uvSeam : UV = k == 0 ? [d[0], r.t] : [r.t, d[2]];
                const uvOther = SurfaceIntersect.toDomain( O, r.uvB );
                const mask = k == 0 ? 1 : 2;
                if (onA) push( r.point, uvSeam, uvOther, mask, 0 ); else push( r.point, uvOther, uvSeam, 0, mask );
            }
        }
        return { points : pts, uvA : ua, uvB : ub, seamA : sa, seamB : sb, closed : c.closed };
    }

    // Where an isoparametric curve of `a` (u or v fixed at `value`) crosses surface `b`, by Newton's method on
    // A(t) - B(s, r) = 0, starting from the guess (t0, uvB0). Returns the parameter along the isocurve, the
    // parameters on b and the point; null if it does not converge. Parameters on b are not wrapped or clamped.
    public static isocurveSurface( a : NurbsSurfaceData, fixU : boolean, value : number, t0 : number,
                                   b : NurbsSurfaceData, uvB0 : UV, tol : number = 1e-10 ) : { t : number, uvB : UV, point : Point } | null {
        let t = t0, s = uvB0[0], r = uvB0[1];
        const d = SurfaceIntersect.domain( a );
        const lo = fixU ? d[2] : d[0], hi = fixU ? d[3] : d[1];
        for (let it = 0; it < 50; it++) {
            const da = fixU ? Eval.rationalSurfaceDerivatives( a, value, t, 1 ) : Eval.rationalSurfaceDerivatives( a, t, value, 1 );
            const db = Eval.rationalSurfaceDerivatives( b, s, r, 1 );
            const F = Vec.sub( da[0][0], db[0][0] );
            if (Vec.norm( F ) < tol) return { t : t, uvB : [s, r], point : Vec.lerp( 0.5, da[0][0], db[0][0] ) };
            const At = fixU ? da[0][1] : da[1][0];
            const J = [0, 1, 2].map( k => [At[k], -db[1][0][k], -db[0][1][k]] );
            let step : Array<number>;
            try { step = Mat.solve( J, Vec.mul( -1, F ) ); } catch (e) { return null; }
            if (step.some( x => !isFinite( x ) )) return null;
            t = Math.min( Math.max( t + step[0], lo ), hi );
            s += step[1]; r += step[2];
        }
        return null;
    }

    // A grid triangulation of a surface with its parameters, for finding intersection branches.
    public static gridMesh( s : NurbsSurfaceData, divs : [number, number] ) : MeshData {
        const d = SurfaceIntersect.domain( s );
        const pts : Array<Point> = [], uvs : Array<UV> = [], nrm : Array<Point> = [], faces : Array<Array<number>> = [];
        for (let i = 0; i <= divs[0]; i++) for (let j = 0; j <= divs[1]; j++) {
            const u = d[0] + (d[1] - d[0]) * i / divs[0], v = d[2] + (d[3] - d[2]) * j / divs[1];
            pts.push( Eval.rationalSurfacePoint( s, u, v ) ); uvs.push( [u, v] ); nrm.push( [0, 0, 0] );
        }
        const w = divs[1] + 1;
        for (let i = 0; i < divs[0]; i++) for (let j = 0; j < divs[1]; j++) {
            const a = i * w + j, b = a + 1, c = a + w + 1, e = a + w;
            faces.push( [a, b, c] ); faces.push( [a, c, e] );
        }
        return new MeshData( faces, pts, nrm, uvs );
    }

    private static size( m : MeshData ) : number {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const p of m.points) for (let k = 0; k < 3; k++) { min[k] = Math.min( min[k], p[k] ); max[k] = Math.max( max[k], p[k] ); }
        return Vec.dist( min, max );
    }

    // the longest triangle edge of either mesh, which bounds the gap the mesh intersection can leave in a loop
    private static meshEdge( ma : MeshData, mb : MeshData ) : number {
        let e = 0.0;
        for (const m of [ma, mb]) for (const f of m.faces) for (let k = 0; k < 3; k++) e = Math.max( e, Vec.dist( m.points[f[k]], m.points[f[(k + 1) % 3]] ) );
        return e;
    }
}
