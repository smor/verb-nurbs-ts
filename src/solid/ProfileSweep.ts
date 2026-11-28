import { NurbsCurveData, NurbsSurfaceData, Point, Vector } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { triangulate } from "../eval/Cdt.js";
import { Eval } from "../eval/Eval.js";
import { Modify } from "../eval/Modify.js";
import { RotationMinimizingFrames } from "../eval/Sweep.js";
import { BrepSolid } from "./Brep.js";
import { BrepShell, ShellBuilder, ShellEdge, ShellFace } from "./BrepShell.js";
import { Extrusion, ProfileSpec } from "./Extrusion.js";
import { TriMesh } from "./TriMesh.js";

/**
 * How the section turns along the rail (#134). The section is always in the plane normal to the rail; its v axis is
 * held:
 * * `radial`: pointing away from an axis (a barrel cam's groove: the cutter's axis points at the drum's);
 * * `up`: along a fixed direction, projected into the normal plane;
 * * `rmf`: by a rotation-minimizing frame (Wang, Jüttler, Zheng and Liu, "Computation of rotation minimizing frames",
 *   ACM TOG 27(1), 2008), from `up` at the start; on a closed rail its twist after one loop (`closureAngle`) is spread
 *   evenly along it, so the section meets itself where the rail does.
 * The u axis is v × t, so that (u, v, t) is right-handed and a counter-clockwise section faces out.
 */
export type SweepFrame = "radial" | "up" | "rmf";

/** The rail and the frame of a sweep (`ProfileSweep`). */
export interface ProfileSweepOptions {
    // the rail closes on itself: its points do not repeat the first at the end (a ring, with no caps)
    closed? : boolean;
    // default "rmf"
    frame? : SweepFrame;
    // `radial`: the axis v points away from, through `point` along `direction` (default: the z axis)
    axis? : { point : Point, direction : Vector };
    // `up`: the direction v is held along; `rmf`: v at the start (default z, or x where the rail starts along z)
    up? : Vector;
    // an open rail's derivatives d/dt at its ends (t from 0 to 1 over the points); estimated from the points if missing
    startTangent? : Vector;
    endTangent? : Vector;
    // an open rail: flat caps at both ends (default true). Without them the shell is open, a surface, not a solid
    caps? : boolean;
}

/** A rail's end: its point, its unit tangent (the way the rail runs), and the section's u and v axes there. */
export interface SweepEnd {
    point : Point;
    tangent : Vector;
    u : Vector;
    v : Vector;
}

// one segment as an exact curve over [0, 1] in the plane z = 0
interface Piece { curve : NurbsCurveData, index : number }
// a curve's control points and knots, of any dimension (non-rational)
interface Spline { knots : Array<number>, points : Array<Array<number>> }

// The cubic splines' degree, and how many samples a closed rail is carried on past each end before it is cut (the
// effect of an end on a cubic spline interpolant falls by a factor of about 2 - sqrt(3) = 0.27 a sample, de Boor, A
// Practical Guide to Splines, 2001, ch. IV: 12 samples on, below 1e-7 of it).
const DEGREE = 3, OVERLAP = 12;

/**
 * A planar section swept along a rail, as an exact shell of trimmed faces (#134): the operand of Booleans that a
 * barrel cam's groove is cut with.
 *
 * The rail is the cubic spline C(t) through its points at t = i / n. The section's frame, its axes U and V, is taken
 * at the points and interpolated the same way, on the same knots. A section piece s(w) = (x(w), y(w)) then sweeps
 * the tensor-product surface C(t) + x(w) U(t) + y(w) V(t): exact, in that the section is the profile's own exact curve
 * (lines, rational arcs and circles, Béziers) at every t, mapped by the frame; and its control points are those of the
 * piece and the three splines (for a piece's control point (x w, y w, w), the row w C_j + x w U_j + y w V_j).
 *
 * A closed rail makes a ring with no caps, cut into two halves (a face round the whole of it would meet itself along
 * its seam, which the Booleans do not cut against, #122). An open rail is capped by the section's planes at its ends
 * (or left open, a surface). Face names: `outer.k` for the outer path's segment k, `hole{i}.k` for hole i's (the
 * halves of a ring share a name), `start` and `end` for the caps.
 */
export class ProfileSweep {

    /** The swept solid (`shell`), as an operand of Booleans. */
    public static solid( section : ProfileSpec, rail : Array<Point>, options : ProfileSweepOptions = {} ) : BrepSolid {
        const s = ProfileSweep.shell( section, rail, options );
        if (!(options.closed ?? false) && options.caps === false) throw new Error( "ProfileSweep: an open rail without caps sweeps a surface, not a solid" );
        const solid = ShellBuilder.solid( s.shell, s.mesh );
        const names = s.shell.faces.map( f => f.name );
        solid.faces.forEach( (f, k) => { if (names.indexOf( names[k] ) != names.lastIndexOf( names[k] )) f.half = true; } );
        return solid;
    }

    /**
     * The exact shell of the sweep, a closed mesh of it (inside from outside), and the rail's ends with the frame
     * there (`SweepEnd`: what another part is placed by, #134). Refuses a rail of fewer than 4 points, a frame that
     * cannot be taken (the rail along the axis or the up direction) and a section that is not a profile.
     */
    public static shell( section : ProfileSpec, rail : Array<Point>, options : ProfileSweepOptions = {} ) : { shell : BrepShell, mesh : TriMesh, ends : { start : SweepEnd, end : SweepEnd } } {
        const closed = options.closed ?? false, caps = !closed && (options.caps ?? true);
        const R = ProfileSweep.rail( rail, options );
        const loops = Extrusion.loops( section ).map( l => ({ ...l, pieces : l.pieces as Array<Piece> }) );

        // the pieces of the rail: one, or a ring's two halves; their stations (where faces meet across the rail)
        const parts = R.parts;
        ProfileSweep.unfolded( loops.map( l => l.pieces ), parts );
        const stations = closed ? parts.length : parts.length + 1;
        // the point of the rail and the frame at station s, as the parts' own end control points (so exactly theirs)
        const at = (s : number) => {
            const p = s < parts.length ? parts[s] : parts[parts.length - 1], j = s < parts.length ? 0 : p.C.points.length - 1;
            return { C : p.C.points[j], U : p.U.points[j], V : p.V.points[j] };
        };
        const map = (f : { C : Array<number>, U : Array<number>, V : Array<number> }, x : number, y : number) : Point => [0, 1, 2].map( i => f.C[i] + x * f.U[i] + y * f.V[i] );

        // the caps' plane patch: the section's box, a little larger, in each end's frame
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const l of loops) for (const q of l.pieces) for (const hp of q.curve.controlPoints) {
            const x = hp[0] / hp[3], y = hp[1] / hp[3];
            x0 = Math.min( x0, x ); x1 = Math.max( x1, x ); y0 = Math.min( y0, y ); y1 = Math.max( y1, y );
        }
        const pad = 0.01 * Math.max( x1 - x0, y1 - y0 );
        x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
        const W = x1 - x0, H = y1 - y0;
        const plane = (s : number) => { const f = at( s ), m = (x : number, y : number) => [...map( f, x, y ), 1];
            return new NurbsSurfaceData( 1, 1, [0, 0, 1, 1], [0, 0, 1, 1], [[m( x0, y0 ), m( x0, y1 )], [m( x1, y0 ), m( x1, y1 )]] ); };
        const onCap = (c : NurbsCurveData) => new NurbsCurveData( c.degree, c.knots.slice(), c.controlPoints.map( hp => [(hp[0] - x0 * hp[3]) / W, (hp[1] - y0 * hp[3]) / H, hp[3]] ) );
        const line2 = (a : [number, number], b : [number, number]) => new NurbsCurveData( 1, [0, 0, 1, 1], [[a[0], a[1], 1], [b[0], b[1], 1]] );
        // a section piece at station s, exact: its control points mapped by the frame there
        const across = (c : NurbsCurveData, s : number) => { const f = at( s );
            return new NurbsCurveData( c.degree, c.knots.slice(), c.controlPoints.map( hp => [...[0, 1, 2].map( i => hp[3] * f.C[i] + hp[0] * f.U[i] + hp[1] * f.V[i] ), hp[3]] ) ); };
        // a section point (x, y) along rail part r: the isocurve of the side faces there
        const along = (x : number, y : number, r : number) => { const p = parts[r];
            return new NurbsCurveData( DEGREE, p.C.knots.slice(), p.C.points.map( (c, j) => [...[0, 1, 2].map( i => c[i] + x * p.U.points[j][i] + y * p.V.points[j][i] ), 1] ) ); };
        // a side face: section piece by rail part
        const side = (c : NurbsCurveData, r : number) => { const p = parts[r];
            return new NurbsSurfaceData( c.degree, DEGREE, c.knots.slice(), p.C.knots.slice(), c.controlPoints.map( hp => p.C.points.map( (cj, j) =>
                [...[0, 1, 2].map( i => hp[3] * cj[i] + hp[0] * p.U.points[j][i] + hp[1] * p.V.points[j][i] ), hp[3]] ) ) ); };

        const vertices : Array<Point> = [];
        const edges : Array<ShellEdge> = [];
        const faces : Array<ShellFace> = [];
        if (caps) {
            faces.push( { surface : plane( 0 ), sameSense : false, closed : [false, false], loops : [], source : 0, name : "start" } );
            faces.push( { surface : plane( stations - 1 ), sameSense : true, closed : [false, false], loops : [], source : 1, name : "end" } );
        }
        const station = (s : number) => closed ? s % stations : s;
        for (const l of loops) {
            const n = l.pieces.length;
            const start = l.pieces.map( q => { const hp = q.curve.controlPoints[0]; return [hp[0] / hp[3], hp[1] / hp[3]]; } );
            // P[s][k]: the vertex of piece k's start at station s
            const P = Array.from( { length : stations }, (_, s) => start.map( xy => vertices.push( map( at( s ), xy[0], xy[1] ) ) - 1 ) );
            // F[r][k]: the face of piece k along rail part r
            const F = parts.map( (_, r) => l.pieces.map( q => {
                faces.push( { surface : side( q.curve, r ), sameSense : true, closed : [false, false], loops : [], source : faces.length, name : l.name + "." + q.index } );
                return faces.length - 1;
            } ) );
            // S[s][k]: piece k across the rail at station s; the face starting there on its left, the one ending there
            // (or the start cap) on its right; at an open rail's last station, the end cap on its left
            const S = Array.from( { length : stations }, (_, s) => l.pieces.map( (q, k) => {
                const after = closed || s < parts.length ? F[s % parts.length][k] : -1, before = closed || s > 0 ? F[(s + parts.length - 1) % parts.length][k] : -1;
                const left = after >= 0 ? after : 1, right = before >= 0 ? before : 0;
                if ((after < 0 || before < 0) && !caps) return -1;
                edges.push( { curve : across( q.curve, s ), start : P[s][k], end : P[s][(k + 1) % n], left : left, right : right,
                              pcurves : [after >= 0 ? line2( [0, 0], [1, 0] ) : onCap( q.curve ), before >= 0 ? line2( [0, 1], [1, 1] ) : onCap( q.curve )], tolerance : 0 } );
                return edges.length - 1;
            } ) );
            // L[r][k]: along rail part r at piece k's start, piece k - 1 on its left and piece k on its right
            const L = parts.map( (_, r) => l.pieces.map( (_q, k) => {
                edges.push( { curve : along( start[k][0], start[k][1], r ), start : P[r][k], end : P[station( r + 1 )][k],
                              left : F[r][(k + n - 1) % n], right : F[r][k], pcurves : [line2( [1, 0], [1, 1] ), line2( [0, 0], [0, 1] )], tolerance : 0 } );
                return edges.length - 1;
            } ) );
            parts.forEach( (_, r) => l.pieces.forEach( (_q, k) => {
                const lo = S[r][k], hi = S[station( r + 1 )][k];
                const loop : Array<[number, boolean]> = [];
                if (lo >= 0) loop.push( [lo, true] );
                loop.push( [L[r][(k + 1) % n], true] );
                if (hi >= 0) loop.push( [hi, false] );
                loop.push( [L[r][k], false] );
                faces[F[r][k]].loops.push( { outer : true, region : 0, edges : loop } );
            } ) );
            if (caps) {
                faces[0].loops.push( { outer : l.outer, region : 0, edges : S[0].slice().reverse().map( e => [e, false] as [number, boolean] ) } );
                faces[1].loops.push( { outer : l.outer, region : 0, edges : S[stations - 1].map( e => [e, true] as [number, boolean] ) } );
            }
        }
        const shell : BrepShell = { vertices : vertices, edges : edges, faces : faces, tolerance : 0, volume : ProfileSweep.volume( loops.map( l => l.pieces ), parts ) };
        return { shell : shell, mesh : ProfileSweep.mesh( loops.map( l => l.pieces ), parts, closed, caps ), ends : R.ends };
    }

    /**
     * The rail's ends and the frame there, as `shell` takes them (without building the shell): what a graph's end
     * outputs are checked against.
     */
    public static ends( rail : Array<Point>, options : ProfileSweepOptions = {} ) : { start : SweepEnd, end : SweepEnd } {
        return ProfileSweep.rail( rail, options ).ends;
    }

    /**
     * The frame at a point of the rail with derivative `d` there, for the `radial` and `up` frames: v is the axis's
     * outward direction (or `up`) less its part along the tangent, u = v × t. What a graph's end outputs compute, as
     * expressions.
     */
    public static frame( p : Point, d : Vector, frame : "radial" | "up", options : ProfileSweepOptions = {} ) : { tangent : Vector, u : Vector, v : Vector } {
        const len = Vec.norm( d );
        if (!(len > 0)) throw new Error( "ProfileSweep: the rail stops (its derivative is zero)" );
        const T = Vec.mul( 1 / len, d );
        let w : Vector;
        let scale = 1;
        if (frame == "radial") {
            const a = options.axis ?? { point : [0, 0, 0], direction : [0, 0, 1] };
            const dir = Vec.normalized( a.direction );
            const r = Vec.sub( p, a.point );
            const radial = Vec.sub( r, Vec.mul( Vec.dot( r, dir ), dir ) );
            scale = Vec.norm( radial );
            if (!(scale > 0)) throw new Error( "ProfileSweep: the rail meets the axis, where no direction is radial" );
            w = Vec.sub( radial, Vec.mul( Vec.dot( radial, T ), T ) );
        } else {
            const up = options.up ?? [0, 0, 1];
            scale = Vec.norm( up );
            if (!(scale > 0)) throw new Error( "ProfileSweep: the up direction is zero" );
            w = Vec.sub( up, Vec.mul( Vec.dot( up, T ), T ) );
        }
        // (1e-9 of its length: below that, v would be the rounding of a vector along the tangent)
        if (!(Vec.norm( w ) > 1e-9 * scale)) throw new Error( `ProfileSweep: the rail runs along the ${frame == "radial" ? "radial direction" : "up direction"}, where the frame is not defined` );
        const V = Vec.normalized( w );
        return { tangent : T, u : Vec.cross( V, T ), v : V };
    }

    // The rail as cubic splines C, U, V on shared knots, cut into its parts (one, or a ring's two halves), each over
    // [0, 1]; and its ends.
    private static rail( rail : Array<Point>, options : ProfileSweepOptions ) : { parts : Array<{ C : Spline, U : Spline, V : Spline }>, ends : { start : SweepEnd, end : SweepEnd } } {
        const closed = options.closed ?? false, mode = options.frame ?? "rmf";
        if (!["radial", "up", "rmf"].includes( mode )) throw new Error( `ProfileSweep: the frame is "radial", "up" or "rmf", not "${String( mode )}"` );
        if (!Array.isArray( rail ) || rail.length < 4) throw new Error( "ProfileSweep: a rail has 4 points or more" );
        rail.forEach( (p, i) => { if (!Array.isArray( p ) || p.length != 3 || !p.every( isFinite )) throw new Error( `ProfileSweep: the rail's point ${i} is not a point [x, y, z]` ); } );
        const n = closed ? rail.length : rail.length - 1;
        // the points, carried on round a ring past both ends
        const idx = closed ? Array.from( { length : n + 2 * OVERLAP + 1 }, (_, i) => i - OVERLAP ) : Array.from( { length : n + 1 }, (_, i) => i );
        const params = idx.map( i => i / n );
        const wrap = (i : number) => closed ? ((i % n) + n) % n : i;
        const pts = idx.map( i => rail[wrap( i )] );
        // an open rail's end derivatives: given, or one-sided differences of second order
        const h = 1 / n;
        const d0 = options.startTangent ?? [0, 1, 2].map( i => (-3 * rail[0][i] + 4 * rail[1][i] - rail[2][i]) / (2 * h) );
        const m = rail.length - 1;
        const d1 = options.endTangent ?? [0, 1, 2].map( i => (3 * rail[m][i] - 4 * rail[m - 1][i] + rail[m - 2][i]) / (2 * h) );
        const C = ProfileSweep.interpolate( pts, params, closed ? null : [d0, d1] );
        const curve = new NurbsCurveData( DEGREE, C.knots.slice(), C.points.map( p => [...p, 1] ) );
        const derivative = (t : number) => Eval.rationalCurveDerivatives( curve, t, 1 )[1];
        const point = (t : number) => Eval.rationalCurvePoint( curve, t );
        // the frame at a parameter
        let rmf : RotationMinimizingFrames | null = null;
        if (mode == "rmf") {
            const ring = closed ? ProfileSweep.cut( C, [0, 1] )[0] : C;
            rmf = new RotationMinimizingFrames( new NurbsCurveData( DEGREE, ring.knots.slice(), ring.points.map( p => [...p, 1] ) ),
                { closed : closed, samples : Math.max( 512, 16 * n ), ...(options.up != null ? { initialNormal : options.up } : {}) } );
        }
        const frameAt = (t : number) : { tangent : Vector, u : Vector, v : Vector } => {
            if (rmf == null) return ProfileSweep.frame( point( t ), derivative( t ), mode as "radial" | "up", options );
            const f = rmf.frameAt( closed ? ((t % 1) + 1) % 1 : t );
            return { tangent : f.tangent, u : Vec.cross( f.normal, f.tangent ), v : f.normal };
        };
        // at the samples (a ring's carried on past its ends are its own samples again)
        const F = Array.from( { length : n + 1 }, (_, i) => frameAt( i / n ) );
        const frames = idx.map( i => F[wrap( i )] );
        // an open rail's frame derivatives at its ends: differences of second order over a small step (1e-3 of a
        // sample: small against the frame's turning, large against rounding)
        let dF : [Array<number>, Array<number>] | null = null;
        if (!closed) {
            const e = 1e-3 * h;
            const f = [0, e, 2 * e, 1 - 2 * e, 1 - e, 1].map( t => { const g = frameAt( t ); return [...g.u, ...g.v]; } );
            dF = [[0, 1, 2, 3, 4, 5].map( i => (-3 * f[0][i] + 4 * f[1][i] - f[2][i]) / (2 * e) ), [0, 1, 2, 3, 4, 5].map( i => (3 * f[5][i] - 4 * f[4][i] + f[3][i]) / (2 * e) )];
        }
        const UV = ProfileSweep.interpolate( frames.map( f => [...f.u, ...f.v] ), params, dF );
        const half = (s : Spline) : Array<Spline> => closed ? ProfileSweep.cut( s, [0, Math.floor( n / 2 ) / n, 1] ) : [s];
        const Cs = half( C ), UVs = half( UV );
        if (closed) {
            // the ring's seam: its last point and frame those of its first, exactly
            const a = Cs[0], b = Cs[Cs.length - 1], ua = UVs[0], ub = UVs[UVs.length - 1];
            b.points[b.points.length - 1] = a.points[0].slice();
            ub.points[ub.points.length - 1] = ua.points[0].slice();
        }
        const parts = Cs.map( (c, r) => ({ C : c, U : { knots : c.knots, points : UVs[r].points.map( p => p.slice( 0, 3 ) ) }, V : { knots : c.knots, points : UVs[r].points.map( p => p.slice( 3, 6 ) ) } }) );
        const end = (f : { tangent : Vector, u : Vector, v : Vector }, p : Point) : SweepEnd => ({ point : p, tangent : f.tangent, u : f.u, v : f.v });
        const last = parts[parts.length - 1];
        return { parts : parts, ends : { start : end( F[0], parts[0].C.points[0].slice() ), end : end( closed ? F[0] : F[n], last.C.points[last.C.points.length - 1].slice() ) } };
    }

    // The cubic spline through `points` at uniform `params` (i / n): on clamped knots at the parameters (averaging, The
    // NURBS Book, eq. 9.8, which for uniform parameters gives the parameters themselves, so exact), with the end
    // derivatives `ends` when given (two more control points). The collocation matrix is banded, and solved without
    // pivoting: a spline collocation matrix is totally positive (de Boor, "Total positivity of the spline collocation
    // matrix", Indiana Univ. Math. J. 25, 1976), which makes elimination without pivoting stable (de Boor and Pinkus,
    // "Backward error analysis for totally positive linear systems", Numer. Math. 27, 1977); the derivative rows are
    // differences of the first two control points, eliminated by the first row.
    private static interpolate( points : Array<Array<number>>, params : Array<number>, ends : [Array<number>, Array<number>] | null ) : Spline {
        const p = DEGREE, m = points.length - 1, dim = points[0].length;
        const a = params[0], b = params[m];
        const knots = [a, a, a, a];
        if (ends != null) for (let i = 1; i < m; i++) knots.push( params[i] );
        else for (let i = 2; i < m - 1; i++) knots.push( params[i] );
        knots.push( b, b, b, b );
        const N = knots.length - p - 1;
        // the rows: point i at params[i], the derivative rows second and second to last
        const BAND = 4;
        const rows : Array<Float64Array> = [], rhs : Array<Array<number>> = [];
        const put = (cols : Array<[number, number]>, r : Array<number>) => {
            const row = new Float64Array( 2 * BAND + 1 ), i = rows.length;
            for (const [c, v] of cols) {
                if (Math.abs( c - i ) > BAND) throw new Error( "ProfileSweep: the rail's spline is out of its band" );
                row[c - i + BAND] = v;
            }
            rows.push( row ); rhs.push( r.slice() );
        };
        const point = (i : number) => {
            const u = params[i], span = Eval.knotSpanGivenN( N - 1, p, u, knots ), basis = Eval.basisFunctionsGivenKnotSpanIndex( span, u, p, knots );
            put( basis.map( (v, k) => [span - p + k, v] as [number, number] ), points[i] );
        };
        point( 0 );
        // C'(a) = p (P1 - P0) / (knots[p + 1] - a), C'(b) = p (P[N-1] - P[N-2]) / (b - knots[N - 1])
        if (ends != null) put( [[0, -1], [1, 1]], ends[0].map( x => x * (knots[p + 1] - a) / p ) );
        for (let i = 1; i < m; i++) point( i );
        if (ends != null) put( [[N - 2, -1], [N - 1, 1]], ends[1].map( x => x * (b - knots[N - 1]) / p ) );
        point( m );
        if (rows.length != N) throw new Error( "ProfileSweep: the rail's spline has as many conditions as control points" );
        // elimination within the band
        for (let k = 0; k < N; k++) {
            const pivot = rows[k][BAND];
            if (!(Math.abs( pivot ) > 0)) throw new Error( "ProfileSweep: the rail's spline cannot be solved" );
            for (let i = k + 1; i <= Math.min( N - 1, k + BAND ); i++) {
                const f = rows[i][k - i + BAND] / pivot;
                if (f == 0) continue;
                for (let c = k; c <= Math.min( N - 1, k + BAND ); c++) rows[i][c - i + BAND] -= f * rows[k][c - k + BAND];
                for (let d = 0; d < dim; d++) rhs[i][d] -= f * rhs[k][d];
            }
        }
        const x : Array<Array<number>> = new Array( N );
        for (let k = N - 1; k >= 0; k--) {
            const v = rhs[k].slice();
            for (let c = k + 1; c <= Math.min( N - 1, k + BAND ); c++) for (let d = 0; d < dim; d++) v[d] -= rows[k][c - k + BAND] * x[c][d];
            x[k] = v.map( y => y / rows[k][BAND] );
        }
        return { knots : knots, points : x };
    }

    // A spline cut at knots it has (once each), into the pieces between consecutive cuts, each over [0, 1]: the cuts
    // raised to full multiplicity by knot insertion (Boehm), which leaves the curve as it is.
    private static cut( s : Spline, at : Array<number> ) : Array<Spline> {
        const p = DEGREE, dim = s.points[0].length;
        const curve = new NurbsCurveData( p, s.knots.slice(), s.points.map( q => [...q, 1] ) );
        const insert : Array<number> = [];
        for (const c of at) {
            const mult = s.knots.filter( k => k == c ).length;
            for (let i = mult; i < p + 1; i++) insert.push( c );
        }
        const r = Modify.curveKnotRefine( curve, insert.sort( (x, y) => x - y ) );
        const first = at.map( c => r.knots.indexOf( c ) );
        const out : Array<Spline> = [];
        for (let i = 0; i + 1 < at.length; i++) {
            const a = first[i], b = first[i + 1], lo = at[i], hi = at[i + 1];
            out.push( { knots : r.knots.slice( a, b + p + 1 ).map( k => (k - lo) / (hi - lo) ), points : r.controlPoints.slice( a, b ).map( q => q.slice( 0, dim ) ) } );
        }
        return out;
    }

    // The volume the shell bounds, in closed form. The solid is the image of (x, y, t) -> C(t) + x U(t) + y V(t) over
    // the section, so its volume is the integral of det(U, V, C' + x U' + y V') over the section and t: per t,
    // A det(U, V, C') + Mx det(U, V, U') + My det(U, V, V') for the section's area A and first moments Mx, My (their
    // exact pieces, by Green's theorem). Polynomials of degree 8 on each knot span: Gauss-Legendre at 8 points.
    private static volume( loops : Array<Array<Piece>>, parts : Array<{ C : Spline, U : Spline, V : Spline }> ) : number {
        const [A, Mx, My] = ProfileSweep.moments( loops );
        const [xs, ws] = ShellBuilder.gauss( 8 );
        let V = 0;
        for (const part of parts) {
            const c = (s : Spline) => new NurbsCurveData( DEGREE, s.knots.slice(), s.points.map( q => [...q, 1] ) );
            const Cc = c( part.C ), Uc = c( part.U ), Vc = c( part.V );
            const ks = part.C.knots.filter( (k, i) => i == 0 || k > part.C.knots[i - 1] );
            for (let i = 0; i + 1 < ks.length; i++) {
                const h = 0.5 * (ks[i + 1] - ks[i]), m = 0.5 * (ks[i] + ks[i + 1]);
                for (let k = 0; k < xs.length; k++) {
                    const t = m + h * xs[k];
                    const dC = Eval.rationalCurveDerivatives( Cc, t, 1 ), dU = Eval.rationalCurveDerivatives( Uc, t, 1 ), dV = Eval.rationalCurveDerivatives( Vc, t, 1 );
                    const n = Vec.cross( dU[0], dV[0] );
                    V += ws[k] * h * (A * Vec.dot( n, dC[1] ) + Mx * Vec.dot( n, dU[1] ) + My * Vec.dot( n, dV[1] ));
                }
            }
        }
        return V;
    }

    // Refuses a sweep that folds: the map (x, y, t) -> C(t) + x U(t) + y V(t) turns inside out where its Jacobian
    // det(U, V, C' + x U' + y V') is not positive, which is where the section reaches further towards the centre of a
    // bend than the bend's radius (a groove's half-width past the radius of its rail's turn). The Jacobian is affine in
    // (x, y), so it is positive over the section when it is at the corners of the section's control polygons (their
    // convex hull holds it); checked at 8 parameters a knot span of the rail.
    private static unfolded( loops : Array<Array<Piece>>, parts : Array<{ C : Spline, U : Spline, V : Spline }> ) : void {
        const corners : Array<[number, number]> = [];
        for (const l of loops) for (const q of l) for (const hp of q.curve.controlPoints) corners.push( [hp[0] / hp[3], hp[1] / hp[3]] );
        for (const part of parts) {
            const c = (s : Spline) => new NurbsCurveData( DEGREE, s.knots.slice(), s.points.map( q => [...q, 1] ) );
            const Cc = c( part.C ), Uc = c( part.U ), Vc = c( part.V );
            const ks = part.C.knots.filter( (k, i) => i == 0 || k > part.C.knots[i - 1] );
            for (let i = 0; i + 1 < ks.length; i++) for (let j = 0; j <= 8; j++) {
                const t = ks[i] + (ks[i + 1] - ks[i]) * j / 8;
                const dC = Eval.rationalCurveDerivatives( Cc, t, 1 ), dU = Eval.rationalCurveDerivatives( Uc, t, 1 ), dV = Eval.rationalCurveDerivatives( Vc, t, 1 );
                const n = Vec.cross( dU[0], dV[0] ), speed = Vec.norm( dC[1] );
                const a = Vec.dot( n, dC[1] ), bx = Vec.dot( n, dU[1] ), by = Vec.dot( n, dV[1] );
                for (const [x, y] of corners) if (!(a + x * bx + y * by > 1e-9 * speed)) {
                    const p = dC[0].map( v => +v.toFixed( 2 ) ), d2 = Eval.rationalCurveDerivatives( Cc, t, 2 );
                    const radius = Math.pow( speed, 3 ) / Vec.norm( Vec.cross( d2[1], d2[2] ) );
                    throw new Error( `ProfileSweep: the section folds over near (${p.join( ", " )}), where the rail bends with a radius of ${radius.toPrecision( 3 )} mm: `
                        + `the section reaches further than that towards the bend's centre. (A cutter's swept volume is wider there than its section swept along the rail.)` );
                }
            }
        }
    }

    // A region's area and first moments (the integrals of 1, x and y over it), its loops oriented outer
    // counter-clockwise and holes clockwise: by Green's theorem, the integrals of x y', x^2 y' / 2 and -y^2 x' / 2
    // round them, Gauss-Legendre at 16 points a knot span (exact on polynomial pieces, to rounding on arcs).
    private static moments( loops : Array<Array<Piece>> ) : [number, number, number] {
        const [xs, ws] = ShellBuilder.gauss( 16 );
        let A = 0, Mx = 0, My = 0;
        for (const l of loops) for (const q of l) {
            const ks = q.curve.knots.filter( (k, i) => i == 0 || k > q.curve.knots[i - 1] );
            for (let i = 0; i + 1 < ks.length; i++) {
                const h = 0.5 * (ks[i + 1] - ks[i]), m = 0.5 * (ks[i] + ks[i + 1]);
                for (let k = 0; k < xs.length; k++) {
                    const D = Eval.rationalCurveDerivatives( q.curve, m + h * xs[k], 1 );
                    const [x, y] = D[0], [dx, dy] = D[1];
                    A += ws[k] * h * x * dy;
                    Mx += ws[k] * h * x * x * dy / 2;
                    My -= ws[k] * h * y * y * dx / 2;
                }
            }
        }
        return [A, Mx, My];
    }

    // A closed mesh of the sweep (for telling inside from outside): the section sampled, carried along the rail at
    // stations (as many as the rail's knot spans, at most 720 a part), strips between them, and the caps triangulated.
    private static mesh( loops : Array<Array<Piece>>, parts : Array<{ C : Spline, U : Spline, V : Spline }>, closed : boolean, caps : boolean ) : TriMesh {
        const rings = loops.map( pieces => {
            const pts : Array<Point> = [];
            for (const q of pieces) {
                const n = Extrusion.samples( q.curve );
                for (let i = 0; i < n; i++) pts.push( Eval.rationalCurvePoint( q.curve, i / n ) );
            }
            return pts;
        } );
        const mesh = new TriMesh();
        const levels : Array<Array<Array<number>>> = [];
        parts.forEach( (part, r) => {
            const c = (s : Spline) => new NurbsCurveData( DEGREE, s.knots.slice(), s.points.map( q => [...q, 1] ) );
            const Cc = c( part.C ), Uc = c( part.U ), Vc = c( part.V );
            const spans = new Set( part.C.knots ).size - 1, M = Math.min( 720, Math.max( 8, spans ) );
            for (let j = r == 0 ? 0 : 1; j <= M; j++) {
                if (closed && r == parts.length - 1 && j == M) break;
                const t = j / M, C = Eval.rationalCurvePoint( Cc, t ), U = Eval.rationalCurvePoint( Uc, t ), V = Eval.rationalCurvePoint( Vc, t );
                levels.push( rings.map( ring => ring.map( p => mesh.addVertex( [0, 1, 2].map( i => C[i] + p[0] * U[i] + p[1] * V[i] ) ) ) ) );
            }
        } );
        const L = levels.length;
        for (let j = 0; j < (closed ? L : L - 1); j++) rings.forEach( (ring, i) => ring.forEach( (_, k) => {
            const k1 = (k + 1) % ring.length, lo = levels[j][i], hi = levels[(j + 1) % L][i];
            mesh.addTriangle( lo[k], lo[k1], hi[k1] );
            mesh.addTriangle( lo[k], hi[k1], hi[k] );
        } ) );
        if (caps) {
            const flat : Array<Array<number>> = [], seg : Array<Array<number>> = [];
            rings.forEach( r => { const o = flat.length; r.forEach( (p, k) => { flat.push( [p[0], p[1]] ); seg.push( [o + k, o + (k + 1) % r.length] ); } ); } );
            const ids = (k : number, lv : Array<Array<number>>) => { let i = 0, kk = k; while (kk >= rings[i].length) { kk -= rings[i].length; i++; } return lv[i][kk]; };
            for (const t of triangulate( flat, seg, { exterior : false } )) {
                const area = (flat[t[1]][0] - flat[t[0]][0]) * (flat[t[2]][1] - flat[t[0]][1]) - (flat[t[2]][0] - flat[t[0]][0]) * (flat[t[1]][1] - flat[t[0]][1]);
                const [a, b, c] = area > 0 ? t : [t[0], t[2], t[1]];
                // counter-clockwise in (u, v) faces along the rail: out at the end, in at the start
                mesh.addTriangle( ids( a, levels[L - 1] ), ids( b, levels[L - 1] ), ids( c, levels[L - 1] ) );
                mesh.addTriangle( ids( a, levels[0] ), ids( c, levels[0] ), ids( b, levels[0] ) );
            }
        }
        return mesh;
    }
}
