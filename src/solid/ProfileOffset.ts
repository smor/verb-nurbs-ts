import { ProfilePath, ProfilePoint, ProfileSegmentSpec, ProfileSpec } from "./Extrusion.js";

// A segment of a profile path in the plane, over t in [0, 1].
type Seg =
    | { kind : "line", a : ProfilePoint, b : ProfilePoint }
    // centre, radius, start angle and signed sweep (counter-clockwise when positive)
    | { kind : "arc", c : ProfilePoint, r : number, a0 : number, sweep : number }
    | { kind : "cubic", p : [ProfilePoint, ProfilePoint, ProfilePoint, ProfilePoint] };

/**
 * Offsets of planar profile regions (#150, ask 3): the region grown or shrunk by a distance, as a profile of lines,
 * arcs and cubic Béziers again.
 *
 * Each path is turned so that the region lies on its left (outer paths counter-clockwise, holes clockwise); growing
 * the region then moves every segment a distance d to its right. A line moves parallel to itself and an arc keeps its
 * centre and changes its radius, both exactly. A cubic's offset is not a polynomial curve: it is approximated by the
 * Tiller–Hanson construction (the control polygon's legs moved by d and met again: Tiller and Hanson, "Offsets of
 * two-dimensional profiles", IEEE Computer Graphics and Applications 4(9), 1984), split in halves until it lies within
 * `tol` of the true offset at sixteen samples. Where two offset segments leave a gap (a convex corner grown, a concave
 * one shrunk) an arc of radius |d| round the corner fills it, which is the exact offset there; where they overlap they
 * are trimmed at their crossing. A path that offsets into itself (an offset larger than a feature of the profile), a
 * hole that grows into the outside or a region that shrinks away is refused, or dropped where that is exact: a hole
 * whose arcs shrink to nothing when the region grows, an outer circle when it shrinks to nothing.
 */
export class ProfileOffset {

    /**
     * The region grown by d (shrunk when d is negative), within `tol` where cubics are offset. Returns null when the
     * region shrinks away.
     */
    public static region( spec : ProfileSpec, d : number, tol : number = 1e-4, twistRate : number = 0 ) : ProfileSpec | null {
        if (d == 0) return spec;
        const outer = ProfileOffset.path( spec.outer, d, true, tol, "the outer path", twistRate );
        if (outer == null) return null;
        const holes : Array<ProfilePath> = [];
        (spec.holes ?? []).forEach( (h, k) => {
            const o = ProfileOffset.path( h, d, false, tol, `hole ${k}`, twistRate );
            if (o != null) holes.push( o );
        } );
        // the paths must not cross one another once offset
        const polys = [outer].concat( holes ).map( p => ProfileOffset.polyline( ProfileOffset.segs( p ) ) );
        for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++)
            if (ProfileOffset.crosses( polys[i], polys[j] )) throw new Error( `ProfileOffset: offset by ${d}, the profile's paths run into each other` );
        return holes.length > 0 ? { outer : outer, holes : holes } : { outer : outer };
    }

    /** A profile turned by `angle` radians (counter-clockwise) about the origin. */
    public static rotated( spec : ProfileSpec, angle : number ) : ProfileSpec {
        const c = Math.cos( angle ), s = Math.sin( angle );
        const R = (p : ProfilePoint) : ProfilePoint => [c * p[0] - s * p[1], s * p[0] + c * p[1]];
        const path = (p : ProfilePath) : ProfilePath => p.kind == "circle" ? { kind : "circle", center : R( p.center ), r : p.r }
            : { kind : "path", start : R( p.start ), segments : p.segments.map( g => g.type == "line" ? { type : "line", to : R( g.to ) } as ProfileSegmentSpec
                : g.type == "arc" ? { type : "arc", via : R( g.via ), to : R( g.to ) } as ProfileSegmentSpec
                : { type : "cubic", c1 : R( g.c1 ), c2 : R( g.c2 ), to : R( g.to ) } as ProfileSegmentSpec ) };
        return spec.holes != null && spec.holes.length > 0 ? { outer : path( spec.outer ), holes : spec.holes.map( path ) } : { outer : path( spec.outer ) };
    }

    // One path offset, the region on its left grown by d. Returns null when it vanishes.
    private static path( path : ProfilePath, d : number, outer : boolean, tol : number, what : string, w : number ) : ProfilePath | null {
        // (a circle round the axis of a twist is a surface of revolution: offset as in the plane)
        if (path.kind == "circle" && (w == 0 || Math.hypot( path.center[0], path.center[1] ) <= 1e-12 * path.r)) {
            // the region inside an outer circle, outside a hole's
            // (null: an outer circle shrunk away, or a hole the region grows over)
            const r = path.r + (outer ? d : -d);
            return r > 0 ? { kind : "circle", center : path.center, r : r } : null;
        }
        let segs = ProfileOffset.segs( path );
        // the region on the left: outer paths counter-clockwise, holes clockwise
        const area = ProfileOffset.area( segs );
        if ((area > 0) != outer) segs = ProfileOffset.reverse( segs );
        const size = ProfileOffset.size( segs );
        const eps = 1e-9 * Math.max( 1, size );
        // each segment moved d to its right
        // (`corner`: where the segment starts, or the centre of an arc before it that shrank to nothing, round which a
        // gap after it is filled)
        const moved : Array<{ from : Seg, to : Array<Seg>, corner : ProfilePoint }> = [];
        for (const s of segs) moved.push( { from : s, to : w == 0 ? ProfileOffset.offset( s, d, tol, 0 ) : ProfileOffset.screwOffset( s, d, w, tol, size ), corner : ProfileOffset.at( s, 0 ) } );
        moved.forEach( (m, k) => {
            const prev = moved[(k + moved.length - 1) % moved.length];
            if (prev.to.length == 0 && prev.from.kind == "arc") m.corner = prev.from.c;
        } );
        // an arc that shrinks to nothing goes; a path all of whose segments go vanishes
        const kept = moved.filter( m => m.to.length > 0 );
        if (kept.length == 0) return null;
        if (kept.length != moved.length && kept.length < 2) return null;
        // the corners: where an offset segment ends and the next one starts
        const out : Array<Seg> = [];
        const pieces = kept.map( m => m.to.slice() );
        const n = pieces.length;
        for (let i = 0; i < n; i++) {
            const A = pieces[i], B = pieces[(i + 1) % n];
            const a = A[A.length - 1], b = B[0];
            const e = ProfileOffset.at( a, 1 ), s = ProfileOffset.at( b, 0 );
            if (ProfileOffset.dist( e, s ) <= eps) { B[0] = ProfileOffset.withStart( b, e ); continue; }
            const V = kept[(i + 1) % n].corner;
            // (twisted: the turn of the profile itself at the corner, which the offset curves only approximate)
            const tin = w == 0 ? ProfileOffset.tangent( a, 1 ) : ProfileOffset.tangent( kept[i].from, 1 );
            const tout = w == 0 ? ProfileOffset.tangent( b, 0 ) : ProfileOffset.tangent( kept[(i + 1) % n].from, 0 );
            const cross = tin[0] * tout[1] - tin[1] * tout[0];
            if (w != 0 && cross * d > 0) {
                // a gap: the section of the pipe of radius |d| round the corner's helix
                for (const g of ProfileOffset.pipe( V, tin, tout, d, w, tol )) A.push( g );
            } else if (cross * d > 0 || (Math.abs( cross ) < 1e-12 && ProfileOffset.dist( e, s ) > eps)) {
                // a gap: the arc of radius |d| round the corner, from e to s
                const a0 = Math.atan2( e[1] - V[1], e[0] - V[0] ), a1 = Math.atan2( s[1] - V[1], s[0] - V[0] );
                let sweep = a1 - a0;
                const dir = cross != 0 ? Math.sign( cross ) : Math.sign( d );
                while (dir > 0 && sweep <= 0) sweep += 2 * Math.PI;
                while (dir < 0 && sweep >= 0) sweep -= 2 * Math.PI;
                A.push( { kind : "arc", c : V, r : Math.abs( d ), a0 : a0, sweep : sweep } );
            } else {
                // an overlap: both trimmed at their crossing near the corner
                const x = ProfileOffset.meet( a, b );
                if (x == null) throw new Error( `ProfileOffset: ${what}: offset by ${d}, a segment is used up (the offset is larger than a feature of the profile)` );
                A[A.length - 1] = ProfileOffset.trim( a, 0, x[0] );
                B[0] = ProfileOffset.trim( b, x[1], 1 );
            }
        }
        for (const p of pieces) for (const s of p) out.push( s );
        // a path that runs into itself is not an offset that this handles
        const poly = ProfileOffset.polyline( out );
        if (ProfileOffset.selfCrosses( poly )) throw new Error( `ProfileOffset: ${what}: offset by ${d}, the path runs into itself (the offset is larger than a feature of the profile)` );
        // still the same way round: a hole grown over, or an outer path shrunk inside out, would turn over
        if ((ProfileOffset.area( out ) > 0) != outer) return null;
        return ProfileOffset.spec( out );
    }

    // ---- segments ----

    private static segs( path : ProfilePath ) : Array<Seg> {
        if (path.kind == "circle") return [{ kind : "arc", c : path.center, r : path.r, a0 : 0, sweep : 2 * Math.PI }];
        const out : Array<Seg> = [];
        let at = path.start;
        path.segments.forEach( (s, k) => {
            const to = k == path.segments.length - 1 ? path.start : s.to;
            if (s.type == "line") out.push( { kind : "line", a : at, b : to } );
            else if (s.type == "cubic") out.push( { kind : "cubic", p : [at, s.c1, s.c2, to] } );
            else out.push( ProfileOffset.arcThrough( at, s.via, to ) );
            at = to;
        } );
        return out;
    }

    private static arcThrough( a : ProfilePoint, m : ProfilePoint, b : ProfilePoint ) : Seg {
        const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
        if (d == 0) return { kind : "line", a : a, b : b };
        const s = (p : ProfilePoint) => p[0] * p[0] + p[1] * p[1];
        const cx = (s( a ) * (m[1] - b[1]) + s( m ) * (b[1] - a[1]) + s( b ) * (a[1] - m[1])) / d;
        const cy = (s( a ) * (b[0] - m[0]) + s( m ) * (a[0] - b[0]) + s( b ) * (m[0] - a[0])) / d;
        const r = Math.hypot( a[0] - cx, a[1] - cy ), ang = (p : ProfilePoint) => Math.atan2( p[1] - cy, p[0] - cx );
        const a0 = ang( a );
        let sweep = ang( b ) - a0;
        if (d > 0) { while (sweep <= 0) sweep += 2 * Math.PI; } else { while (sweep >= 0) sweep -= 2 * Math.PI; }
        return { kind : "arc", c : [cx, cy], r : r, a0 : a0, sweep : sweep };
    }

    private static at( s : Seg, t : number ) : ProfilePoint {
        if (s.kind == "line") return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
        if (s.kind == "arc") { const a = s.a0 + s.sweep * t; return [s.c[0] + s.r * Math.cos( a ), s.c[1] + s.r * Math.sin( a )]; }
        const [p0, p1, p2, p3] = s.p, u = 1 - t;
        const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        return [b[0] * p0[0] + b[1] * p1[0] + b[2] * p2[0] + b[3] * p3[0], b[0] * p0[1] + b[1] * p1[1] + b[2] * p2[1] + b[3] * p3[1]];
    }

    private static derivative( s : Seg, t : number ) : ProfilePoint {
        if (s.kind == "line") return [s.b[0] - s.a[0], s.b[1] - s.a[1]];
        if (s.kind == "arc") { const a = s.a0 + s.sweep * t; return [-s.r * s.sweep * Math.sin( a ), s.r * s.sweep * Math.cos( a )]; }
        const [p0, p1, p2, p3] = s.p, u = 1 - t;
        return [0, 1].map( k => 3 * u * u * (p1[k] - p0[k]) + 6 * u * t * (p2[k] - p1[k]) + 3 * t * t * (p3[k] - p2[k]) ) as ProfilePoint;
    }

    // the unit tangent, from the control polygon where the derivative vanishes (a cubic with a repeated control point)
    private static tangent( s : Seg, t : number ) : ProfilePoint {
        let v = ProfileOffset.derivative( s, t );
        if (Math.hypot( v[0], v[1] ) < 1e-14 && s.kind == "cubic") {
            const [p0, p1, p2, p3] = s.p;
            v = t < 0.5 ? (ProfileOffset.dist( p0, p1 ) > 0 ? [p1[0] - p0[0], p1[1] - p0[1]] : [p2[0] - p0[0], p2[1] - p0[1]])
                : (ProfileOffset.dist( p2, p3 ) > 0 ? [p3[0] - p2[0], p3[1] - p2[1]] : [p3[0] - p1[0], p3[1] - p1[1]]);
        }
        const l = Math.hypot( v[0], v[1] );
        return [v[0] / l, v[1] / l];
    }

    private static reverse( segs : Array<Seg> ) : Array<Seg> {
        return segs.slice().reverse().map( s => s.kind == "line" ? { kind : "line", a : s.b, b : s.a } as Seg
            : s.kind == "arc" ? { kind : "arc", c : s.c, r : s.r, a0 : s.a0 + s.sweep, sweep : -s.sweep } as Seg
            : { kind : "cubic", p : [s.p[3], s.p[2], s.p[1], s.p[0]] } as Seg );
    }

    // the part of a segment between two of its parameters
    private static trim( s : Seg, t0 : number, t1 : number ) : Seg {
        if (s.kind == "line") return { kind : "line", a : ProfileOffset.at( s, t0 ), b : ProfileOffset.at( s, t1 ) };
        if (s.kind == "arc") return { kind : "arc", c : s.c, r : s.r, a0 : s.a0 + s.sweep * t0, sweep : s.sweep * (t1 - t0) };
        // de Casteljau: split at t1, then the first part at t0 / t1
        const right = ProfileOffset.split( s.p, t0 )[1];
        const t = t0 < 1 ? (t1 - t0) / (1 - t0) : 1;
        return { kind : "cubic", p : ProfileOffset.split( right, t )[0] };
    }

    private static withStart( s : Seg, p : ProfilePoint ) : Seg {
        if (s.kind == "line") return { kind : "line", a : p, b : s.b };
        if (s.kind == "cubic") return { kind : "cubic", p : [p, s.p[1], s.p[2], s.p[3]] };
        return s; // an arc's start is its own; within eps of p
    }

    private static split( p : [ProfilePoint, ProfilePoint, ProfilePoint, ProfilePoint], t : number ) : [[ProfilePoint, ProfilePoint, ProfilePoint, ProfilePoint], [ProfilePoint, ProfilePoint, ProfilePoint, ProfilePoint]] {
        const L = (a : ProfilePoint, b : ProfilePoint) : ProfilePoint => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const a = L( p[0], p[1] ), b = L( p[1], p[2] ), c = L( p[2], p[3] ), ab = L( a, b ), bc = L( b, c ), m = L( ab, bc );
        return [[p[0], a, ab, m], [m, bc, c, p[3]]];
    }

    // ---- offsets ----

    // A segment moved d to its right: exact for lines and arcs (an arc that shrinks to nothing gives nothing), within
    // tol for cubics.
    private static offset( s : Seg, d : number, tol : number, depth : number ) : Array<Seg> {
        if (s.kind == "line") {
            const t = ProfileOffset.tangent( s, 0 ), n : ProfilePoint = [t[1] * d, -t[0] * d];
            return [{ kind : "line", a : [s.a[0] + n[0], s.a[1] + n[1]], b : [s.b[0] + n[0], s.b[1] + n[1]] }];
        }
        if (s.kind == "arc") {
            // the right of a counter-clockwise arc is outside it
            const r = s.r + (s.sweep > 0 ? d : -d);
            return r > 1e-12 * Math.max( 1, s.r ) ? [{ kind : "arc", c : s.c, r : r, a0 : s.a0, sweep : s.sweep }] : [];
        }
        const P = s.p;
        // the control polygon's legs moved d to their right, met again (Tiller and Hanson)
        const leg = (a : ProfilePoint, b : ProfilePoint) => {
            const l = ProfileOffset.dist( a, b );
            return l > 0 ? [b[1] - a[1], a[0] - b[0]].map( x => x / l * d ) as ProfilePoint : null;
        };
        const n0 = ProfileOffset.normal( s, 0, d ), n3 = ProfileOffset.normal( s, 1, d );
        const n1 = leg( P[1], P[2] ) ?? ProfileOffset.normal( s, 0.5, d );
        const lines : Array<[ProfilePoint, ProfilePoint]> = [
            [[P[0][0] + n0[0], P[0][1] + n0[1]], [P[1][0] + n0[0], P[1][1] + n0[1]]],
            [[P[1][0] + n1[0], P[1][1] + n1[1]], [P[2][0] + n1[0], P[2][1] + n1[1]]],
            [[P[2][0] + n3[0], P[2][1] + n3[1]], [P[3][0] + n3[0], P[3][1] + n3[1]]],
        ];
        const meetLines = (A : [ProfilePoint, ProfilePoint], B : [ProfilePoint, ProfilePoint], fallback : ProfilePoint) : ProfilePoint => {
            const da = [A[1][0] - A[0][0], A[1][1] - A[0][1]], db = [B[1][0] - B[0][0], B[1][1] - B[0][1]];
            const den = da[0] * db[1] - da[1] * db[0];
            if (Math.abs( den ) < 1e-12 * (Math.hypot( da[0], da[1] ) * Math.hypot( db[0], db[1] ) + 1e-300)) return fallback;
            const t = ((B[0][0] - A[0][0]) * db[1] - (B[0][1] - A[0][1]) * db[0]) / den;
            return [A[0][0] + da[0] * t, A[0][1] + da[1] * t];
        };
        const q0 = lines[0][0], q3 = lines[2][1];
        const q1 = meetLines( lines[0], lines[1], lines[0][1] ), q2 = meetLines( lines[1], lines[2], lines[2][0] );
        const c : Seg = { kind : "cubic", p : [q0, q1, q2, q3] };
        // how far it strays from the true offset, at sixteen samples (each true offset point to the nearest of the
        // approximation's samples, refined on the curve)
        let err = 0;
        for (let k = 1; k < 16; k++) {
            const t = k / 16, p = ProfileOffset.at( s, t ), nn = ProfileOffset.normal( s, t, d );
            const q : ProfilePoint = [p[0] + nn[0], p[1] + nn[1]];
            err = Math.max( err, ProfileOffset.distanceTo( c, q, t ) );
        }
        if (err <= tol || depth >= 10) return [c];
        const [l, r] = ProfileOffset.split( P, 0.5 );
        return ProfileOffset.offset( { kind : "cubic", p : l }, d, tol, depth + 1 ).concat( ProfileOffset.offset( { kind : "cubic", p : r }, d, tol, depth + 1 ) );
    }

    // ---- offsets of twisted profiles ----
    //
    // A profile extruded with a twist of w radians per unit height sweeps a screw surface: the section c at height z
    // is c turned by w z. Its offset is again a screw surface of the same pitch, so it too is a twisted extrusion, of
    // the section in which it meets the plane z = 0. At the section point c with tangent c', the surface's tangents are
    // (c', 0) and the helix's (-w c_y, w c_x, 1); their cross product (c'_y, -c'_x, w c·c') is the normal, to the
    // right of the profile. The offset point q = c + d n lies at height q_z, and the screw motion back by -q_z brings
    // it into the plane: (q_x, q_y) turned by -w q_z. Those plane curves are fitted by cubics within tol.

    // the unit normal to the right of the screw surface at the section point c with unit tangent v
    private static screwNormal( c : ProfilePoint, v : ProfilePoint, w : number ) : [number, number, number] {
        const n : [number, number, number] = [v[1], -v[0], w * (c[0] * v[0] + c[1] * v[1])];
        const l = Math.hypot( n[0], n[1], n[2] );
        return [n[0] / l, n[1] / l, n[2] / l];
    }

    // a point in space brought down into the plane z = 0 along its helix
    private static unscrew( q : [number, number, number], w : number ) : ProfilePoint {
        const a = -w * q[2], c = Math.cos( a ), s = Math.sin( a );
        return [c * q[0] - s * q[1], s * q[0] + c * q[1]];
    }

    // A segment's offset section on a screw surface: exact for an arc round the axis (a surface of revolution's
    // offset; nothing when it shrinks to nothing), within tol otherwise.
    private static screwOffset( s : Seg, d : number, w : number, tol : number, size : number ) : Array<Seg> {
        if (s.kind == "arc" && Math.hypot( s.c[0], s.c[1] ) <= 1e-12 * Math.max( 1, size )) return ProfileOffset.offset( s, d, tol, 0 );
        if (s.kind == "arc" && s.r + (s.sweep > 0 ? d : -d) <= 0) return [];
        return ProfileOffset.fit( t => {
            const c = ProfileOffset.at( s, t ), n = ProfileOffset.screwNormal( c, ProfileOffset.tangent( s, t ), w );
            return ProfileOffset.unscrew( [c[0] + d * n[0], c[1] + d * n[1], d * n[2]], w );
        }, tol );
    }

    // The section of the pipe of radius |d| round the helix through the corner V, between the normals there of the
    // segments meeting at it (tangents tin and tout): the normal turned about the helix's tangent.
    private static pipe( V : ProfilePoint, tin : ProfilePoint, tout : ProfilePoint, d : number, w : number, tol : number ) : Array<Seg> {
        const T = [-w * V[1], w * V[0], 1], lt = Math.hypot( T[0], T[1], T[2] );
        T[0] /= lt; T[1] /= lt; T[2] /= lt;
        const n0 = ProfileOffset.screwNormal( V, tin, w ), n1 = ProfileOffset.screwNormal( V, tout, w );
        const b = [T[1] * n0[2] - T[2] * n0[1], T[2] * n0[0] - T[0] * n0[2], T[0] * n0[1] - T[1] * n0[0]];
        const phi = Math.atan2( b[0] * n1[0] + b[1] * n1[1] + b[2] * n1[2], n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] );
        return ProfileOffset.fit( t => {
            const c = Math.cos( phi * t ), s = Math.sin( phi * t );
            const n = [0, 1, 2].map( k => c * n0[k] + s * b[k] );
            return ProfileOffset.unscrew( [V[0] + d * n[0], V[1] + d * n[1], d * n[2]], w );
        }, tol );
    }

    // A smooth plane curve over [0, 1] by cubic Hermite pieces (tangents by central differences), halved until each
    // lies within tol of the curve at eight samples.
    private static fit( f : (t : number) => ProfilePoint, tol : number ) : Array<Seg> {
        const D = (t : number) : ProfilePoint => {
            const h = 1e-6, a = Math.max( 0, t - h ), b = Math.min( 1, t + h ), p = f( a ), q = f( b );
            return [(q[0] - p[0]) / (b - a), (q[1] - p[1]) / (b - a)];
        };
        const out : Array<Seg> = [];
        const go = (t0 : number, t1 : number, depth : number) => {
            const p0 = f( t0 ), p3 = f( t1 ), d0 = D( t0 ), d1 = D( t1 ), k = (t1 - t0) / 3;
            const c : Seg = { kind : "cubic", p : [p0, [p0[0] + k * d0[0], p0[1] + k * d0[1]], [p3[0] - k * d1[0], p3[1] - k * d1[1]], p3] };
            let err = 0;
            for (let j = 1; j < 8; j++) err = Math.max( err, ProfileOffset.distanceTo( c, f( t0 + (t1 - t0) * j / 8 ), j / 8 ) );
            if (err <= tol || depth >= 12) { out.push( c ); return; }
            const m = 0.5 * (t0 + t1);
            go( t0, m, depth + 1 ); go( m, t1, depth + 1 );
        };
        go( 0, 1, 0 );
        return out;
    }

    // d times the unit normal to the right of a segment at t
    private static normal( s : Seg, t : number, d : number ) : ProfilePoint {
        const v = ProfileOffset.tangent( s, t );
        return [v[1] * d, -v[0] * d];
    }

    // the distance from q to a segment, by Newton's method on the parameter from a start, then the segment's ends
    private static distanceTo( s : Seg, q : ProfilePoint, start : number ) : number {
        let t = start;
        for (let it = 0; it < 30; it++) {
            const p = ProfileOffset.at( s, t ), v = ProfileOffset.derivative( s, t );
            const h = 1e-6, v2 = ProfileOffset.derivative( s, Math.min( 1, t + h ) ), v1 = ProfileOffset.derivative( s, Math.max( 0, t - h ) );
            const acc = [(v2[0] - v1[0]) / (Math.min( 1, t + h ) - Math.max( 0, t - h )), (v2[1] - v1[1]) / (Math.min( 1, t + h ) - Math.max( 0, t - h ))];
            const w = [p[0] - q[0], p[1] - q[1]];
            const f = w[0] * v[0] + w[1] * v[1], fp = v[0] * v[0] + v[1] * v[1] + w[0] * acc[0] + w[1] * acc[1];
            if (fp == 0) break;
            const nt = Math.max( 0, Math.min( 1, t - f / fp ) );
            if (Math.abs( nt - t ) < 1e-14) { t = nt; break; }
            t = nt;
        }
        return Math.min( ProfileOffset.dist( ProfileOffset.at( s, t ), q ), ProfileOffset.dist( ProfileOffset.at( s, 0 ), q ), ProfileOffset.dist( ProfileOffset.at( s, 1 ), q ) );
    }

    // Where two segments cross near the end of a and the start of b: Newton's method on a(u) = b(w) from (1, 0), with
    // both parameters kept in [0, 1]; null when they do not meet there.
    private static meet( a : Seg, b : Seg ) : [number, number] | null {
        // seeds: the ends, then a scan of both segments' polylines for a crossing
        const seeds : Array<[number, number]> = [[1, 0]];
        const pa = Array.from( { length : 33 }, (_, k) => ProfileOffset.at( a, k / 32 ) ), pb = Array.from( { length : 33 }, (_, k) => ProfileOffset.at( b, k / 32 ) );
        for (let i = 0; i < 32; i++) for (let j = 0; j < 32; j++) {
            const x = ProfileOffset.segCross( pa[i], pa[i + 1], pb[j], pb[j + 1] );
            if (x != null) seeds.push( [(i + x[0]) / 32, (j + x[1]) / 32] );
        }
        for (const seed of seeds.reverse()) {
            let [u, w] = seed;
            for (let it = 0; it < 50; it++) {
                const A = ProfileOffset.at( a, u ), B = ProfileOffset.at( b, w ), da = ProfileOffset.derivative( a, u ), db = ProfileOffset.derivative( b, w );
                const F = [A[0] - B[0], A[1] - B[1]];
                const det = -da[0] * db[1] + da[1] * db[0];
                if (Math.abs( det ) < 1e-300) break;
                // J = [da, -db]
                const du = (-F[0] * -db[1] + F[1] * -db[0]) / det, dw = (-da[0] * F[1] + da[1] * F[0]) / det;
                u = u + du; w = w + dw;
                if (Math.hypot( du, dw ) < 1e-15) break;
            }
            const ok = u >= -1e-9 && u <= 1 + 1e-9 && w >= -1e-9 && w <= 1 + 1e-9;
            const A = ProfileOffset.at( a, u ), B = ProfileOffset.at( b, w );
            if (ok && ProfileOffset.dist( A, B ) < 1e-9 * (1 + Math.hypot( A[0], A[1] ))) return [Math.max( 0, Math.min( 1, u ) ), Math.max( 0, Math.min( 1, w ) )];
        }
        return null;
    }

    // ---- checks ----

    private static polyline( segs : Array<Seg> ) : Array<ProfilePoint> {
        const out : Array<ProfilePoint> = [];
        for (const s of segs) {
            const n = s.kind == "line" ? 1 : 16;
            for (let k = 0; k < n; k++) out.push( ProfileOffset.at( s, k / n ) );
        }
        return out;
    }

    // the parameters where segments pq and rs cross (strictly inside both), or null
    private static segCross( p : ProfilePoint, q : ProfilePoint, r : ProfilePoint, s : ProfilePoint ) : [number, number] | null {
        const d1 = [q[0] - p[0], q[1] - p[1]], d2 = [s[0] - r[0], s[1] - r[1]];
        const den = d1[0] * d2[1] - d1[1] * d2[0];
        if (den == 0) return null;
        const t = ((r[0] - p[0]) * d2[1] - (r[1] - p[1]) * d2[0]) / den, u = ((r[0] - p[0]) * d1[1] - (r[1] - p[1]) * d1[0]) / den;
        return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? [t, u] : null;
    }

    private static selfCrosses( poly : Array<ProfilePoint> ) : boolean {
        const n = poly.length;
        for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
            if (i == 0 && j == n - 1) continue;
            if (ProfileOffset.segCross( poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n] ) != null) return true;
        }
        return false;
    }

    private static crosses( a : Array<ProfilePoint>, b : Array<ProfilePoint> ) : boolean {
        for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++)
            if (ProfileOffset.segCross( a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length] ) != null) return true;
        return false;
    }

    // the signed area (positive counter-clockwise), by Green's theorem on each segment (Gauss points on cubics and
    // arcs: ∮ x dy is exact for a cubic with 4 points)
    private static area( segs : Array<Seg> ) : number {
        const g = [[-0.8611363115940526, 0.3478548451374538], [-0.3399810435848563, 0.6521451548625461], [0.3399810435848563, 0.6521451548625461], [0.8611363115940526, 0.3478548451374538]];
        let a = 0;
        for (const s of segs) {
            if (s.kind == "line") { a += 0.5 * (s.a[0] * s.b[1] - s.b[0] * s.a[1]); continue; }
            for (const [x, w] of g) {
                const t = 0.5 * (x + 1), p = ProfileOffset.at( s, t ), v = ProfileOffset.derivative( s, t );
                a += 0.5 * w * 0.5 * (p[0] * v[1] - p[1] * v[0]);
            }
        }
        return a;
    }

    private static size( segs : Array<Seg> ) : number {
        let m = 0;
        for (const s of segs) { const p = ProfileOffset.at( s, 0 ); m = Math.max( m, Math.abs( p[0] ), Math.abs( p[1] ) ); }
        return m;
    }

    private static dist( a : ProfilePoint, b : ProfilePoint ) : number {
        return Math.hypot( a[0] - b[0], a[1] - b[1] );
    }

    // back to a profile path: a full circle as a circle, else segments from the first one's start
    private static spec( segs : Array<Seg> ) : ProfilePath {
        if (segs.length == 1 && segs[0].kind == "arc" && Math.abs( Math.abs( segs[0].sweep ) - 2 * Math.PI ) < 1e-12) return { kind : "circle", center : segs[0].c, r : segs[0].r };
        const out : Array<ProfileSegmentSpec> = segs.map( s => {
            const to = ProfileOffset.at( s, 1 );
            if (s.kind == "line") return { type : "line", to : to };
            if (s.kind == "arc") return { type : "arc", via : ProfileOffset.at( s, 0.5 ), to : to };
            return { type : "cubic", c1 : s.p[1], c2 : s.p[2], to : to };
        } );
        return { kind : "path", start : ProfileOffset.at( segs[0], 0 ), segments : out };
    }
}
