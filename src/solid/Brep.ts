import { triangulate } from "../eval/Cdt.js";
import { NurbsCurveData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { Make } from "../eval/Make.js";
import { SurfaceDomain, SurfaceIntersect } from "./SurfaceIntersect.js";
import { TriMesh } from "./TriMesh.js";

// One face of a boundary representation: a NURBS surface over its whole parameter domain. Faces of a solid meet
// along their domain edges; a periodic direction closes on itself (the two edges of the seam are the same curve), and
// an edge may collapse to a point (a pole, as at the apex of a cap).
export interface BrepFace {
    surface : NurbsSurfaceData;
    // whether the face closes on itself in u and in v
    periodic : [boolean, boolean];
    // tessellation grid. Faces that share an edge must sample it the same way: the same number of divisions along it
    // and the same parameterisation, which is what the constructors below arrange.
    divs : [number, number];
    // true when the outward normal is -(dS/du x dS/dv); set by `BrepSolid.orient`
    reversed : boolean;
    name? : string;
    // a trimmed face (of a solid made from a shell, `ShellBuilder.solid`): the loops in its parameters that bound the
    // part of its surface it covers; the surface carries on past them
    trims? : Array<Array<UV>>;
    // one of the two halves of an extrusion's side round a path of one piece (a circle, #122): the two are named as
    // one face while neither is split
    half? : boolean;
}

// An edge between two trimmed faces of a solid: its points, shared by both faces, with their parameters on each.
export interface TrimEdge {
    faces : [number, number];
    points : Array<Point>;
    uvA : Array<UV>;
    uvB : Array<UV>;
    closed : boolean;
}

// A polyline in a face's parameter domain whose vertices carry their exact 3D points. Cut curves are shared by the
// two faces they separate: both faces use the same 3D points, so their tessellations meet without gaps.
export interface FaceCut {
    uv : Array<UV>;
    points : Array<Point>;
    closed : boolean;
    // which curve the cut comes from, to tell regions apart by the cuts around them
    tag? : number;
}

// The tessellation of one face, with the cut curves as constrained edges.
export interface FaceTessellation {
    // per local vertex: its parameters, its point and its id in the shared welder
    uv : Array<UV>;
    points : Array<Point>;
    ids : Array<number>;
    // triangles over local vertices, counter-clockwise in (u, v), so their normal is dS/du x dS/dv
    triangles : Array<Array<number>>;
    // the cut edges, as pairs of local vertices
    cutEdges : Array<[number, number]>;
    // the tag of each cut edge's curve (-1 when untagged)
    cutTags : Array<number>;
}

// Merges points closer than a tolerance into one vertex of a TriMesh, through a hash grid of cells of that size.
export class Welder {
    public mesh : TriMesh = new TriMesh();
    // cells of side tolerance, hashed to integers; a bucket can hold several cells, so each vertex keeps its cell
    // and only the vertices of the cell asked for are compared, in the order they were added
    private cells : Map<number, Array<number>> = new Map();
    private cellOf : Array<number> = [];
    constructor( public tolerance : number ) {}

    private static hash( x : number, y : number, z : number ) : number {
        return Math.imul( x | 0, 73856093 ) ^ Math.imul( y | 0, 19349663 ) ^ Math.imul( z | 0, 83492791 );
    }

    public id( p : Point ) : number {
        const t = this.tolerance, t2 = t * t, cell = this.cellOf, vs = this.mesh.vertices;
        const cx = Math.floor( p[0] / t ), cy = Math.floor( p[1] / t ), cz = Math.floor( p[2] / t );
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            const x = cx + dx, y = cy + dy, z = cz + dz;
            const l = this.cells.get( Welder.hash( x, y, z ) );
            if (l == null) continue;
            for (const i of l) {
                if (cell[3 * i] != x || cell[3 * i + 1] != y || cell[3 * i + 2] != z) continue;
                if (Vec.distSquared( vs[i], p ) <= t2) return i;
            }
        }
        const id = this.mesh.addVertex( p );
        cell.push( cx, cy, cz );
        const key = Welder.hash( cx, cy, cz );
        const l = this.cells.get( key );
        if (l == null) this.cells.set( key, [id] ); else l.push( id );
        return id;
    }
}

// A closed solid bounded by NURBS faces.
export class BrepSolid {

    // A solid of trimmed faces (`ShellBuilder.solid`) also has the edges between them, and its boundary as a mesh,
    // which stands for it when points are tested against it (its faces' surfaces carry on past their trims).
    public edges? : Array<TrimEdge>;
    public boundary? : TriMesh;

    constructor( public faces : Array<BrepFace> ) {}

    public static face( surface : NurbsSurfaceData, periodic : [boolean, boolean], divs : [number, number], name? : string ) : BrepFace {
        return { surface : surface, periodic : periodic, divs : divs, reversed : false, name : name };
    }

    // The ruled surface between two curves (u along the curves, v from the first to the second).
    public static ruled( c0 : NurbsCurveData, c1 : NurbsCurveData ) : NurbsSurfaceData {
        return Make.loftedSurface( [c0, c1], 1 );
    }

    // The cone from a point to a curve (u along the curve, v from the apex to the curve). A cap for a planar curve
    // that is star-shaped around the apex.
    public static cone( apex : Point, curve : NurbsCurveData ) : NurbsSurfaceData {
        const w = curve.controlPoints.map( p => p[p.length - 1] );
        const apexCurve = new NurbsCurveData( curve.degree, curve.knots.slice(), w.map( wi => apex.map( x => x * wi ).concat( [wi] ) ) );
        return Make.loftedSurface( [apexCurve, curve], 1 );
    }

    // The curve along a domain edge: u fixed at its start (or end), or v fixed.
    public static edge( s : NurbsSurfaceData, alongV : boolean, atEnd : boolean ) : NurbsCurveData {
        const d = SurfaceIntersect.domain( s );
        return alongV ? Make.surfaceIsocurve( s, atEnd ? d[1] : d[0], false ) : Make.surfaceIsocurve( s, atEnd ? d[3] : d[2], true );
    }

    // The centroid of a closed curve's samples
    public static curveCentroid( c : NurbsCurveData, samples : number = 64 ) : Point {
        const a = c.knots[0], b = c.knots[c.knots.length - 1];
        let s = [0, 0, 0];
        for (let i = 0; i < samples; i++) s = Vec.add( s, Eval.rationalCurvePoint( c, a + (b - a) * i / samples ) );
        return Vec.mul( 1 / samples, s );
    }

    // An axis-aligned box: six bilinear faces, named by the side they face ("-x", "+x", ...), each sharing its four
    // sides with its neighbours.
    public static box( min : Point, max : Point, divs : number = 8 ) : BrepSolid {
        const c = (i : number, j : number, k : number) : Point => [i ? max[0] : min[0], j ? max[1] : min[1], k ? max[2] : min[2]];
        const quad = (a : Point, b : Point, cc : Point, d : Point, name : string) => BrepSolid.face( Make.fourPointSurface( a, b, cc, d, 1 ), [false, false], [divs, divs], name );
        return new BrepSolid( [
            quad( c(0,0,0), c(0,1,0), c(0,1,1), c(0,0,1), "-x" ), quad( c(1,0,0), c(1,0,1), c(1,1,1), c(1,1,0), "+x" ),
            quad( c(0,0,0), c(0,0,1), c(1,0,1), c(1,0,0), "-y" ), quad( c(0,1,0), c(1,1,0), c(1,1,1), c(0,1,1), "+y" ),
            quad( c(0,0,0), c(1,0,0), c(1,1,0), c(0,1,0), "-z" ), quad( c(0,0,1), c(0,1,1), c(1,1,1), c(1,0,1), "+z" ),
        ] ).orient();
    }

    // A tube closed in v, with a flat cap at each end: the solid of a pipe or of any surface swept along an open rail.
    public static cappedTube( tube : NurbsSurfaceData, divs : [number, number] ) : BrepSolid {
        const c0 = BrepSolid.edge( tube, true, false ), c1 = BrepSolid.edge( tube, true, true );
        const capDivs : [number, number] = [divs[1], Math.max( 4, Math.round( divs[1] / 8 ) )];
        return new BrepSolid( [
            BrepSolid.face( tube, [false, true], divs, "tube" ),
            BrepSolid.face( BrepSolid.cone( BrepSolid.curveCentroid( c0 ), c0 ), [true, false], capDivs, "start cap" ),
            BrepSolid.face( BrepSolid.cone( BrepSolid.curveCentroid( c1 ), c1 ), [true, false], capDivs, "end cap" ),
        ] ).orient();
    }

    // The solid inside a round tube closed by hemispheres (#150, ask 4: a ball swept along its rail). The tube's ends
    // must be circles (a pipe's are: its section, an exact rational circle, moved by the rail's frame); each dome is the
    // end circle turned a quarter about its centre towards the pole, as a tensor product of the circle (exact, with its
    // own weights) and the rational quarter circle (weights 1, sqrt 2 / 2, 1), so it meets the tube along the very same
    // curve and is an exact hemisphere: centre + cos(v) (c(u) - centre) + sin(v) r axis.
    public static roundedTube( tube : NurbsSurfaceData, divs : [number, number] ) : BrepSolid {
        const d = SurfaceIntersect.domain( tube );
        const dome = (atEnd : boolean) : NurbsSurfaceData => {
            const c = BrepSolid.edge( tube, true, atEnd ), centre = BrepSolid.curveCentroid( c );
            // the circle's plane (Newell's normal of its samples), turned outwards: away from a section a little way in
            const a0 = c.knots[0], a1 = c.knots[c.knots.length - 1], ring : Array<Point> = [];
            for (let i = 0; i < 64; i++) ring.push( Vec.sub( Eval.rationalCurvePoint( c, a0 + (a1 - a0) * i / 64 ), centre ) );
            let axis = [0, 0, 0];
            ring.forEach( (p, i) => { axis = Vec.add( axis, Vec.cross( p, ring[(i + 1) % ring.length] ) ); } );
            axis = Vec.normalized( axis );
            const inner = BrepSolid.curveCentroid( Make.surfaceIsocurve( tube, atEnd ? d[1] - 1e-3 * (d[1] - d[0]) : d[0] + 1e-3 * (d[1] - d[0]), false ) );
            if (Vec.dot( axis, Vec.sub( centre, inner ) ) < 0) axis = Vec.mul( -1, axis );
            const r = Vec.dist( centre, Eval.rationalCurvePoint( c, c.knots[0] ) );
            const pole = Vec.add( centre, Vec.mul( r, axis ) ), h = Math.SQRT1_2;
            // rows along v from the pole (as `cone`, apex first) to the circle
            const cps = c.controlPoints.map( hp => {
                const w = hp[hp.length - 1], p = [hp[0] / w, hp[1] / w, hp[2] / w];
                const mid = Vec.add( p, Vec.mul( r, axis ) );
                return [pole.map( x => x * w ).concat( [w] ), mid.map( x => x * w * h ).concat( [w * h] ), hp.slice()];
            } );
            return new NurbsSurfaceData( c.degree, 2, c.knots.slice(), [0, 0, 0, 1, 1, 1], cps );
        };
        const capDivs : [number, number] = [divs[1], Math.max( 4, Math.round( divs[1] / 4 ) )];
        return new BrepSolid( [
            BrepSolid.face( tube, [false, true], divs, "tube" ),
            BrepSolid.face( dome( false ), [true, false], capDivs, "start cap" ),
            BrepSolid.face( dome( true ), [true, false], capDivs, "end cap" ),
        ] ).orient();
    }

    // The solid inside a wall that is closed in v (u from bottom to top), with a cap at the bottom and at the top.
    public static cappedWall( wall : NurbsSurfaceData, divs : [number, number] ) : BrepSolid {
        const s = BrepSolid.cappedTube( wall, divs );
        s.faces[0].name = "wall"; s.faces[1].name = "bottom"; s.faces[2].name = "top";
        return s;
    }

    // Set each face's `reversed` flag so its normal points out of the solid: step a little off the face along its
    // normal and test whether that point is inside.
    public orient() : BrepSolid {
        for (const f of this.faces) f.reversed = false;
        const mesh = this.tessellate();
        const bb = mesh.boundingBox();
        const eps = Vec.dist( bb.min, bb.max ) * 2e-4;
        for (const f of this.faces) {
            const t = FaceMesher.mesh( f, [], new Welder( eps * 1e-3 ) );
            // the largest triangle, away from the face's edges
            let best = -1, bestA = -1;
            t.triangles.forEach( (tri, k) => {
                const a = Vec.norm( Vec.cross( Vec.sub( t.points[tri[1]], t.points[tri[0]] ), Vec.sub( t.points[tri[2]], t.points[tri[0]] ) ) );
                if (a > bestA) { bestA = a; best = k; }
            } );
            const tri = t.triangles[best];
            const p = Vec.mul( 1 / 3, Vec.add( t.points[tri[0]], Vec.add( t.points[tri[1]], t.points[tri[2]] ) ) );
            const n = Vec.normalized( Vec.cross( Vec.sub( t.points[tri[1]], t.points[tri[0]] ), Vec.sub( t.points[tri[2]], t.points[tri[0]] ) ) );
            f.reversed = mesh.containsPoint( Vec.add( p, Vec.mul( eps, n ) ) );
        }
        return this;
    }

    // A watertight triangle mesh of the solid (outward facing once `orient` has run).
    public tessellate( welder? : Welder ) : TriMesh {
        if (this.boundary != null && welder == null) return this.boundary;
        if (welder == null) welder = new Welder( this.weldTolerance() );
        const out = new TriMesh();
        for (const f of this.faces) {
            const t = FaceMesher.mesh( f, [], welder );
            for (const tri of t.triangles) {
                const a = t.ids[tri[0]], b = t.ids[tri[1]], c = t.ids[tri[2]];
                if (f.reversed) out.addTriangle( a, c, b ); else out.addTriangle( a, b, c );
            }
        }
        out.vertices = welder.mesh.vertices;
        out.compact();
        return out;
    }

    public boundingBox() : { min : Point, max : Point } {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const f of this.faces) {
            const b = BrepSolid.faceBox( f );
            for (let k = 0; k < 3; k++) { min[k] = Math.min( min[k], b.min[k] ); max[k] = Math.max( max[k], b.max[k] ); }
        }
        return { min : min, max : max };
    }

    // A box that contains the face: the box of its control points (a NURBS surface lies in their convex hull).
    public static faceBox( f : BrepFace ) : { min : Point, max : Point } {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const row of f.surface.controlPoints) for (const hp of row) {
            const w = hp[hp.length - 1];
            for (let k = 0; k < 3; k++) { min[k] = Math.min( min[k], hp[k] / w ); max[k] = Math.max( max[k], hp[k] / w ); }
        }
        return { min : min, max : max };
    }

    public weldTolerance() : number {
        const b = this.boundingBox();
        return Vec.dist( b.min, b.max ) * 1e-7;
    }

    // Whether a point of a face's parameters lies inside its trims (by the parity of the trims it is inside).
    public static insideTrims( trims : Array<Array<UV>>, p : UV ) : boolean {
        let inside = false;
        for (const poly of trims) {
            const n = poly.length;
            for (let i = 0, j = n - 1; i < n; j = i++) {
                const a = poly[i], b = poly[j];
                if ((a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
            }
        }
        return inside;
    }

    public static domainOf( f : BrepFace ) : SurfaceDomain {
        return { surface : f.surface, periodic : f.periodic };
    }
}

// Tessellates a face, possibly cut by curves, with a constrained Delaunay triangulation of its parameter domain
// (cdt2d's sweep with the filtered flips of eval/Cdt, after Shewchuk's robust predicates). The domain is scaled to the
// face's mean edge lengths so the triangles are not stretched by the parameterisation. Grid points too close to a cut are left out.
export class FaceMesher {

    public static mesh( f : BrepFace, cuts : Array<FaceCut>, welder : Welder ) : FaceTessellation {
        const s = f.surface;
        const d = SurfaceIntersect.domain( s );
        const nu = f.divs[0], nv = f.divs[1];
        const L = FaceMesher.lengths( s, d );
        // cut points within rounding of a domain edge lie on it: a point a hair inside would leave a sliver triangle
        // between it and the edge, bridging the cut (across a seam, the regions on both sides would merge)
        const onEdge = (x : number, lo : number, hi : number) => Math.abs( x - lo ) < 1e-12 ? lo : Math.abs( x - hi ) < 1e-12 ? hi : x;
        cuts = cuts.map( c => ({ ...c, uv : c.uv.map( p => [onEdge( p[0], d[0], d[1] ), onEdge( p[1], d[2], d[3] )] as UV ) }) );
        // the ends of an open cut lie on the domain's edge (or on another cut): one refined to a hair inside it (a point
        // where three faces meet, found on each face to its own accuracy) is on it
        const nearEdge = (x : number, lo : number, hi : number) => Math.abs( x - lo ) < 1e-7 * (hi - lo) ? lo : Math.abs( x - hi ) < 1e-7 * (hi - lo) ? hi : x;
        cuts = cuts.map( c => c.closed || c.uv.length < 2 ? c : { ...c, uv : c.uv.map( (p, k) => k == 0 || k == c.uv.length - 1
            ? [nearEdge( p[0], d[0], d[1] ), nearEdge( p[1], d[2], d[3] )] as UV : p ) } );
        // a cut ending on a side that collapses to a point (a pole, the centre of a cap) could have any parameter along
        // that side; it takes its neighbour's, so that its last segment runs straight into the pole: a slanted one
        // leaves triangles on both sides of it that are the same, flat, triangle in space
        const collapsed = FaceMesher.collapsed( s, d );
        cuts = cuts.map( c => {
            if (c.closed || c.uv.length < 2) return c;
            const uv = c.uv.map( p => [p[0], p[1]] as UV );
            for (const [e, n] of [[0, 1], [uv.length - 1, uv.length - 2]]) for (let axis = 0; axis < 2; axis++) for (let sd = 0; sd < 2; sd++) {
                if (!collapsed[axis][sd] || uv[e][axis] != d[2 * axis + sd] || uv[n][axis] == uv[e][axis]) continue;
                uv[e][1 - axis] = uv[n][1 - axis];
            }
            return { ...c, uv : uv };
        } );
        const X = (uv : UV) : Array<number> => [(uv[0] - d[0]) / (d[1] - d[0]) * L[0], (uv[1] - d[2]) / (d[3] - d[2]) * L[1]];
        const hx = L[0] / nu, hy = L[1] / nv;

        const uv : Array<UV> = [], pts : Array<Point> = [];
        const keyOf = (p : UV) => Math.round( p[0] * 1e11 ) + ":" + Math.round( p[1] * 1e11 );
        const index : Map<string, number> = new Map();
        const add = (p : UV, x : Point | null) : number => {
            const k = keyOf( p );
            const i = index.get( k );
            if (i != null) return i;
            uv.push( p ); pts.push( x != null ? x : Eval.rationalSurfacePoint( s, p[0], p[1] ) );
            index.set( k, uv.length - 1 );
            return uv.length - 1;
        };

        // where cuts meet the domain edges: extra u values on the edges v = start (0) and v = end (1), extra v values
        // on the edges u = start and u = end. A cut end on a seam is added to both sides of the seam; on an ordinary
        // edge only to that edge, where the neighbouring face adds the same point from its own side of the cut.
        // A cut end inside the face must meet the end of another cut (a branch that continues on another face).
        const us = Array.from( { length : nu + 1 }, (_, i) => d[0] + (d[1] - d[0]) * i / nu );
        const vs = Array.from( { length : nv + 1 }, (_, j) => d[2] + (d[3] - d[2]) * j / nv );
        us[nu] = d[1]; vs[nv] = d[3]; // exactly on the edge, so points on it stay collinear
        const atU : [Array<number>, Array<number>] = [[], []], atV : [Array<number>, Array<number>] = [[], []];
        const endpoints : Map<string, Point> = new Map();
        for (const c of cuts) {
            if (c.closed) continue;
            for (const e of [0, c.uv.length - 1]) {
                const p = c.uv[e];
                const onU = Math.abs( p[0] - d[0] ) < 1e-12 || Math.abs( p[0] - d[1] ) < 1e-12;
                const onV = Math.abs( p[1] - d[2] ) < 1e-12 || Math.abs( p[1] - d[3] ) < 1e-12;
                if (onV) {
                    const sides = f.periodic[1] ? [0, 1] : [Math.abs( p[1] - d[3] ) < 1e-12 ? 1 : 0];
                    for (const sd of sides) { atU[sd].push( p[0] ); endpoints.set( keyOf( [p[0], d[2 + sd]] ), c.points[e] ); }
                } else if (onU) {
                    const sides = f.periodic[0] ? [0, 1] : [Math.abs( p[0] - d[1] ) < 1e-12 ? 1 : 0];
                    for (const sd of sides) { atV[sd].push( p[1] ); endpoints.set( keyOf( [d[sd], p[1]] ), c.points[e] ); }
                }
            }
        }
        // a cut lying along a domain side (where another face meets this one exactly at its edge): its points are the
        // side's vertices over its span, so that both faces have the same ones there; the grid nodes inside the span
        // are left out (see `covered`)
        const spans : Array<{ alongU : boolean, sd : number, lo : number, hi : number, at : Array<number> }> = [];
        for (const c of cuts) for (let sd = 0; sd < 2; sd++) for (const alongU of [true, false]) {
            const fixed = alongU ? 1 : 0, value = alongU ? d[2 + sd] : d[sd];
            if (c.uv.length < 2 || !c.uv.every( p => p[fixed] == value )) continue;
            if (alongU ? f.periodic[1] : f.periodic[0]) continue; // along a seam: inside the face
            const at = c.uv.map( p => p[1 - fixed] );
            spans.push( { alongU : alongU, sd : sd, lo : Math.min( ...at ), hi : Math.max( ...at ), at : at } );
            c.uv.forEach( (p, k) => { (alongU ? atU : atV)[sd].push( p[1 - fixed] ); endpoints.set( keyOf( p ), c.points[k] ); } );
        }
        const addB = (p : UV) => { const e = endpoints.get( keyOf( p ) ); return add( p, e != null ? e : null ); };
        // a boundary grid node strictly inside the span of a cut along its side, and not at one of the cut's points
        const covered = (i : number, j : number) : boolean => {
            if ((i == 0 || i == nu) && (j == 0 || j == nv)) return false; // the face's corners stay
            return spans.some( sp => {
                const onSide = sp.alongU ? j == (sp.sd == 0 ? 0 : nv) : i == (sp.sd == 0 ? 0 : nu);
                if (!onSide) return false;
                const x = sp.alongU ? us[i] : vs[j], w = sp.alongU ? d[1] - d[0] : d[3] - d[2];
                return x > sp.lo + 1e-7 * w && x < sp.hi - 1e-7 * w && !sp.at.some( y => Math.abs( y - x ) < 1e-7 * w );
            } );
        };

        // a boundary grid node that (almost) coincides with a cut end becomes that cut end
        const snapU = [0, 1].map( sd => us.map( u => { const e = atU[sd].find( x => Math.abs( x - u ) < (d[1] - d[0]) * 1e-7 ); return e != null ? e : u; } ) );
        const snapV = [0, 1].map( sd => vs.map( v => { const e = atV[sd].find( x => Math.abs( x - v ) < (d[3] - d[2]) * 1e-7 ); return e != null ? e : v; } ) );
        const nodes = new Int32Array( (nu + 1) * (nv + 1) ).fill( -1 );
        const node = (i : number, j : number) : number => {
            const k = i * (nv + 1) + j;
            if (nodes[k] < 0) {
                const onI = i == 0 || i == nu, onJ = j == 0 || j == nv;
                nodes[k] = addB( [onJ ? snapU[j == 0 ? 0 : 1][i] : us[i], onI ? snapV[i == 0 ? 0 : 1][j] : vs[j]] );
            }
            return nodes[k];
        };

        // the cuts, as constrained segments
        const cutEdges : Array<[number, number]> = [];
        const cutTags : Array<number> = [];
        const edges : Array<Array<number>> = [];
        const segs : Array<[Array<number>, Array<number>]> = [];
        for (const c of cuts) {
            const ids = c.uv.map( (p, k) => { const e = endpoints.get( keyOf( p ) ); return add( p, e != null ? e : c.points[k] ); } );
            const n = ids.length, m = c.closed ? n : n - 1;
            for (let k = 0; k < m; k++) {
                const a = ids[k], b = ids[(k + 1) % n];
                if (a == b) continue;
                edges.push( [a, b] ); cutEdges.push( [a, b] ); cutTags.push( c.tag != null ? c.tag : -1 );
                segs.push( [X( uv[a] ), X( uv[b] )] );
            }
        }

        // cells near a cut, or holding a cut end on their edge, are triangulated with the cuts (constrained Delaunay);
        // the rest of the grid is split into triangle pairs directly
        const r = 0.35 * Math.min( hx, hy );
        const blocked = new Uint8Array( nu * nv );
        const near = new Uint8Array( (nu + 1) * (nv + 1) );
        const clampI = (x : number) => Math.min( nu - 1, Math.max( 0, x ) ), clampJ = (x : number) => Math.min( nv - 1, Math.max( 0, x ) );
        for (const sg of segs) {
            const x0 = Math.min( sg[0][0], sg[1][0] ) - r, x1 = Math.max( sg[0][0], sg[1][0] ) + r;
            const y0 = Math.min( sg[0][1], sg[1][1] ) - r, y1 = Math.max( sg[0][1], sg[1][1] ) + r;
            for (let i = clampI( Math.floor( x0 / hx ) ); i <= clampI( Math.floor( x1 / hx ) ); i++)
                for (let j = clampJ( Math.floor( y0 / hy ) ); j <= clampJ( Math.floor( y1 / hy ) ); j++) blocked[i * nv + j] = 1;
            for (let i = Math.max( 0, Math.ceil( x0 / hx ) ); i <= Math.min( nu, Math.floor( x1 / hx ) ); i++)
                for (let j = Math.max( 0, Math.ceil( y0 / hy ) ); j <= Math.min( nv, Math.floor( y1 / hy ) ); j++)
                    if (FaceMesher.segDist( [i * hx, j * hy], sg[0], sg[1] ) < r) near[i * (nv + 1) + j] = 1;
        }
        const cellOf = (x : number, n : number) => [Math.floor( x * n - 1e-6 ), Math.floor( x * n + 1e-6 )];
        for (let sd = 0; sd < 2; sd++) {
            for (const u of atU[sd]) for (const i of cellOf( (u - d[0]) / (d[1] - d[0]), nu )) {
                if (i >= 0 && i < nu) blocked[i * nv + (sd == 0 ? 0 : nv - 1)] = 1;
            }
            for (const v of atV[sd]) for (const j of cellOf( (v - d[2]) / (d[3] - d[2]), nv )) {
                if (j >= 0 && j < nv) blocked[(sd == 0 ? 0 : nu - 1) * nv + j] = 1;
            }
        }

        if (spans.length > 0) for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) if (covered( i, j ))
            for (const [ci, cj] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]]) if (ci >= 0 && ci < nu && cj >= 0 && cj < nv) blocked[ci * nv + cj] = 1;
        const triangles : Array<Array<number>> = [];
        for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
            if (blocked[i * nv + j]) continue;
            const a = node( i, j ), b = node( i + 1, j ), c = node( i + 1, j + 1 ), e = node( i, j + 1 );
            if (Vec.distSquared( pts[a], pts[c] ) <= Vec.distSquared( pts[b], pts[e] )) { triangles.push( [a, b, c] ); triangles.push( [a, c, e] ); }
            else { triangles.push( [a, b, e] ); triangles.push( [b, c, e] ); }
        }

        if (segs.length > 0 || atU[0].length + atU[1].length + atV[0].length + atV[1].length > 0) {
            const isBlocked = (i : number, j : number) => i >= 0 && i < nu && j >= 0 && j < nv && blocked[i * nv + j] == 1;
            const inside = (i : number, j : number) => i >= 0 && i < nu && j >= 0 && j < nv;
            const used = new Set<number>();
            for (const e of edges) { used.add( e[0] ); used.add( e[1] ); }
            const constrain = (a : number, b : number) => { if (a != b) { edges.push( [a, b] ); used.add( a ); used.add( b ); } };
            // a boundary side of a cell, with the cut ends that lie on it
            // (a covered node is left out: the cut's own segment there stands for the side)
            const chain = (p : UV, q : UV, axis : number, extra : Array<number>, a : number, b : number, coverA : boolean, coverB : boolean) => {
                const lo = Math.min( p[axis], q[axis] ), hi = Math.max( p[axis], q[axis] );
                const mids = extra.filter( x => x > lo && x < hi ).sort( (x, y) => p[axis] < q[axis] ? x - y : y - x );
                let prev = coverA ? -1 : a;
                for (const x of mids) {
                    const m : UV = axis == 0 ? [x, p[1]] : [p[0], x];
                    const id = addB( m );
                    if (prev >= 0) constrain( prev, id );
                    prev = id;
                }
                if (prev >= 0 && !coverB) constrain( prev, b );
            };
            for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
                if (!blocked[i * nv + j]) continue;
                // keep the corners unless they are surrounded by blocked cells and too close to a cut
                for (const c of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]) {
                    const ci = c[0], cj = c[1];
                    const interior = ci > 0 && ci < nu && cj > 0 && cj < nv && isBlocked( ci - 1, cj - 1 ) && isBlocked( ci, cj - 1 ) && isBlocked( ci - 1, cj ) && isBlocked( ci, cj );
                    if (!(interior && near[ci * (nv + 1) + cj]) && !(spans.length > 0 && covered( ci, cj ))) used.add( node( ci, cj ) );
                }
                // sides facing kept cells or the domain edge are constrained
                const sides : Array<[number, number, number, number, number, number]> = [
                    [i, j, i + 1, j, i, j - 1], [i + 1, j, i + 1, j + 1, i + 1, j], [i + 1, j + 1, i, j + 1, i, j + 1], [i, j + 1, i, j, i - 1, j]];
                for (const sd of sides) {
                    const ni = sd[4], nj = sd[5];
                    if (isBlocked( ni, nj )) continue;
                    const a = node( sd[0], sd[1] ), b = node( sd[2], sd[3] );
                    if (inside( ni, nj )) constrain( a, b );
                    else {
                        const alongU = sd[1] == sd[3];
                        chain( uv[a], uv[b], alongU ? 0 : 1, alongU ? atU[sd[1] == 0 ? 0 : 1] : atV[sd[0] == 0 ? 0 : 1], a, b,
                               spans.length > 0 && covered( sd[0], sd[1] ), spans.length > 0 && covered( sd[2], sd[3] ) );
                    }
                }
            }
            const ids = Array.from( used );
            const local = new Map<number, number>();
            ids.forEach( (id, k) => local.set( id, k ) );
            const tris = triangulate( ids.map( id => X( uv[id] ) ), edges.map( e => [local.get( e[0] )!, local.get( e[1] )!] ), { exterior : true } );
            for (const t of tris) {
                const a = ids[t[0]], b = ids[t[1]], c = ids[t[2]];
                const pa = X( uv[a] ), pb = X( uv[b] ), pc = X( uv[c] );
                const ci = Math.floor( (pa[0] + pb[0] + pc[0]) / 3 / hx ), cj = Math.floor( (pa[1] + pb[1] + pc[1]) / 3 / hy );
                if (!isBlocked( clampI( ci ), clampJ( cj ) )) continue;
                const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
                // a flat triangle along three collinear grid nodes (a diagonal of the staircase between blocked and
                // kept cells) has its centroid on a node, where the cell test cannot tell which side it is on; it
                // covers nothing, and keeping it would use the nodes' edges a third time
                if (Math.abs( area ) <= 1e-9 * hx * hy) continue;
                triangles.push( area > 0 ? [a, b, c] : [a, c, b] );
            }
        }
        const ids = pts.map( p => welder.id( p ) );
        // next to a pole, two triangles of the parameter plane can be the same triangle in space, facing opposite ways
        // (a pole node on each side of a cut running into the pole): together they cover nothing, and are dropped
        const seen = new Map<string, number>(), drop = new Set<number>();
        triangles.forEach( (t, k) => {
            const w = t.map( i => ids[i] );
            if (w[0] == w[1] || w[1] == w[2] || w[2] == w[0]) return;
            const key = w.slice().sort( (x, y) => x - y ).join( ":" );
            const j = seen.get( key );
            if (j == null) { seen.set( key, k ); return; }
            const o = triangles[j].map( i => ids[i] );
            const same = [0, 1, 2].some( r => o[r] == w[0] && o[(r + 1) % 3] == w[1] );
            if (!same) { drop.add( j ); drop.add( k ); seen.delete( key ); }
        } );
        const kept = drop.size > 0 ? triangles.filter( (_, k) => !drop.has( k ) ) : triangles;
        return { uv : uv, points : pts, ids : ids, triangles : kept, cutEdges : cutEdges, cutTags : cutTags };
    }

    // [axis][side]: whether the side of the domain where that parameter is at its start (0) or end (1) is a single
    // point in space
    private static collapsed( s : NurbsSurfaceData, d : Array<number> ) : [[boolean, boolean], [boolean, boolean]] {
        const out : [[boolean, boolean], [boolean, boolean]] = [[false, false], [false, false]];
        let size = 0.0;
        const c0 = s.controlPoints[0][0], w0 = c0[3];
        for (const row of s.controlPoints) for (const h of row) size = Math.max( size, Vec.dist( [h[0] / h[3], h[1] / h[3], h[2] / h[3]], [c0[0] / w0, c0[1] / w0, c0[2] / w0] ) );
        for (let axis = 0; axis < 2; axis++) for (let sd = 0; sd < 2; sd++) {
            const at = (t : number) => {
                const x = d[2 * (1 - axis)] + (d[2 * (1 - axis) + 1] - d[2 * (1 - axis)]) * t, fixed = d[2 * axis + sd];
                return axis == 0 ? Eval.rationalSurfacePoint( s, fixed, x ) : Eval.rationalSurfacePoint( s, x, fixed );
            };
            const p0 = at( 0 );
            out[axis][sd] = [0.25, 0.5, 0.75, 1].every( t => Vec.dist( at( t ), p0 ) < 1e-12 * size );
        }
        return out;
    }

    // mean length of the u and v isocurves
    private static lengths( s : NurbsSurfaceData, d : Array<number> ) : [number, number] {
        const n = 24, m = 5;
        let lu = 0.0, lv = 0.0;
        for (let k = 0; k < m; k++) {
            const t = (k + 0.5) / m;
            let pu = Eval.rationalSurfacePoint( s, d[0], d[2] + (d[3] - d[2]) * t ), pv = Eval.rationalSurfacePoint( s, d[0] + (d[1] - d[0]) * t, d[2] );
            for (let i = 1; i <= n; i++) {
                const qu = Eval.rationalSurfacePoint( s, d[0] + (d[1] - d[0]) * i / n, d[2] + (d[3] - d[2]) * t );
                const qv = Eval.rationalSurfacePoint( s, d[0] + (d[1] - d[0]) * t, d[2] + (d[3] - d[2]) * i / n );
                lu += Vec.dist( pu, qu ); lv += Vec.dist( pv, qv );
                pu = qu; pv = qv;
            }
        }
        return [Math.max( lu / m, 1e-9 ), Math.max( lv / m, 1e-9 )];
    }

    private static segDist( p : Array<number>, a : Array<number>, b : Array<number> ) : number {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max( 0, Math.min( 1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 ) ) : 0;
        const ex = a[0] + t * dx - p[0], ey = a[1] + t * dy - p[1];
        return Math.sqrt( ex * ex + ey * ey );
    }
}
