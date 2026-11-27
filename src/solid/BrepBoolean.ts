import { Ribbon } from "../eval/Transfinite.js";
import { Point, UV } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { BrepFace, BrepSolid, FaceCut, FaceMesher, FaceTessellation, Welder } from "./Brep.js";
import { IntersectionCurve, SurfaceIntersect } from "./SurfaceIntersect.js";
import { IntersectionCertificate } from "./IntersectionCertificate.js";
import { MeshBVH } from "./MeshBVH.js";
import { BrepEdges, DomainSide, SolidEdge } from "./BrepEdges.js";
import { Fillet, FilletRadius, FilletResult, FilletShape, FilletSide } from "./Fillet.js";
import { FilletCorner, OpenBlend, ThirdEdge } from "./FilletCorner.js";
import { ManifoldReport, TriMesh } from "./TriMesh.js";

// A face of the result: a face of one of the operands, trimmed to the loops (in its parameter domain) that bound the
// part kept. Loops run counter-clockwise in (u, v) around kept material when `reversed` is false.
export interface TrimmedFace {
    solid : number;
    face : number;
    name : string;
    surface : BrepFace["surface"];
    reversed : boolean;
    loops : Array<Array<UV>>;
}

export interface BooleanOptions {
    // spacing of the intersection curve vertices (default: the smaller grid cell of the two faces)
    step? : number;
    // refinement tolerance of intersection points (default 1e-9)
    tolerance? : number;
    // rolling-ball fillet radius for the new edges: one radius for all, or per intersection curve (0: no fillet).
    // Edges are the runs of the branches between corners; only runs that are edges of the result are filleted. A run
    // that ends at corners is rounded where each corner joins it to one other rounded edge across a sharp one, to two
    // other rounded edges, or (running out onto a face) to two sharp ones.
    // The function may also return a function of the position along the edge (see `FilletRadius`): a variable-radius
    // fillet.
    // the shape of the fillets' cross-sections (default "circular"; see `FilletShape`)
    filletShape? : FilletShape;
    // corners where three rounded edges of one radius and kind meet: "auto" (default) gives a ball, unless the blends
    // are curvature-continuous, which get a G2 setback vertex blend; "ball" always gives a ball (a bent one for
    // curvature-continuous blends: G1 with them, and spherical in look)
    filletCorner? : "auto" | "ball";
    fillet? : number | ((curve : { solids : [number, number], faces : [number, number] }, index : number) => FilletRadius);
    // edges of the solids' own faces to round too (see `BrepEdges`): the solid, its two faces, and the radius. They take
    // the same fillet shape. Closed edges only for now (a cap's rim, a wall's top).
    edges? : Array<{ solid : number, faces : [number, number], radius : FilletRadius }>;
    // look for intersection loops too small for the search grids (see `SurfaceLoops`; default true)
    loops? : boolean;
    // prove each pair of faces' intersection complete, no branch or loop missed (`IntersectionCertificate`; default
    // false: it costs a fraction of a second per pair of faces that meet), into `report.certificate`
    certify? : boolean;
}

// A position in a transfinite patch's polygon.
export type XY = [number, number];

export interface BooleanResult {
    mesh : TriMesh;
    faces : Array<TrimmedFace>;
    // for each triangle of the mesh, the index of its face in `faces`
    faceOf : Array<number>;
    // for each triangle, the parameters of its three corners on its face's surface, blends and corner patches
    // included (null only where a corner patch could not be given them): what exact normals and curvature need
    cornerUV : Array<[UV, UV, UV] | null>;
    // for each triangle of a setback corner, the positions of its three corners in the corner's transfinite polygon
    // (null for other triangles): with the corner's `ribbons`, the exact patch there (`Transfinite.evaluate`)
    patchXY : Array<[XY, XY, XY] | null>;
    // the intersection branches, then any own edges rounded (`own` set: the domain sides they run along)
    // (`trim`: an edge of a solid made from a shell, between two of its trimmed faces)
    curves : Array<{ solids : [number, number], faces : [number, number], curve : IntersectionCurve, own? : [DomainSide, DomainSide], trim? : boolean }>;
    // the rolling-ball blends added, with the index of the edge each one rounds
    fillets : Array<{ curve : number, radius : FilletRadius, blend : FilletResult }>;
    // corners where three fillets meet, and the corner's face in `faces`: a ball where their radii are equal (its
    // centre and radius), a setback vertex blend otherwise (the mean of the end sections' centres, the largest radius)
    // (`faces`: all the corner's faces, one for a ball, six four-sided ones for a setback; `face`: the first)
    // (`ribbons`: a setback corner's exact patch, for `Transfinite.evaluate`)
    corners : Array<{ kind : "ball" | "setback", centre : Point, radius : number, face : number, faces : Array<number>, ribbons? : Array<Ribbon> }>;
    report : {
        manifold : ManifoldReport;
        volume : number;
        intersectionCurves : number;
        // branches along which two faces touch without crossing (tangent): the result is not a manifold there
        tangentContacts : number;
        // the largest distance between the two surfaces at the vertices of the intersection curves
        maxCurveError : number;
        // edges rounded; edges that asked for a fillet the ball could not roll along (too large a radius); and edges
        // left sharp because a corner they end at is not one `FilletCorner` builds (or a neighbour's corner failed)
        fillets : number;
        filletsFailed : number;
        filletsSkipped : number;
        // closed fillets made smaller than asked, so that their edges on a face they share keep clear of each other
        filletsReduced : number;
        // pairs of faces (of different operands) whose boxes meet: those intersected, and those skipped because no
        // point where they meet can be on the result's boundary (`BrepBoolean.activeBoxes`)
        facePairs : { intersected : number, skipped : number };
        // with `certify`: the pairs of faces intersected, how many of them are proven complete, and the others
        // (their pairs of cells left undecided, where the faces may be tangent or a loop may hide, and the starts of
        // branches found on no curve)
        certificate? : { pairs : number, proven : number,
                         unproven : Array<{ solids : [number, number], faces : [number, number], unresolved : number, missed : number }> };
    };
}

// Booleans on solids bounded by NURBS faces.
//
// The algorithm is CSG boundary evaluation (Requicha and Voelcker, "Boolean operations in solid modeling: boundary
// evaluation and merging algorithms", Proc. IEEE 73(1), 1985), with the surface/surface intersection of
// `SurfaceIntersect`:
//
// 1. intersect every pair of faces of different solids; each branch is a closed polyline with its parameters on both
//    faces (the "pcurves" of Patrikalakis and Maekawa), split where it crosses a periodic seam
// 2. tessellate every face with its cut curves as constrained edges; both faces of a cut use the same 3D vertices
// 3. group the triangles of each face into regions (connected without crossing a cut)
// 4. classify each region as inside or outside every other solid (ray parity against that solid's tessellation)
// 5. evaluate the CSG expression with the region's own solid taken as inside and as outside: if both give the same
//    answer the region is not on the result's boundary and is dropped; otherwise it is kept, facing the side where
//    the expression is false
//
// Step 5 handles any expression over any number of solids, so `union`, `intersection` and `difference` are one-line
// wrappers. Current limits: intersection branches must be closed loops (two faces of a solid may not both be cut by
// the same branch), branches of one face must not cross each other, and faces must not touch tangentially.

export class BrepBoolean {

    // Closed blends whose contact curves on a shared face come within a tenth of the smaller radius of each other
    // (or cross) are rebuilt at 0.8 times their radius, up to six times; a pair that still cannot keep clear is left
    // sharp. Returns how many blends were made smaller, and how many dropped.
    private static keepBlendsApart( runs : Array<{ ci : number, curve : IntersectionCurve, sides : [FilletSide, FilletSide] | null, radius : FilletRadius }>,
                                    curves : BooleanResult["curves"], blends : Map<number, FilletResult>, tol : number,
                                    shape? : FilletShape ) : { count : number, dropped : number } {
        const size = (r : FilletRadius) => typeof r == "number" ? r : Math.min( ...Array.from( { length : 17 }, (_, k) => r( k / 16 ) ) );
        const scaled = (r : FilletRadius, f : number) : FilletRadius => typeof r == "number" ? r * f : (t : number) => r( t ) * f;
        const onFace = (g : number) => {
            const e = curves[runs[g].ci], b = blends.get( g )!;
            return [{ key : e.solids[0] + ":" + e.faces[0], cuts : b.cutA }, { key : e.solids[1] + ":" + e.faces[1], cuts : b.cutB }];
        };
        // whether two sets of cuts come within d of each other, segment against segment
        const near = (a : Array<FaceCut>, b : Array<FaceCut>, d : number) => {
            const segs = (c : FaceCut) => { const n = c.points.length, m = c.closed ? n : n - 1; return Array.from( { length : m }, (_, k) => [c.points[k], c.points[(k + 1) % n]] ); };
            const A = a.flatMap( segs ), B = b.flatMap( segs );
            for (const [p0, p1] of A) for (const [q0, q1] of B) {
                if (Math.min( p0[0], p1[0] ) > Math.max( q0[0], q1[0] ) + d || Math.min( q0[0], q1[0] ) > Math.max( p0[0], p1[0] ) + d) continue;
                if (Math.min( p0[1], p1[1] ) > Math.max( q0[1], q1[1] ) + d || Math.min( q0[1], q1[1] ) > Math.max( p0[1], p1[1] ) + d) continue;
                if (Math.min( p0[2], p1[2] ) > Math.max( q0[2], q1[2] ) + d || Math.min( q0[2], q1[2] ) > Math.max( p0[2], p1[2] ) + d) continue;
                if (BrepBoolean.segmentsDistance( p0, p1, q0, q1 ) < d) return true;
            }
            return false;
        };
        const reducedSet = new Set<number>();
        let dropped = 0;
        for (let round = 0; round < 6; round++) {
            const gs = Array.from( blends.keys() );
            const clash = new Set<number>();
            for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
                const gap = 0.1 * Math.min( size( runs[gs[i]].radius ), size( runs[gs[j]].radius ) );
                const fi = onFace( gs[i] ), fj = onFace( gs[j] );
                if (fi.some( a => fj.some( b => a.key == b.key && near( a.cuts, b.cuts, gap ) ) )) { clash.add( gs[i] ); clash.add( gs[j] ); }
            }
            if (clash.size == 0) break;
            for (const g of clash) {
                const r = runs[g];
                if (round == 5) { blends.delete( g ); dropped++; continue; }
                r.radius = scaled( r.radius, 0.8 );
                const fr = Fillet.rollingBall( r.sides![0], r.sides![1], r.curve, r.radius, tol, shape );
                if (fr == null) { blends.delete( g ); dropped++; } else { blends.set( g, fr ); reducedSet.add( g ); }
            }
        }
        for (const g of reducedSet) if (!blends.has( g )) reducedSet.delete( g );
        return { count : reducedSet.size, dropped : dropped };
    }

    // The distance between segments p0p1 and q0q1 (closest points, clamped to both segments).
    private static segmentsDistance( p0 : Point, p1 : Point, q0 : Point, q1 : Point ) : number {
        const u = Vec.sub( p1, p0 ), v = Vec.sub( q1, q0 ), w = Vec.sub( p0, q0 );
        const a = Vec.dot( u, u ), b = Vec.dot( u, v ), c = Vec.dot( v, v ), d = Vec.dot( u, w ), e = Vec.dot( v, w );
        const den = a * c - b * b;
        let sN = den > 1e-24 ? (b * e - c * d) / den : 0;
        sN = Math.min( 1, Math.max( 0, sN ) );
        let t = c > 1e-24 ? (b * sN + e) / c : 0;
        if (t < 0 || t > 1) { t = Math.min( 1, Math.max( 0, t ) ); sN = a > 1e-24 ? Math.min( 1, Math.max( 0, (b * t - d) / a ) ) : 0; }
        return Vec.norm( Vec.sub( Vec.add( p0, Vec.mul( sN, u ) ), Vec.add( q0, Vec.mul( t, v ) ) ) );
    }

    public static union( solids : Array<BrepSolid>, options? : BooleanOptions ) : BooleanResult {
        return BrepBoolean.evaluate( solids, f => f.some( x => x ), options );
    }

    public static intersection( solids : Array<BrepSolid>, options? : BooleanOptions ) : BooleanResult {
        return BrepBoolean.evaluate( solids, f => f.every( x => x ), options );
    }

    // the first solid minus all the others
    public static difference( a : BrepSolid, tools : Array<BrepSolid>, options? : BooleanOptions ) : BooleanResult {
        return BrepBoolean.evaluate( [a].concat( tools ), f => f[0] && !f.slice( 1 ).some( x => x ), options );
    }

    // Evaluate any Boolean expression of the solids: `expr(inside)` says whether a point that is inside the solids
    // flagged in `inside` is in the result.
    public static evaluate( solids : Array<BrepSolid>, expr : (inside : Array<boolean>) => boolean, options? : BooleanOptions ) : BooleanResult {
        const o = options != null ? options : {};
        const tol = o.tolerance != null ? o.tolerance : 1e-9;
        const weldTol = Math.max( ...solids.map( s => s.weldTolerance() ) );
        const meshes = solids.map( s => new MeshBVH( s.tessellate() ) );

        // 1. intersections
        const cuts : Array<Array<Array<FaceCut>>> = solids.map( s => s.faces.map( _ => [] as Array<FaceCut> ) );
        const curves : BooleanResult["curves"] = [];
        let maxErr = 0.0;
        let tangentContacts = 0;
        const certificate = o.certify ? { pairs : 0, proven : 0, unproven : [] as NonNullable<BooleanResult["report"]["certificate"]>["unproven"] } : undefined;
        const active = BrepBoolean.activeBoxes( solids, meshes, expr );
        const facePairs = { intersected : 0, skipped : 0 };
        const paired : Array<[number, number, number, number]> = [];
        for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
            solids[i].faces.forEach( (fa, ia) => solids[j].faces.forEach( (fb, ib) => {
                if (!BrepBoolean.boxesOverlap( BrepSolid.faceBox( fa ), BrepSolid.faceBox( fb ) )) return;
                if (active != null && !BrepBoolean.boxesOverlap( active[i][ia], active[j][ib] )) { facePairs.skipped++; return; }
                facePairs.intersected++;
                paired.push( [i, ia, j, ib] );
                const step = o.step != null ? o.step : Math.min( BrepBoolean.cell( fa ), BrepBoolean.cell( fb ) );
                const res = SurfaceIntersect.analyze( BrepSolid.domainOf( fa ), BrepSolid.domainOf( fb ), {
                    divsA : BrepBoolean.searchDivs( fa ), divsB : BrepBoolean.searchDivs( fb ), step : step, tolerance : tol, loops : o.loops } );
                tangentContacts += res.tangent.length;
                const found = res.curves;
                if (certificate != null) {
                    const c = IntersectionCertificate.check( BrepSolid.domainOf( fa ), BrepSolid.domainOf( fb ), found );
                    certificate.pairs++;
                    if (c.proven) certificate.proven++;
                    else certificate.unproven.push( { solids : [i, j], faces : [ia, ib], unresolved : c.unresolved, missed : c.missed.length } );
                }
                for (const c of BrepBoolean.dropRetraces( found, 0.02 * step ))
                    curves.push( { solids : [i, j], faces : [ia, ib], curve : BrepBoolean.cleanSeams( c, fa, fb ) } );
            } ) );
        }

        // a solid made from a shell brings the edges between its trimmed faces: curves like the branches, whose
        // crossings with the branches are the points where a branch leaves a face for its neighbour
        solids.forEach( (solid, si) => { if (solid.edges != null) for (const e of solid.edges) {
            const copy = (x : Array<UV>) => x.map( p => [p[0], p[1]] as UV );
            curves.push( { solids : [si, si], faces : [e.faces[0], e.faces[1]], trim : true, curve : { points : e.points.slice(), uvA : copy( e.uvA ), uvB : copy( e.uvB ),
                           seamA : e.points.map( _ => 0 ), seamB : e.points.map( _ => 0 ), closed : e.closed } } );
        } } );
        // the part of a face a trimmed face covers: a branch keeps only its runs inside the trims of both its faces
        const inTrims = (si : number, fi : number, uv : UV) => { const F = solids[si].faces[fi]; return F.trims == null || BrepSolid.insideTrims( F.trims, uv ); };
        // a run along a trim of its face, all its points on it (a branch along an edge of the face, where a layer
        // stacked on another's cap meets the cap at the edge between its side and its bottom) cuts the other face all
        // the same (#104); a run of two points between crossings of one straight trim does not count
        const alongTrim = (si : number, fi : number, uvs : Array<UV>) => {
            const F = solids[si].faces[fi];
            if (F.trims == null || uvs.length < 3) return false;
            const d = SurfaceIntersect.domain( F.surface ), eps = 1e-9 * Math.max( d[1] - d[0], d[3] - d[2] );
            return uvs.every( uv => F.trims!.some( poly => poly.some( (a, i) => BrepBoolean.segDist( uv, a, poly[(i + 1) % poly.length] ) < eps ) ) );
        };

        // where branches cross inside a face, three faces meet at one point: find it exactly and put it in every
        // branch through it, so the faces share it
        BrepBoolean.insertTriplePoints( solids, curves, tol, weldTol * 50 );

        // branches that cross an edge between two faces of a solid end there, on each side, at points computed
        // separately: give the ends that meet one shared point
        const ends : Array<{ c : IntersectionCurve, k : number }> = [];
        for (const e of curves) if (!e.curve.closed) { ends.push( { c : e.curve, k : 0 } ); ends.push( { c : e.curve, k : e.curve.points.length - 1 } ); }
        const snap = weldTol * 50;
        // (each end in turn takes the later ends within snap of it; a grid of cells snap wide, kept up to date as ends
        // move, finds them, in the same order as comparing every pair)
        const cell = (p : Point) => Math.floor( p[0] / snap ) + "," + Math.floor( p[1] / snap ) + "," + Math.floor( p[2] / snap );
        const grid = new Map<string, Set<number>>();
        const put = (y : number) => { const key = cell( ends[y].c.points[ends[y].k] ); let set = grid.get( key ); if (set == null) grid.set( key, set = new Set() ); set.add( y ); };
        ends.forEach( (_, y) => put( y ) );
        for (let x = 0; x < ends.length; x++) {
            const p = ends[x].c.points[ends[x].k];
            const i = Math.floor( p[0] / snap ), j = Math.floor( p[1] / snap ), l = Math.floor( p[2] / snap );
            const near : Array<number> = [];
            for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
                const set = grid.get( (i + a) + "," + (j + b) + "," + (l + c) );
                if (set != null) for (const y of set) if (y > x) near.push( y );
            }
            near.sort( (u, v) => u - v );
            for (const y of near) {
                const q = ends[y].c.points[ends[y].k];
                if (p !== q && Vec.dist( p, q ) < snap) {
                    grid.get( cell( q ) )!.delete( y );
                    ends[y].c.points[ends[y].k] = p;
                    put( y );
                }
            }
        }

        // where four faces meet (a layer's edge crossing the rim of the cap it stands on), a branch can end at a point
        // that the others' crossing put into two branches already, found separately: it ends there exactly (#104)
        {
            const count = new Map<Point, number>();
            for (const e of curves) for (const p of e.curve.points) count.set( p, (count.get( p ) || 0) + 1 );
            const corners = Array.from( count.keys() ).filter( p => (count.get( p ) as number) > 1 );
            for (const e of curves) if (!e.curve.closed) for (const k of [0, e.curve.points.length - 1]) {
                const p = e.curve.points[k];
                if ((count.get( p ) as number) > 1) continue;
                let best : Point | null = null, bd = snap;
                for (const q of corners) { const d = Vec.dist( p, q ); if (d < bd) { bd = d; best = q; } }
                if (best != null) e.curve.points[k] = best;
            }
        }
        // a branch that runs along an edge of a solid made from a shell (a layer stacked on another's cap: the branch
        // of the cap and the layer's side lies on the layer's bottom edge) takes that edge's points, so that the face
        // across the branch and the edge's faces share them (#104)
        BrepBoolean.edgeContacts( solids, curves, snap );
        BrepBoolean.trimVertices( solids, curves, snap );
        BrepBoolean.alongEdges( solids, curves, snap );
        BrepBoolean.sharedStretches( solids, curves, snap );

        // the edges of the result: runs of each branch between corners, the points where it meets another branch
        const owners = new Map<Point, Set<number>>();
        curves.forEach( (e, ci) => { for (const p of e.curve.points) {
            let set = owners.get( p );
            if (set == null) owners.set( p, set = new Set<number>() );
            set.add( ci );
        } } );
        const isCorner = (p : Point) => (owners.get( p ) as Set<number>).size > 1;
        type Run = { ci : number, curve : IntersectionCurve, sides : [FilletSide, FilletSide] | null, radius : FilletRadius, own? : boolean };
        const runs : Array<Run> = [];
        curves.forEach( (e, ci) => {
            const c = e.curve, n = c.points.length;
            const take = (idx : Array<number>, closed : boolean) => {
                const run : IntersectionCurve = { points : idx.map( k => c.points[k] ), uvA : idx.map( k => c.uvA[k] ), uvB : idx.map( k => c.uvB[k] ),
                                                seamA : idx.map( k => c.seamA[k] ), seamB : idx.map( k => c.seamB[k] ), closed : closed };
                let mid = run.points[run.points.length >> 1];
                if (!closed && run.points.length == 2) mid = Vec.lerp( 0.5, run.points[0], run.points[1] );
                if (!e.trim) {
                    const m = run.points.length >> 1;
                    const uvA = closed || run.points.length > 2 ? run.uvA[m] : Vec.lerp( 0.5, run.uvA[0], run.uvA[1] ) as UV;
                    const uvB = closed || run.points.length > 2 ? run.uvB[m] : Vec.lerp( 0.5, run.uvB[0], run.uvB[1] ) as UV;
                    if (!(inTrims( e.solids[0], e.faces[0], uvA ) || alongTrim( e.solids[0], e.faces[0], run.uvA ))
                        || !(inTrims( e.solids[1], e.faces[1], uvB ) || alongTrim( e.solids[1], e.faces[1], run.uvB ))) return;
                }
                runs.push( { ci : ci, curve : run, sides : e.trim ? null : BrepBoolean.sides( solids, meshes, expr, e, mid ), radius : 0 } );
            };
            const ks = c.points.map( (_, k) => k ).filter( k => isCorner( c.points[k] ) );
            if (c.closed && ks.length == 0) { take( c.points.map( (_, k) => k ), true ); return; }
            if (c.closed) {
                for (let x = 0; x < ks.length; x++) {
                    const idx : Array<number> = [];
                    for (let k = ks[x]; ; k = (k + 1) % n) { idx.push( k ); if (k == ks[(x + 1) % ks.length] && idx.length > 1) break; }
                    take( idx, false );
                }
                return;
            }
            const at = [0].concat( ks.filter( k => k > 0 && k < n - 1 ), [n - 1] );
            for (let x = 0; x + 1 < at.length; x++) take( Array.from( { length : at[x + 1] - at[x] + 1 }, (_, k) => at[x] + k ), false );
        } );

        // the solids' own edges to round: runs that are not cut into their faces (they lie on the faces' sides)
        let ownFailed = 0;
        const vertices : Array<Point> = [];
        // the ends of the Boolean's branches, where they may cross an own edge
        const branchEnds : Array<Point> = [];
        for (const c of curves) if (!c.curve.closed) for (const p of [c.curve.points[0], c.curve.points[c.curve.points.length - 1]]) if (!branchEnds.includes( p )) branchEnds.push( p );
        for (const x of o.edges || []) {
            const solid = solids[x.solid];
            const e = BrepEdges.between( solid, x.faces[0], x.faces[1] );
            if (e == null) { ownFailed++; continue; }
            // an open edge ends at vertices of the solid, shared with the other edges there
            if (!e.curve.closed) {
                const pts = e.curve.points;
                for (const k of [0, pts.length - 1]) {
                    const same = vertices.find( v => Vec.dist( v, pts[k] ) < snap );
                    if (same != null) pts[k] = same; else vertices.push( pts[k] );
                }
            }
            // where branches of the Boolean end on the edge, it is split: each piece is an edge of the result or not
            for (const piece of BrepBoolean.splitAt( e.curve, branchEnds, snap )) {
                // an edge of the result where the other solids leave its solid's boundary there
                let mid = piece.points[piece.points.length >> 1];
                if (!piece.closed && piece.points.length == 2) mid = Vec.lerp( 0.5, piece.points[0], piece.points[1] );
                const flags = solids.map( (_, k) => k == x.solid ? false : meshes[k].contains( mid ) );
                const fin = expr( flags.map( (f, k) => k == x.solid ? true : f ) ), fout = expr( flags );
                if (fin == fout) continue;
                const pe : SolidEdge = { faces : e.faces, sides : e.sides, curve : piece };
                curves.push( { solids : [x.solid, x.solid], faces : x.faces, curve : piece, own : e.sides } );
                // a solid the result keeps the outside of (taken away): its faces face the other way, and the edge
                // is concave, so each face's kept part lies outside the other's solid where it was inside
                let sides = BrepEdges.filletSides( solid, pe, piece.points.length >> 1 );
                if (!fin) sides = sides.map( sd => ({ face : sd.face, sign : -sd.sign, keptInsideOther : sd.keptInsideOther }) ) as [FilletSide, FilletSide];
                runs.push( { ci : curves.length - 1, curve : piece, sides : sides, radius : x.radius, own : true } );
            }
        }

        // rolling-ball fillets: the contact curves are extra cuts (tagged runs.length + the run's index); the strip of
        // each face between the edge and its contact curve is dropped, and the blend takes its place. A blend along an
        // open edge ends at corners, where it meets another blend along a mitre (`FilletCorner`).
        const blends : Array<FilletResult> = [];
        const filletInfo : BooleanResult["fillets"] = [];
        let failed = ownFailed, skipped = 0;
        const closedBlends = new Map<number, FilletResult>();
        const openBlends = new Map<number, OpenBlend>();
        runs.forEach( (r, g) => {
            if (r.sides == null) return;
            const e = curves[r.ci];
            if (!r.own) {
                if (o.fillet == null) return;
                r.radius = typeof o.fillet == "number" ? o.fillet : o.fillet( { solids : e.solids, faces : e.faces }, r.ci );
            }
            // a variable radius must stay positive along the edge
            const rad = r.radius;
            const positive = typeof rad == "number" ? rad > 0 : Array.from( { length : 33 }, (_, k) => k / 32 ).every( t => (rad as (t : number) => number)( t ) > 0 );
            if (!positive) return;
            const A = r.sides[0], B = r.sides[1];
            if (r.curve.closed) {
                const fr = Fillet.rollingBall( A, B, r.curve, r.radius, tol, o.filletShape );
                if (fr == null) failed++; else closedBlends.set( g, fr );
                return;
            }
            const sec = Fillet.sections( A, B, r.curve, r.radius, tol );
            if (sec == null) { failed++; return; }
            openBlends.set( g, FilletCorner.open( A, B, sec, o.filletShape ) );
        } );
        // closed blends on the same face must keep clear of each other: two contact curves that cross (handle joints
        // close together, holes close together) would cut the face into pieces that belong to neither. Where two come
        // within a tenth of the smaller radius, both are rebuilt smaller, in steps, until they keep clear; a blend
        // that still cannot is left sharp (counted as failed)
        const reduced = BrepBoolean.keepBlendsApart( runs, curves, closedBlends, tol, o.filletShape );
        failed += reduced.dropped;
        // corners: the ends of the runs that are edges of the result
        const key = (s : number, f : number) => s + ":" + f;
        const faceKeys = (g : number) => { const e = curves[runs[g].ci]; return [key( e.solids[0], e.faces[0] ), key( e.solids[1], e.faces[1] )]; };
        const corners = new Map<Point, Array<{ g : number, end : number }>>();
        runs.forEach( (r, g) => {
            if (r.sides == null || r.curve.closed) return;
            const pts = r.curve.points;
            for (let end = 0; end < 2; end++) {
                const p = pts[end == 0 ? 0 : pts.length - 1];
                let l = corners.get( p );
                if (l == null) corners.set( p, l = [] );
                l.push( { g : g, end : end } );
            }
        } );
        const unsupported = new Set<number>();
        const inserts : Array<{ g : [number, number], insert : () => void }> = [];
        const balls : Array<{ g : Array<number>, patch : NonNullable<ReturnType<typeof FilletCorner.ball>> }> = [];
        const partners = new Map<number, Array<number>>();
        // blends that run out onto a third face: its cut along their end section, and its corner there
        const runouts : Array<{ g : number, solid : number, face : number, uv : Array<UV>, points : Array<Point>, P : Point }> = [];
        for (const [P, at] of corners) {
            const filleted = at.filter( x => openBlends.has( x.g ) );
            if (filleted.length == 0) continue;
            const others = at.filter( x => !openBlends.has( x.g ) );
            let ok = false;
            if (filleted.length == 2 && others.length <= 1 && filleted[0].g != filleted[1].g) {
                const x1 = filleted[0], x2 = filleted[1];
                const k1 = faceKeys( x1.g ), k2 = faceKeys( x2.g );
                const common = k1.filter( k => k2.includes( k ) );
                if (common.length == 1) {
                    const b1 = k1.indexOf( common[0] ), b2 = k2.indexOf( common[0] );
                    const a1k = k1[1 - b1], a2k = k2[1 - b2];
                    const face = (k : string) => { const q = k.split( ":" ).map( Number ); return solids[q[0]].faces[q[1]]; };
                    const F1 = openBlends.get( x1.g ) as OpenBlend, F2 = openBlends.get( x2.g ) as OpenBlend;
                    let third : ThirdEdge | null = null;
                    if (others.length == 1) {
                        const t = runs[others[0].g], tk = faceKeys( others[0].g );
                        if (tk.includes( a1k ) && tk.includes( a2k ) && a1k != a2k)
                            third = { kind : "curve", curve : t.curve, a1IsA : tk[0] == a1k, a1 : face( a1k ), a2 : face( a2k ), atStart : others[0].end == 0 };
                    } else if (a1k.split( ":" )[0] == a2k.split( ":" )[0]) {
                        // an edge between two faces of one solid: the side of each face's domain that P lies on (at
                        // a corner of the domain, as at a box's vertex, the side other than the one the blend's own
                        // edge runs along, #93)
                        const sideOf = (x : { g : number, end : number }, bSide : number) => {
                            const c = runs[x.g].curve, k = x.end == 0 ? 0 : c.points.length - 1;
                            const F = bSide == 0 ? runs[x.g].sides![1].face : runs[x.g].sides![0].face;
                            const uvs = bSide == 0 ? c.uvB : c.uvA, uv = uvs[k], mid = uvs[Math.floor( (uvs.length - 1) / 2 )];
                            const d = SurfaceIntersect.domain( F.surface );
                            for (let ax = 0; ax < 2; ax++) {
                                if (F.periodic[ax]) continue;
                                const span = d[2 * ax + 1] - d[2 * ax];
                                for (const v of [d[2 * ax], d[2 * ax + 1]]) {
                                    if (Math.abs( uv[ax] - v ) >= 1e-9 * span) continue;
                                    if (uvs.length > 2 && Math.abs( mid[ax] - v ) < 1e-9 * span) continue;
                                    return { axis : ax, value : v };
                                }
                            }
                            return null;
                        };
                        const s1 = sideOf( x1, b1 ), s2 = sideOf( x2, b2 );
                        if (s1 != null && s2 != null)
                            third = { kind : "boundary", a1 : face( a1k ), a2 : face( a2k ), axis1 : s1.axis, value1 : s1.value, axis2 : s2.axis, value2 : s2.value };
                    }
                    if (third != null) ok = FilletCorner.mitre( F1, x1.end, b1, F2, x2.end, b2, third, tol );
                    if (ok && FilletCorner.pending != null) inserts.push( { g : [x1.g, x2.g], insert : FilletCorner.pending } );
                    if (ok) {
                        for (const [g, h] of [[x1.g, x2.g], [x2.g, x1.g]]) { let l = partners.get( g ); if (l == null) partners.set( g, l = [] ); l.push( h ); }
                    }
                }
            }
            if (filleted.length == 3 && others.length == 0 && new Set( filleted.map( x => x.g ) ).size == 3) {
                const three = filleted.map( x => ({ F : openBlends.get( x.g ) as OpenBlend, e : x.end, keys : faceKeys( x.g ) as [string, string] }) );
                // a ball where the three radii are equal there, a setback vertex blend otherwise. Curvature-continuous
                // blends always get a setback blend, which is G2 with them; a sphere cannot be (their sections are
                // not circular arcs)
                const g2 = o.filletCorner != "ball" && three.every( x => x.F.shape == "curvature" );
                let patch = g2 ? FilletCorner.setback( three, tol ) : FilletCorner.ball( three, tol );
                if (patch == null) patch = g2 ? FilletCorner.ball( three, tol ) : FilletCorner.setback( three, tol );
                if (patch != null) {
                    ok = true;
                    balls.push( { g : filleted.map( x => x.g ), patch : patch } );
                    for (const x of filleted) for (const y of filleted) if (x.g != y.g) {
                        let l = partners.get( x.g ); if (l == null) partners.set( x.g, l = [] ); l.push( y.g );
                    }
                }
            }
            if (!ok && filleted.length == 1 && others.length <= 2) {
                const x = filleted[0], F = openBlends.get( x.g ) as OpenBlend;
                const [ka, kb] = faceKeys( x.g );
                const face = (k : string) => { const q = k.split( ":" ).map( Number ); return solids[q[0]].faces[q[1]]; };
                let found : { kc : string, edgeA : ThirdEdge, edgeB : ThirdEdge } | null = null;
                const curveEdge = (y : { g : number, end : number }, k : string, kc : string) : ThirdEdge => ({ kind : "curve", curve : runs[y.g].curve,
                    a1IsA : faceKeys( y.g )[0] == k, a1 : face( k ), a2 : face( kc ), atStart : y.end == 0 });
                // the edge between faces k and kc of one solid that ends at P, as a third edge
                const ownEdge = (k : string, kc : string) : ThirdEdge | null => {
                    const [s1, f1] = k.split( ":" ).map( Number ), [s2, f2] = kc.split( ":" ).map( Number );
                    if (s1 != s2) return null;
                    const e = BrepEdges.between( solids[s1], f1, f2 );
                    // P on it: at an end, or within it where a branch splits it
                    if (e == null || !e.curve.points.some( (q, j) => j > 0 && BrepBoolean.segmentDistance( P, e.curve.points[j - 1], q ) < snap )) return null;
                    return { kind : "boundary", a1 : face( k ), a2 : face( kc ), axis1 : e.sides[0].axis, value1 : e.sides[0].value, axis2 : e.sides[1].axis, value2 : e.sides[1].value };
                };
                if (others.length == 2 && others.every( y => !runs[y.g].own )) {
                    // two branches, from A and from B to the same third face
                    const ta = others.find( y => faceKeys( y.g ).includes( ka ) ), tb = others.find( y => faceKeys( y.g ).includes( kb ) );
                    if (ta != null && tb != null && ta !== tb) {
                        const kca = faceKeys( ta.g ).find( k => k != ka ), kcb = faceKeys( tb.g ).find( k => k != kb );
                        if (kca != null && kca == kcb && kca != ka && kca != kb) found = { kc : kca, edgeA : curveEdge( ta, ka, kca ), edgeB : curveEdge( tb, kb, kca ) };
                    }
                } else if (others.length == 1 && !runs[others[0].g].own) {
                    // a branch from one of A and B to the third face, and an edge of a solid from the other
                    const y = others[0], ky = faceKeys( y.g );
                    for (const [k, kOther] of [[ka, kb], [kb, ka]]) {
                        if (found != null || !ky.includes( k )) continue;
                        const kc = ky.find( z => z != k );
                        if (kc == null || kc == ka || kc == kb) continue;
                        const own = ownEdge( kOther, kc );
                        if (own == null) continue;
                        const branch = curveEdge( y, k, kc );
                        found = k == ka ? { kc : kc, edgeA : branch, edgeB : own } : { kc : kc, edgeA : own, edgeB : branch };
                    }
                } else if (others.length == 0 && runs[x.g].own) {
                    // a solid's own vertex: the face of that solid meeting both A and B there
                    const si = Number( ka.split( ":" )[0] ), fa = Number( ka.split( ":" )[1] ), fb = Number( kb.split( ":" )[1] );
                    const solid = solids[si];
                    const at = (e : SolidEdge | null) => e != null && !e.curve.closed && [e.curve.points[0], e.curve.points[e.curve.points.length - 1]].some( q => Vec.dist( q, P ) < snap );
                    for (let fc = 0; fc < solid.faces.length && found == null; fc++) {
                        if (fc == fa || fc == fb) continue;
                        const ea = BrepEdges.between( solid, fa, fc ), eb = BrepEdges.between( solid, fb, fc );
                        if (!at( ea ) || !at( eb )) continue;
                        const C = solid.faces[fc], A = solid.faces[fa], B = solid.faces[fb];
                        const ia = ea as SolidEdge, ib = eb as SolidEdge;
                        found = { kc : key( si, fc ),
                            edgeA : { kind : "boundary", a1 : A, a2 : C, axis1 : ia.sides[0].axis, value1 : ia.sides[0].value, axis2 : ia.sides[1].axis, value2 : ia.sides[1].value },
                            edgeB : { kind : "boundary", a1 : B, a2 : C, axis1 : ib.sides[0].axis, value1 : ib.sides[0].value, axis2 : ib.sides[1].axis, value2 : ib.sides[1].value } };
                    }
                }
                if (found != null) {
                    const q = found.kc.split( ":" ).map( Number );
                    const cut = FilletCorner.runout( F, x.end, solids[q[0]].faces[q[1]], found.edgeA, found.edgeB, tol );
                    if (cut != null) {
                        ok = true;
                        runouts.push( { g : x.g, solid : q[0], face : q[1], uv : cut.uv, points : cut.points, P : P } );
                        for (const ins of cut.inserts) inserts.push( { g : [x.g, x.g], insert : ins } );
                    }
                }
            }
            if (!ok) for (const x of filleted) unsupported.add( x.g );
        }
        // a blend that cannot end at one of its corners takes its partners at the others with it
        const built = new Map<number, FilletResult>();
        for (let round = 0; round < 64; round++) {
            let changed = true;
            while (changed) {
                changed = false;
                for (const g of Array.from( unsupported )) for (const h of partners.get( g ) || []) if (!unsupported.has( h )) { unsupported.add( h ); changed = true; }
            }
            let again = false;
            for (const [g, F] of openBlends) {
                if (unsupported.has( g ) || built.has( g )) continue;
                const fr = FilletCorner.build( F );
                if (fr == null) { unsupported.add( g ); again = true; } else built.set( g, fr );
            }
            for (const g of Array.from( built.keys() )) if (unsupported.has( g )) built.delete( g );
            if (!again) break;
        }
        skipped = Array.from( openBlends.keys() ).filter( g => unsupported.has( g ) ).length;
        for (const x of inserts) if (built.has( x.g[0] ) && built.has( x.g[1] )) x.insert();
        const strip : Array<[number, number]> = [];
        const ownStrips : Array<{ solid : number, face : number, tag : number, side : DomainSide }> = [];
        const addBlend = (g : number, fr : FilletResult) => {
            const r = runs[g], e = curves[r.ci];
            for (const x of fr.cutA) x.tag = runs.length + g;
            for (const x of fr.cutB) x.tag = runs.length + g;
            cuts[e.solids[0]][e.faces[0]].push( ...fr.cutA );
            cuts[e.solids[1]][e.faces[1]].push( ...fr.cutB );
            blends.push( fr ); filletInfo.push( { curve : r.ci, radius : r.radius, blend : fr } );
            strip.push( [g, runs.length + g] );
            if (r.own) for (let k = 0; k < 2; k++) ownStrips.push( { solid : e.solids[k], face : e.faces[k], tag : runs.length + g, side : (e.own as [DomainSide, DomainSide])[k] } );
        };
        runs.forEach( (_, g) => { const fr = closedBlends.get( g ) || built.get( g ); if (fr != null) addBlend( g, fr ); } );
        for (const x of runouts) {
            if (!built.has( x.g )) continue;
            const C = solids[x.solid].faces[x.face];
            const pieces = BrepBoolean.facePieces( C, x.uv, x.uv.map( _ => 0 ), x.points, false );
            for (const pc of pieces) pc.tag = runs.length + x.g;
            cuts[x.solid][x.face].push( ...pieces );
        }
        // ball corners whose three blends were built
        const ballPatches = balls.filter( b => b.g.every( g => built.has( g ) ) ).map( b => b.patch );

        // the runs as cuts of their faces; a branch that another one on the same face already traces
        // (two coincident faces crossing a third) cuts that face once
        const traced = BrepBoolean.traced( curves, snap );
        runs.forEach( (r, g) => {
            if (r.own) return;
            const c = r.curve, e = curves[r.ci], i = e.solids[0], j = e.solids[1];
            const fa = solids[i].faces[e.faces[0]], fb = solids[j].faces[e.faces[1]];
            const tag = (x : Array<FaceCut>) => { for (const p of x) p.tag = g; return x; };
            if (!traced.has( r.ci + ":0" )) cuts[i][e.faces[0]].push( ...tag( BrepBoolean.facePieces( fa, c.uvA, c.seamA, c.points, c.closed ) ) );
            if (!traced.has( r.ci + ":1" )) cuts[j][e.faces[1]].push( ...tag( BrepBoolean.facePieces( fb, c.uvB, c.seamB, c.points, c.closed ) ) );
        } );
        curves.forEach( e => {
            const c = e.curve, fa = solids[e.solids[0]].faces[e.faces[0]], fb = solids[e.solids[1]].faces[e.faces[1]];
            for (let k = 0; k < c.points.length; k++) {
                const err = Vec.dist( BrepBoolean.eval( fa.surface, c.uvA[k] ), BrepBoolean.eval( fb.surface, c.uvB[k] ) );
                maxErr = Math.max( maxErr, err );
            }
        } );
        // faces of two solids whose sides coincide (a rim on a disc of the same radius, each with its own grid)
        BrepBoolean.coincidentSides( solids, cuts, paired, snap );
        // a cut that runs along a side of its face's domain, to rounding (the parameters of a branch found where two
        // solids are flush at an edge stray from the side by 1e-17 or so), lies exactly on it (#94)
        solids.forEach( (solid, si) => solid.faces.forEach( (f, fi) => { for (const c of cuts[si][fi]) BrepBoolean.ontoSide( f, c ); } ) );
        // a cut along a side of a face runs along an edge of its solid: the face across that edge gets it too, so that
        // the three faces meeting there (two of this solid, one of the other) share its points
        solids.forEach( (solid, si) => solid.faces.forEach( (_, fi) => {
            for (const c of cuts[si][fi].slice()) {
                if (solid.edges != null || BrepBoolean.side( solid.faces[fi], c.uv ) == null) continue;
                solid.faces.forEach( (g, gi) => {
                    if (gi == fi || cuts[si][gi].some( x => x.points == c.points )) return;
                    const across = BrepBoolean.along( g, c.points, snap );
                    if (across != null) cuts[si][gi].push( { uv : across, points : c.points, closed : c.closed, tag : -1 } );
                } );
            }
        } ) );
        // within a face, ends of pieces that meet get the same parameters
        solids.forEach( (solid, si) => solid.faces.forEach( (face, fi) => BrepBoolean.joinEnds( face, cuts[si][fi] ) ) );

        // 2.-5. tessellate, group, classify, keep
        const welder = new Welder( weldTol );
        const out = new TriMesh();
        const faces : Array<TrimmedFace> = [];
        let faceOf : Array<number> = [];
        let cornerUV : Array<[UV, UV, UV] | null> = [];
        let patchXY : Array<[XY, XY, XY] | null> = [];
        solids.forEach( (solid, si) => solid.faces.forEach( (face, fi) => {
            const t = FaceMesher.mesh( face, cuts[si][fi], welder );
            const regions = BrepBoolean.regions( t );
            const emit = (reg : Array<number>, flip : boolean) => {
                for (const k of reg) {
                    const tri = t.triangles[k];
                    const a = t.ids[tri[0]], b = t.ids[tri[1]], c = t.ids[tri[2]];
                    if (flip) out.addTriangle( a, c, b ); else out.addTriangle( a, b, c );
                    faceOf.push( faces.length );
                    cornerUV.push( flip ? [t.uv[tri[0]], t.uv[tri[2]], t.uv[tri[1]]] : [t.uv[tri[0]], t.uv[tri[1]], t.uv[tri[2]]] );
                    patchXY.push( null );
                }
                faces.push( { solid : si, face : fi, name : face.name != null ? face.name : "", surface : face.surface,
                              reversed : flip, loops : BrepBoolean.loops( t, reg ) } );
            };
            // the corners of this face that blends run out onto: the region there is cut off where the blend rounds a
            // convex edge, and filled in where it fills a concave one (on the side the rest of the face is kept)
            const mine = runouts.filter( x => x.solid == si && x.face == fi && built.has( x.g ) );
            // (the face's other regions are kept with the material on one side: a corner filled in has it there too)
            const fills : Array<{ reg : Array<number> }> = [];
            let keptFlip : boolean | null = null;
            for (const reg of regions) {
                // a trimmed face keeps the regions inside its trims (at the middle of the region's largest triangle)
                if (face.trims != null) {
                    let big = reg[0], ba = -1;
                    for (const k of reg) {
                        const [a, b, c] = t.triangles[k].map( i => t.uv[i] );
                        const ar = Math.abs( (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) );
                        if (ar > ba) { ba = ar; big = k; }
                    }
                    const [a, b, c] = t.triangles[big].map( i => t.uv[i] );
                    if (!BrepSolid.insideTrims( face.trims, [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3] )) continue;
                }
                let runoutTag = -1;
                if (strip.length > 0) {
                    const tags = BrepBoolean.regionTags( t, reg );
                    for (const x of mine) {
                        const tg = runs.length + x.g;
                        if (tags.has( tg ) && reg.some( k => t.triangles[k].some( v => Vec.dist( t.points[v], x.P ) < snap ) )) runoutTag = tg;
                    }
                    if (strip.some( x => tags.has( x[0] ) && tags.has( x[1] ) )) continue;
                    // the strip along an own edge: bounded by the contact curve, and reaching the face's side
                    if (ownStrips.some( x => x.solid == si && x.face == fi && tags.has( x.tag ) && BrepBoolean.touches( face, t, reg, x.side ) )) continue;
                }
                const inside = BrepBoolean.classify( t, reg, si, meshes );
                // next to a seam with another solid, the side is exact: it does not depend on how finely that solid is
                // tessellated, which matters when the two barely overlap
                for (const [k, x] of BrepBoolean.seamSides( t, reg, si, solids, runs, curves )) inside[k] = x;
                // on a face of another solid (coincident faces): just behind the region, that solid is inside where
                // its face points the same way, outside where it points against; just in front, the reverse
                const on = BrepBoolean.coincident( face, t, reg, si, solids, weldTol * 50 );
                const fin = expr( inside.map( (x, k) => k == si ? true : on.has( k ) ? on.get( k ) as boolean : x ) );
                const fout = expr( inside.map( (x, k) => k == si ? false : on.has( k ) ? !on.get( k ) : x ) );
                if (runoutTag >= 0) {
                    if (fin == fout) fills.push( { reg : reg } );
                    continue;
                }
                if (fin == fout) continue;
                // the solids sharing the region would each keep it: the first of them does
                if (Array.from( on.keys() ).some( k => k < si )) continue;
                const flip = face.reversed != !fin; // keep the material side of the result behind the face
                keptFlip = flip;
                emit( reg, flip );
            }
            for (const x of fills) if (keptFlip != null) emit( x.reg, keptFlip );
        } ) );
        for (const b of blends) {
            const ids = b.points.map( p => welder.id( p ) );
            for (const tri of b.triangles) {
                out.addTriangle( ids[tri[0]], ids[tri[1]], ids[tri[2]] ); faceOf.push( faces.length );
                cornerUV.push( [b.uv[tri[0]], b.uv[tri[1]], b.uv[tri[2]]] ); patchXY.push( null );
            }
            faces.push( { solid : -1, face : -1, name : "fillet", surface : b.surface, reversed : b.reversed,
                          loops : BrepBoolean.surfaceLoops( b.triangles, b.uv, b.reversed ) } );
        }
        const cornerInfo : BooleanResult["corners"] = [];
        for (const b of ballPatches) {
            const first = faces.length;
            const ids = b.points.map( p => welder.id( p ) );
            // a ball's parameters are by vertex; a setback patch's by triangle, on the part it lies in
            const parts = b.parts != null ? b.parts
                : [{ surface : b.surface, triangles : b.triangles, uv : b.uv != null ? b.triangles.map( t => [b.uv![t[0]], b.uv![t[1]], b.uv![t[2]]] as [UV, UV, UV] ) : [] }];
            for (const part of parts) {
                const uv : Array<UV> = [];
                part.triangles.forEach( (tri, j) => {
                    out.addTriangle( ids[tri[0]], ids[tri[1]], ids[tri[2]] ); faceOf.push( faces.length );
                    const q = part.uv[j];
                    cornerUV.push( q != null ? q : null );
                    if (q != null) for (let x = 0; x < 3; x++) uv[tri[x]] = q[x];
                    const D = b.domain;
                    patchXY.push( D != null ? [D[tri[0]], D[tri[1]], D[tri[2]]] : null );
                } );
                faces.push( { solid : -1, face : -1, name : "fillet corner", surface : part.surface, reversed : b.reversed,
                              loops : part.uv.length == part.triangles.length ? BrepBoolean.surfaceLoops( part.triangles, uv, b.reversed ) : [] } );
            }
            cornerInfo.push( { kind : b.kind, centre : b.centre, radius : b.radius, face : first, faces : parts.map( (_, k) => first + k ), ribbons : b.ribbons } );
        }
        out.vertices = welder.mesh.vertices;
        const kept = (k : number) => { const t = out.triangles[k]; return t[0] != t[1] && t[1] != t[2] && t[2] != t[0]; };
        faceOf = faceOf.filter( (_, k) => kept( k ) );
        cornerUV = cornerUV.filter( (_, k) => kept( k ) );
        patchXY = patchXY.filter( (_, k) => kept( k ) );
        out.compact(); // drops the same degenerate triangles
        return { mesh : out, faces : faces, faceOf : faceOf, cornerUV : cornerUV, patchXY : patchXY, curves : curves, fillets : filletInfo, corners : cornerInfo, report : {
            manifold : out.checkClosedManifold(), volume : out.signedVolume(), intersectionCurves : curves.length, tangentContacts : tangentContacts, maxCurveError : maxErr,
            fillets : blends.length, filletsFailed : failed, filletsSkipped : skipped, filletsReduced : reduced.count, facePairs : facePairs, certificate : certificate } };
    }

    // Drop a closed branch that only retraces part of another branch: where a branch ends on a face's edge, the marcher
    // can step back along it and close a loop of zero area over the same points.
    public static dropRetraces( found : Array<IntersectionCurve>, tol : number ) : Array<IntersectionCurve> {
        const near = (p : Point, c : IntersectionCurve) => {
            const q = c.points;
            for (let k = 0; k + 1 < q.length; k++) {
                const d = Vec.sub( q[k + 1], q[k] ), l2 = Vec.dot( d, d );
                const t = l2 > 0 ? Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( p, q[k] ), d ) / l2 ) ) : 0;
                if (Vec.dist( p, Vec.add( q[k], Vec.mul( t, d ) ) ) < tol) return true;
            }
            return q.length == 1 && Vec.dist( p, q[0] ) < tol;
        };
        // a branch that lies along another one, as long or longer, is the same branch found twice (a closed loop traced
        // again, or the piece of an open branch on one side of a face's seam besides the whole branch across it); of
        // two copies of one length, the first is kept
        return found.filter( (c, i) => !found.some( (o, j) => j != i && (o.points.length > c.points.length || (o.points.length == c.points.length && j < i))
            && c.points.every( p => near( p, o ) ) ) );
    }

    // The rolling-ball blend of one edge, if both its faces are kept on exactly one side of it.
    // How the two faces of an edge take part in the result, judged at a point of the edge: null where the edge is not
    // an edge of the result (it lies inside or outside another solid that decides the expression there).
    private static sides( solids : Array<BrepSolid>, meshes : Array<MeshBVH>, expr : (inside : Array<boolean>) => boolean,
                          e : BooleanResult["curves"][0], p : Point ) : [FilletSide, FilletSide] | null {
        const i = e.solids[0], j = e.solids[1];
        const flags = solids.map( (_, k) => k == i || k == j ? false : meshes[k].contains( p ) );
        // the side of the edge kept on the face of solid `own`: inside the other solid or outside it
        const side = (own : number, other : number, face : BrepFace) : FilletSide | null => {
            const keep : Array<{ inside : boolean, fin : boolean }> = [];
            for (const x of [true, false]) {
                const f = flags.slice(); f[other] = x;
                f[own] = true; const fin = expr( f );
                f[own] = false; const fout = expr( f );
                if (fin != fout) keep.push( { inside : x, fin : fin } );
            }
            if (keep.length != 1) return null;
            const flip = face.reversed != !keep[0].fin;
            return { face : face, sign : flip ? -1 : 1, keptInsideOther : keep[0].inside };
        };
        const A = side( i, j, solids[i].faces[e.faces[0]] ), B = side( j, i, solids[j].faces[e.faces[1]] );
        if (A == null || B == null) return null;
        return [A, B];
    }

    // A curve split at the points of `at` that lie on it (within tol): the points are put into it (their parameters
    // interpolated along the segment they fall on) and the pieces between them returned, open. A curve that no point
    // lies on comes back whole.
    private static splitAt( c : IntersectionCurve, at : Array<Point>, tol : number ) : Array<IntersectionCurve> {
        const n = c.points.length, segs = c.closed ? n : n - 1;
        const hits : Array<{ k : number, f : number, p : Point }> = [];
        for (const p of at) {
            for (let k = 0; k < segs; k++) {
                const a = c.points[k], b = c.points[(k + 1) % n], ab = Vec.sub( b, a ), l2 = Vec.dot( ab, ab );
                const f = l2 > 0 ? Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( p, a ), ab ) / l2 ) ) : 0;
                if (Vec.dist( p, Vec.add( a, Vec.mul( f, ab ) ) ) < tol) {
                    // not an end of an open curve (those are vertices of the solid)
                    if (!c.closed && ((k == 0 && f < 1e-9) || (k == segs - 1 && f > 1 - 1e-9))) break;
                    if (f > 1 - 1e-9) hits.push( { k : (k + 1) % n, f : 0, p : p } ); else hits.push( { k : k, f : f, p : p } );
                    break;
                }
            }
        }
        if (hits.length == 0) return [c];
        // the curve with the points put in, and their indices
        hits.sort( (x, y) => x.k - y.k || x.f - y.f );
        const pts : Array<Point> = [], uvA : Array<UV> = [], uvB : Array<UV> = [], sA : Array<number> = [], sB : Array<number> = [], cut : Array<number> = [];
        const lerp = (a : UV, b : UV, f : number) : UV => [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
        let h = 0;
        for (let k = 0; k < n; k++) {
            let atStart = false;
            while (h < hits.length && hits[h].k == k && hits[h].f < 1e-9) { atStart = true; cut.push( pts.length ); pts.push( hits[h].p ); uvA.push( c.uvA[k] ); uvB.push( c.uvB[k] ); sA.push( c.seamA[k] ); sB.push( c.seamB[k] ); h++; }
            if (!atStart) { pts.push( c.points[k] ); uvA.push( c.uvA[k] ); uvB.push( c.uvB[k] ); sA.push( c.seamA[k] ); sB.push( c.seamB[k] ); }
            while (h < hits.length && hits[h].k == k) {
                const k1 = (k + 1) % n, f = hits[h].f;
                cut.push( pts.length ); pts.push( hits[h].p );
                uvA.push( lerp( c.uvA[k], c.uvA[k1], f ) ); uvB.push( lerp( c.uvB[k], c.uvB[k1], f ) ); sA.push( 0 ); sB.push( 0 );
                h++;
            }
        }
        const m = pts.length, out : Array<IntersectionCurve> = [];
        const take = (idx : Array<number>) => out.push( { points : idx.map( i => pts[i] ), uvA : idx.map( i => uvA[i] ), uvB : idx.map( i => uvB[i] ),
                                                        seamA : idx.map( i => sA[i] ), seamB : idx.map( i => sB[i] ), closed : false } );
        const bounds = c.closed ? cut : [0].concat( cut, [m - 1] );
        const pieces = c.closed ? bounds.length : bounds.length - 1;
        for (let x = 0; x < pieces; x++) {
            const a = bounds[x], b = bounds[(x + 1) % bounds.length];
            const idx : Array<number> = [];
            for (let i = a; ; i = (i + 1) % m) { idx.push( i ); if (i == b && idx.length > 1) break; if (idx.length > m + 1) break; }
            if (idx.length >= 2) take( idx );
        }
        return out;
    }

    // Whether a region of a face's tessellation has a vertex on a side of the face's domain.
    // The distance from p to the segment a-b.
    private static segmentDistance( p : Point, a : Point, b : Point ) : number {
        const ab = Vec.sub( b, a ), l2 = Math.max( Vec.dot( ab, ab ), 1e-300 );
        const t = Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( p, a ), ab ) / l2 ) );
        return Vec.dist( p, Vec.add( a, Vec.mul( t, ab ) ) );
    }

    private static touches( f : BrepFace, t : FaceTessellation, region : Array<number>, side : DomainSide ) : boolean {
        const d = SurfaceIntersect.domain( f.surface );
        const eps = 1e-9 * (d[2 * side.axis + 1] - d[2 * side.axis]);
        for (const k of region) for (const v of t.triangles[k]) if (Math.abs( t.uv[v][side.axis] - side.value ) <= eps) return true;
        return false;
    }

    // Inside/outside flags of a region against the solids it meets along a seam, from the geometry at the seam: step
    // from the seam into the region, in the tangent plane of the region's face and across the seam, and see which side
    // of the other face that is (its outward normal). Exact for transversal seams, whatever the tessellation.
    private static seamSides( t : FaceTessellation, region : Array<number>, own : number, solids : Array<BrepSolid>,
                              runs : Array<{ ci : number, curve : IntersectionCurve, own? : boolean }>,
                              curves : BooleanResult["curves"] ) : Map<number, boolean> {
        // votes per other solid: [inside, outside], one per seam edge; a side is decided by a clear majority (a sliver
        // triangle at the end of a seam can vote wrong), otherwise left to the ray test
        const votes = new Map<number, [number, number]>();
        const key = (a : number, b : number) => a + "," + b;
        const tagOf = new Map<string, number>();
        t.cutEdges.forEach( (e, k) => { tagOf.set( key( e[0], e[1] ), t.cutTags[k] ); tagOf.set( key( e[1], e[0] ), t.cutTags[k] ); } );
        for (const k of region) {
            const tri = t.triangles[k];
            for (let x = 0; x < 3; x++) {
                const a = tri[x], b = tri[(x + 1) % 3], c = tri[(x + 2) % 3];
                const g = tagOf.get( key( a, b ) );
                if (g == null || g < 0 || g >= runs.length || runs[g].own || curves[runs[g].ci].trim) continue;
                const e = curves[runs[g].ci], run = runs[g].curve;
                const mine = e.solids[0] == own ? 0 : 1, other = 1 - mine;
                if (e.solids[mine] != own) continue;
                const myFace = solids[own].faces[e.faces[mine]], otherFace = solids[e.solids[other]].faces[e.faces[other]];
                const mid = Vec.lerp( 0.5, t.points[a], t.points[b] );
                let best = 0, bd = Infinity;
                run.points.forEach( (p, i) => { const d = Vec.distSquared( p, mid ); if (d < bd) { bd = d; best = i; } } );
                const uvMine = mine == 0 ? run.uvA[best] : run.uvB[best], uvOther = mine == 0 ? run.uvB[best] : run.uvA[best];
                const da = Eval.rationalSurfaceDerivatives( myFace.surface, uvMine[0], uvMine[1], 1 );
                const db = Eval.rationalSurfaceDerivatives( otherFace.surface, uvOther[0], uvOther[1], 1 );
                const na = Vec.normalized( Vec.cross( da[1][0], da[0][1] ) );
                let nb = Vec.normalized( Vec.cross( db[1][0], db[0][1] ) );
                if (otherFace.reversed) nb = Vec.mul( -1, nb );
                const along = Vec.cross( na, nb );
                if (Vec.norm( along ) < 1e-9) continue; // tangent here: no clean side
                const T = Vec.normalized( along );
                let d = Vec.sub( t.points[c], mid );
                d = Vec.sub( d, Vec.mul( Vec.dot( d, na ), na ) );
                d = Vec.sub( d, Vec.mul( Vec.dot( d, T ), T ) );
                const s = Vec.dot( d, nb );
                if (Math.abs( s ) < 1e-12 * Math.max( 1, Vec.norm( d ) )) continue;
                const v = votes.get( e.solids[other] );
                if (v == null) votes.set( e.solids[other], s < 0 ? [1, 0] : [0, 1] ); else v[s < 0 ? 0 : 1]++;
            }
        }
        const out = new Map<number, boolean>();
        for (const [k, v] of votes) if (Math.max( v[0], v[1] ) >= 0.9 * (v[0] + v[1])) out.set( k, v[0] > v[1] );
        return out;
    }

    // The other solids that a region of a face lies on: for each, whether its face there points the same way (true)
    // or against (false). Decided at the centres of the region's largest triangles, projected exactly onto the faces
    // of the other solids whose boxes hold them; all of them must agree.
    private static coincident( f : BrepFace, t : FaceTessellation, region : Array<number>, own : number,
                               solids : Array<BrepSolid>, eps : number ) : Map<number, boolean> {
        const out = new Map<number, boolean>();
        const area = (k : number) => {
            const tri = t.triangles[k];
            return Vec.norm( Vec.cross( Vec.sub( t.points[tri[1]], t.points[tri[0]] ), Vec.sub( t.points[tri[2]], t.points[tri[0]] ) ) );
        };
        const sample = region.slice().sort( (a, b) => area( b ) - area( a ) ).slice( 0, 3 ).map( k => {
            const tri = t.triangles[k];
            const uv : UV = [(t.uv[tri[0]][0] + t.uv[tri[1]][0] + t.uv[tri[2]][0]) / 3, (t.uv[tri[0]][1] + t.uv[tri[1]][1] + t.uv[tri[2]][1]) / 3];
            return { p : BrepBoolean.eval( f.surface, uv ), n : BrepBoolean.normal( f, uv ) };
        } );
        if (sample.length == 0) return out;
        solids.forEach( (solid, k) => {
            if (k == own) return;
            let same : boolean | null = null;
            for (const x of sample) {
                let found : boolean | null = null;
                for (const g of solid.faces) {
                    const b = BrepSolid.faceBox( g );
                    if (x.p.some( (c, a) => c < b.min[a] - eps || c > b.max[a] + eps )) continue;
                    const uv = SurfaceIntersect.project( g.surface, x.p );
                    if (Vec.dist( BrepBoolean.eval( g.surface, uv ), x.p ) > eps) continue;
                    // a trimmed face is its surface only inside its trims: a cap plane runs on past its outline, and
                    // the region beside a stacked layer is not on it (#104)
                    if (g.trims != null && g.trims.length > 0 && !BrepSolid.insideTrims( g.trims, uv )) continue;
                    const c = Vec.dot( x.n, BrepBoolean.normal( g, uv ) );
                    if (Math.abs( c ) < 1 - 1e-6) continue; // crossing, not coincident
                    found = c > 0;
                    break;
                }
                if (found == null || (same != null && same != found)) return;
                same = found;
            }
            out.set( k, same as boolean );
        } );
        return out;
    }

    // The sides ("curve:k") of branches that another branch on the same face of the same solid already traces: every
    // point of one lies on the other's polyline (when each lies on the other, the earlier one is kept).
    private static traced( curves : BooleanResult["curves"], eps : number ) : Set<string> {
        const out = new Set<string>();
        const near = (p : Point, c : IntersectionCurve) => {
            const n = c.points.length, segs = c.closed ? n : n - 1;
            for (let k = 0; k < segs; k++) {
                const a = c.points[k], b = c.points[(k + 1) % n], ab = Vec.sub( b, a ), l2 = Vec.dot( ab, ab );
                const t = l2 > 0 ? Math.min( 1, Math.max( 0, Vec.dot( Vec.sub( p, a ), ab ) / l2 ) ) : 0;
                if (Vec.dist( p, Vec.add( a, Vec.mul( t, ab ) ) ) < eps + 0.05 * Math.sqrt( l2 )) return true;
            }
            return false;
        };
        // each branch's box, and how far from its polyline a point still counts as on it: a branch can trace another
        // only if its box lies within the other's grown by that much
        const boxes = curves.map( e => {
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
            let seg = 0;
            const q = e.curve.points;
            q.forEach( (p, k) => {
                for (let c = 0; c < 3; c++) { lo[c] = Math.min( lo[c], p[c] ); hi[c] = Math.max( hi[c], p[c] ); }
                if (k > 0) seg = Math.max( seg, Vec.dist( p, q[k - 1] ) );
            } );
            if (e.curve.closed && q.length > 1) seg = Math.max( seg, Vec.dist( q[0], q[q.length - 1] ) );
            return { lo : lo, hi : hi, grow : eps + 0.05 * seg };
        } );
        const within = (a : number, b : number) => {
            const A = boxes[a], B = boxes[b];
            for (let c = 0; c < 3; c++) if (A.lo[c] < B.lo[c] - B.grow || A.hi[c] > B.hi[c] + B.grow) return false;
            return true;
        };
        // the branches on each face of each solid, in order
        const onFace = new Map<string, Array<number>>();
        curves.forEach( (f, cj) => { for (const m of [0, 1]) {
            const key = f.solids[m] + ":" + f.faces[m];
            let list = onFace.get( key );
            if (list == null) onFace.set( key, list = [] );
            if (list[list.length - 1] != cj) list.push( cj );
        } } );
        curves.forEach( (e, ci) => { for (let k = 0; k < 2; k++) {
            for (const cj of onFace.get( e.solids[k] + ":" + e.faces[k] ) as Array<number>) {
                const f = curves[cj];
                if (cj == ci) continue;
                // an edge of a solid made from a shell always cuts its face: a branch along it keeps only its runs inside
                // both faces' trims, and would leave the rest of the edge uncut (an upright flush with a foot's side,
                // along its bottom edge only as far as the foot's corner arcs, #123)
                if (e.trim && !f.trim) continue;
                if ((e.curve.closed && !f.curve.closed) || !within( ci, cj )) continue;
                // all of it along the other (a stretch of it: a face covering only part of a third face's edge)
                if (!e.curve.points.every( p => near( p, f.curve ) )) continue;
                if (cj > ci && f.curve.closed == e.curve.closed && f.curve.points.every( p => near( p, e.curve ) )) continue;
                out.add( ci + ":" + k ); break;
            }
        } } );
        return out;
    }

    // Sides of faces of two solids that are the same curve (#94), as where a tube stands on a disc of its outer radius:
    // nothing crosses there, so no intersection is traced, and each face would keep its own grid along the side (the
    // disc's 64 divisions round, the tube's 32), which do not meet. Both get a cut along it, at the same points: the
    // finer of the two grids, on the first face's side.
    private static coincidentSides( solids : Array<BrepSolid>, cuts : Array<Array<Array<FaceCut>>>, pairs : Array<[number, number, number, number]>, snap : number ) : void {
        const sides = (f : BrepFace) => {
            const d = SurfaceIntersect.domain( f.surface ), out : Array<{ axis : number, value : number, lo : number, hi : number, n : number }> = [];
            for (let axis = 0; axis < 2; axis++) {
                if (f.periodic[axis]) continue;
                for (const value of [d[2 * axis], d[2 * axis + 1]]) out.push( { axis : axis, value : value, lo : d[2 * (1 - axis)], hi : d[2 * (1 - axis) + 1], n : f.divs[1 - axis] } );
            }
            return out;
        };
        const at = (f : BrepFace, s : { axis : number, value : number, lo : number, hi : number }, t : number) : UV => s.axis == 0 ? [s.value, s.lo + t * (s.hi - s.lo)] : [s.lo + t * (s.hi - s.lo), s.value];
        const probe = [0.13, 0.37, 0.5, 0.71, 0.94];
        for (const [i, ia, j, ib] of pairs) {
            const fa = solids[i].faces[ia], fb = solids[j].faces[ib];
            if (fa.trims != null || fb.trims != null) continue;
            for (const sa of sides( fa )) {
                // a side of fa all along a side of fb, and that side all along fa's: the same curve
                const pa = probe.map( t => BrepBoolean.eval( fa.surface, at( fa, sa, t ) ) );
                if (Vec.norm( Vec.sub( pa[0], pa[4] ) ) <= snap) continue; // a pole: no side
                if (BrepBoolean.along( fb, pa, snap ) == null) continue;
                const sb = sides( fb ).find( s => BrepBoolean.along( fa, probe.map( t => BrepBoolean.eval( fb.surface, at( fb, s, t ) ) ), snap ) != null );
                if (sb == null) continue;
                const ends = [0, 1].map( t => BrepBoolean.eval( fb.surface, at( fb, sb, t ) ) );
                if (BrepBoolean.along( fa, ends, snap ) == null) continue;
                const n = Math.max( sa.n, sb.n ), points : Array<Point> = [], uvA : Array<UV> = [];
                for (let k = 0; k <= n; k++) {
                    uvA.push( at( fa, sa, k / n ) );
                    points.push( k == n && Vec.dist( BrepBoolean.eval( fa.surface, uvA[k] ), points[0] ) <= snap ? points[0] : BrepBoolean.eval( fa.surface, uvA[k] ) );
                }
                const uvB = BrepBoolean.along( fb, points, snap );
                if (uvB == null) continue;
                cuts[i][ia].push( { uv : uvA, points : points, closed : false, tag : -1 } );
                cuts[j][ib].push( { uv : uvB, points : points, closed : false, tag : -1 } );
            }
        }
    }

    // A cut whose parameters are all on one side of its face's domain to within 1e-12 of the domain's width is put
    // exactly on that side.
    private static ontoSide( f : BrepFace, c : FaceCut ) : void {
        if (c.uv.length < 2) return;
        const d = SurfaceIntersect.domain( f.surface );
        for (let axis = 0; axis < 2; axis++) {
            if (f.periodic[axis]) continue;
            const w = d[2 * axis + 1] - d[2 * axis];
            for (const value of [d[2 * axis], d[2 * axis + 1]]) {
                if (!c.uv.every( p => Math.abs( p[axis] - value ) <= 1e-12 * w )) continue;
                c.uv = c.uv.map( p => (axis == 0 ? [value, p[1]] : [p[0], value]) as UV );
                return;
            }
        }
    }

    // The side of a face's domain that a polyline lies on (all its parameters exactly there), or null.
    private static side( f : BrepFace, uv : Array<UV> ) : DomainSide | null {
        if (uv.length < 2) return null;
        const d = SurfaceIntersect.domain( f.surface );
        for (let axis = 0; axis < 2; axis++) {
            if (f.periodic[axis]) continue;
            for (const value of [d[2 * axis], d[2 * axis + 1]]) if (uv.every( p => p[axis] == value )) return { axis : axis, value : value };
        }
        return null;
    }

    // The parameters of points on a side of a face's domain (within eps in space), or null if they are not all there.
    private static along( g : BrepFace, points : Array<Point>, eps : number ) : Array<UV> | null {
        const b = BrepSolid.faceBox( g );
        if (points.some( p => p.some( (c, a) => c < b.min[a] - eps || c > b.max[a] + eps ) )) return null;
        const d = SurfaceIntersect.domain( g.surface );
        const near = (x : number, lo : number, hi : number) => Math.abs( x - lo ) < 1e-7 * (hi - lo) ? lo : Math.abs( x - hi ) < 1e-7 * (hi - lo) ? hi : null;
        const out : Array<UV> = [];
        let side : string | null = null;
        for (const p of points) {
            const uv = SurfaceIntersect.project( g.surface, p );
            if (Vec.dist( BrepBoolean.eval( g.surface, uv ), p ) > eps) return null;
            const u = g.periodic[0] ? null : near( uv[0], d[0], d[1] ), v = g.periodic[1] ? null : near( uv[1], d[2], d[3] );
            // the same side for all points (a point at a corner is on two)
            const sides = [u != null ? "u" + u : null, v != null ? "v" + v : null].filter( x => x != null ) as Array<string>;
            if (sides.length == 0) return null;
            if (side == null || !sides.includes( side )) {
                if (side != null && out.length > 1) return null;
                side = sides.length == 1 || side == null ? sides[0] : sides.find( x => x != side ) as string;
            }
            out.push( [u != null ? u : uv[0], v != null ? v : uv[1]] );
        }
        // all on that side exactly
        const axis = side![0] == "u" ? 0 : 1, value = Number( side!.slice( 1 ) );
        for (const p of out) p[axis] = value;
        // a point on the seam of a closed direction takes the end of the domain its neighbour is nearer, so that the
        // piece runs the short way round (pieces are split at seams, so only their ends can be on one)
        for (let k = 0; k < 2; k++) {
            if (!g.periodic[k] || out.length < 2) continue;
            const lo = d[2 * k], hi = d[2 * k + 1], w = hi - lo;
            const seam = (x : number) => Math.abs( x - lo ) < 1e-9 * w || Math.abs( x - hi ) < 1e-9 * w;
            const n = out.length;
            for (const [i, j] of [[0, 1], [n - 1, n - 2]]) {
                if (!seam( out[i][k] ) || seam( out[j][k] )) continue;
                out[i][k] = out[j][k] - lo < hi - out[j][k] ? lo : hi;
            }
        }
        return out;
    }

    // the outward unit normal of a face
    private static normal( f : BrepFace, uv : UV ) : Point {
        const d = Eval.rationalSurfaceDerivatives( f.surface, uv[0], uv[1], 1 );
        const n = Vec.normalized( Vec.cross( d[1][0], d[0][1] ) );
        return f.reversed ? Vec.mul( -1, n ) : n;
    }

    // the tags of the cut edges around a region
    private static regionTags( t : FaceTessellation, region : Array<number> ) : Set<number> {
        const key = (a : number, b : number) => a < b ? a + "," + b : b + "," + a;
        const tagOf = new Map<string, number>();
        t.cutEdges.forEach( (e, k) => tagOf.set( key( t.ids[e[0]], t.ids[e[1]] ), t.cutTags[k] ) );
        const out = new Set<number>();
        for (const k of region) {
            const tri = t.triangles[k];
            for (let x = 0; x < 3; x++) {
                const g = tagOf.get( key( t.ids[tri[x]], t.ids[tri[(x + 1) % 3]] ) );
                if (g != null) out.add( g );
            }
        }
        return out;
    }

    // Make seam crossings unambiguous: a vertex lying exactly on a periodic seam is flagged as a seam vertex (its
    // parameter stored as the start of the domain), and consecutive vertices at the same point are merged, their
    // flags combined. Where both faces' seams cross the curve at one point, the intersection may return that point
    // two or three times, flagged for one face each.
    public static cleanSeams( c : IntersectionCurve, fa : BrepFace, fb : BrepFace ) : IntersectionCurve {
        const flag = (f : BrepFace, uv : Array<UV>, seam : Array<number>) => {
            const d = SurfaceIntersect.domain( f.surface );
            for (let k = 0; k < uv.length; k++) for (let a = 0; a < 2; a++) {
                if (!f.periodic[a]) continue;
                const lo = d[2 * a], hi = d[2 * a + 1], eps = (hi - lo) * 1e-12;
                if (Math.abs( uv[k][a] - lo ) <= eps || Math.abs( uv[k][a] - hi ) <= eps) {
                    const p : UV = [uv[k][0], uv[k][1]]; p[a] = lo; uv[k] = p;
                    seam[k] |= 1 << a;
                }
            }
        };
        flag( fa, c.uvA, c.seamA ); flag( fb, c.uvB, c.seamB );
        let scale = 0.0;
        for (const p of c.points) scale = Math.max( scale, Math.abs( p[0] ), Math.abs( p[1] ), Math.abs( p[2] ) );
        const same = 1e-10 * Math.max( 1, scale );
        const out : IntersectionCurve = { points : [], uvA : [], uvB : [], seamA : [], seamB : [], closed : c.closed };
        for (let k = 0; k < c.points.length; k++) {
            const m = out.points.length;
            if (m > 0 && Vec.dist( out.points[m - 1], c.points[k] ) < same) {
                // keep the merged vertex's parameters from whichever copy is flagged
                if (c.seamA[k] != 0) out.uvA[m - 1] = c.uvA[k];
                if (c.seamB[k] != 0) out.uvB[m - 1] = c.uvB[k];
                out.seamA[m - 1] |= c.seamA[k]; out.seamB[m - 1] |= c.seamB[k];
                continue;
            }
            out.points.push( c.points[k] ); out.uvA.push( c.uvA[k] ); out.uvB.push( c.uvB[k] );
            out.seamA.push( c.seamA[k] ); out.seamB.push( c.seamB[k] );
        }
        const m = out.points.length;
        if (c.closed && m > 2 && Vec.dist( out.points[0], out.points[m - 1] ) < same) {
            out.seamA[0] |= out.seamA[m - 1]; out.seamB[0] |= out.seamB[m - 1];
            if (out.seamA[m - 1] != 0) out.uvA[0] = out.uvA[m - 1];
            if (out.seamB[m - 1] != 0) out.uvB[0] = out.uvB[m - 1];
            for (const arr of [out.points, out.uvA, out.uvB, out.seamA, out.seamB] as Array<Array<any>>) arr.pop();
        }
        return out;
    }

    // Split a curve, given by its parameters on one face, into the polylines it makes in that face's domain: a loop
    // that crosses a seam is cut there, and the seam vertex appears at both ends of the domain.
    public static facePieces( f : BrepFace, uv : Array<UV>, seam : Array<number>, points : Array<Point>, closed : boolean = true ) : Array<FaceCut> {
        // an open piece that ends on a periodic face's seam, its neighbour on the far side of the domain, ends at that
        // side's end of it: a run cut at a point on the seam (where a circle split in halves starts, #121) would
        // otherwise run across the whole domain from the seam's other end
        const ends = (pieces : Array<FaceCut>) : Array<FaceCut> => {
            const d = SurfaceIntersect.domain( f.surface );
            for (const pc of pieces) {
                if (pc.closed || pc.uv.length < 2) continue;
                for (const [e, nb] of [[0, 1], [pc.uv.length - 1, pc.uv.length - 2]]) for (let a = 0; a < 2; a++) {
                    if (!f.periodic[a]) continue;
                    const lo = d[2 * a], hi = d[2 * a + 1], eps = (hi - lo) * 1e-9, x = pc.uv[e][a], y = pc.uv[nb][a];
                    if (Math.abs( x - lo ) <= eps && y > (lo + hi) / 2) pc.uv[e] = (a == 0 ? [hi, pc.uv[e][1]] : [pc.uv[e][0], hi]) as UV;
                    else if (Math.abs( x - hi ) <= eps && y < (lo + hi) / 2) pc.uv[e] = (a == 0 ? [lo, pc.uv[e][1]] : [pc.uv[e][0], lo]) as UV;
                }
            }
            return pieces;
        };
        return ends( BrepBoolean.pieces( f, uv, seam, points, closed ) );
    }

    private static pieces( f : BrepFace, uv : Array<UV>, seam : Array<number>, points : Array<Point>, closed : boolean ) : Array<FaceCut> {
        const n = uv.length;
        const first = seam.findIndex( m => m != 0 );
        if (first < 0) return [{ uv : uv.slice(), points : points.slice(), closed : closed }];
        const d = SurfaceIntersect.domain( f.surface );
        // the parameters of a seam vertex as seen from a neighbouring vertex
        const closedLoop = closed;
        // the parameters of a seam vertex as seen from its neighbours in one direction (+1 or -1): the first
        // neighbour not on that seam tells which end of the domain the vertex stands for
        const side = (k : number, dir : number) : UV => {
            const p : UV = [uv[k][0], uv[k][1]];
            for (let a = 0; a < 2; a++) {
                if ((seam[k] & (1 << a)) == 0) continue;
                const lo = d[2 * a], hi = d[2 * a + 1], eps = (hi - lo) * 1e-9;
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
        const pieces : Array<FaceCut> = [];
        if (closed) {
            let cur : FaceCut = { uv : [side( first, 1 )], points : [points[first]], closed : false };
            for (let s = 1; s <= n; s++) {
                const k = (first + s) % n;
                if (seam[k] != 0) {
                    cur.uv.push( side( k, -1 ) ); cur.points.push( points[k] );
                    if (cur.uv.length >= 2) pieces.push( cur );
                    cur = { uv : [side( k, 1 )], points : [points[k]], closed : false };
                } else { cur.uv.push( uv[k] ); cur.points.push( points[k] ); }
            }
            return pieces;
        }
        let cur : FaceCut = { uv : [], points : [], closed : false };
        for (let k = 0; k < n; k++) {
            if (seam[k] != 0 && k > 0 && k < n - 1) {
                cur.uv.push( side( k, -1 ) ); cur.points.push( points[k] );
                if (cur.uv.length >= 2) pieces.push( cur );
                cur = { uv : [side( k, 1 )], points : [points[k]], closed : false };
            } else if (seam[k] != 0) {
                cur.uv.push( side( k, k == 0 ? 1 : -1 ) ); cur.points.push( points[k] );
            } else { cur.uv.push( uv[k] ); cur.points.push( points[k] ); }
        }
        if (cur.uv.length >= 2) pieces.push( cur );
        return pieces;
    }

    // Triple points: where two intersection branches cross inside a face, three faces meet. For each crossing of two
    // branch polylines in one face's parameters, solve F(a) = G(b) = H(c) by Newton's method (6 equations, 6
    // unknowns) from the crossing, and insert the point into all three branches (F/G, F/H and G/H).
    public static insertTriplePoints( solids : Array<BrepSolid>, curves : BooleanResult["curves"], tol : number, same : number ) : number {
        type Use = { e : BooleanResult["curves"][0], onA : boolean };
        const byFace = new Map<string, Array<Use>>();
        const key = (s : number, f : number) => s + ":" + f;
        for (const e of curves) {
            for (let side = 0; side < 2; side++) {
                const k = key( e.solids[side], e.faces[side] );
                let l = byFace.get( k );
                if (l == null) byFace.set( k, l = [] );
                l.push( { e : e, onA : side == 0 } );
            }
        }
        const face = (s : number, f : number) => solids[s].faces[f];
        const found : Array<Point> = [];
        // whether one of two branches lies along the other all its length (allowing for the chords' sag)
        const known = new Map<IntersectionCurve, Map<IntersectionCurve, boolean>>();
        const alongOne = (x : IntersectionCurve, y : IntersectionCurve) => {
            let m = known.get( x );
            if (m == null) known.set( x, m = new Map() );
            let r = m.get( y );
            if (r == null) {
                const on = (u : IntersectionCurve, v : IntersectionCurve) => {
                    const pts = v.closed ? v.points.concat( [v.points[0]] ) : v.points;
                    return u.points.every( p => BrepBoolean.onto( pts, p, same ).on );
                };
                r = on( x, y ) || on( y, x );
                m.set( y, r );
            }
            return r;
        };
        for (const [k, uses] of byFace) {
            const parts = k.split( ":" ).map( Number );
            const F = face( parts[0], parts[1] );
            const d = SurfaceIntersect.domain( F.surface );
            const span = [d[1] - d[0], d[3] - d[2]];
            for (let x = 0; x < uses.length; x++) for (let y = x + 1; y < uses.length; y++) {
                const a = uses[x], b = uses[y];
                // the other faces of the two branches
                const oa = a.onA ? [a.e.solids[1], a.e.faces[1]] : [a.e.solids[0], a.e.faces[0]];
                const ob = b.onA ? [b.e.solids[1], b.e.faces[1]] : [b.e.solids[0], b.e.faces[0]];
                if (oa[0] == ob[0] && oa[1] == ob[1]) continue;
                // two edges of one solid meet only at its vertices, which they share already
                if (a.e.trim && b.e.trim) continue;
                // two branches along one curve (a countersink's cone meeting its hole in the plate's top plane: plate
                // and cone, plate and hole, cone and hole all meet on one circle, #92) do not cross: their chords do,
                // at shallow angles, all along it
                if (alongOne( a.e.curve, b.e.curve )) continue;
                const ua = a.onA ? a.e.curve.uvA : a.e.curve.uvB, ub = b.onA ? b.e.curve.uvA : b.e.curve.uvB;
                const na = ua.length, nb = ub.length;
                const sa = a.e.curve.closed ? na : na - 1, sb = b.e.curve.closed ? nb : nb - 1;
                const jump = (p : UV, q : UV) => (F.periodic[0] && Math.abs( p[0] - q[0] ) > span[0] / 2) || (F.periodic[1] && Math.abs( p[1] - q[1] ) > span[1] / 2);
                for (let i = 0; i < sa; i++) {
                    const p0 = ua[i], p1 = ua[(i + 1) % na];
                    if (jump( p0, p1 )) continue;
                    for (let j = 0; j < sb; j++) {
                        const q0 = ub[j], q1 = ub[(j + 1) % nb];
                        if (jump( q0, q1 )) continue;
                        // (an edge's samples fall on a branch as often as not, at a corner of a box's face: the ends count)
                        const st = BrepBoolean.segCross( p0, p1, q0, q1, span, a.e.trim || b.e.trim ? -1e-9 : 1e-9 );
                        if (st == null) continue;
                        // estimates on all three faces
                        const G = face( oa[0], oa[1] ), H = face( ob[0], ob[1] );
                        const ga = a.onA ? a.e.curve.uvB : a.e.curve.uvA, hb = b.onA ? b.e.curve.uvB : b.e.curve.uvA;
                        const uvF = Vec.lerp( 1 - st[0], p0, p1 ) as UV;
                        const uvG = SurfaceIntersect.lerpUV( BrepSolid.domainOf( G ), st[0], ga[i], ga[(i + 1) % na] );
                        const uvH = SurfaceIntersect.lerpUV( BrepSolid.domainOf( H ), st[1], hb[j], hb[(j + 1) % nb] );
                        // where a branch crosses an edge of a solid made from a shell, the two faces of the edge meet
                        // tangentially as often as not (a blend and a face it rounds), and the three-face Newton step
                        // is singular: the point is where the edge crosses the branch's other face instead
                        let r = a.e.trim || b.e.trim
                            ? BrepBoolean.edgeCross( a.e.trim ? a.e.curve : b.e.curve, a.e.trim ? i : j, a.e.trim ? st[0] : st[1],
                                                     a.e.trim ? H : G, a.e.trim ? uvH : uvG, a.e.trim ? a.onA : b.onA )
                            : BrepBoolean.triple( F, G, H, uvF, uvG, uvH, tol );
                        // the crossing on the edge's polyline is on a chord, a sag inside a curved edge: where the three
                        // faces meet transversally it goes onto them, as the branch along H ends there (an upright's side
                        // crossing a rounded corner of the foot it shares a bottom with, #123); a point that does not
                        // settle within a fraction of the chord keeps the chord's
                        if (r != null && (a.e.trim || b.e.trim)) {
                            const E = a.e.trim ? a.e.curve : b.e.curve, at = a.e.trim ? i : j, nE = E.points.length;
                            const chord = Vec.dist( E.points[at], E.points[(at + 1) % nE] );
                            const x = BrepBoolean.triple( F, a.e.trim ? G : H, a.e.trim ? H : G, r.uvF, r.uvG, r.uvH, tol );
                            if (x != null && Vec.dist( x.point, r.point ) < 0.25 * chord) r = x;
                        }
                        // (edgeCross gives the edge's other face second: here that is H when b is the edge)
                        if (r != null && b.e.trim) r = { point : r.point, uvF : r.uvF, uvG : r.uvH, uvH : r.uvG };
                        if (r == null) continue;
                        // a point found already, from another pair of the faces meeting there (four faces meet where
                        // a layer's edge crosses the edge of the cap it stands on, #104): the same point goes into
                        // these branches too
                        const prev = found.find( p => Vec.dist( p, r!.point ) < same );
                        if (prev != null) r = { ...r, point : prev };
                        else found.push( r.point );
                        // the three branches through the point: F/G (a), F/H (b) and G/H (looked up)
                        const uvOf = (s : number, f : number) => (s == parts[0] && f == parts[1]) ? r.uvF : (s == oa[0] && f == oa[1]) ? r.uvG : r.uvH;
                        const branches = curves.filter( e => {
                            const fs = [key( e.solids[0], e.faces[0] ), key( e.solids[1], e.faces[1] )];
                            const three = [k, key( oa[0], oa[1] ), key( ob[0], ob[1] )];
                            return three.includes( fs[0] ) && three.includes( fs[1] );
                        } );
                        // (a branch that has the point already keeps it where it is)
                        for (const e of branches) if (!e.curve.points.includes( r.point ))
                            BrepBoolean.insertPoint( e.curve, r.point, uvOf( e.solids[0], e.faces[0] ), uvOf( e.solids[1], e.faces[1] ), same * 20 );
                    }
                }
            }
        }
        return found.length;
    }

    // Parameters (s, t) where segments p0-p1 and q0-q1 cross (strictly inside both), measured in units of the domain
    // spans so the test is not skewed by the parameterisation; null if they do not.
    private static segCross( p0 : UV, p1 : UV, q0 : UV, q1 : UV, span : Array<number>, eps = 1e-9 ) : [number, number] | null {
        const ax = (p1[0] - p0[0]) / span[0], ay = (p1[1] - p0[1]) / span[1];
        const bx = (q1[0] - q0[0]) / span[0], by = (q1[1] - q0[1]) / span[1];
        const cx = (q0[0] - p0[0]) / span[0], cy = (q0[1] - p0[1]) / span[1];
        const den = ax * by - ay * bx;
        // (parallel, to rounding: a branch along an edge it runs beside crosses it nowhere, not at every sample)
        if (Math.abs( den ) < 1e-18 || Math.abs( den ) < 1e-9 * Math.sqrt( (ax * ax + ay * ay) * (bx * bx + by * by) )) return null;
        const s = (cx * by - cy * bx) / den, t = (cx * ay - cy * ax) / den;
        if (s <= eps || s >= 1 - eps || t <= eps || t >= 1 - eps) return null;
        return [s, t];
    }

    // Where an edge of a solid made from a shell (a polyline of points on both its faces, F and G) crosses the
    // surface of face H: the point of the polyline, near segment k at fraction t, on H (by bisection on the side of H,
    // over the segment and its neighbours). Returns it with its parameters on F (the face the crossing was found on,
    // the edge's first face when `onA`), on G (the edge's other face, along the edge's parameters) and on H.
    private static edgeCross( e : IntersectionCurve, k : number, t : number, H : BrepFace, uvH0 : UV, onA : boolean )
        : { point : Point, uvF : UV, uvG : UV, uvH : UV } | null {
        const n = e.points.length, m = e.closed ? n : n - 1;
        const at = (x : number) => {
            // position along the polyline: segment index plus fraction, wrapped on a closed edge
            let i = Math.floor( x ), f = x - i;
            if (e.closed) i = ((i % n) + n) % n; else if (i < 0) { i = 0; f = 0; } else if (i >= m) { i = m - 1; f = 1; }
            const j = (i + 1) % n;
            return { p : Vec.lerp( f, e.points[j], e.points[i] ), uvA : Vec.lerp( f, e.uvA[j], e.uvA[i] ) as UV, uvB : Vec.lerp( f, e.uvB[j], e.uvB[i] ) as UV };
        };
        let seed = uvH0;
        const side = (x : number) => {
            const q = at( x ).p, uv = SurfaceIntersect.project( H.surface, q, 12, seed );
            const D = Eval.rationalSurfaceDerivatives( H.surface, uv[0], uv[1], 1 );
            seed = uv;
            return { s : Vec.dot( Vec.sub( q, D[0][0] ), Vec.cross( D[1][0], D[0][1] ) ), uv : uv };
        };
        let lo = k + t - 1, hi = k + t + 1;
        let slo = side( lo ).s;
        seed = uvH0;
        const shi = side( hi ).s;
        if (slo * shi > 0) return null;
        let uvH = uvH0;
        for (let it = 0; it < 60; it++) {
            const mid = 0.5 * (lo + hi), sm = side( mid );
            uvH = sm.uv;
            if (sm.s * slo > 0) { lo = mid; slo = sm.s; } else hi = mid;
        }
        const x = at( 0.5 * (lo + hi) );
        const uvF = onA ? x.uvA : x.uvB, uvG = onA ? x.uvB : x.uvA;
        return { point : x.p, uvF : uvF, uvG : uvG, uvH : uvH };
    }

    // F(a) = G(b) = H(c) by Newton's method.
    private static triple( F : BrepFace, G : BrepFace, H : BrepFace, a : UV, b : UV, c : UV, tol : number ) : { point : Point, uvF : UV, uvG : UV, uvH : UV } | null {
        const DF = BrepSolid.domainOf( F ), DG = BrepSolid.domainOf( G ), DH = BrepSolid.domainOf( H );
        for (let it = 0; it < 40; it++) {
            const f = Eval.rationalSurfaceDerivatives( F.surface, a[0], a[1], 1 );
            const g = Eval.rationalSurfaceDerivatives( G.surface, b[0], b[1], 1 );
            const h = Eval.rationalSurfaceDerivatives( H.surface, c[0], c[1], 1 );
            const r1 = Vec.sub( f[0][0], g[0][0] ), r2 = Vec.sub( f[0][0], h[0][0] );
            if (Vec.norm( r1 ) < tol && Vec.norm( r2 ) < tol) {
                return { point : Vec.mul( 1 / 3, Vec.add( f[0][0], Vec.add( g[0][0], h[0][0] ) ) ), uvF : a, uvG : b, uvH : c };
            }
            const J : Array<Array<number>> = [];
            for (let k = 0; k < 3; k++) J.push( [f[1][0][k], f[0][1][k], -g[1][0][k], -g[0][1][k], 0, 0] );
            for (let k = 0; k < 3; k++) J.push( [f[1][0][k], f[0][1][k], 0, 0, -h[1][0][k], -h[0][1][k]] );
            let step : Array<number>;
            try { step = Mat.solve( J, Vec.mul( -1, r1.concat( r2 ) ) ); } catch (e) { return null; }
            if (step.some( x => !isFinite( x ) )) return null;
            a = SurfaceIntersect.toDomain( DF, [a[0] + step[0], a[1] + step[1]] );
            b = SurfaceIntersect.toDomain( DG, [b[0] + step[2], b[1] + step[3]] );
            c = SurfaceIntersect.toDomain( DH, [c[0] + step[4], c[1] + step[5]] );
        }
        return null;
    }

    // The distance from p to a polyline, the arc length along it of the nearest point, and whether p lies on it: within
    // eps, plus the sag of the exact curve the polyline samples (as in `traced`, a twentieth of the segment's length).
    private static onto( pts : Array<Point>, p : Point, eps : number = 0 ) : { d : number, s : number, on : boolean } {
        let best = Infinity, at = 0, run = 0, len = 0;
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], ab = Vec.sub( pts[i + 1], a ), l2 = Vec.dot( ab, ab ), l = Math.sqrt( l2 );
            const t = l2 > 0 ? Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( p, a ), ab ) / l2 ) ) : 0;
            const d = Vec.dist( p, Vec.add( a, Vec.mul( t, ab ) ) );
            if (d < best) { best = d; at = run + t * l; len = l; }
            run += l;
        }
        return { d : best, s : at, on : best < eps + 0.05 * len };
    }

    // The edges of a solid made from a shell that bound a face of it: the trim branches on that face, open ones.
    private static trimsOf( curves : BooleanResult["curves"], si : number, fi : number ) : Array<{ e : BooleanResult["curves"][0], uv : Array<UV> }> {
        return curves.filter( T => T.trim && T.solids[0] == si && (T.faces[0] == fi || T.faces[1] == fi) && !T.curve.closed )
            .map( T => ({ e : T, uv : T.faces[0] == fi ? T.curve.uvA : T.curve.uvB }) );
    }

    // Where faces of two solids meet only edge to edge (a hub on an arm's round end of its own radius: the arm's wall
    // meets the hub's bottom along the rim, which is an edge of each), the meshes give a branch broken into pieces
    // along it, of no use: no face is cut there. A branch that lies along an edge of a solid made from a shell on one
    // face, and along an edge or a side of the domain on the other, is dropped (#104).
    private static edgeContacts( solids : Array<BrepSolid>, curves : BooleanResult["curves"], eps : number ) : void {
        const onEdge = (si : number, fi : number, pts : Array<Point>) =>
            BrepBoolean.trimsOf( curves, si, fi ).some( T => pts.every( p => BrepBoolean.onto( T.e.curve.points, p, eps ).on ) );
        const onSide = (f : BrepFace, uv : Array<UV>) => {
            const d = SurfaceIntersect.domain( f.surface );
            for (let axis = 0; axis < 2; axis++) {
                const w = 1e-7 * (d[2 * axis + 1] - d[2 * axis]);
                for (const value of [d[2 * axis], d[2 * axis + 1]]) if (uv.every( q => Math.abs( q[axis] - value ) < w )) return true;
            }
            return false;
        };
        for (let k = curves.length - 1; k >= 0; k--) {
            const e = curves[k], c = e.curve;
            if (e.trim || e.own != null) continue;
            const edge = [0, 1].map( s => onEdge( e.solids[s], e.faces[s], c.points ) );
            if (!edge[0] && !edge[1]) continue;
            const along = [0, 1].map( s => edge[s] || onSide( solids[e.solids[s]].faces[e.faces[s]], s == 0 ? c.uvA : c.uvB ) );
            if (along[0] && along[1]) curves.splice( k, 1 );
        }
    }

    // A vertex of a solid made from a shell (an end of one of its edges) lying inside a branch on a face it bounds is
    // where the branch leaves that edge (a hub's rim runs along the arm's round end, then on across the arm's top):
    // the branch gets that very point, and its runs end there (#104).
    private static trimVertices( solids : Array<BrepSolid>, curves : BooleanResult["curves"], eps : number ) : void {
        // a vertex of one solid inside an edge of another (an upright flush with a foot's side, standing on its bottom
        // plane: the foot's corner, where its side turns into a rounded corner, lies on the upright's bottom edge) is a
        // vertex of that edge too, as of the branches through it, so the edge's faces and the branches share it (#123)
        for (const T of curves) {
            if (!T.trim || T.curve.closed) continue;
            for (const end of [0, T.curve.points.length - 1]) {
                const v = T.curve.points[end];
                for (const U of curves) {
                    if (!U.trim || U.solids[0] == T.solids[0] || U.curve.closed || U.curve.points.includes( v )) continue;
                    const P = U.curve.points;
                    if (P.some( p => Vec.dist( p, v ) < eps ) || !BrepBoolean.onto( P, v, eps ).on) continue;
                    let nearest = 0;
                    P.forEach( (p, k) => { if (Vec.dist( p, v ) < Vec.dist( P[nearest], v )) nearest = k; } );
                    const FA = solids[U.solids[0]].faces[U.faces[0]], FB = solids[U.solids[1]].faces[U.faces[1]];
                    const uvA = SurfaceIntersect.project( FA.surface, v, 12, U.curve.uvA[nearest] ), uvB = SurfaceIntersect.project( FB.surface, v, 12, U.curve.uvB[nearest] );
                    if (Vec.dist( BrepBoolean.eval( FA.surface, uvA ), v ) > eps || Vec.dist( BrepBoolean.eval( FB.surface, uvB ), v ) > eps) continue;
                    BrepBoolean.insertPoint( U.curve, v, uvA, uvB, eps );
                }
            }
        }
        for (const e of curves) {
            if (e.trim) continue;
            const c = e.curve;
            for (let side = 0; side < 2; side++) {
                const si = e.solids[side], fi = e.faces[side];
                const other = solids[e.solids[1 - side]].faces[e.faces[1 - side]];
                for (const T of BrepBoolean.trimsOf( curves, si, fi )) for (const end of [0, T.e.curve.points.length - 1]) {
                    const v = T.e.curve.points[end];
                    if (c.points.includes( v )) continue;
                    if (c.points.some( p => Vec.dist( p, v ) < eps ) && !c.closed) {
                        // (at an end of the branch the ends were joined already; elsewhere, take the vertex)
                        const k = c.points.findIndex( p => Vec.dist( p, v ) < eps );
                        if (k == 0 || k == c.points.length - 1) continue;
                    }
                    const pts = c.closed ? c.points.concat( [c.points[0]] ) : c.points;
                    if (!BrepBoolean.onto( pts, v, eps ).on) continue;
                    let nearest = 0;
                    c.points.forEach( (p, k) => { if (Vec.dist( p, v ) < Vec.dist( c.points[nearest], v )) nearest = k; } );
                    const uvO = SurfaceIntersect.project( other.surface, v, 12, (side == 0 ? c.uvB : c.uvA)[nearest] );
                    if (Vec.dist( BrepBoolean.eval( other.surface, uvO ), v ) > eps) continue;
                    const uvS = T.uv[end];
                    BrepBoolean.insertPoint( c, v, side == 0 ? [uvS[0], uvS[1]] : uvO, side == 0 ? uvO : [uvS[0], uvS[1]], eps );
                }
            }
        }
    }

    // Two branches on one face that lie along each other for a stretch of their length, and no further (two pockets of
    // one depth that overlap, their sides in one plane: each side's branch with the plate's bottom runs along the
    // other's where the sides overlap, #120), are sampled each on its own: the face takes the points of both and the
    // face across the stretch only those of one. Each takes the other's points along the stretch, so both have them all.
    private static sharedStretches( solids : Array<BrepSolid>, curves : BooleanResult["curves"], eps : number ) : void {
        const boxes = curves.map( e => {
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
            for (const p of e.curve.points) for (let a = 0; a < 3; a++) { lo[a] = Math.min( lo[a], p[a] ); hi[a] = Math.max( hi[a], p[a] ); }
            return { lo : lo, hi : hi };
        } );
        const keys = curves.map( e => [0, 1].map( m => e.solids[m] + ":" + e.faces[m] ) );
        const ring = (c : IntersectionCurve) => c.closed ? c.points.concat( [c.points[0]] ) : c.points;
        const along = (pts : Array<Point>, p : Point) => BrepBoolean.onto( pts, p, eps ).d < eps;
        const adds : Array<{ to : number, p : Point, uvA : UV, uvB : UV }> = [];
        curves.forEach( (A, ia) => curves.forEach( (B, ib) => {
            // (a branch along an edge of a solid made from a shell takes the edge's points in alongEdges, between its
            // corners; here an edge only takes a branch's, as where pockets cut one after another overlap)
            if (ia == ib || A.trim) return;
            const shared = keys[ia].findIndex( k => keys[ib].includes( k ) );
            if (shared < 0) return;
            if ([0, 1, 2].some( a => boxes[ia].lo[a] > boxes[ib].hi[a] + eps || boxes[ib].lo[a] > boxes[ia].hi[a] + eps )) return;
            const P = A.curve.points, Q = ring( B.curve ), n = P.length;
            const on = P.map( p => along( Q, p ) );
            if (!on.some( x => x )) return;
            const side = keys[ib].indexOf( keys[ia][shared] );
            const other = solids[B.solids[1 - side]].faces[B.faces[1 - side]];
            P.forEach( (p, k) => {
                if (!on[k] || B.curve.points.some( q => Vec.dist( p, q ) < eps )) return;
                // on a stretch: a neighbour on it too
                const prev = k > 0 ? k - 1 : A.curve.closed ? n - 1 : -1, next = k + 1 < n ? k + 1 : A.curve.closed ? 0 : -1;
                if (!((prev >= 0 && on[prev]) || (next >= 0 && on[next]))) return;
                let nearest = 0;
                B.curve.points.forEach( (q, j) => { if (Vec.dist( q, p ) < Vec.dist( B.curve.points[nearest], p )) nearest = j; } );
                const uvS = (shared == 0 ? A.curve.uvA : A.curve.uvB)[k];
                const uvO = SurfaceIntersect.project( other.surface, p, 12, (side == 0 ? B.curve.uvB : B.curve.uvA)[nearest] );
                if (Vec.dist( BrepBoolean.eval( other.surface, uvO ), p ) > eps) return;
                const same : UV = [uvS[0], uvS[1]];
                adds.push( { to : ib, p : [p[0], p[1], p[2]], uvA : side == 0 ? same : uvO, uvB : side == 0 ? uvO : same } );
            } );
        } ) );
        for (const a of adds) {
            const c = curves[a.to].curve;
            if (c.points.some( q => Vec.dist( q, a.p ) < eps )) continue;
            BrepBoolean.insertPoint( c, a.p, a.uvA, a.uvB, eps );
        }
    }

    // Branches that lie along an edge between two trimmed faces of one solid, on one of those faces: the cap of one
    // solid and the side of another stacked on it meet along the side's bottom edge. The branch and the edge are
    // sampled separately, so the cap's cut and the stacked solid's edge would not share their points and the result
    // would be open there. Each stretch of a branch between its corners (its ends and the points it shares with other
    // branches, where runs end) that lies along an edge takes the edge's points between its ends, with the edge's
    // parameters on the shared face and parameters projected onto its other face.
    private static alongEdges( solids : Array<BrepSolid>, curves : BooleanResult["curves"], eps : number ) : void {
        const owners = new Map<Point, number>();
        for (const e of curves) for (const p of e.curve.points) owners.set( p, (owners.get( p ) || 0) + 1 );
        const onto = BrepBoolean.onto;
        type Pt = { p : Point, uvA : UV, uvB : UV, seamA : number, seamB : number };
        for (const e of curves) {
            const c = e.curve, n = c.points.length;
            if (e.trim || n < 2) continue;
            // (a point on a seam is a corner too: it keeps its place and its flags)
            const ks = c.points.map( (_, k) => k ).filter( k => (owners.get( c.points[k] ) || 0) > 1 || c.seamA[k] != 0 || c.seamB[k] != 0 || (!c.closed && (k == 0 || k == n - 1)) );
            // a loop with no corners all along another (a pulley's bore standing on a bored hub, #121: the bore's foot
            // on the hub's top, the pulley's bottom on the hub's bore and the hub's top on its bore are one circle, found
            // three times with different samples, and each face meets the others round it): all of them take the
            // points of the finest, projected onto their faces
            if (c.closed && c.points.every( p => (owners.get( p ) || 0) <= 1 )) {
                const ring = (x : IntersectionCurve) => x.points.concat( [x.points[0]] );
                const same = curves.filter( t => t.curve.closed && t.curve.points.length >= 3
                    && c.points.every( p => onto( ring( t.curve ), p, eps ).on ) && t.curve.points.every( p => onto( ring( c ), p, eps ).on ) );
                let ref = same[0];
                for (const t of same) if (t.curve.points.length > ref.curve.points.length) ref = t;
                if (ref != null && ref != e) {
                    const FA = solids[e.solids[0]].faces[e.faces[0]], FB = solids[e.solids[1]].faces[e.faces[1]];
                    const near = (p : Point) => { let b = 0; c.points.forEach( (q, k) => { if (Vec.dist( q, p ) < Vec.dist( c.points[b], p )) b = k; } ); return b; };
                    const pts = ref.curve.points.map( q => [q[0], q[1], q[2]] as Point );
                    const uvA = pts.map( p => SurfaceIntersect.project( FA.surface, p, 12, c.uvA[near( p )] ) );
                    const uvB = pts.map( p => SurfaceIntersect.project( FB.surface, p, 12, c.uvB[near( p )] ) );
                    // on a periodic face the loop crosses the seam at one of the points, flagged as such (a parameter
                    // within rounding of the seam is on it); one whose points miss the seam keeps its own
                    const seams = (F : BrepFace, uv : Array<UV>) : Array<number> | null => {
                        const d = SurfaceIntersect.domain( F.surface ), flags = uv.map( _ => 0 );
                        for (let a = 0; a < 2; a++) {
                            if (!F.periodic[a]) continue;
                            const lo = d[2 * a], hi = d[2 * a + 1], w = 1e-9 * (hi - lo);
                            uv.forEach( (q, k) => { if (Math.abs( q[a] - lo ) <= w || Math.abs( q[a] - hi ) <= w) { q[a] = lo; flags[k] |= 1 << a; } } );
                            const wraps = uv.some( (q, k) => Math.abs( q[a] - uv[(k + 1) % uv.length][a] ) > 0.5 * (hi - lo) );
                            if (wraps && !flags.some( f => (f & (1 << a)) != 0 )) return null;
                        }
                        return flags;
                    };
                    const sA = seams( FA, uvA ), sB = seams( FB, uvB );
                    if (sA != null && sB != null && pts.every( (p, k) => Vec.dist( BrepBoolean.eval( FA.surface, uvA[k] ), p ) <= eps && Vec.dist( BrepBoolean.eval( FB.surface, uvB[k] ), p ) <= eps )) {
                        c.points = pts; c.uvA = uvA; c.uvB = uvB; c.seamA = sA; c.seamB = sB;
                    }
                }
                continue;
            }
            if (ks.length < (c.closed ? 1 : 2)) continue;
            const stretches : Array<Array<number>> = [];
            if (c.closed) {
                for (let x = 0; x < ks.length; x++) {
                    const idx : Array<number> = [];
                    for (let k = ks[x]; ; k = (k + 1) % n) { idx.push( k ); if (k == ks[(x + 1) % ks.length] && idx.length > 1) break; }
                    stretches.push( idx );
                }
            } else for (let x = 0; x + 1 < ks.length; x++) stretches.push( Array.from( { length : ks[x + 1] - ks[x] + 1 }, (_, k) => ks[x] + k ) );
            let changed = false;
            const out : Array<Array<Pt>> = stretches.map( idx => {
                const own : Array<Pt> = idx.map( k => ({ p : c.points[k], uvA : c.uvA[k], uvB : c.uvB[k], seamA : c.seamA[k], seamB : c.seamB[k] }) );
                const P = own.map( x => x.p );
                const len = onto( P, P[P.length - 1] ).s;
                if (P.length < 2 || len < 2 * eps) return own;
                for (let side = 0; side < 2; side++) {
                    const si = e.solids[side], fi = e.faces[side];
                    const edge = BrepBoolean.trimsOf( curves, si, fi ).find( T => P.every( p => onto( T.e.curve.points, p, eps ).on ) );
                    if (edge == null) continue;
                    const T = edge.e.curve, tuv = edge.uv;
                    const other = solids[e.solids[1 - side]].faces[e.faces[1 - side]];
                    const ouv = own.map( x => side == 0 ? x.uvB : x.uvA );
                    const arc = P.map( q => onto( P, q ).s );
                    const added : Array<{ s : number, x : Pt }> = [];
                    let ok = true;
                    T.points.forEach( (q, k) => {
                        if (!ok) return;
                        const o = onto( P, q, eps );
                        if (!o.on || o.s < eps || o.s > len - eps) return;
                        // the branch's parameters on the other face, interpolated at that arc length, refined onto it
                        // (from the grid if that strays: Newton from a disc's rim can fall into its pole)
                        let j = 0;
                        while (j + 2 < P.length && arc[j + 1] < o.s) j++;
                        const f = arc[j + 1] > arc[j] ? Math.max( 0, Math.min( 1, (o.s - arc[j]) / (arc[j + 1] - arc[j]) ) ) : 0;
                        const seed = SurfaceIntersect.lerpUV( BrepSolid.domainOf( other ), f, ouv[j], ouv[j + 1] );
                        const p = [q[0], q[1], q[2]] as Point;
                        let uvO = SurfaceIntersect.project( other.surface, p, 12, seed );
                        if (Vec.dist( BrepBoolean.eval( other.surface, uvO ), p ) > eps) uvO = SurfaceIntersect.project( other.surface, p, 24 );
                        if (Vec.dist( BrepBoolean.eval( other.surface, uvO ), p ) > eps) { ok = false; return; }
                        const uvS : UV = [tuv[k][0], tuv[k][1]];
                        added.push( { s : o.s, x : { p : p, uvA : side == 0 ? uvS : uvO, uvB : side == 0 ? uvO : uvS, seamA : 0, seamB : 0 } } );
                    } );
                    if (!ok || added.length == 0) continue;
                    changed = true;
                    added.sort( (x, y) => x.s - y.s );
                    return [own[0]].concat( added.map( x => x.x ), [own[own.length - 1]] );
                }
                return own;
            } );
            if (!changed) continue;
            // the stretches joined, each corner once
            const all : Array<Pt> = [];
            out.forEach( (st, x) => { for (let k = 0; k < st.length; k++) if (k > 0 || x == 0) all.push( st[k] ); } );
            if (c.closed) all.pop();
            c.points = all.map( x => x.p ); c.uvA = all.map( x => x.uvA ); c.uvB = all.map( x => x.uvB );
            c.seamA = all.map( x => x.seamA ); c.seamB = all.map( x => x.seamB );
        }
    }

    // The distance in the plane from p to the segment a-b.
    private static segDist( p : UV, a : UV, b : UV ) : number {
        const ab = [b[0] - a[0], b[1] - a[1]], l2 = ab[0] * ab[0] + ab[1] * ab[1];
        const t = l2 > 0 ? Math.max( 0, Math.min( 1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2 ) ) : 0;
        return Math.hypot( p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1] );
    }

    // Insert an exact point into a branch, in the segment it lies on (or replacing a vertex it coincides with).
    private static insertPoint( c : IntersectionCurve, p : Point, uvA : UV, uvB : UV, reach : number ) : void {
        const n = c.points.length, m = c.closed ? n : n - 1;
        let best = -1, bestD = Infinity, bestT = 0, bestL = 0;
        for (let i = 0; i < m; i++) {
            const a = c.points[i], b = c.points[(i + 1) % n];
            const ab = Vec.sub( b, a ), l2 = Vec.dot( ab, ab );
            const t = l2 > 0 ? Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( p, a ), ab ) / l2 ) ) : 0;
            const dd = Vec.dist( p, Vec.add( a, Vec.mul( t, ab ) ) );
            if (dd < bestD) { bestD = dd; best = i; bestT = t; bestL = Math.sqrt( l2 ); }
        }
        // the point lies on the exact curve, which bulges away from a coarse polyline by up to a fraction of the
        // segment's length: allow for that, while a different branch of the same pair of faces stays out of reach
        if (best < 0 || bestD > Math.max( reach, 0.15 * bestL )) return;
        const at = bestT < 1e-6 ? best : bestT > 1 - 1e-6 ? (best + 1) % n : -1;
        if (at >= 0 && c.seamA[at] == 0 && c.seamB[at] == 0) { c.points[at] = p; c.uvA[at] = uvA; c.uvB[at] = uvB; return; }
        const k = best + 1;
        // between two points on the same isoline (a trim along a face's seam, say) the new point stays on that
        // isoline: parameters copied from another branch may name the other side of a closed face's seam
        const iso = (uv : UV, q : Array<UV>) : UV => {
            const a = q[best], b = q[k % n];
            return [a[0] == b[0] ? a[0] : uv[0], a[1] == b[1] ? a[1] : uv[1]];
        };
        uvA = iso( uvA, c.uvA ); uvB = iso( uvB, c.uvB );
        c.points.splice( k, 0, p ); c.uvA.splice( k, 0, uvA ); c.uvB.splice( k, 0, uvB );
        c.seamA.splice( k, 0, 0 ); c.seamB.splice( k, 0, 0 );
    }

    // Ends of open pieces inside a face (where a branch continues on a neighbouring face of the other solid) that
    // share a 3D point also get exactly the same parameters, so the face's triangulation joins them.
    private static joinEnds( f : BrepFace, cuts : Array<FaceCut> ) : void {
        const d = SurfaceIntersect.domain( f.surface );
        const onEdge = (p : UV) => Math.abs( p[0] - d[0] ) < 1e-12 || Math.abs( p[0] - d[1] ) < 1e-12 || Math.abs( p[1] - d[2] ) < 1e-12 || Math.abs( p[1] - d[3] ) < 1e-12;
        const refs : Array<{ c : FaceCut, k : number }> = [];
        for (const c of cuts) if (!c.closed) for (const k of [0, c.uv.length - 1]) if (!onEdge( c.uv[k] )) refs.push( { c : c, k : k } );
        for (let x = 0; x < refs.length; x++) for (let y = x + 1; y < refs.length; y++) {
            const a = refs[x], b = refs[y];
            if (a.c.points[a.k] === b.c.points[b.k]) b.c.uv[b.k] = a.c.uv[a.k];
        }
    }

    // Triangles of a face tessellation grouped into connected regions that do not cross a cut. Adjacency is by the
    // tessellation's own vertices, a planar triangulation of the domain in which every cut is a run of edges; on the
    // domain's sides it is by the welded vertex ids, so that regions continue across periodic seams. (Welded ids
    // everywhere would join the two sides of a cut wherever two of its points are close enough to weld into one.)
    public static regions( t : FaceTessellation ) : Array<Array<number>> {
        const parent = t.triangles.map( (_, k) => k );
        const find = (x : number) : number => { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        const key = (a : number, b : number) => a < b ? a + "," + b : b + "," + a;
        const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
        for (const p of t.uv) for (let k = 0; k < 2; k++) { lo[k] = Math.min( lo[k], p[k] ); hi[k] = Math.max( hi[k], p[k] ); }
        const onSide = (a : number, b : number) => [0, 1].some( k => [lo[k], hi[k]].some( x => t.uv[a][k] == x && t.uv[b][k] == x ) );
        const cutLocal = new Set<string>(), cutWelded = new Set<string>();
        for (const e of t.cutEdges) { cutLocal.add( key( e[0], e[1] ) ); cutWelded.add( key( t.ids[e[0]], t.ids[e[1]] ) ); }
        const byEdge = new Map<string, number>();
        t.triangles.forEach( (tri, k) => {
            for (let e = 0; e < 3; e++) {
                const i = tri[e], j = tri[(e + 1) % 3];
                const a = t.ids[i], b = t.ids[j];
                if (a == b) continue;
                const side = onSide( i, j );
                const kk = side ? "w" + key( a, b ) : key( i, j );
                if (side ? cutWelded.has( key( a, b ) ) : cutLocal.has( kk )) continue;
                const other = byEdge.get( kk );
                if (other == null) byEdge.set( kk, k ); else parent[find( k )] = find( other );
            }
        } );
        const groups = new Map<number, Array<number>>();
        t.triangles.forEach( (tri, k) => {
            if (t.ids[tri[0]] == t.ids[tri[1]] || t.ids[tri[1]] == t.ids[tri[2]] || t.ids[tri[2]] == t.ids[tri[0]]) return;
            const r = find( k );
            const g = groups.get( r );
            if (g == null) groups.set( r, [k] ); else g.push( k );
        } );
        return Array.from( groups.values() );
    }

    // Inside/outside flags of a region against every other solid, by majority over a few of its largest triangles.
    private static classify( t : FaceTessellation, region : Array<number>, own : number, meshes : Array<MeshBVH> ) : Array<boolean> {
        const area = (k : number) => {
            const tri = t.triangles[k];
            return Vec.norm( Vec.cross( Vec.sub( t.points[tri[1]], t.points[tri[0]] ), Vec.sub( t.points[tri[2]], t.points[tri[0]] ) ) );
        };
        const sample = region.slice().sort( (a, b) => area( b ) - area( a ) ).slice( 0, 5 );
        const centres = sample.map( k => {
            const tri = t.triangles[k];
            return Vec.mul( 1 / 3, Vec.add( t.points[tri[0]], Vec.add( t.points[tri[1]], t.points[tri[2]] ) ) );
        } );
        return meshes.map( (m, k) => {
            if (k == own) return false;
            const votes = centres.filter( c => m.contains( c ) ).length;
            return votes * 2 > centres.length;
        } );
    }

    // The boundary loops of a region, in the face's parameters.
    // The loops of a face made of its own triangles (a blend, a corner patch), with each vertex's parameters; triangles
    // turned for a reversed face are turned back, so the loops run as those of the operands' faces do
    private static surfaceLoops( triangles : Array<[number, number, number]>, uv : Array<UV>, reversed : boolean ) : Array<Array<UV>> {
        const tris = triangles.map( t => (reversed ? [t[0], t[2], t[1]] : [t[0], t[1], t[2]]) as [number, number, number] );
        return BrepBoolean.loops( { triangles : tris, uv : uv }, tris.map( (_, k) => k ) );
    }

    private static loops( t : { triangles : Array<Array<number>>, uv : Array<UV> }, region : Array<number> ) : Array<Array<UV>> {
        const next = new Map<number, number>();
        const has = new Set<string>();
        for (const k of region) { const tri = t.triangles[k]; for (let e = 0; e < 3; e++) has.add( tri[e] + "," + tri[(e + 1) % 3] ); }
        for (const k of region) {
            const tri = t.triangles[k];
            for (let e = 0; e < 3; e++) {
                const a = tri[e], b = tri[(e + 1) % 3];
                if (!has.has( b + "," + a )) next.set( a, b );
            }
        }
        const out : Array<Array<UV>> = [];
        const seen = new Set<number>();
        for (const start of next.keys()) {
            if (seen.has( start )) continue;
            const loop : Array<UV> = [];
            let v = start;
            while (!seen.has( v ) && next.has( v )) { seen.add( v ); loop.push( t.uv[v] ); v = next.get( v )!; }
            out.push( BrepBoolean.simplify( loop ) );
        }
        return out;
    }

    // drop vertices in the middle of straight runs along a domain edge
    private static simplify( loop : Array<UV> ) : Array<UV> {
        const n = loop.length;
        if (n < 4) return loop;
        const same = (a : UV, b : UV, c : UV, k : number) => a[k] == b[k] && b[k] == c[k];
        return loop.filter( (p, i) => {
            const a = loop[(i - 1 + n) % n], c = loop[(i + 1) % n];
            return !(same( a, p, c, 0 ) || same( a, p, c, 1 ));
        } );
    }

    private static eval( s : BrepFace["surface"], uv : UV ) : Point {
        return Eval.rationalSurfacePoint( s, uv[0], uv[1] );
    }

    // the smaller grid cell of a face, in model units
    private static cell( f : BrepFace ) : number {
        const b = BrepSolid.faceBox( f );
        const size = Vec.dist( b.min, b.max );
        return size / Math.max( f.divs[0], f.divs[1] );
    }

    // grid used to find intersection branches: the face's own grid, at most 96 cells each way
    private static searchDivs( f : BrepFace ) : [number, number] {
        return [Math.min( 96, Math.max( 8, f.divs[0] ) ), Math.min( 96, Math.max( 8, f.divs[1] ) )];
    }

    // For each face of each operand, a box around the part of it that can be on the result's boundary, or null when
    // there are only two operands. A point of operand L's face is on the boundary only where L matters: where
    // `expr` changes when L's membership flips, the others' held (J. R. Rossignac, H. B. Voelcker, "Active zones in
    // CSG for accelerating boundary evaluation, redundancy elimination, interference detection, and shading
    // algorithms", ACM Transactions on Graphics 8(1), 1989). Each triangle of the face's mesh is tested against
    // every other operand: out of it when their boxes miss, inside or outside it (by its mesh) when no triangle of it
    // comes within both meshes' distance from their exact faces, and undecided otherwise. The triangle is kept when
    // some choice for the undecided operands makes L matter, or makes an undecided operand matter (a face that
    // coincides with another operand's, like the hub cylinders of windows cut one after another, is split along
    // that one's edges too). A pair of faces whose boxes of kept triangles miss has no branch on the result: when
    // windows are cut one after another, the faces of different windows are not paired. Up to 16 operands (a truth
    // table of the expression); with more, or only two, every pair whose face boxes meet is intersected.
    private static activeBoxes( solids : Array<BrepSolid>, meshes : Array<MeshBVH>, expr : (inside : Array<boolean>) => boolean ) : Array<Array<{ min : Point, max : Point }>> | null {
        const n = solids.length;
        if (n < 3 || n > 16) return null;
        const empty = () => ({ min : [Infinity, Infinity, Infinity] as Point, max : [-Infinity, -Infinity, -Infinity] as Point });
        // each face's own mesh, and how far an operand's mesh may be from its exact faces: twice the largest gap
        // between a triangle's centroid and the surface at its parameters (a chord's sag peaks inside it), or a cell
        // of the coarsest face when the operand brings its own mesh
        const faceMeshes = solids.map( s => s.faces.map( f => FaceMesher.mesh( f, [], new Welder( s.weldTolerance() ) ) ) );
        const margin = solids.map( (s, L) => {
            if (s.boundary != null) return Math.max( ...s.faces.map( f => BrepBoolean.cell( f ) ) ) + s.weldTolerance();
            let sag = 0;
            s.faces.forEach( (f, fi) => { const t = faceMeshes[L][fi]; for (const tri of t.triangles) {
                const uv : UV = [(t.uv[tri[0]][0] + t.uv[tri[1]][0] + t.uv[tri[2]][0]) / 3, (t.uv[tri[0]][1] + t.uv[tri[1]][1] + t.uv[tri[2]][1]) / 3];
                const c = [0, 1, 2].map( k => (t.points[tri[0]][k] + t.points[tri[1]][k] + t.points[tri[2]][k]) / 3 );
                sag = Math.max( sag, Vec.dist( Eval.rationalSurfacePoint( f.surface, uv[0], uv[1] ), c ) );
            } } );
            return 2 * sag + s.weldTolerance();
        } );
        const boxes = solids.map( s => s.boundingBox() );
        const flags = new Array<boolean>( n ).fill( false );
        const unknown : Array<number> = [];
        // the expression's truth table, by bit mask of the operands a point is inside, and whether operand X matters
        // for some choice of the operands in `free` (X aside), the others as in `flags`
        const table = new Uint8Array( 1 << n );
        const bits = new Array<boolean>( n );
        for (let m = 0; m < table.length; m++) {
            for (let k = 0; k < n; k++) bits[k] = ((m >> k) & 1) == 1;
            table[m] = expr( bits ) ? 1 : 0;
        }
        const matters = (X : number, free : Array<number>) : boolean => {
            const vary = free.filter( k => k != X );
            if (vary.length > 12) return true;
            let base = 0;
            for (let k = 0; k < n; k++) if (flags[k] && k != X && !vary.includes( k )) base |= 1 << k;
            const x = 1 << X;
            for (let m = 0; m < (1 << vary.length); m++) {
                let mask = base;
                for (let b = 0; b < vary.length; b++) if ((m >> b) & 1) mask |= 1 << vary[b];
                if (table[mask | x] != table[mask]) return true;
            }
            return false;
        };
        // a group of triangles of L's face is tested as one box, and split in two along its longest side while it
        // may be on the boundary: large regions away from it are settled at once, the boundary found triangle by
        // triangle
        const test = (L : number, lo : Point, hi : Point) : boolean => {
            unknown.length = 0;
            const mid = [0, 1, 2].map( c => (lo[c] + hi[c]) / 2 ) as Point;
            for (let k = 0; k < n; k++) {
                if (k == L) continue;
                const m = margin[k];
                const lo2 = lo.map( x => x - m ) as Point, hi2 = hi.map( x => x + m ) as Point;
                if (!BrepBoolean.boxesOverlap( { min : lo2, max : hi2 }, boxes[k] )) flags[k] = false;
                else if (!meshes[k].overlaps( lo2, hi2 )) flags[k] = meshes[k].contains( mid );
                else unknown.push( k );
            }
            // on the boundary where L matters, or near the boundary of an operand that matters there: the Boolean
            // splits a face that coincides with another operand's along that one's edges too
            if (matters( L, unknown )) return true;
            const near = unknown.slice();
            return near.some( K => matters( K, near.concat( [L] ) ) );
        };
        return solids.map( (s, L) => s.faces.map( (f, fi) => {
            const t = faceMeshes[L][fi];
            const out = empty();
            const tri = t.triangles.map( x => {
                const P = x.map( k => t.points[k] );
                return { lo : [0, 1, 2].map( c => Math.min( P[0][c], P[1][c], P[2][c] ) - margin[L] ) as Point,
                         hi : [0, 1, 2].map( c => Math.max( P[0][c], P[1][c], P[2][c] ) + margin[L] ) as Point };
            } );
            const visit = (group : typeof tri) : void => {
                const lo = [0, 1, 2].map( c => Math.min( ...group.map( g => g.lo[c] ) ) ) as Point;
                const hi = [0, 1, 2].map( c => Math.max( ...group.map( g => g.hi[c] ) ) ) as Point;
                if (!test( L, lo, hi )) return;
                if (group.length == 1) {
                    for (let c = 0; c < 3; c++) { out.min[c] = Math.min( out.min[c], lo[c] ); out.max[c] = Math.max( out.max[c], hi[c] ); }
                    return;
                }
                let axis = 0;
                for (let c = 1; c < 3; c++) if (hi[c] - lo[c] > hi[axis] - lo[axis]) axis = c;
                const sorted = group.slice().sort( (x, y) => (x.lo[axis] + x.hi[axis]) - (y.lo[axis] + y.hi[axis]) );
                const h = sorted.length >> 1;
                visit( sorted.slice( 0, h ) ); visit( sorted.slice( h ) );
            };
            if (tri.length > 0) visit( tri );
            return out;
        } ) );
    }

    private static boxesOverlap( a : { min : Point, max : Point }, b : { min : Point, max : Point } ) : boolean {
        for (let k = 0; k < 3; k++) if (a.max[k] < b.min[k] || b.max[k] < a.min[k]) return false;
        return true;
    }
}

