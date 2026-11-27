import { NurbsCurveData, NurbsSurfaceData, Point } from "../core/Data.js";
import { Eval } from "../eval/Eval.js";
import { Make } from "../eval/Make.js";
import { Modify } from "../eval/Modify.js";
import { triangulate } from "../eval/Cdt.js";
import { BrepSolid } from "./Brep.js";
import { BrepShell, ShellBuilder, ShellEdge, ShellFace } from "./BrepShell.js";
import { TriMesh } from "./TriMesh.js";

/** A point of a profile, in mm, in the plane of the profile (x, y). */
export type ProfilePoint = [number, number];

/**
 * One segment of a profile path, from the current point: a line to `to`, an arc from the current point through `via`
 * to `to`, or a cubic Bézier curve with control points `c1` and `c2` to `to`.
 */
export type ProfileSegmentSpec =
    | { type : "line", to : ProfilePoint }
    | { type : "arc", via : ProfilePoint, to : ProfilePoint }
    | { type : "cubic", c1 : ProfilePoint, c2 : ProfilePoint, to : ProfilePoint };

/** A closed path: segments from `start`, the last one ending at `start`; or a circle. */
export type ProfilePath =
    | { kind : "path", start : ProfilePoint, segments : Array<ProfileSegmentSpec> }
    | { kind : "circle", center : ProfilePoint, r : number };

/**
 * How the top follows the bottom (#86): turned by `twist` degrees (counter-clockwise, seen from above) and scaled by
 * `scaleTop` about the z axis, both growing linearly with the height. Twisted sides follow a helix (a worm, a helical
 * gear), scaled ones a cone towards the apex on the axis (a bevel gear).
 */
export interface ExtrusionOptions {
    twist? : number;
    scaleTop? : number;
}

/** A region of the plane: an outer path and the paths of its holes, in either orientation. */
export interface ProfileSpec {
    outer : ProfilePath;
    holes? : Array<ProfilePath>;
}

// one segment as an exact curve over [0, 1] in the plane z = 0, with the index it had in its path
interface Piece { curve : NurbsCurveData, index : number }

/**
 * Exact extrusions of planar profiles along z, as solids of trimmed faces (`ShellBuilder.solid`), so that they are
 * operands of Booleans like any shell.
 *
 * Each segment of a path becomes a side face: a ruled surface over the segment's exact curve (lines, rational arcs and
 * circles, cubic Béziers). The top and bottom are planes trimmed by the paths. Face names: `bottom`, `top`, `outer.k`
 * for the face of the outer path's segment k, `hole{i}.k` for hole i's (both counted from 0; a circle is segment 0).
 * The names follow the segments as given, whichever way round a path runs.
 */
export class Extrusion {

    /** The solid between z and z + height over the profile, its top turned and scaled about the z axis (#86). */
    public static solid( profile : ProfileSpec, height : number, z : number = 0, options : ExtrusionOptions = {} ) : BrepSolid {
        const shell = Extrusion.shell( profile, height, z, options );
        return ShellBuilder.solid( shell.shell, shell.mesh );
    }

    /** The exact shell of the extrusion, and a closed mesh of it for telling inside from outside. */
    public static shell( profile : ProfileSpec, height : number, z : number = 0, options : ExtrusionOptions = {} ) : { shell : BrepShell, mesh : TriMesh } {
        if (!(height > 0) || !isFinite( height )) throw new Error( "Extrusion: the height is a positive number" );
        if (!isFinite( z )) throw new Error( "Extrusion: z is a number" );
        const twist = (options.twist ?? 0) * Math.PI / 180, scale = options.scaleTop ?? 1;
        if (!isFinite( twist )) throw new Error( "Extrusion: the twist is a number of degrees" );
        if (!(scale > 0) || !isFinite( scale )) throw new Error( "Extrusion: the top's scale is a positive number" );
        // the section at a fraction v of the height: the profile scaled by 1 + (scale - 1) v and turned by twist v about
        // the axis, as a point map of the plane
        const at = (v : number) => { const k = 1 + (scale - 1) * v, a = twist * v; return [k * Math.cos( a ), k * Math.sin( a )]; };
        const [ca, sa] = at( 1 );
        // the top's map, exact on rational curves (a similarity of the plane acts on their control points)
        const toTop = (c : NurbsCurveData) => new NurbsCurveData( c.degree, c.knots.slice(), c.controlPoints.map( hp => [ca * hp[0] - sa * hp[1], sa * hp[0] + ca * hp[1], hp[2], hp[3]] ) );
        // the path of a point up a twisted side: (a(v), b(v), z(v)), so that p goes to (x a - y b, x b + y a, z): a cubic
        // spline through the exact sections every 5 degrees of turn (within 1e-6 of the radius); a straight line with no
        // twist, where the sides are ruled (exactly: towards the apex on the axis when the top is scaled)
        const steps = Math.ceil( Math.abs( twist ) / (5 * Math.PI / 180) );
        const G = steps == 0 ? null : Make.rationalInterpCurve(
            Array.from( { length : Math.max( steps, 3 ) + 1 }, (_, k) => { const v = k / Math.max( steps, 3 ); const ab = at( v ); return [ab[0], ab[1], z + height * v]; } ),
            3, false, null, null, Array.from( { length : Math.max( steps, 3 ) + 1 }, (_, k) => k / Math.max( steps, 3 ) ) );
        if (G != null) {
            // its ends exactly: the bottom as it is and the top's map
            G.controlPoints[0] = [1, 0, z, 1];
            G.controlPoints[G.controlPoints.length - 1] = [ca, sa, z + height, 1];
        }
        // a side: ruled, or the tensor product of the segment and the path
        const sideOf = (c : NurbsCurveData) : NurbsSurfaceData => G == null ? BrepSolid.ruled( lift( c, z ), lift( toTop( c ), zt ) )
            : new NurbsSurfaceData( c.degree, G.degree, c.knots.slice(), G.knots.slice(),
                c.controlPoints.map( hp => G.controlPoints.map( g => [hp[0] * g[0] - hp[1] * g[1], hp[0] * g[1] + hp[1] * g[0], hp[3] * g[2], hp[3]] ) ) );
        // a point's path up the side (a vertical edge)
        const up = (p : Point) : NurbsCurveData => G == null ? line3( [p[0], p[1], z], [ca * p[0] - sa * p[1], sa * p[0] + ca * p[1], zt] )
            : new NurbsCurveData( G.degree, G.knots.slice(), G.controlPoints.map( g => [p[0] * g[0] - p[1] * g[1], p[0] * g[1] + p[1] * g[0], g[2], 1] ) );
        if (profile == null || profile.outer == null) throw new Error( "Extrusion: a profile has an outer path" );
        const paths = [{ path : profile.outer, name : "outer", outer : true }]
            .concat( (profile.holes ?? []).map( (h, i) => ({ path : h, name : "hole" + i, outer : false }) ) );
        // the pieces of each path, counter-clockwise for the outer path and clockwise for holes
        const loops = paths.map( p => {
            let pieces = Extrusion.pieces( p.path, p.name );
            const area = Extrusion.area( pieces );
            if (!(Math.abs( area ) > 0)) throw new Error( `Extrusion: the ${p.name} path encloses no area` );
            if ((area > 0) != p.outer) pieces = pieces.slice().reverse().map( q => ({ curve : Modify.curveReverse( q.curve ), index : q.index }) );
            return { name : p.name, outer : p.outer, pieces : pieces };
        } );

        // the caps' plane patch: the profile's box, a little larger
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const l of loops) for (const q of l.pieces) for (const hp of q.curve.controlPoints) {
            const x = hp[0] / hp[hp.length - 1], y = hp[1] / hp[hp.length - 1];
            x0 = Math.min( x0, x ); x1 = Math.max( x1, x ); y0 = Math.min( y0, y ); y1 = Math.max( y1, y );
        }
        const pad = 0.01 * Math.max( x1 - x0, y1 - y0 );
        x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
        const W = x1 - x0, H = y1 - y0;
        // (the top's: the bottom's under the top's map, so that a curve has the same parameters on both)
        const plane = (h : number, m : (x : number, y : number) => [number, number]) => new NurbsSurfaceData( 1, 1, [0, 0, 1, 1], [0, 0, 1, 1],
            [[[...m( x0, y0 ), h, 1], [...m( x0, y1 ), h, 1]], [[...m( x1, y0 ), h, 1], [...m( x1, y1 ), h, 1]]] );
        const zt = z + height;
        const lift = (c : NurbsCurveData, at : number) => new NurbsCurveData( c.degree, c.knots.slice(), c.controlPoints.map( hp => [hp[0], hp[1], at * hp[3], hp[3]] ) );
        // a curve of the plane in the caps' parameters: an affine map of its control points, so exact
        const onCap = (c : NurbsCurveData) => new NurbsCurveData( c.degree, c.knots.slice(), c.controlPoints.map( hp => [(hp[0] - x0 * hp[3]) / W, (hp[1] - y0 * hp[3]) / H, hp[3]] ) );
        const line2 = (a : [number, number], b : [number, number]) => new NurbsCurveData( 1, [0, 0, 1, 1], [[a[0], a[1], 1], [b[0], b[1], 1]] );
        const line3 = (a : Point, b : Point) => new NurbsCurveData( 1, [0, 0, 1, 1], [[a[0], a[1], a[2], 1], [b[0], b[1], b[2], 1]] );

        const vertices : Array<Point> = [];
        const edges : Array<ShellEdge> = [];
        const faces : Array<ShellFace> = [
            { surface : plane( z, (x, y) => [x, y] ), sameSense : false, closed : [false, false], loops : [], source : 0, name : "bottom" },
            { surface : plane( zt, (x, y) => [ca * x - sa * y, sa * x + ca * y] ), sameSense : true, closed : [false, false], loops : [], source : 1, name : "top" },
        ];
        for (const l of loops) {
            const n = l.pieces.length;
            const start = l.pieces.map( q => Eval.rationalCurvePoint( q.curve, 0 ) );
            const P = start.map( p => vertices.push( [p[0], p[1], z] ) - 1 );
            const Q = start.map( p => vertices.push( [ca * p[0] - sa * p[1], sa * p[0] + ca * p[1], zt] ) - 1 );
            const side = l.pieces.map( q => {
                faces.push( { surface : sideOf( q.curve ), sameSense : true, closed : [n == 1, false], loops : [],
                              source : faces.length, name : l.name + "." + q.index } );
                return faces.length - 1;
            } );
            // vertical edges: V[k] up the start of piece k, piece k - 1 on its left and piece k on its right
            const V = l.pieces.map( (q, k) => {
                edges.push( { curve : up( start[k] ), start : P[k], end : Q[k], left : side[(k + n - 1) % n], right : side[k],
                              pcurves : [line2( [1, 0], [1, 1] ), line2( [0, 0], [0, 1] )], tolerance : 0 } );
                return edges.length - 1;
            } );
            // bottom and top edges along each piece: the side face on the left of the bottom one, the top cap on the
            // left of the top one
            const B = l.pieces.map( (q, k) => {
                edges.push( { curve : lift( q.curve, z ), start : P[k], end : P[(k + 1) % n], left : side[k], right : 0,
                              pcurves : [line2( [0, 0], [1, 0] ), onCap( q.curve )], tolerance : 0 } );
                return edges.length - 1;
            } );
            const T = l.pieces.map( (q, k) => {
                edges.push( { curve : lift( toTop( q.curve ), zt ), start : Q[k], end : Q[(k + 1) % n], left : 1, right : side[k],
                              pcurves : [onCap( q.curve ), line2( [0, 1], [1, 1] )], tolerance : 0 } );
                return edges.length - 1;
            } );
            l.pieces.forEach( (_, k) => faces[side[k]].loops.push( { outer : true, region : 0,
                edges : [[B[k], true], [V[(k + 1) % n], true], [T[k], false], [V[k], false]] } ) );
            faces[0].loops.push( { outer : l.outer, region : 0, edges : B.slice().reverse().map( e => [e, false] as [number, boolean] ) } );
            faces[1].loops.push( { outer : l.outer, region : 0, edges : T.map( e => [e, true] as [number, boolean] ) } );
        }
        const shell : BrepShell = { vertices : vertices, edges : edges, faces : faces, tolerance : 0 };
        return { shell : shell, mesh : Extrusion.mesh( loops.map( l => l.pieces ), z, zt, at, steps ) };
    }

    // A closed mesh of the extrusion: each path sampled, the caps triangulated between the samples, the sides strips.
    // (Twisted, the sides are strips between sections every 5 degrees of turn, `levels` of them.)
    private static mesh( loops : Array<Array<Piece>>, z : number, zt : number, section : (v : number) => Array<number>, levels : number ) : TriMesh {
        const rings = loops.map( pieces => {
            const pts : Array<Point> = [];
            for (const q of pieces) {
                // (a line twisted is a curve on the side: sampled along it too)
                const n = Extrusion.samples( q.curve ) * (levels > 1 && q.curve.degree == 1 ? 8 : 1);
                for (let i = 0; i < n; i++) pts.push( Eval.rationalCurvePoint( q.curve, i / n ) );
            }
            return pts;
        } );
        const mesh = new TriMesh();
        const L = Math.max( 1, levels );
        const level = (j : number) => { const v = j / L, ab = section( v ), h = z + (zt - z) * v;
            return rings.map( r => r.map( p => mesh.addVertex( [ab[0] * p[0] - ab[1] * p[1], ab[1] * p[0] + ab[0] * p[1], h] ) ) ); };
        const lv = Array.from( { length : L + 1 }, (_, j) => level( j ) );
        const bottom = lv[0], top = lv[L];
        const flat : Array<Array<number>> = [], seg : Array<Array<number>> = [];
        const at : Array<number> = [];
        rings.forEach( (r, i) => {
            const o = flat.length;
            r.forEach( (p, k) => { flat.push( [p[0], p[1]] ); at.push( i ); seg.push( [o + k, o + (k + 1) % r.length] ); } );
        } );
        const ids = (k : number, lid : Array<Array<number>>) => {
            let i = 0, kk = k;
            while (kk >= rings[i].length) { kk -= rings[i].length; i++; }
            return lid[i][kk];
        };
        for (const t of triangulate( flat, seg, { exterior : false } )) {
            // counter-clockwise in the plane: up for the top, down for the bottom
            const area = (flat[t[1]][0] - flat[t[0]][0]) * (flat[t[2]][1] - flat[t[0]][1]) - (flat[t[2]][0] - flat[t[0]][0]) * (flat[t[1]][1] - flat[t[0]][1]);
            const [a, b, c] = area > 0 ? t : [t[0], t[2], t[1]];
            mesh.addTriangle( ids( a, top ), ids( b, top ), ids( c, top ) );
            mesh.addTriangle( ids( a, bottom ), ids( c, bottom ), ids( b, bottom ) );
        }
        for (let j = 0; j < L; j++) rings.forEach( (r, i) => r.forEach( (_, k) => {
            const k1 = (k + 1) % r.length, lo = lv[j][i], hi = lv[j + 1][i];
            mesh.addTriangle( lo[k], lo[k1], hi[k1] );
            mesh.addTriangle( lo[k], hi[k1], hi[k] );
        } ) );
        return mesh;
    }

    // samples along a curve for the mesh: one span for a line, more for the curved
    private static samples( c : NurbsCurveData ) : number {
        if (c.degree == 1) return c.controlPoints.length - 1;
        // the turn of the control polygon, at most 64 samples to a full turn
        let turn = 0;
        const pts = c.controlPoints.map( hp => [hp[0] / hp[3], hp[1] / hp[3]] );
        for (let k = 1; k + 1 < pts.length; k++) {
            const a = [pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]], b = [pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]];
            const la = Math.hypot( a[0], a[1] ), lb = Math.hypot( b[0], b[1] );
            if (la > 0 && lb > 0) turn += Math.acos( Math.max( -1, Math.min( 1, (a[0] * b[0] + a[1] * b[1]) / (la * lb) ) ) );
        }
        return Math.max( 4, Math.ceil( 64 * turn / (2 * Math.PI) ) );
    }

    // signed area of a loop of pieces (positive counter-clockwise), by sampling
    private static area( pieces : Array<Piece> ) : number {
        let a = 0;
        for (const q of pieces) {
            const n = 4 * Extrusion.samples( q.curve );
            let p = Eval.rationalCurvePoint( q.curve, 0 );
            for (let i = 1; i <= n; i++) {
                const r = Eval.rationalCurvePoint( q.curve, i / n );
                a += (p[0] * r[1] - r[0] * p[1]) / 2;
                p = r;
            }
        }
        return a;
    }

    // the segments of a path as exact curves over [0, 1] in the plane z = 0
    // (also the revolve's, `Lathe`)
    public static pieces( path : ProfilePath, name : string ) : Array<{ curve : NurbsCurveData, index : number }> {
        const P = (p : ProfilePoint, what : string) : Point => {
            if (!Array.isArray( p ) || p.length != 2 || !isFinite( p[0] ) || !isFinite( p[1] )) throw new Error( `Extrusion: ${name}: ${what} is a point [x, y]` );
            return [p[0], p[1], 0];
        };
        if (path == null) throw new Error( `Extrusion: ${name} is a path` );
        if (path.kind == "circle") {
            const c = P( path.center, "the centre" );
            if (!(path.r > 0)) throw new Error( `Extrusion: ${name}: a circle's radius is positive` );
            return [{ curve : Extrusion.unit( Make.arc( c, [1, 0, 0], [0, 1, 0], path.r, 0, 2 * Math.PI ) ), index : 0 }];
        }
        if (path.kind != "path") throw new Error( `Extrusion: ${name}: a path's kind is "path" or "circle"` );
        if (!Array.isArray( path.segments ) || path.segments.length == 0) throw new Error( `Extrusion: ${name}: a path has segments` );
        const out : Array<Piece> = [];
        const start = P( path.start, "the start" );
        let at = start;
        const n = path.segments.length;
        path.segments.forEach( (s, k) => {
            const what = `segment ${k}`;
            // the last segment ends at the start exactly
            const to = k == n - 1 ? start : P( s.to, what + "'s end" );
            if (k == n - 1) {
                const given = P( s.to, what + "'s end" );
                if (Math.hypot( given[0] - start[0], given[1] - start[1] ) > 1e-6 * (1 + Math.hypot( start[0], start[1] )))
                    throw new Error( `Extrusion: ${name}: the last segment ends at the start (the path is closed)` );
            }
            if (Math.hypot( to[0] - at[0], to[1] - at[1] ) == 0) throw new Error( `Extrusion: ${name}: ${what} has no length` );
            let curve : NurbsCurveData;
            if (s.type == "line") curve = new NurbsCurveData( 1, [0, 0, 1, 1], [[at[0], at[1], 0, 1], [to[0], to[1], 0, 1]] );
            else if (s.type == "arc") curve = Extrusion.arc( at, P( s.via, what + "'s via" ), to, `${name}: ${what}` );
            else if (s.type == "cubic") {
                const c1 = P( s.c1, what + "'s c1" ), c2 = P( s.c2, what + "'s c2" );
                curve = new NurbsCurveData( 3, [0, 0, 0, 0, 1, 1, 1, 1], [at, c1, c2, to].map( p => [p[0], p[1], 0, 1] ) );
            } else throw new Error( `Extrusion: ${name}: ${what}'s type is "line", "arc" or "cubic"` );
            out.push( { curve : curve, index : k } );
            at = to;
        } );
        return out;
    }

    // the arc from a through m to b, exact (rational), over [0, 1]
    private static arc( a : Point, m : Point, b : Point, what : string ) : NurbsCurveData {
        const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
        const scale = Math.max( Math.hypot( m[0] - a[0], m[1] - a[1] ), Math.hypot( b[0] - m[0], b[1] - m[1] ) );
        if (!(Math.abs( d ) > 1e-12 * scale * scale)) throw new Error( `Extrusion: ${what}: an arc's three points are on a line` );
        const s = (p : Point) => p[0] * p[0] + p[1] * p[1];
        const cx = (s( a ) * (m[1] - b[1]) + s( m ) * (b[1] - a[1]) + s( b ) * (a[1] - m[1])) / d;
        const cy = (s( a ) * (b[0] - m[0]) + s( m ) * (a[0] - b[0]) + s( b ) * (m[0] - a[0])) / d;
        const r = Math.hypot( a[0] - cx, a[1] - cy );
        const ang = (p : Point) => Math.atan2( p[1] - cy, p[0] - cx );
        // counter-clockwise when m is on the left of a -> b
        const ccw = d > 0;
        const a0 = ang( a );
        const sweep = (p : Point) => { let t = ccw ? ang( p ) - a0 : a0 - ang( p ); while (t <= 0) t += 2 * Math.PI; return t; };
        const total = sweep( b );
        const c = Make.arc( [cx, cy, 0], [Math.cos( a0 ), Math.sin( a0 ), 0], ccw ? [-Math.sin( a0 ), Math.cos( a0 ), 0] : [Math.sin( a0 ), -Math.cos( a0 ), 0], r, 0, total );
        const unit = Extrusion.unit( c );
        // end exactly at the given points
        const cps = unit.controlPoints.map( hp => hp.slice() );
        const w0 = cps[0][3], w1 = cps[cps.length - 1][3];
        cps[0] = [a[0] * w0, a[1] * w0, 0, w0];
        cps[cps.length - 1] = [b[0] * w1, b[1] * w1, 0, w1];
        return new NurbsCurveData( unit.degree, unit.knots, cps );
    }

    // a curve reparametrized over [0, 1]
    private static unit( c : NurbsCurveData ) : NurbsCurveData {
        const a = c.knots[0], b = c.knots[c.knots.length - 1];
        return new NurbsCurveData( c.degree, c.knots.map( k => (k - a) / (b - a) ), c.controlPoints.map( hp => hp.slice() ) );
    }
}
