import { NurbsCurveData, Point } from "../../core/Data.js";
import { Vec } from "../../core/Vec.js";
import { CapLoop, Profile, ProfileDensity, ProfileSegment } from "./Profile.js";

const TAU = 2 * Math.PI;

// Closed planar profiles, counter-clockwise in the plane z = 0, centred on the origin unless said otherwise: the
// sections of prisms and the bases of pyramids. Straight segments and circular arcs are exact (arcs are rational
// quadratics); every corner of a profile becomes an edge of the solids built on it. See docs/primitives.md, section 6.
export class Profiles {

    // A polygon through the points (counter-clockwise; clockwise input is reversed), every vertex a corner. The caps
    // are cones from `center` (the centroid by default), so the polygon must be star-shaped about it.
    public static polygon( points : Array<Point>, center? : Point, density : ProfileDensity = {} ) : Profile {
        let pts = points.map( Profile.p3 );
        if (Profiles.signedArea( pts ) < 0) pts = pts.slice().reverse();
        const segs = pts.map( (p, i) => Profile.line( p, pts[(i + 1) % pts.length], density.line ) );
        return Profiles.checked( new Profile( segs, center != null ? Profile.p3( center ) : Profile.polygonCentroid( pts ) ), "polygon" );
    }

    // A regular polygon with `sides` vertices on a circle of `radius`; the first vertex at angle `rotation` (radians,
    // default: pointing along +y).
    public static regular( sides : number, radius : number, rotation : number = Math.PI / 2, density : ProfileDensity = {} ) : Profile {
        Profiles.require( sides >= 3 && Number.isInteger( sides ), "a regular polygon has a whole number of sides, 3 or more" );
        Profiles.positive( radius, "radius" );
        return Profiles.polygon( Profiles.ring( sides, radius, rotation ), [0, 0, 0], density );
    }

    // A w by h rectangle centred on the origin.
    public static rectangle( w : number, h : number, density : ProfileDensity = {} ) : Profile {
        Profiles.positive( w, "width" ); Profiles.positive( h, "height" );
        return Profiles.polygon( [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], [0, 0, 0], density );
    }

    // A star with `points` tips on a circle of `outer` radius and the notches between them on a circle of `inner`
    // radius; the first tip at angle `rotation`.
    public static star( points : number, outer : number, inner : number, rotation : number = Math.PI / 2, density : ProfileDensity = {} ) : Profile {
        Profiles.require( points >= 2 && Number.isInteger( points ), "a star has a whole number of points, 2 or more" );
        Profiles.positive( outer, "outer radius" ); Profiles.positive( inner, "inner radius" );
        const pts : Array<Point> = [];
        for (let i = 0; i < 2 * points; i++) {
            const r = i % 2 == 0 ? outer : inner, a = rotation + Math.PI * i / points;
            pts.push( [r * Math.cos( a ), r * Math.sin( a ), 0] );
        }
        return Profiles.polygon( pts, [0, 0, 0], density );
    }

    // The regular star polygon {n/k} (a pentagram is {5/2}) with tips on a circle of `radius`: the outline of the
    // star, whose notches lie where the lines from tip i to tip i + k cross.
    public static starPolygon( n : number, k : number, radius : number, rotation : number = Math.PI / 2, density : ProfileDensity = {} ) : Profile {
        Profiles.require( Number.isInteger( n ) && Number.isInteger( k ) && n >= 5 && k >= 2 && 2 * k < n, "a star polygon {n/k} needs whole n >= 5 and 2 <= k < n/2" );
        // the notch radius: the line from tip 0 to tip k crosses the line from tip 1 to tip 1 - k on the bisector
        const inner = radius * Math.cos( Math.PI * k / n ) / Math.cos( Math.PI * (k - 1) / n );
        return Profiles.star( n, radius, inner, rotation, density );
    }

    // A polygon with its corners rounded by tangent arcs: radius `radius` at every vertex, or one radius per vertex
    // (0 leaves that corner sharp). Concave corners are rounded too. The result has no corner where every radius is
    // positive, so a prism over it has one smooth side face.
    public static rounded( points : Array<Point>, radius : number | Array<number>, center? : Point, density : ProfileDensity = {} ) : Profile {
        let pts = points.map( Profile.p3 );
        let radii = typeof radius == "number" ? pts.map( () => radius ) : radius.slice();
        if (radii.length != pts.length) throw new Error( "Profiles: one radius per vertex" );
        if (Profiles.signedArea( pts ) < 0) { pts = pts.slice().reverse(); radii = radii.slice().reverse(); }
        const n = pts.length;
        // per vertex: where the rounding starts and ends, and the arc between
        const corners = pts.map( (v, i) => {
            const a = Vec.normalized( Vec.sub( v, pts[(i + n - 1) % n] ) ), b = Vec.normalized( Vec.sub( pts[(i + 1) % n], v ) );
            const r = radii[i];
            if (!(r > 0)) return { start : v, end : v, arc : null as ProfileSegment | null };
            const turn = Math.atan2( a[0] * b[1] - a[1] * b[0], Vec.dot( a, b ) ); // signed: > 0 at a convex corner
            const d = r * Math.tan( Math.abs( turn ) / 2 );
            const p1 = Vec.sub( v, Vec.mul( d, a ) ), p2 = Vec.add( v, Vec.mul( d, b ) );
            const left : Point = [-a[1], a[0], 0];
            const c = Vec.add( p1, Vec.mul( turn > 0 ? r : -r, left ) );
            const s0 = Math.atan2( p1[1] - c[1], p1[0] - c[0] );
            return { start : p1, end : p2, arc : Profile.arc( c, r, s0, s0 + turn, density.turn, false ) };
        } );
        // check that neighbouring roundings do not overlap along an edge
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n, len = Vec.dist( pts[i], pts[j] );
            if (Vec.dist( pts[i], corners[i].end ) + Vec.dist( pts[j], corners[j].start ) > len * (1 + 1e-12))
                throw new Error( "Profiles: the corner radii are too large for the polygon's edges" );
        }
        // a line leaves a rounding tangentially and a sharp corner with a turn; an arc always follows its edge's
        // line (or, when the roundings fill the edge, the previous arc) tangentially, unless the edge is used up
        // right from a sharp corner
        const segs : Array<ProfileSegment> = [];
        let sharp = false;
        for (let i = 0; i < n; i++) {
            const c = corners[i], next = corners[(i + 1) % n];
            if (c.arc != null) { c.arc.corner = sharp; segs.push( c.arc ); }
            sharp = c.arc == null;
            if (Vec.dist( c.end, next.start ) > 1e-12 * Math.max( 1, Vec.norm( c.end ) )) { segs.push( Profile.line( c.end, next.start, density.line, sharp ) ); sharp = false; }
            else if (next.arc == null) throw new Error( "Profiles: a zero-length edge" );
        }
        if (corners[0].arc != null) corners[0].arc.corner = sharp;
        return Profiles.checked( new Profile( segs, center != null ? Profile.p3( center ) : Profile.polygonCentroid( pts ) ), "rounded polygon" );
    }

    // A w by h rectangle with corners rounded to radius r (a stadium when r is half the shorter side).
    public static roundedRectangle( w : number, h : number, r : number, density : ProfileDensity = {} ) : Profile {
        Profiles.positive( w, "width" ); Profiles.positive( h, "height" );
        Profiles.require( r >= 0 && 2 * r <= Math.min( w, h ) + 1e-12, "the corner radius is at most half the shorter side" );
        if (r == 0) return Profiles.rectangle( w, h, density );
        return Profiles.rounded( [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], r, [0, 0, 0], density );
    }

    // A regular polygon with rounded corners.
    public static roundedRegular( sides : number, radius : number, r : number, rotation : number = Math.PI / 2, density : ProfileDensity = {} ) : Profile {
        return Profiles.rounded( Profiles.ring( sides, radius, rotation ), r, [0, 0, 0], density );
    }

    // A circle: one rational closed segment, no corner.
    public static circle( radius : number, density : ProfileDensity = {} ) : Profile {
        Profiles.positive( radius, "radius" );
        return Profiles.ellipse( radius, radius, density );
    }

    // An ellipse with semi-axes rx (along x) and ry (along y).
    public static ellipse( rx : number, ry : number, density : ProfileDensity = {} ) : Profile {
        Profiles.positive( rx, "rx" ); Profiles.positive( ry, "ry" );
        return new Profile( [Profile.ellipseArc( [0, 0, 0], rx, ry, 0, TAU, density.turn, false )], [0, 0, 0] );
    }

    // A slot: two half circles of `radius` whose centres are `length` apart along x, joined by tangent lines.
    public static stadium( length : number, radius : number, density : ProfileDensity = {} ) : Profile {
        Profiles.positive( radius, "radius" );
        Profiles.require( length >= 0, "a stadium's length is 0 or more" );
        if (length == 0) return Profiles.circle( radius, density );
        const h = length / 2;
        return new Profile( [
            Profile.line( [-h, -radius], [h, -radius], density.line, false ),
            Profile.arc( [h, 0], radius, -Math.PI / 2, Math.PI / 2, density.turn, false ),
            Profile.line( [h, radius], [-h, radius], density.line, false ),
            Profile.arc( [-h, 0], radius, Math.PI / 2, 3 * Math.PI / 2, density.turn, false ),
        ], [0, 0, 0] );
    }

    // A circular sector (a pie slice) of `radius` and opening `angle` (radians, below a full turn), symmetric about
    // +x, with its apex at the origin. A sector wider than a half turn is star-shaped about points on its bisector
    // near the apex, where the cap is centred.
    public static sector( radius : number, angle : number, density : ProfileDensity = {} ) : Profile {
        Profiles.positive( radius, "radius" );
        Profiles.require( angle > 0 && angle < TAU, "a sector's angle is between 0 and a full turn" );
        const a0 = -angle / 2, a1 = angle / 2;
        const p0 : Point = [radius * Math.cos( a0 ), radius * Math.sin( a0 ), 0], p1 : Point = [radius * Math.cos( a1 ), radius * Math.sin( a1 ), 0];
        return Profiles.checked( new Profile( [
            Profile.line( [0, 0, 0], p0, density.line ),
            Profile.arc( [0, 0, 0], radius, a0, a1, density.turn ),
            Profile.line( p1, [0, 0, 0], density.line ),
        ], [0.4 * radius, 0, 0] ), "sector" );
    }

    // A heart `width` wide: a square standing on a corner, with a half disc on each of its two upper sides (two exact
    // arcs and two lines, each line tangent to its arc). The point is at the origin and the heart is symmetric about
    // the y axis. Its two corners, the point and the dip between the lobes, make two smooth side faces.
    public static heart( width : number, density : ProfileDensity = {} ) : Profile {
        Profiles.positive( width, "width" );
        const L = width / (Math.SQRT1_2 + 1); // the square's side
        const s = L * Math.SQRT1_2, r = L / 2;
        const right : Point = [s, s, 0], left : Point = [-s, s, 0];
        const mr : Point = [s / 2, 1.5 * s, 0], ml : Point = [-s / 2, 1.5 * s, 0];
        return Profiles.checked( new Profile( [
            Profile.line( [0, 0, 0], right, density.line ),
            Profile.arc( mr, r, -Math.PI / 4, 3 * Math.PI / 4, density.turn, false ),
            Profile.arc( ml, r, Math.PI / 4, 5 * Math.PI / 4, density.turn ),
            Profile.line( left, [0, 0, 0], density.line, false ),
        ], [0, s, 0] ), "heart" );
    }

    // A plus sign `size` across with arms `arm` wide.
    public static cross( size : number, arm : number, density : ProfileDensity = {} ) : Profile {
        Profiles.positive( size, "size" ); Profiles.positive( arm, "arm width" );
        Profiles.require( arm < size, "the arms are narrower than the cross" );
        const a = arm / 2, s = size / 2;
        return Profiles.polygon( [[a, -s], [a, -a], [s, -a], [s, a], [a, a], [a, s], [-a, s], [-a, a], [-s, a], [-s, -a], [-a, -a], [-a, -s]], [0, 0, 0], density );
    }

    // An arrow along +x from the origin: a shaft `shaft` wide and a triangular head `head` wide and `headLength` long,
    // `length` in all.
    public static arrow( length : number, shaft : number, head : number, headLength : number, density : ProfileDensity = {} ) : Profile {
        Profiles.positive( length, "length" ); Profiles.positive( shaft, "shaft width" );
        Profiles.require( head > shaft && headLength > 0 && headLength < length, "the head is wider than the shaft and shorter than the arrow" );
        const b = length - headLength, s = shaft / 2, h = head / 2;
        return Profiles.polygon( [[0, -s], [b, -s], [b, -h], [length, 0], [b, h], [b, s], [0, s]], [b + headLength / 4, 0, 0], density );
    }

    // An L (angle) section: legs w along x and h along y, both t thick, the outer corner at the origin.
    public static angleSection( w : number, h : number, t : number, density : ProfileDensity = {} ) : Profile {
        Profiles.require( t > 0 && t < w && t < h, "an angle section's thickness is less than its legs" );
        return Profiles.polygon( [[0, 0], [w, 0], [w, t], [t, t], [t, h], [0, h]], [t / 2, t / 2, 0], density );
    }

    // A T section `w` wide and `h` tall: a flange `flange` thick on top of a web `web` thick, the web's foot centred
    // on the origin.
    public static teeSection( w : number, h : number, flange : number, web : number, density : ProfileDensity = {} ) : Profile {
        Profiles.require( flange > 0 && flange < h && web > 0 && web < w, "a T section's flange and web are thinner than it" );
        const a = web / 2, b = w / 2, y = h - flange;
        return Profiles.polygon( [[-a, 0], [a, 0], [a, y], [b, y], [b, h], [-b, h], [-b, y], [-a, y]], [0, h - flange / 2, 0], density );
    }

    // An I (H) section `w` wide and `h` tall, flanges `flange` thick and a web `web` thick, centred on the origin. It
    // is not star-shaped, so its caps are three rectangles: two flanges and the web.
    public static iSection( w : number, h : number, flange : number, web : number, density : ProfileDensity = {} ) : Profile {
        Profiles.require( flange > 0 && 2 * flange < h && web > 0 && web < w, "an I section's flanges and web are thinner than it" );
        const a = web / 2, b = w / 2, y0 = -h / 2 + flange, y1 = h / 2 - flange;
        const pts : Array<Point> = [[-b, -h / 2], [b, -h / 2], [b, y0], [a, y0], [a, y1], [b, y1], [b, h / 2], [-b, h / 2], [-b, y1], [-a, y1], [-a, y0], [-b, y0]];
        return Profiles.split( pts, [[0, 1, 2, 3, 10, 11], [3, 4, 9, 10], [4, 5, 6, 7, 8, 9]], density, "I section" );
    }

    // A U (channel) section `w` wide and `h` tall, walls `t` thick, open upwards, its base centred on the origin. Its
    // caps are three quadrilaterals: the base and the two uprights.
    public static channelSection( w : number, h : number, t : number, density : ProfileDensity = {} ) : Profile {
        Profiles.require( t > 0 && 2 * t < w && t < h, "a channel's walls are thinner than it" );
        const b = w / 2;
        const pts : Array<Point> = [[-b, 0], [b, 0], [b, h], [b - t, h], [b - t, t], [-b + t, t], [-b + t, h], [-b, h]];
        return Profiles.split( pts, [[0, 1, 4, 5], [1, 2, 3, 4], [5, 6, 7, 0]], density, "channel section" );
    }

    // A Reuleaux polygon of constant `width` with an odd number of `sides`: each side an arc centred on the opposite
    // vertex. The vertices are corners.
    public static reuleaux( sides : number, width : number, rotation : number = Math.PI / 2, density : ProfileDensity = {} ) : Profile {
        Profiles.require( sides >= 3 && sides % 2 == 1, "a Reuleaux polygon has an odd number of sides, 3 or more" );
        Profiles.positive( width, "width" );
        // the distance from a vertex to the two opposite ones is the width
        const R = width / (2 * Math.sin( Math.PI * (sides - 1) / (2 * sides) ));
        const v = Profiles.ring( sides, R, rotation );
        const segs : Array<ProfileSegment> = [];
        for (let i = 0; i < sides; i++) {
            const c = v[(i + (sides + 1) / 2) % sides], p = v[i], q = v[(i + 1) % sides];
            const a0 = Math.atan2( p[1] - c[1], p[0] - c[0] );
            let a1 = Math.atan2( q[1] - c[1], q[0] - c[0] );
            while (a1 < a0) a1 += TAU;
            segs.push( Profile.arc( c, width, a0, a1, density.turn ) );
        }
        return new Profile( segs, [0, 0, 0] );
    }

    // Any closed planar NURBS curve (its end weights 1), as one smooth piece, star-shaped about `center`.
    public static curve( c : NurbsCurveData, divs : number, center : Point ) : Profile {
        return Profiles.checked( new Profile( [Profile.nurbs( c, divs, false )], Profile.p3( center ) ), "curve" );
    }

    // ---- helpers ----

    // A polygon capped by several star-shaped loops, given as lists of its vertex indices (counter-clockwise). A loop
    // edge between consecutive vertices is that side of the polygon; any other is a chord inside it, shared by the
    // two loops on either side, so the caps meet sample for sample.
    public static split( points : Array<Point>, loops : Array<Array<number>>, density : ProfileDensity, what : string ) : Profile {
        const pts = points.map( Profile.p3 );
        const n = pts.length;
        const segs = pts.map( (p, i) => Profile.line( p, pts[(i + 1) % n], density.line ) );
        const caps : Array<CapLoop> = loops.map( l => ({
            segments : l.map( (i, k) => {
                const j = l[(k + 1) % l.length];
                return j == (i + 1) % n ? segs[i] : Profile.line( pts[i], pts[j], density.line );
            } ),
            center : Profile.polygonCentroid( l.map( i => pts[i] ) ),
        }) );
        return Profiles.checked( new Profile( segs, Profile.polygonCentroid( pts ), caps ), what );
    }

    public static ring( n : number, radius : number, rotation : number ) : Array<Point> {
        return Array.from( { length : n }, (_, i) => [radius * Math.cos( rotation + TAU * i / n ), radius * Math.sin( rotation + TAU * i / n ), 0] );
    }

    public static signedArea( pts : Array<Point> ) : number {
        let a = 0.0;
        for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
        return a / 2;
    }

    private static checked( p : Profile, what : string ) : Profile {
        if (!p.isStarShaped()) throw new Error( `Profiles: the ${what} is not star-shaped about its cap centre` );
        return p;
    }

    private static require( ok : boolean, message : string ) : void {
        if (!ok) throw new Error( "Profiles: " + message );
    }

    private static positive( x : number, name : string ) : void {
        if (!(x > 0) || !isFinite( x )) throw new Error( `Profiles: the ${name} must be positive` );
    }
}
