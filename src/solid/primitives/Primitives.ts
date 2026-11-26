import { Matrix, NurbsCurveData, Point } from "../../core/Data.js";
import { Vec } from "../../core/Vec.js";
import { Eval } from "../../eval/Eval.js";
import { Make } from "../../eval/Make.js";
import { Modify } from "../../eval/Modify.js";
import { BrepFace, BrepSolid } from "../Brep.js";
import { BrepEdges, SolidEdge } from "../BrepEdges.js";
import { PolyhedronData, Polyhedra } from "./Polyhedra.js";
import { Profile, ProfileSegment } from "./Profile.js";
import { Profiles } from "./Profiles.js";

// How the top of a prism follows its base: scaled about the profile's centre, turned about it, and moved.
export interface PrismOptions {
    // top scale about the profile's centre: one factor, or one along x and one along y (default 1; 0 makes a pyramid)
    scale? : number | [number, number];
    // turn of the top about the axis, in radians (default 0); the sides become ruled (bilinear on straight segments)
    twist? : number;
    // offset of the top in x and y (an oblique prism; default none)
    shear? : [number, number];
    // divisions along the height (default 4)
    divs? : number;
}

// Tessellation density of a primitive: divisions per straight edge and per full turn of a circle.
export interface Density {
    line? : number;
    turn? : number;
}

const TAU = 2 * Math.PI;
const DEFAULT_TURN = 64;
const DEFAULT_LINE = 4;

// Parameterised primitive solids, each a closed B-rep (`BrepSolid`) that Booleans, fillets of its own edges, shells
// and STEP export take as they are. Every solid stands on z = 0 with its axis along +z through the origin (the
// polyhedra are centred on the origin); place it with `transform`. The catalogue, with what each family takes and
// how exact it is, is docs/primitives.md.
//
// Four builders make every family: `prism` (and `pyramid`) over a planar `Profile`, `revolve` of a profile in the
// (r, z) half-plane, and `polyhedron` from vertices and faces. Each face is a NURBS surface over its whole domain and
// neighbouring faces share their edges sample for sample, which is what makes the tessellation watertight without
// welding (docs/architecture.md). Faces are ordered so that every face with at most four sides comes first, which
// lets `BrepEdges` find each of their edges (a whole side of the earlier face lies along a side of the later one).
export class Primitives {

    // ---- builders ----

    // A prism over a profile: the profile at z = 0, its image under the top map (`PrismOptions`) at z = height, one
    // side face per smooth piece of the profile (ruled between the two), and a cap at each end (a cone from the cap
    // centre, so planar and exact). A top scale of 0 gives a pyramid instead, with its apex over the profile's centre
    // moved by `shear`.
    public static prism( profile : Profile, height : number, options : PrismOptions = {} ) : BrepSolid {
        Primitives.positive( height, "height" );
        const sc = options.scale == null ? [1, 1] : typeof options.scale == "number" ? [options.scale, options.scale] : options.scale;
        if (!(sc[0] >= 0 && sc[1] >= 0) || (sc[0] == 0) != (sc[1] == 0)) throw new Error( "Primitives: a prism's top scale is 0 (a pyramid) or positive" );
        const twist = options.twist != null ? options.twist : 0, shear = options.shear != null ? options.shear : [0, 0];
        const vd = options.divs != null ? options.divs : DEFAULT_LINE;
        const c = profile.center;
        const cos = Math.cos( twist ), sin = Math.sin( twist );
        // p -> R(twist) S(scale) (p - c) + c + (shear, height)
        const m : Matrix = [
            [cos * sc[0], -sin * sc[1], 0, c[0] + shear[0] - (cos * sc[0] * c[0] - sin * sc[1] * c[1])],
            [sin * sc[0], cos * sc[1], 0, c[1] + shear[1] - (sin * sc[0] * c[0] + cos * sc[1] * c[1])],
            [0, 0, 1, height],
            [0, 0, 0, 1],
        ];
        if (sc[0] == 0) return Primitives.pyramid( profile, [c[0] + shear[0], c[1] + shear[1], height], vd );
        return Primitives.loft( profile, profile.map( m ), vd );
    }

    // A pyramid (or cone) from a profile at z = 0 to an apex: one side face per smooth piece and the base cap.
    public static pyramid( profile : Profile, apex : Point, divs : number = DEFAULT_LINE ) : BrepSolid {
        if (Math.abs( apex[2] ) < 1e-12) throw new Error( "Primitives: a pyramid's apex is off the base plane" );
        const faces : Array<BrepFace> = [];
        const pieces = profile.pieces();
        pieces.forEach( (pc, k) => faces.push( BrepSolid.face( BrepSolid.cone( apex, pc.curve ), [pc.closed, false], [pc.divs, divs], pieces.length == 1 ? "side" : "side." + k ) ) );
        Primitives.caps( profile, "bottom", faces );
        return new BrepSolid( faces ).orient();
    }

    // The solid between two compatible profiles (one the image of the other under an affine or projective map),
    // with ruled sides: a prism, a frustum, a twisted or an obliquely cut prism.
    public static loft( bottom : Profile, top : Profile, divs : number = DEFAULT_LINE ) : BrepSolid {
        const faces : Array<BrepFace> = [];
        const pb = bottom.pieces(), pt = top.pieces();
        pb.forEach( (pc, k) => faces.push( BrepSolid.face( BrepSolid.ruled( pc.curve, pt[k].curve ), [pc.closed, false], [pc.divs, divs], pb.length == 1 ? "side" : "side." + k ) ) );
        Primitives.caps( bottom, "bottom", faces );
        Primitives.caps( top, "top", faces );
        return new BrepSolid( faces ).orient();
    }

    // Extrude a profile along a direction (Rhino's and Grasshopper's Extrude): the prism whose top is the profile
    // moved by `direction`, which must leave the profile's plane.
    public static extrude( profile : Profile, direction : Point, divs : number = DEFAULT_LINE ) : BrepSolid {
        if (!(direction[2] > 0)) {
            if (direction[2] < 0) return Primitives.extrude( profile.map( Primitives.translation( direction ) ), Vec.mul( -1, direction ), divs );
            throw new Error( "Primitives: an extrusion's direction leaves the profile's plane" );
        }
        return Primitives.loft( profile, profile.map( Primitives.translation( direction ) ), divs );
    }

    // Extrude a profile to a point (Extrude Point): the cone or pyramid from the profile to `apex`.
    public static extrudePoint( profile : Profile, apex : Point, divs : number = DEFAULT_LINE ) : BrepSolid {
        return Primitives.pyramid( profile, apex, divs );
    }

    // A solid of revolution about the z axis. The generatrix is given in the (r, z) half-plane as the segments of a
    // `Profile` whose x is the radius and y the height: either an open chain that starts and ends on the axis (r = 0),
    // or a closed loop off the axis (a torus, a tube). Each smooth piece becomes one face, revolved exactly (rational
    // in the angle); points on the axis are poles. `turn` is the number of divisions round the axis.
    public static revolve( generatrix : Array<ProfileSegment>, turn : number = DEFAULT_TURN, names? : Array<string> ) : BrepSolid {
        const toXZ : Matrix = [[1, 0, 0, 0], [0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 1]];
        const segs = generatrix.map( s => ({ curve : Profile.mapCurve( s.curve, toXZ ), divs : s.divs, corner : s.corner }) );
        for (const s of segs) for (const hp of s.curve.controlPoints) if (hp[0] / hp[3] < -1e-9) throw new Error( "Primitives: a generatrix stays on the side r >= 0 of the axis" );
        const first = Primitives.endPoint( segs[0].curve, false ), last = Primitives.endPoint( segs[segs.length - 1].curve, true );
        const size = Math.max( ...segs.flatMap( s => s.curve.controlPoints.map( hp => Vec.norm( hp.slice( 0, 3 ).map( x => x / hp[3] ) ) ) ) );
        const closed = Vec.dist( first, last ) < 1e-9 * size;
        let pieces : Array<{ curve : NurbsCurveData, divs : number, closed : boolean }>;
        if (closed) {
            if (segs.some( s => s.curve.controlPoints.some( hp => Math.abs( hp[0] / hp[3] ) < 1e-12 * size ) )) throw new Error( "Primitives: a closed generatrix stays off the axis" );
            pieces = new Profile( segs, [0, 0, 0] ).pieces();
        } else {
            if (Math.abs( first[0] ) > 1e-9 * size || Math.abs( last[0] ) > 1e-9 * size) throw new Error( "Primitives: an open generatrix starts and ends on the axis" );
            pieces = [];
            let run : Array<ProfileSegment> = [];
            segs.forEach( (s, k) => {
                if (k > 0 && s.corner) { pieces.push( { curve : Profile.join( run ), divs : run.reduce( (a, x) => a + x.divs, 0 ), closed : false } ); run = []; }
                run.push( s );
            } );
            pieces.push( { curve : Profile.join( run ), divs : run.reduce( (a, x) => a + x.divs, 0 ), closed : false } );
        }
        const faces = pieces.map( (pc, k) => BrepSolid.face( Make.revolvedSurface( pc.curve, [0, 0, 0], [0, 0, 1], TAU ), [true, pc.closed], [turn, pc.divs],
            names != null && names[k] != null ? names[k] : pieces.length == 1 ? "surface" : "face." + k ) );
        return new BrepSolid( faces ).orient();
    }

    // A polyhedron from vertices and faces: triangles and quadrilaterals as bilinear patches (a triangle is a
    // quadrilateral with one side collapsed; a non-planar quadrilateral is a hyperbolic paraboloid), larger polygons
    // as cones from their centroid (planar when the polygon is, and star-shaped about its centroid when convex).
    // `divs` divisions along every edge. Faces are turned to face away from the centroid of the vertices, so the
    // polyhedron must be star-shaped about it (every convex one is).
    public static polyhedron( p : PolyhedronData, divs : number = DEFAULT_LINE ) : BrepSolid {
        const faces : Array<{ face : BrepFace, sides : number }> = [];
        const mid = Polyhedra.center( p.vertices );
        p.faces.forEach( (f, k) => {
            let pts = f.map( i => p.vertices[i] ).filter( (q, i, a) => Vec.dist( q, a[(i + 1) % a.length] ) > 1e-12 );
            const name = "face." + k;
            if (pts.length < 3) return;
            // every face's own normal outward, as the prism builder makes them: a patch's normal turns with its
            // corners (counter-clockwise seen from outside), a cone's against its ring (clockwise seen from outside).
            // The fillet corners are built from the faces' parameterisations and expect them to agree like this.
            let nw = [0, 0, 0];
            for (let i = 0; i < pts.length; i++) nw = Vec.add( nw, Vec.cross( pts[i], pts[(i + 1) % pts.length] ) );
            const outward = Vec.dot( nw, Vec.sub( Polyhedra.center( pts ), mid ) ) > 0;
            if (outward != (pts.length <= 4)) pts = pts.slice().reverse();
            if (pts.length == 3) faces.push( { face : BrepSolid.face( Make.fourPointSurface( pts[0], pts[1], pts[2], pts[2], 1 ), [false, false], [divs, divs], name ), sides : 3 } );
            else if (pts.length == 4) faces.push( { face : BrepSolid.face( Make.fourPointSurface( pts[0], pts[1], pts[2], pts[3], 1 ), [false, false], [divs, divs], name ), sides : 4 } );
            else {
                const ring = Profile.join( Primitives.seamMidway( pts.map( (q, i) => Profile.line( q, pts[(i + 1) % pts.length], divs ) ) ) );
                faces.push( { face : BrepSolid.face( BrepSolid.cone( Polyhedra.center( pts ), ring ), [true, false], [pts.length * divs, divs], name ), sides : pts.length } );
            }
        } );
        // stable: faces of up to four sides first, so BrepEdges finds their edges
        faces.sort( (a, b) => Math.min( a.sides, 5 ) - Math.min( b.sides, 5 ) );
        return new BrepSolid( faces.map( f => f.face ) ).orient();
    }

    // ---- boxes ----

    // A box w by d by h standing on z = 0, centred on the z axis (or with a corner at the origin).
    public static box( w : number, d : number, h : number, centered : boolean = true, divs : number = 8 ) : BrepSolid {
        Primitives.positive( w, "width" ); Primitives.positive( d, "depth" ); Primitives.positive( h, "height" );
        return centered ? BrepSolid.box( [-w / 2, -d / 2, 0], [w / 2, d / 2, h], divs ) : BrepSolid.box( [0, 0, 0], [w, d, h], divs );
    }

    public static cube( edge : number, divs : number = 8 ) : BrepSolid {
        return Primitives.box( edge, edge, edge, true, divs );
    }

    // A wedge (as OpenCascade's BRepPrimAPI_MakeWedge): the base [0, dx] x [0, dy] at z = 0 and the top
    // [xmin, xmax] x [ymin, ymax] at z = dz. A top that shrinks to a segment (xmin = xmax, or ymin = ymax) is a ridge
    // and the solid has five faces; to a point, a pyramid.
    public static wedge( dx : number, dy : number, dz : number, xmin : number, xmax : number, ymin : number = 0, ymax? : number, divs : number = DEFAULT_LINE ) : BrepSolid {
        if (ymax == null) ymax = dy;
        Primitives.positive( dx, "dx" ); Primitives.positive( dy, "dy" ); Primitives.positive( dz, "dz" );
        if (!(xmax >= xmin && ymax >= ymin)) throw new Error( "Primitives: a wedge's top has xmax >= xmin and ymax >= ymin" );
        const v : Array<Point> = [[0, 0, 0], [dx, 0, 0], [dx, dy, 0], [0, dy, 0], [xmin, ymin, dz], [xmax, ymin, dz], [xmax, ymax, dz], [xmin, ymax, dz]];
        return Primitives.polyhedron( { vertices : v, faces : [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]] }, divs );
    }

    // A parallelepiped spanned by three edge vectors from the origin.
    public static parallelepiped( a : Point, b : Point, c : Point, divs : number = DEFAULT_LINE ) : BrepSolid {
        if (Math.abs( Vec.dot( a, Vec.cross( b, c ) ) ) < 1e-12 * Vec.norm( a ) * Vec.norm( b ) * Vec.norm( c )) throw new Error( "Primitives: a parallelepiped's edges are not coplanar" );
        const o = [0, 0, 0];
        const v : Array<Point> = [o, a, Vec.add( a, b ), b, c, Vec.add( a, c ), Vec.add( Vec.add( a, b ), c ), Vec.add( b, c )];
        return Primitives.polyhedron( { vertices : v, faces : [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]] }, divs );
    }

    // ---- prisms and pyramids over regular polygons ----

    public static regularPrism( sides : number, radius : number, height : number, options : PrismOptions = {} ) : BrepSolid {
        return Primitives.prism( Profiles.regular( sides, radius ), height, options );
    }

    public static regularPyramid( sides : number, radius : number, height : number, apex : [number, number] = [0, 0] ) : BrepSolid {
        return Primitives.pyramid( Profiles.regular( sides, radius ), [apex[0], apex[1], height] );
    }

    // A frustum of a pyramid (or of any profile): the top is the base scaled by `top` about its centre.
    public static frustum( profile : Profile, height : number, top : number, options : PrismOptions = {} ) : BrepSolid {
        if (!(top > 0)) throw new Error( "Primitives: a frustum's top scale is positive (0 is a pyramid)" );
        return Primitives.prism( profile, height, { ...options, scale : top } );
    }

    public static antiprism( sides : number, radius : number, height? : number, divs : number = DEFAULT_LINE ) : BrepSolid {
        Primitives.sides( sides );
        return Primitives.polyhedron( Polyhedra.antiprism( sides, radius, height ), divs );
    }

    // A bipyramid: a regular n-gon at z = 0 with apexes `up` above and `down` below (equal by default).
    public static bipyramid( sides : number, radius : number, up : number, down? : number, divs : number = DEFAULT_LINE ) : BrepSolid {
        Primitives.sides( sides ); Primitives.positive( radius, "radius" ); Primitives.positive( up, "height" );
        return Primitives.polyhedron( Polyhedra.bipyramid( sides, radius, up, down != null ? down : up ), divs );
    }

    // A named Platonic, Archimedean or Catalan solid (`Polyhedra.named`) of circumradius `radius`, centred on the origin.
    public static platonic( name : string, radius : number, divs : number = DEFAULT_LINE ) : BrepSolid {
        Primitives.positive( radius, "radius" );
        const p = Polyhedra.named( name );
        return Primitives.polyhedron( { vertices : p.vertices.map( q => Vec.mul( radius / Math.max( ...p.vertices.map( x => Vec.norm( x ) ) ), q ) ), faces : p.faces }, divs );
    }

    // ---- solids of revolution ----

    public static cylinder( radius : number, height : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" ); Primitives.positive( height, "height" );
        const l = Primitives.lineDivs( density );
        return Primitives.revolve( [
            Profile.line( [0, 0], [radius, 0], l ), Profile.line( [radius, 0], [radius, height], l ), Profile.line( [radius, height], [0, height], l ),
        ], Primitives.turn( density ), ["bottom", "side", "top"] );
    }

    // A cone of base `radius` and apex `height` above its centre, or a frustum when `top` (the top radius) is given.
    public static cone( radius : number, height : number, top : number = 0, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" ); Primitives.positive( height, "height" );
        if (!(top >= 0)) throw new Error( "Primitives: a cone's top radius is 0 or more" );
        const l = Primitives.lineDivs( density );
        if (top == 0) return Primitives.revolve( [Profile.line( [0, 0], [radius, 0], l ), Profile.line( [radius, 0], [0, height], l )], Primitives.turn( density ), ["bottom", "side"] );
        return Primitives.revolve( [
            Profile.line( [0, 0], [radius, 0], l ), Profile.line( [radius, 0], [top, height], l ), Profile.line( [top, height], [0, height], l ),
        ], Primitives.turn( density ), ["bottom", "side", "top"] );
    }

    // A cone whose tip is rounded by a sphere of radius `tip` tangent to its side.
    public static roundedCone( radius : number, height : number, tip : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" ); Primitives.positive( height, "height" ); Primitives.positive( tip, "tip radius" );
        const a = Math.atan2( radius, height ); // the half angle at the apex
        // the sphere's centre on the axis, `tip / sin(a)` below the apex; it touches the side where the side's normal
        // through it meets the side
        const zc = height - tip / Math.sin( a );
        if (!(zc - tip > 0)) throw new Error( "Primitives: the tip radius is too large for the cone" );
        const contact : Point = [tip * Math.cos( a ), zc + tip * Math.sin( a )];
        const l = Primitives.lineDivs( density ), t = Primitives.turn( density );
        return Primitives.revolve( [
            Profile.line( [0, 0], [radius, 0], l ), Profile.line( [radius, 0], contact, l ),
            Profile.arc( [0, zc], tip, a, Math.PI / 2, t, false ),
        ], t, ["bottom", "side"] );
    }

    // A sphere of `radius` centred at (0, 0, radius), so it stands on z = 0.
    public static sphere( radius : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" );
        const t = Primitives.turn( density );
        return Primitives.revolve( [Profile.arc( [0, radius], radius, -Math.PI / 2, Math.PI / 2, t, false )], t, ["sphere"] );
    }

    // A spherical cap (segment of one base) of the sphere of `radius`, `height` tall, its flat base on z = 0. A
    // height equal to the radius is a hemisphere.
    public static sphericalCap( radius : number, height : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" );
        if (!(height > 0 && height < 2 * radius)) throw new Error( "Primitives: a spherical cap's height is between 0 and the diameter" );
        const zc = height - radius, r0 = Math.sqrt( radius * radius - zc * zc );
        const t = Primitives.turn( density );
        return Primitives.revolve( [
            Profile.line( [0, 0], [r0, 0], Primitives.lineDivs( density ) ),
            Profile.arc( [0, zc], radius, Math.atan2( -zc, r0 ), Math.PI / 2, t ),
        ], t, ["base", "cap"] );
    }

    public static hemisphere( radius : number, density : Density = {} ) : BrepSolid {
        return Primitives.sphericalCap( radius, radius, density );
    }

    // The zone of the sphere of `radius` (centred at the origin) between the planes z = z0 and z = z1.
    public static sphericalZone( radius : number, z0 : number, z1 : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" );
        if (!(-radius < z0 && z0 < z1 && z1 < radius)) throw new Error( "Primitives: a zone has -radius < z0 < z1 < radius" );
        const r0 = Math.sqrt( radius * radius - z0 * z0 ), r1 = Math.sqrt( radius * radius - z1 * z1 );
        const l = Primitives.lineDivs( density ), t = Primitives.turn( density );
        return Primitives.revolve( [
            Profile.line( [0, z0], [r0, z0], l ), Profile.arc( [0, 0], radius, Math.atan2( z0, r0 ), Math.atan2( z1, r1 ), t ), Profile.line( [r1, z1], [0, z1], l ),
        ], t, ["bottom", "zone", "top"] );
    }

    // A spherical sector: the cone from the centre of the sphere of `radius` (at the origin) to a cap, with half
    // opening `angle` about +z (radians, below a half turn).
    public static sphericalSector( radius : number, angle : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" );
        if (!(angle > 0 && angle < Math.PI)) throw new Error( "Primitives: a sector's half angle is between 0 and a half turn" );
        const p : Point = [radius * Math.sin( angle ), radius * Math.cos( angle )];
        const t = Primitives.turn( density );
        return Primitives.revolve( [
            Profile.line( [0, 0], p, Primitives.lineDivs( density ) ), Profile.arc( [0, 0], radius, Math.PI / 2 - angle, Math.PI / 2, t ),
        ], t, ["cone", "cap"] );
    }

    // A spheroid: the ellipse of horizontal semi-axis `radius` and vertical semi-axis `height / 2` revolved, standing
    // on z = 0 (oblate when height < 2 radius, prolate when more).
    public static spheroid( radius : number, height : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" ); Primitives.positive( height, "height" );
        const t = Primitives.turn( density );
        return Primitives.revolve( [Profile.ellipseArc( [0, height / 2], radius, height / 2, -Math.PI / 2, Math.PI / 2, t, false )], t, ["surface"] );
    }

    // A triaxial ellipsoid with semi-axes rx, ry, rz, standing on z = 0: a spheroid scaled in y (an affine map of
    // the control points, so still exact).
    public static ellipsoid( rx : number, ry : number, rz : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( ry, "ry" );
        return Primitives.transformed( Primitives.spheroid( rx, 2 * rz, density ), [[1, 0, 0, 0], [0, ry / rx, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] );
    }

    // A capsule (spherocylinder): a cylinder of `radius` and straight `length` with a hemisphere on each end,
    // standing on z = 0 (total height length + 2 radius).
    public static capsule( radius : number, length : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" );
        if (!(length >= 0)) throw new Error( "Primitives: a capsule's length is 0 or more" );
        if (length == 0) return Primitives.sphere( radius, density );
        const t = Primitives.turn( density );
        return Primitives.revolve( [
            Profile.arc( [0, radius], radius, -Math.PI / 2, 0, t, false ),
            Profile.line( [radius, radius], [radius, radius + length], Primitives.lineDivs( density ), false ),
            Profile.arc( [0, radius + length], radius, 0, Math.PI / 2, t, false ),
        ], t, ["surface"] );
    }

    // A solid paraboloid: z = height (r / radius)^2 for r up to `radius`, closed by a flat top. The parabola is a
    // quadratic Bézier curve, so the surface is exact.
    public static paraboloid( radius : number, height : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" ); Primitives.positive( height, "height" );
        // the tangent at r = radius meets the axis at z = -height, so it meets z = 0 at r = radius / 2
        const parabola = Make.rationalBezierCurve( [[0, 0, 0], [radius / 2, 0, 0], [radius, height, 0]] );
        const t = Primitives.turn( density );
        return Primitives.revolve( [Profile.nurbs( parabola, Math.max( 4, Math.round( t / 4 ) ) ), Profile.line( [radius, height], [0, height], Primitives.lineDivs( density ) )], t, ["surface", "top"] );
    }

    // A lens: two spherical caps of radii r1 (below) and r2 (above) on a common rim circle of `diameter`, meeting at
    // a sharp edge; the lens stands on z = 0.
    public static lens( r1 : number, r2 : number, diameter : number, density : Density = {} ) : BrepSolid {
        const a = diameter / 2;
        if (!(a > 0 && r1 >= a && r2 >= a)) throw new Error( "Primitives: a lens's radii are at least half its diameter" );
        const h1 = r1 - Math.sqrt( r1 * r1 - a * a ), h2 = r2 - Math.sqrt( r2 * r2 - a * a );
        const t = Primitives.turn( density );
        return Primitives.revolve( [
            Profile.arc( [0, r1], r1, -Math.PI / 2, Math.atan2( h1 - r1, a ), t ),
            Profile.arc( [0, h1 + h2 - r2], r2, Math.atan2( r2 - h2, a ), Math.PI / 2, t ),
        ], t, ["bottom", "top"] );
    }

    // A torus: the circle of `minor` radius at distance `major` from the axis, revolved; centred at z = minor so it
    // lies on z = 0. Its section can be an ellipse (`minorZ`, the vertical semi-axis).
    public static torus( major : number, minor : number, minorZ? : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( minor, "minor radius" );
        if (!(major > minor)) throw new Error( "Primitives: a torus's major radius is larger than its minor radius (a horn or spindle torus is not a solid)" );
        const rz = minorZ != null ? minorZ : minor;
        Primitives.positive( rz, "vertical semi-axis" );
        const t = Primitives.turn( density );
        // two halves, outer and inner, so that each face closes in one direction only, as STEP expects
        return Primitives.revolve( [
            Profile.ellipseArc( [major, rz], minor, rz, -Math.PI / 2, Math.PI / 2, t, true ),
            Profile.ellipseArc( [major, rz], minor, rz, Math.PI / 2, 3 * Math.PI / 2, t, true ),
        ], t, ["outer", "inner"] );
    }

    // A tube (thick-walled cylinder, a washer when short): outer and inner radii, height.
    public static tube( outer : number, inner : number, height : number, density : Density = {} ) : BrepSolid {
        return Primitives.conicalTube( outer, inner, outer, inner, height, density );
    }

    // A hollow frustum: outer and inner radii at the bottom (r0, i0) and at the top (r1, i1).
    public static conicalTube( r0 : number, i0 : number, r1 : number, i1 : number, height : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( height, "height" );
        if (!(i0 > 0 && i1 > 0 && r0 > i0 && r1 > i1)) throw new Error( "Primitives: a tube's inner radii are positive and less than its outer radii" );
        const l = Primitives.lineDivs( density );
        return Primitives.revolve( [
            Profile.line( [i0, 0], [r0, 0], l ), Profile.line( [r0, 0], [r1, height], l ), Profile.line( [r1, height], [i1, height], l ), Profile.line( [i1, height], [i0, 0], l ),
        ], Primitives.turn( density ), ["bottom", "outer", "top", "inner"] );
    }

    // An egg of revolution made of two half spheroids sharing their equator of `radius`: `top` tall above it and
    // `bottom` below. The halves meet with a common tangent (G1); their curvatures differ there unless top = bottom.
    public static egg( radius : number, top : number, bottom : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" ); Primitives.positive( top, "top" ); Primitives.positive( bottom, "bottom" );
        const t = Primitives.turn( density );
        return Primitives.revolve( [
            Profile.ellipseArc( [0, bottom], radius, bottom, -Math.PI / 2, 0, t, false ),
            Profile.ellipseArc( [0, bottom], radius, top, 0, Math.PI / 2, t, false ),
        ], t, ["surface"] );
    }

    // Moss's egg: a half circle of `radius` below; above it two arcs of radius 2 radius centred on the ends of the
    // horizontal diameter, and a small arc on top centred where they meet the vertical through the egg's axis (the
    // arcs are tangent at every join). It stands on z = 0 and is (4 - sqrt 2) radius tall.
    public static mossEgg( radius : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" );
        const r = radius, t = Primitives.turn( density );
        // centre of the half circle at (0, r); the side arc is centred at (-r, r) with radius 2r, from angle 0 up to
        // 45 degrees; the top arc is centred at (0, 2r) with radius (2 - sqrt 2) r, from 45 to 90 degrees
        const small = (2 - Math.SQRT2) * r;
        return Primitives.revolve( [
            Profile.arc( [0, r], r, -Math.PI / 2, 0, t, false ),
            Profile.arc( [-r, r], 2 * r, 0, Math.PI / 4, t, false ),
            Profile.arc( [0, 2 * r], small, Math.PI / 4, Math.PI / 2, t, false ),
        ], t, ["surface"] );
    }

    // A tangent ogive nose cone of base `radius` and `length`: the arc of the circle tangent to the cylinder at the
    // base, through the tip, revolved; with a flat base.
    public static ogive( radius : number, length : number, density : Density = {} ) : BrepSolid {
        Primitives.positive( radius, "radius" ); Primitives.positive( length, "length" );
        // the ogive radius rho = (R^2 + L^2) / (2 R), centred at (R - rho, 0)
        const rho = (radius * radius + length * length) / (2 * radius);
        const a1 = Math.atan2( length, rho - radius );
        const t = Primitives.turn( density );
        return Primitives.revolve( [
            Profile.line( [0, 0], [radius, 0], Primitives.lineDivs( density ) ), Profile.arc( [radius - rho, 0], rho, 0, a1, t ),
        ], t, ["base", "nose"] );
    }

    // ---- measures ----

    // The edges of a solid where its faces meet at an angle (more than `degrees` between their normals anywhere
    // along the edge): the edges a fillet can round. A tangent join, as between a torus's two halves or a capsule's
    // cylinder and caps, is an edge of the B-rep but not a crease, and rounding it is meaningless.
    public static creases( solid : BrepSolid, degrees : number = 1 ) : Array<SolidEdge> {
        const cos = Math.cos( degrees * Math.PI / 180 );
        const normal = (f : BrepFace, uv : Array<number>) : Point => {
            const d = Eval.rationalSurfaceDerivatives( f.surface, uv[0], uv[1], 1 );
            return Vec.normalized( Vec.mul( f.reversed ? -1 : 1, Vec.cross( d[1][0], d[0][1] ) ) );
        };
        return BrepEdges.all( solid ).filter( e => {
            const fa = solid.faces[e.faces[0]], fb = solid.faces[e.faces[1]], c = e.curve;
            // away from the ends, where a face may have a pole
            for (let k = 1; k + 1 < c.points.length; k++) {
                const na = normal( fa, c.uvA[k] ), nb = normal( fb, c.uvB[k] );
                if (isFinite( na[0] ) && isFinite( nb[0] ) && Vec.dot( na, nb ) < cos) return true;
            }
            return false;
        } );
    }

    // The volume enclosed by a solid's faces, from the divergence theorem: V = 1/3 of the integral over the boundary
    // of p . n dA, which on a face is the integral over its domain of S . (Su x Sv) du dv (negated for a reversed
    // face). Each knot span is integrated by Gauss-Legendre quadrature of `order` points in each direction, so the
    // result does not depend on any tessellation: polynomial faces are integrated exactly once the order covers
    // their degree, and rational ones (circles, spheres) to about 1e-12 at the default order.
    public static volume( solid : BrepSolid, order : number = 12 ) : number {
        const g = Primitives.gauss( order );
        let v = 0.0;
        for (const f of solid.faces) {
            const s = f.surface;
            const us = Array.from( new Set( s.knotsU ) ), vs = Array.from( new Set( s.knotsV ) );
            let sum = 0.0;
            for (let i = 0; i + 1 < us.length; i++) for (let j = 0; j + 1 < vs.length; j++) {
                const hu = (us[i + 1] - us[i]) / 2, hv = (vs[j + 1] - vs[j]) / 2;
                for (let a = 0; a < order; a++) for (let b = 0; b < order; b++) {
                    const d = Eval.rationalSurfaceDerivatives( s, us[i] + hu * (1 + g.x[a]), vs[j] + hv * (1 + g.x[b]), 1 );
                    sum += g.w[a] * g.w[b] * hu * hv * Vec.dot( d[0][0], Vec.cross( d[1][0], d[0][1] ) );
                }
            }
            v += (f.reversed ? -sum : sum) / 3;
        }
        return v;
    }

    // Gauss-Legendre nodes and weights on [-1, 1]: the roots of the Legendre polynomial P_n by Newton's method from
    // Chebyshev guesses (W. H. Press et al., "Numerical Recipes", 3rd ed., Cambridge University Press, 2007, 4.6).
    private static gauss( n : number ) : { x : Array<number>, w : Array<number> } {
        const x : Array<number> = [], w : Array<number> = [];
        for (let i = 0; i < n; i++) {
            let z = Math.cos( Math.PI * (i + 0.75) / (n + 0.5) ), dp = 1.0;
            for (let it = 0; it < 100; it++) {
                let p0 = 1.0, p1 = 0.0;
                for (let k = 1; k <= n; k++) { const p2 = p1; p1 = p0; p0 = ((2 * k - 1) * z * p1 - (k - 1) * p2) / k; }
                dp = n * (z * p0 - p1) / (z * z - 1);
                const dz = p0 / dp;
                z -= dz;
                if (Math.abs( dz ) < 1e-16) break;
            }
            x.push( z ); w.push( 2 / ((1 - z * z) * dp * dp) );
        }
        return { x : x, w : w };
    }

    // ---- helpers ----

    // The solid mapped by a 4x4 affine matrix (the faces' control points; exact for rational faces too).
    public static transformed( s : BrepSolid, m : Matrix ) : BrepSolid {
        return new BrepSolid( s.faces.map( f => BrepSolid.face( Modify.rationalSurfaceTransform( f.surface, m ), f.periodic, f.divs, f.name ) ) ).orient();
    }

    // The cap faces of a profile, one per cap loop (a cone from the loop's centre to its boundary).
    private static caps( profile : Profile, name : string, faces : Array<BrepFace> ) : void {
        const loops = profile.capLoops();
        loops.forEach( (l, k) => {
            const ring = Profile.join( Primitives.seamMidway( l.segments ) );
            const n = l.segments.reduce( (a, s) => a + s.divs, 0 );
            faces.push( BrepSolid.face( BrepSolid.cone( l.center, ring ), [true, false], [n, Math.max( 4, Math.round( n / 8 ) )], loops.length == 1 ? name : name + "." + k ) );
        } );
    }

    // A closed loop of segments restarted halfway along its longest-divided segment. A cap is a cone from its centre,
    // so its seam (where its angle parameter starts) is the line from the centre to the loop's start; started at a
    // corner, the seam would run into a vertex of the solid, where the fillets of its edges meet and the corner blend
    // has to cross it. Halfway along a side the seam crosses one fillet's edge cleanly, as on a cylinder's cap.
    private static seamMidway( segs : Array<ProfileSegment> ) : Array<ProfileSegment> {
        let best = 0;
        segs.forEach( (sg, k) => { if (sg.divs > segs[best].divs) best = k; } );
        const sg = segs[best];
        if (sg.divs < 2) return segs;
        const h = Math.floor( sg.divs / 2 );
        const halves = Primitives.split( sg.curve, h / sg.divs );
        const norm = (c : NurbsCurveData) : NurbsCurveData => {
            const a = c.knots[0], b = c.knots[c.knots.length - 1];
            return new NurbsCurveData( c.degree, c.knots.map( x => (x - a) / (b - a) ), c.controlPoints );
        };
        const first : ProfileSegment = { curve : norm( halves[1] ), divs : sg.divs - h, corner : false };
        const last : ProfileSegment = { curve : norm( halves[0] ), divs : h, corner : sg.corner };
        return [first].concat( segs.slice( best + 1 ), segs.slice( 0, best ), [last] );
    }

    // A curve split in two at parameter u, by knot insertion up to the degree (Piegl and Tiller, "The NURBS Book",
    // 2nd ed., 1997, section 5.2). `Divide.curveSplit` returns a degenerate first half when u is already a knot, as
    // where two arcs of a circle meet; this counts the knot's multiplicity first.
    private static split( c : NurbsCurveData, u : number ) : [NurbsCurveData, NurbsCurveData] {
        const p = c.degree, m = c.knots.filter( x => x == u ).length;
        const r = m >= p ? c : Modify.curveKnotRefine( c, Array.from( { length : p - m }, () => u ) );
        const s = r.knots.indexOf( u );
        return [
            new NurbsCurveData( p, r.knots.slice( 0, s + p ).concat( [u] ), r.controlPoints.slice( 0, s ) ),
            new NurbsCurveData( p, [u].concat( r.knots.slice( s ) ), r.controlPoints.slice( s - 1 ) ),
        ];
    }

    private static translation( d : Point ) : Matrix {
        return [[1, 0, 0, d[0]], [0, 1, 0, d[1]], [0, 0, 1, d[2]], [0, 0, 0, 1]];
    }

    private static endPoint( c : NurbsCurveData, atEnd : boolean ) : Point {
        const hp = c.controlPoints[atEnd ? c.controlPoints.length - 1 : 0];
        return [hp[0] / hp[3], hp[1] / hp[3], hp[2] / hp[3]];
    }

    private static turn( d : Density ) : number { return d.turn != null ? d.turn : DEFAULT_TURN; }
    private static lineDivs( d : Density ) : number { return d.line != null ? d.line : DEFAULT_LINE; }

    private static sides( n : number ) : void {
        if (!(Number.isInteger( n ) && n >= 3)) throw new Error( "Primitives: a whole number of sides, 3 or more" );
    }

    private static positive( x : number, name : string ) : void {
        if (!(x > 0) || !isFinite( x )) throw new Error( `Primitives: the ${name} must be positive` );
    }
}


