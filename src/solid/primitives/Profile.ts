import { Matrix, NurbsCurveData, Point } from "../../core/Data.js";
import { Vec } from "../../core/Vec.js";
import { Eval } from "../../eval/Eval.js";
import { Make } from "../../eval/Make.js";
import { Modify } from "../../eval/Modify.js";

// One segment of a closed planar profile: a NURBS curve over [0, 1] whose end weights are 1, the number of
// tessellation divisions along it, and whether the profile has a corner where the segment starts (its tangent turns
// there). Segments between corners make one smooth piece, which becomes one face of a prism or of a revolve.
export interface ProfileSegment {
    curve : NurbsCurveData;
    divs : number;
    corner : boolean;
}

// A star-shaped part of a profile's cap: its boundary segments, counter-clockwise, and the point it is star-shaped
// about. A profile that is not star-shaped (an I or a U section) is capped by several of these.
export interface CapLoop {
    segments : Array<ProfileSegment>;
    center : Point;
}

// Tessellation density of profile segments: divisions per straight segment and per full turn of an arc.
export interface ProfileDensity {
    line? : number;
    turn? : number;
}

const DEFAULT_LINE_DIVS = 4;
const DEFAULT_TURN_DIVS = 64;

// A closed planar profile in the plane z = 0, counter-clockwise seen from +z: the section of a prism, the base of a
// pyramid, or (in the (r, z) half-plane) the generatrix of a revolve.
//
// A profile keeps its segments and corners. A prism over it gets one side face per smooth piece, so every corner is an
// edge that `BrepEdges` finds and a fillet can round, while a tangent join (a line into an arc of a rounded
// rectangle) stays inside one face.
export class Profile {

    constructor( public segments : Array<ProfileSegment>, public center : Point, public caps : Array<CapLoop> | null = null ) {}

    // The smooth pieces between corners, each as one curve over [0, 1] in which every segment has a share of the
    // parameter proportional to its divisions, so a uniform grid over the piece meets every segment's grid. A profile
    // with no corner is one closed piece.
    public pieces() : Array<{ curve : NurbsCurveData, divs : number, closed : boolean }> {
        const n = this.segments.length;
        const first = this.segments.findIndex( s => s.corner );
        if (first < 0) return [{ curve : Profile.join( this.segments ), divs : this.totalDivs(), closed : true }];
        const out : Array<{ curve : NurbsCurveData, divs : number, closed : boolean }> = [];
        let run : Array<ProfileSegment> = [];
        for (let k = 0; k < n; k++) {
            const s = this.segments[(first + k) % n];
            if (s.corner && run.length > 0) { out.push( Profile.piece( run ) ); run = []; }
            run.push( s );
        }
        out.push( Profile.piece( run ) );
        return out;
    }

    // The whole profile as one closed curve over [0, 1], starting at the first corner (or at the first segment when
    // there is none), each segment's share of the parameter proportional to its divisions.
    public curve() : NurbsCurveData {
        const n = this.segments.length;
        const first = Math.max( 0, this.segments.findIndex( s => s.corner ) );
        const segs : Array<ProfileSegment> = [];
        for (let k = 0; k < n; k++) segs.push( this.segments[(first + k) % n] );
        return Profile.join( segs );
    }

    public totalDivs() : number {
        return this.segments.reduce( (a, s) => a + s.divs, 0 );
    }

    // The loops that cap the profile: itself, or the parts it was split into.
    public capLoops() : Array<CapLoop> {
        return this.caps != null ? this.caps : [{ segments : this.segments, center : this.center }];
    }

    // Signed area (positive counter-clockwise), from the sampled boundary.
    public area( samples : number = 32 ) : number {
        let a = 0.0;
        for (const s of this.segments) {
            for (let k = 0; k < samples; k++) {
                const p = Eval.rationalCurvePoint( s.curve, k / samples ), q = Eval.rationalCurvePoint( s.curve, (k + 1) / samples );
                a += (p[0] * q[1] - q[0] * p[1]) / 2;
            }
        }
        return a;
    }

    // Whether every cap loop is star-shaped about its centre: walking its boundary, the centre stays strictly on the
    // left. A cap is a cone from its centre to its boundary, which folds over itself unless this holds.
    public isStarShaped( samples : number = 16 ) : boolean {
        for (const loop of this.capLoops()) {
            const c = loop.center;
            for (const s of loop.segments) {
                for (let k = 0; k < samples; k++) {
                    const p = Eval.rationalCurvePoint( s.curve, k / samples ), q = Eval.rationalCurvePoint( s.curve, (k + 1) / samples );
                    const cross = (p[0] - c[0]) * (q[1] - c[1]) - (p[1] - c[1]) * (q[0] - c[0]);
                    if (!(cross > 0)) return false;
                }
            }
        }
        return true;
    }

    // The profile mapped by a 4x4 matrix acting on homogeneous control points (an affine map, or a projective one:
    // either keeps a rational curve rational and exact).
    public map( m : Matrix ) : Profile {
        const mapSeg = (s : ProfileSegment) : ProfileSegment => ({ curve : Profile.mapCurve( s.curve, m ), divs : s.divs, corner : s.corner });
        const mapPt = (p : Point) : Point => Profile.mapPoint( p, m );
        return new Profile( this.segments.map( mapSeg ), mapPt( this.center ),
            this.caps == null ? null : this.caps.map( l => ({ segments : l.segments.map( mapSeg ), center : mapPt( l.center ) }) ) );
    }

    // The same profile with every segment's divisions scaled (at least 1).
    public refined( factor : number ) : Profile {
        const r = (s : ProfileSegment) : ProfileSegment => ({ curve : s.curve, divs : Math.max( 1, Math.round( s.divs * factor ) ), corner : s.corner });
        return new Profile( this.segments.map( r ), this.center, this.caps == null ? null : this.caps.map( l => ({ segments : l.segments.map( r ), center : l.center }) ) );
    }

    public static mapCurve( c : NurbsCurveData, m : Matrix ) : NurbsCurveData {
        return new NurbsCurveData( c.degree, c.knots.slice(), c.controlPoints.map( hp => [0, 1, 2, 3].map( i => m[i][0] * hp[0] + m[i][1] * hp[1] + m[i][2] * hp[2] + m[i][3] * hp[3] ) ) );
    }

    public static mapPoint( p : Point, m : Matrix ) : Point {
        const h = [0, 1, 2, 3].map( i => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3] );
        return [h[0] / h[3], h[1] / h[3], h[2] / h[3]];
    }

    private static piece( run : Array<ProfileSegment> ) : { curve : NurbsCurveData, divs : number, closed : boolean } {
        return { curve : Profile.join( run ), divs : run.reduce( (a, s) => a + s.divs, 0 ), closed : false };
    }

    // Segments joined end to end into one curve: each is raised to the largest degree and given the parameter span
    // of its divisions; the knot where two meet keeps multiplicity equal to the degree, so the join interpolates the
    // shared end point and the curve is exactly the union of the segments. The result runs over [0, 1].
    public static join( segs : Array<ProfileSegment> ) : NurbsCurveData {
        const p = Math.max( ...segs.map( s => s.curve.degree ) );
        let knots : Array<number> = [], cps : Array<Point> = [], at = 0.0;
        segs.forEach( (s, k) => {
            const c = Modify.curveElevateDegree( s.curve, p );
            const a = c.knots[0], b = c.knots[c.knots.length - 1];
            // the end knots exactly, so the next segment starts on them
            const kn = c.knots.map( x => x == a ? at : x == b ? at + s.divs : at + (x - a) / (b - a) * s.divs );
            if (k == 0) { knots = kn; cps = c.controlPoints.slice(); }
            else { knots = knots.slice( 0, knots.length - 1 ).concat( kn.slice( p + 1 ) ); cps = cps.concat( c.controlPoints.slice( 1 ) ); }
            at += s.divs;
        } );
        // over [0, 1], as every face of a solid is: the spans keep their proportions, so the grids still meet
        const total = at;
        return new NurbsCurveData( p, knots.map( x => x == total ? 1 : x / total ), cps );
    }

    // ---- segments ----

    // A straight segment from a to b.
    public static line( a : Point, b : Point, divs : number = DEFAULT_LINE_DIVS, corner : boolean = true ) : ProfileSegment {
        return { curve : Make.rationalBezierCurve( [Profile.p3( a ), Profile.p3( b )] ), divs : divs, corner : corner };
    }

    // A circular arc about `center` from angle a0 to a1 (radians, counter-clockwise when a1 > a0, clockwise when
    // a1 < a0), rational and exact.
    public static arc( center : Point, radius : number, a0 : number, a1 : number, turn : number = DEFAULT_TURN_DIVS, corner : boolean = true ) : ProfileSegment {
        return Profile.ellipseArc( center, radius, radius, a0, a1, turn, corner );
    }

    // An arc of the ellipse with semi-axes rx (along x) and ry (along y) about `center`, as `arc`.
    public static ellipseArc( center : Point, rx : number, ry : number, a0 : number, a1 : number, turn : number = DEFAULT_TURN_DIVS, corner : boolean = true ) : ProfileSegment {
        const c = Profile.p3( center );
        const lo = Math.min( a0, a1 ), hi = Math.max( a0, a1 );
        let curve = Make.ellipseArc( c, [rx, 0, 0], [0, ry, 0], lo, hi );
        if (a1 < a0) curve = Modify.curveReverse( curve );
        return { curve : curve, divs : Math.max( 2, Math.ceil( turn * (hi - lo) / (2 * Math.PI) ) ), corner : corner };
    }

    // A segment along any NURBS curve (reparameterised to [0, 1]). Its end weights must be 1.
    public static nurbs( curve : NurbsCurveData, divs : number, corner : boolean = true ) : ProfileSegment {
        const w0 = curve.controlPoints[0][3], w1 = curve.controlPoints[curve.controlPoints.length - 1][3];
        if (Math.abs( w0 - 1 ) > 1e-12 || Math.abs( w1 - 1 ) > 1e-12) throw new Error( "Profile: a segment's end weights must be 1" );
        const a = curve.knots[0], b = curve.knots[curve.knots.length - 1];
        return { curve : new NurbsCurveData( curve.degree, curve.knots.map( x => (x - a) / (b - a) ), curve.controlPoints.map( p => p.slice() ) ), divs : divs, corner : corner };
    }

    public static p3( p : Point ) : Point {
        return [p[0], p[1], p.length > 2 ? p[2] : 0];
    }

    // The area centroid of a closed polygon.
    public static polygonCentroid( pts : Array<Point> ) : Point {
        let a = 0.0, cx = 0.0, cy = 0.0;
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i], q = pts[(i + 1) % pts.length];
            const c = p[0] * q[1] - q[0] * p[1];
            a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
        }
        return Math.abs( a ) < 1e-300 ? Vec.mul( 1 / pts.length, pts.reduce( (s, p) => Vec.add( s, Profile.p3( p ) ), [0, 0, 0] ) ) : [cx / (3 * a), cy / (3 * a), 0];
    }
}
