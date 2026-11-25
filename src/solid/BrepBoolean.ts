import { Point, UV } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { BrepFace, BrepSolid, FaceCut, FaceMesher, FaceTessellation, Welder } from "./Brep.js";
import { IntersectionCurve, SurfaceIntersect } from "./SurfaceIntersect.js";
import { MeshBVH } from "./MeshBVH.js";
import { Fillet, FilletResult, FilletSide } from "./Fillet.js";
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
    // that ends at corners is rounded where each corner joins it to one other rounded edge across a sharp one.
    fillet? : number | ((curve : { solids : [number, number], faces : [number, number] }, index : number) => number);
}

export interface BooleanResult {
    mesh : TriMesh;
    faces : Array<TrimmedFace>;
    // for each triangle of the mesh, the index of its face in `faces`
    faceOf : Array<number>;
    curves : Array<{ solids : [number, number], faces : [number, number], curve : IntersectionCurve }>;
    // the rolling-ball blends added, with the index of the edge each one rounds
    fillets : Array<{ curve : number, radius : number, blend : FilletResult }>;
    // ball corners, where three fillets of one radius meet: the ball's centre and radius, and the corner's face in
    // `faces`
    corners : Array<{ centre : Point, radius : number, face : number }>;
    report : {
        manifold : ManifoldReport;
        volume : number;
        intersectionCurves : number;
        // the largest distance between the two surfaces at the vertices of the intersection curves
        maxCurveError : number;
        // edges rounded; edges that asked for a fillet the ball could not roll along (too large a radius); and edges
        // left sharp because a corner they end at is not one `FilletCorner` builds (or a neighbour's corner failed)
        fillets : number;
        filletsFailed : number;
        filletsSkipped : number;
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
        let o = options != null ? options : {};
        let tol = o.tolerance != null ? o.tolerance : 1e-9;
        let weldTol = Math.max( ...solids.map( s => s.weldTolerance() ) );
        let meshes = solids.map( s => new MeshBVH( s.tessellate() ) );

        // 1. intersections
        let cuts : Array<Array<Array<FaceCut>>> = solids.map( s => s.faces.map( _ => [] as Array<FaceCut> ) );
        let curves : BooleanResult["curves"] = [];
        let maxErr = 0.0;
        for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
            solids[i].faces.forEach( (fa, ia) => solids[j].faces.forEach( (fb, ib) => {
                if (!BrepBoolean.boxesOverlap( BrepSolid.faceBox( fa ), BrepSolid.faceBox( fb ) )) return;
                let step = o.step != null ? o.step : Math.min( BrepBoolean.cell( fa ), BrepBoolean.cell( fb ) );
                let found = SurfaceIntersect.surfaces( BrepSolid.domainOf( fa ), BrepSolid.domainOf( fb ), {
                    divsA : BrepBoolean.searchDivs( fa ), divsB : BrepBoolean.searchDivs( fb ), step : step, tolerance : tol } );
                for (let c of BrepBoolean.dropRetraces( found, 0.02 * step ))
                    curves.push( { solids : [i, j], faces : [ia, ib], curve : BrepBoolean.cleanSeams( c, fa, fb ) } );
            } ) );
        }

        // where branches cross inside a face, three faces meet at one point: find it exactly and put it in every
        // branch through it, so the faces share it
        BrepBoolean.insertTriplePoints( solids, curves, tol, weldTol * 50 );

        // branches that cross an edge between two faces of a solid end there, on each side, at points computed
        // separately: give the ends that meet one shared point
        let ends : Array<{ c : IntersectionCurve, k : number }> = [];
        for (let e of curves) if (!e.curve.closed) { ends.push( { c : e.curve, k : 0 } ); ends.push( { c : e.curve, k : e.curve.points.length - 1 } ); }
        let snap = weldTol * 50;
        for (let x = 0; x < ends.length; x++) for (let y = x + 1; y < ends.length; y++) {
            let p = ends[x].c.points[ends[x].k], q = ends[y].c.points[ends[y].k];
            if (p !== q && Vec.dist( p, q ) < snap) ends[y].c.points[ends[y].k] = p;
        }

        // the edges of the result: runs of each branch between corners, the points where it meets another branch
        let owners = new Map<Point, Set<number>>();
        curves.forEach( (e, ci) => { for (let p of e.curve.points) {
            let set = owners.get( p );
            if (set == null) owners.set( p, set = new Set<number>() );
            set.add( ci );
        } } );
        let isCorner = (p : Point) => (owners.get( p ) as Set<number>).size > 1;
        type Run = { ci : number, curve : IntersectionCurve, sides : [FilletSide, FilletSide] | null, radius : number };
        let runs : Array<Run> = [];
        curves.forEach( (e, ci) => {
            let c = e.curve, n = c.points.length;
            let take = (idx : Array<number>, closed : boolean) => {
                let run : IntersectionCurve = { points : idx.map( k => c.points[k] ), uvA : idx.map( k => c.uvA[k] ), uvB : idx.map( k => c.uvB[k] ),
                                                seamA : idx.map( k => c.seamA[k] ), seamB : idx.map( k => c.seamB[k] ), closed : closed };
                let mid = run.points[run.points.length >> 1];
                if (!closed && run.points.length == 2) mid = Vec.lerp( 0.5, run.points[0], run.points[1] );
                runs.push( { ci : ci, curve : run, sides : BrepBoolean.sides( solids, meshes, expr, e, mid ), radius : 0 } );
            };
            let ks = c.points.map( (_, k) => k ).filter( k => isCorner( c.points[k] ) );
            if (c.closed && ks.length == 0) { take( c.points.map( (_, k) => k ), true ); return; }
            if (c.closed) {
                for (let x = 0; x < ks.length; x++) {
                    let idx : Array<number> = [];
                    for (let k = ks[x]; ; k = (k + 1) % n) { idx.push( k ); if (k == ks[(x + 1) % ks.length] && idx.length > 1) break; }
                    take( idx, false );
                }
                return;
            }
            let at = [0].concat( ks.filter( k => k > 0 && k < n - 1 ), [n - 1] );
            for (let x = 0; x + 1 < at.length; x++) take( Array.from( { length : at[x + 1] - at[x] + 1 }, (_, k) => at[x] + k ), false );
        } );

        // rolling-ball fillets: the contact curves are extra cuts (tagged runs.length + the run's index); the strip of
        // each face between the edge and its contact curve is dropped, and the blend takes its place. A blend along an
        // open edge ends at corners, where it meets another blend along a mitre (`FilletCorner`).
        let blends : Array<FilletResult> = [];
        let filletInfo : BooleanResult["fillets"] = [];
        let failed = 0, skipped = 0;
        let closedBlends = new Map<number, FilletResult>();
        let openBlends = new Map<number, OpenBlend>();
        if (o.fillet != null) runs.forEach( (r, g) => {
            if (r.sides == null) return;
            let e = curves[r.ci];
            r.radius = typeof o.fillet == "number" ? o.fillet : o.fillet( { solids : e.solids, faces : e.faces }, r.ci );
            if (!(r.radius > 0)) return;
            let A = r.sides[0], B = r.sides[1];
            if (r.curve.closed) {
                let fr = Fillet.rollingBall( A, B, r.curve, r.radius, tol );
                if (fr == null) failed++; else closedBlends.set( g, fr );
                return;
            }
            let sec = Fillet.sections( A, B, r.curve, r.radius, tol );
            if (sec == null) { failed++; return; }
            openBlends.set( g, FilletCorner.open( A, B, sec, r.radius ) );
        } );
        // corners: the ends of the runs that are edges of the result
        let key = (s : number, f : number) => s + ":" + f;
        let faceKeys = (g : number) => { let e = curves[runs[g].ci]; return [key( e.solids[0], e.faces[0] ), key( e.solids[1], e.faces[1] )]; };
        let corners = new Map<Point, Array<{ g : number, end : number }>>();
        runs.forEach( (r, g) => {
            if (r.sides == null || r.curve.closed) return;
            let pts = r.curve.points;
            for (let end = 0; end < 2; end++) {
                let p = pts[end == 0 ? 0 : pts.length - 1];
                let l = corners.get( p );
                if (l == null) corners.set( p, l = [] );
                l.push( { g : g, end : end } );
            }
        } );
        let unsupported = new Set<number>();
        let inserts : Array<{ g : [number, number], insert : () => void }> = [];
        let balls : Array<{ g : Array<number>, patch : NonNullable<ReturnType<typeof FilletCorner.ball>> }> = [];
        let partners = new Map<number, Array<number>>();
        for (let [P, at] of corners) {
            let filleted = at.filter( x => openBlends.has( x.g ) );
            if (filleted.length == 0) continue;
            let others = at.filter( x => !openBlends.has( x.g ) );
            let ok = false;
            if (filleted.length == 2 && others.length <= 1 && filleted[0].g != filleted[1].g) {
                let x1 = filleted[0], x2 = filleted[1];
                let k1 = faceKeys( x1.g ), k2 = faceKeys( x2.g );
                let common = k1.filter( k => k2.includes( k ) );
                if (common.length == 1) {
                    let b1 = k1.indexOf( common[0] ), b2 = k2.indexOf( common[0] );
                    let a1k = k1[1 - b1], a2k = k2[1 - b2];
                    let face = (k : string) => { let q = k.split( ":" ).map( Number ); return solids[q[0]].faces[q[1]]; };
                    let F1 = openBlends.get( x1.g ) as OpenBlend, F2 = openBlends.get( x2.g ) as OpenBlend;
                    let third : ThirdEdge | null = null;
                    if (others.length == 1) {
                        let t = runs[others[0].g], tk = faceKeys( others[0].g );
                        if (tk.includes( a1k ) && tk.includes( a2k ) && a1k != a2k)
                            third = { kind : "curve", curve : t.curve, a1IsA : tk[0] == a1k, a1 : face( a1k ), a2 : face( a2k ), atStart : others[0].end == 0 };
                    } else if (a1k.split( ":" )[0] == a2k.split( ":" )[0]) {
                        // an edge between two faces of one solid: the side of each face's domain that P lies on
                        let sideOf = (x : { g : number, end : number }, bSide : number) => {
                            let c = runs[x.g].curve, k = x.end == 0 ? 0 : c.points.length - 1;
                            let F = bSide == 0 ? runs[x.g].sides![1].face : runs[x.g].sides![0].face;
                            let uv = bSide == 0 ? c.uvB[k] : c.uvA[k];
                            let d = SurfaceIntersect.domain( F.surface );
                            for (let ax = 0; ax < 2; ax++) {
                                if (F.periodic[ax]) continue;
                                let span = d[2 * ax + 1] - d[2 * ax];
                                for (let v of [d[2 * ax], d[2 * ax + 1]]) if (Math.abs( uv[ax] - v ) < 1e-9 * span) return { axis : ax, value : v };
                            }
                            return null;
                        };
                        let s1 = sideOf( x1, b1 ), s2 = sideOf( x2, b2 );
                        if (s1 != null && s2 != null)
                            third = { kind : "boundary", a1 : face( a1k ), a2 : face( a2k ), axis1 : s1.axis, value1 : s1.value, axis2 : s2.axis, value2 : s2.value };
                    }
                    if (third != null) ok = FilletCorner.mitre( F1, x1.end, b1, F2, x2.end, b2, third, tol );
                    if (ok && FilletCorner.pending != null) inserts.push( { g : [x1.g, x2.g], insert : FilletCorner.pending } );
                    if (ok) {
                        for (let [g, h] of [[x1.g, x2.g], [x2.g, x1.g]]) { let l = partners.get( g ); if (l == null) partners.set( g, l = [] ); l.push( h ); }
                    }
                }
            }
            if (filleted.length == 3 && others.length == 0 && new Set( filleted.map( x => x.g ) ).size == 3) {
                let patch = FilletCorner.ball( filleted.map( x => ({ F : openBlends.get( x.g ) as OpenBlend, e : x.end, keys : faceKeys( x.g ) as [string, string] }) ), tol );
                if (patch != null) {
                    ok = true;
                    balls.push( { g : filleted.map( x => x.g ), patch : patch } );
                    for (let x of filleted) for (let y of filleted) if (x.g != y.g) {
                        let l = partners.get( x.g ); if (l == null) partners.set( x.g, l = [] ); l.push( y.g );
                    }
                }
            }
            if (!ok) for (let x of filleted) unsupported.add( x.g );
        }
        // a blend that cannot end at one of its corners takes its partners at the others with it
        let built = new Map<number, FilletResult>();
        for (let round = 0; round < 64; round++) {
            let changed = true;
            while (changed) {
                changed = false;
                for (let g of Array.from( unsupported )) for (let h of partners.get( g ) || []) if (!unsupported.has( h )) { unsupported.add( h ); changed = true; }
            }
            let again = false;
            for (let [g, F] of openBlends) {
                if (unsupported.has( g ) || built.has( g )) continue;
                let fr = FilletCorner.build( F );
                if (fr == null) { unsupported.add( g ); again = true; } else built.set( g, fr );
            }
            for (let g of Array.from( built.keys() )) if (unsupported.has( g )) built.delete( g );
            if (!again) break;
        }
        skipped = Array.from( openBlends.keys() ).filter( g => unsupported.has( g ) ).length;
        for (let x of inserts) if (built.has( x.g[0] ) && built.has( x.g[1] )) x.insert();
        let strip : Array<[number, number]> = [];
        let addBlend = (g : number, fr : FilletResult) => {
            let r = runs[g], e = curves[r.ci];
            for (let x of fr.cutA) x.tag = runs.length + g;
            for (let x of fr.cutB) x.tag = runs.length + g;
            cuts[e.solids[0]][e.faces[0]].push( ...fr.cutA );
            cuts[e.solids[1]][e.faces[1]].push( ...fr.cutB );
            blends.push( fr ); filletInfo.push( { curve : r.ci, radius : r.radius, blend : fr } );
            strip.push( [g, runs.length + g] );
        };
        runs.forEach( (_, g) => { let fr = closedBlends.get( g ) || built.get( g ); if (fr != null) addBlend( g, fr ); } );
        // ball corners whose three blends were built
        let ballPatches = balls.filter( b => b.g.every( g => built.has( g ) ) ).map( b => b.patch );

        // the runs as cuts of their faces
        runs.forEach( (r, g) => {
            let c = r.curve, e = curves[r.ci], i = e.solids[0], j = e.solids[1];
            let fa = solids[i].faces[e.faces[0]], fb = solids[j].faces[e.faces[1]];
            let tag = (x : Array<FaceCut>) => { for (let p of x) p.tag = g; return x; };
            cuts[i][e.faces[0]].push( ...tag( BrepBoolean.facePieces( fa, c.uvA, c.seamA, c.points, c.closed ) ) );
            cuts[j][e.faces[1]].push( ...tag( BrepBoolean.facePieces( fb, c.uvB, c.seamB, c.points, c.closed ) ) );
        } );
        curves.forEach( e => {
            let c = e.curve, fa = solids[e.solids[0]].faces[e.faces[0]], fb = solids[e.solids[1]].faces[e.faces[1]];
            for (let k = 0; k < c.points.length; k++) {
                let err = Vec.dist( BrepBoolean.eval( fa.surface, c.uvA[k] ), BrepBoolean.eval( fb.surface, c.uvB[k] ) );
                maxErr = Math.max( maxErr, err );
            }
        } );
        // within a face, ends of pieces that meet get the same parameters
        solids.forEach( (solid, si) => solid.faces.forEach( (face, fi) => BrepBoolean.joinEnds( face, cuts[si][fi] ) ) );

        // 2.-5. tessellate, group, classify, keep
        let welder = new Welder( weldTol );
        let out = new TriMesh();
        let faces : Array<TrimmedFace> = [];
        let faceOf : Array<number> = [];
        solids.forEach( (solid, si) => solid.faces.forEach( (face, fi) => {
            let t = FaceMesher.mesh( face, cuts[si][fi], welder );
            let regions = BrepBoolean.regions( t );
            for (let reg of regions) {
                if (strip.length > 0) {
                    let tags = BrepBoolean.regionTags( t, reg );
                    if (strip.some( x => tags.has( x[0] ) && tags.has( x[1] ) )) continue;
                }
                let inside = BrepBoolean.classify( t, reg, si, meshes );
                let fin = expr( inside.map( (x, k) => k == si ? true : x ) );
                let fout = expr( inside.map( (x, k) => k == si ? false : x ) );
                if (fin == fout) continue;
                let flip = face.reversed != !fin; // keep the material side of the result behind the face
                for (let k of reg) {
                    let tri = t.triangles[k];
                    let a = t.ids[tri[0]], b = t.ids[tri[1]], c = t.ids[tri[2]];
                    if (flip) out.addTriangle( a, c, b ); else out.addTriangle( a, b, c );
                    faceOf.push( faces.length );
                }
                faces.push( { solid : si, face : fi, name : face.name != null ? face.name : "", surface : face.surface,
                              reversed : flip, loops : BrepBoolean.loops( t, reg ) } );
            }
        } ) );
        for (let b of blends) {
            let ids = b.points.map( p => welder.id( p ) );
            for (let tri of b.triangles) { out.addTriangle( ids[tri[0]], ids[tri[1]], ids[tri[2]] ); faceOf.push( faces.length ); }
            faces.push( { solid : -1, face : -1, name : "fillet", surface : b.surface, reversed : b.reversed, loops : [] } );
        }
        let cornerInfo : BooleanResult["corners"] = [];
        for (let b of ballPatches) {
            cornerInfo.push( { centre : b.centre, radius : b.radius, face : faces.length } );
            let ids = b.points.map( p => welder.id( p ) );
            for (let tri of b.triangles) { out.addTriangle( ids[tri[0]], ids[tri[1]], ids[tri[2]] ); faceOf.push( faces.length ); }
            faces.push( { solid : -1, face : -1, name : "fillet corner", surface : b.surface, reversed : b.reversed, loops : [] } );
        }
        out.vertices = welder.mesh.vertices;
        faceOf = faceOf.filter( (_, k) => { let t = out.triangles[k]; return t[0] != t[1] && t[1] != t[2] && t[2] != t[0]; } );
        out.compact(); // drops the same degenerate triangles
        return { mesh : out, faces : faces, faceOf : faceOf, curves : curves, fillets : filletInfo, corners : cornerInfo, report : {
            manifold : out.checkClosedManifold(), volume : out.signedVolume(), intersectionCurves : curves.length, maxCurveError : maxErr,
            fillets : blends.length, filletsFailed : failed, filletsSkipped : skipped } };
    }

    // Drop a closed branch that only retraces part of another branch: where a branch ends on a face's edge, the marcher
    // can step back along it and close a loop of zero area over the same points.
    public static dropRetraces( found : Array<IntersectionCurve>, tol : number ) : Array<IntersectionCurve> {
        let near = (p : Point, c : IntersectionCurve) => {
            let q = c.points;
            for (let k = 0; k + 1 < q.length; k++) {
                let d = Vec.sub( q[k + 1], q[k] ), l2 = Vec.dot( d, d );
                let t = l2 > 0 ? Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( p, q[k] ), d ) / l2 ) ) : 0;
                if (Vec.dist( p, Vec.add( q[k], Vec.mul( t, d ) ) ) < tol) return true;
            }
            return q.length == 1 && Vec.dist( p, q[0] ) < tol;
        };
        return found.filter( c => !(c.closed && found.some( o => o !== c && o.points.length >= c.points.length && c.points.every( p => near( p, o ) ) )) );
    }

    // The rolling-ball blend of one edge, if both its faces are kept on exactly one side of it.
    // How the two faces of an edge take part in the result, judged at a point of the edge: null where the edge is not
    // an edge of the result (it lies inside or outside another solid that decides the expression there).
    private static sides( solids : Array<BrepSolid>, meshes : Array<MeshBVH>, expr : (inside : Array<boolean>) => boolean,
                          e : BooleanResult["curves"][0], p : Point ) : [FilletSide, FilletSide] | null {
        let i = e.solids[0], j = e.solids[1];
        let flags = solids.map( (_, k) => k == i || k == j ? false : meshes[k].contains( p ) );
        // the side of the edge kept on the face of solid `own`: inside the other solid or outside it
        let side = (own : number, other : number, face : BrepFace) : FilletSide | null => {
            let keep : Array<{ inside : boolean, fin : boolean }> = [];
            for (let x of [true, false]) {
                let f = flags.slice(); f[other] = x;
                f[own] = true; let fin = expr( f );
                f[own] = false; let fout = expr( f );
                if (fin != fout) keep.push( { inside : x, fin : fin } );
            }
            if (keep.length != 1) return null;
            let flip = face.reversed != !keep[0].fin;
            return { face : face, sign : flip ? -1 : 1, keptInsideOther : keep[0].inside };
        };
        let A = side( i, j, solids[i].faces[e.faces[0]] ), B = side( j, i, solids[j].faces[e.faces[1]] );
        if (A == null || B == null) return null;
        return [A, B];
    }

    // the tags of the cut edges around a region
    private static regionTags( t : FaceTessellation, region : Array<number> ) : Set<number> {
        let key = (a : number, b : number) => a < b ? a + "," + b : b + "," + a;
        let tagOf = new Map<string, number>();
        t.cutEdges.forEach( (e, k) => tagOf.set( key( t.ids[e[0]], t.ids[e[1]] ), t.cutTags[k] ) );
        let out = new Set<number>();
        for (let k of region) {
            let tri = t.triangles[k];
            for (let x = 0; x < 3; x++) {
                let g = tagOf.get( key( t.ids[tri[x]], t.ids[tri[(x + 1) % 3]] ) );
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
        let flag = (f : BrepFace, uv : Array<UV>, seam : Array<number>) => {
            let d = SurfaceIntersect.domain( f.surface );
            for (let k = 0; k < uv.length; k++) for (let a = 0; a < 2; a++) {
                if (!f.periodic[a]) continue;
                let lo = d[2 * a], hi = d[2 * a + 1], eps = (hi - lo) * 1e-12;
                if (Math.abs( uv[k][a] - lo ) <= eps || Math.abs( uv[k][a] - hi ) <= eps) {
                    let p : UV = [uv[k][0], uv[k][1]]; p[a] = lo; uv[k] = p;
                    seam[k] |= 1 << a;
                }
            }
        };
        flag( fa, c.uvA, c.seamA ); flag( fb, c.uvB, c.seamB );
        let scale = 0.0;
        for (let p of c.points) scale = Math.max( scale, Math.abs( p[0] ), Math.abs( p[1] ), Math.abs( p[2] ) );
        let same = 1e-10 * Math.max( 1, scale );
        let out : IntersectionCurve = { points : [], uvA : [], uvB : [], seamA : [], seamB : [], closed : c.closed };
        for (let k = 0; k < c.points.length; k++) {
            let m = out.points.length;
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
        let m = out.points.length;
        if (c.closed && m > 2 && Vec.dist( out.points[0], out.points[m - 1] ) < same) {
            out.seamA[0] |= out.seamA[m - 1]; out.seamB[0] |= out.seamB[m - 1];
            if (out.seamA[m - 1] != 0) out.uvA[0] = out.uvA[m - 1];
            if (out.seamB[m - 1] != 0) out.uvB[0] = out.uvB[m - 1];
            for (let arr of [out.points, out.uvA, out.uvB, out.seamA, out.seamB] as Array<Array<any>>) arr.pop();
        }
        return out;
    }

    // Split a curve, given by its parameters on one face, into the polylines it makes in that face's domain: a loop
    // that crosses a seam is cut there, and the seam vertex appears at both ends of the domain.
    public static facePieces( f : BrepFace, uv : Array<UV>, seam : Array<number>, points : Array<Point>, closed : boolean = true ) : Array<FaceCut> {
        let n = uv.length;
        let first = seam.findIndex( m => m != 0 );
        if (first < 0) return [{ uv : uv.slice(), points : points.slice(), closed : closed }];
        let d = SurfaceIntersect.domain( f.surface );
        // the parameters of a seam vertex as seen from a neighbouring vertex
        let closedLoop = closed;
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
        let pieces : Array<FaceCut> = [];
        if (closed) {
            let cur : FaceCut = { uv : [side( first, 1 )], points : [points[first]], closed : false };
            for (let s = 1; s <= n; s++) {
                let k = (first + s) % n;
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
        let byFace = new Map<string, Array<Use>>();
        let key = (s : number, f : number) => s + ":" + f;
        for (let e of curves) {
            for (let side = 0; side < 2; side++) {
                let k = key( e.solids[side], e.faces[side] );
                let l = byFace.get( k );
                if (l == null) byFace.set( k, l = [] );
                l.push( { e : e, onA : side == 0 } );
            }
        }
        let face = (s : number, f : number) => solids[s].faces[f];
        let found : Array<Point> = [];
        for (let [k, uses] of byFace) {
            let parts = k.split( ":" ).map( Number );
            let F = face( parts[0], parts[1] );
            let d = SurfaceIntersect.domain( F.surface );
            let span = [d[1] - d[0], d[3] - d[2]];
            for (let x = 0; x < uses.length; x++) for (let y = x + 1; y < uses.length; y++) {
                let a = uses[x], b = uses[y];
                // the other faces of the two branches
                let oa = a.onA ? [a.e.solids[1], a.e.faces[1]] : [a.e.solids[0], a.e.faces[0]];
                let ob = b.onA ? [b.e.solids[1], b.e.faces[1]] : [b.e.solids[0], b.e.faces[0]];
                if (oa[0] == ob[0] && oa[1] == ob[1]) continue;
                let ua = a.onA ? a.e.curve.uvA : a.e.curve.uvB, ub = b.onA ? b.e.curve.uvA : b.e.curve.uvB;
                let na = ua.length, nb = ub.length;
                let sa = a.e.curve.closed ? na : na - 1, sb = b.e.curve.closed ? nb : nb - 1;
                let jump = (p : UV, q : UV) => (F.periodic[0] && Math.abs( p[0] - q[0] ) > span[0] / 2) || (F.periodic[1] && Math.abs( p[1] - q[1] ) > span[1] / 2);
                for (let i = 0; i < sa; i++) {
                    let p0 = ua[i], p1 = ua[(i + 1) % na];
                    if (jump( p0, p1 )) continue;
                    for (let j = 0; j < sb; j++) {
                        let q0 = ub[j], q1 = ub[(j + 1) % nb];
                        if (jump( q0, q1 )) continue;
                        let st = BrepBoolean.segCross( p0, p1, q0, q1, span );
                        if (st == null) continue;
                        // estimates on all three faces
                        let G = face( oa[0], oa[1] ), H = face( ob[0], ob[1] );
                        let ga = a.onA ? a.e.curve.uvB : a.e.curve.uvA, hb = b.onA ? b.e.curve.uvB : b.e.curve.uvA;
                        let uvF = Vec.lerp( 1 - st[0], p0, p1 ) as UV;
                        let uvG = SurfaceIntersect.lerpUV( BrepSolid.domainOf( G ), st[0], ga[i], ga[(i + 1) % na] );
                        let uvH = SurfaceIntersect.lerpUV( BrepSolid.domainOf( H ), st[1], hb[j], hb[(j + 1) % nb] );
                        let r = BrepBoolean.triple( F, G, H, uvF, uvG, uvH, tol );
                        if (r == null) continue;
                        if (found.some( p => Vec.dist( p, r.point ) < same )) continue;
                        found.push( r.point );
                        // the three branches through the point: F/G (a), F/H (b) and G/H (looked up)
                        let uvOf = (s : number, f : number) => (s == parts[0] && f == parts[1]) ? r.uvF : (s == oa[0] && f == oa[1]) ? r.uvG : r.uvH;
                        let branches = curves.filter( e => {
                            let fs = [key( e.solids[0], e.faces[0] ), key( e.solids[1], e.faces[1] )];
                            let three = [k, key( oa[0], oa[1] ), key( ob[0], ob[1] )];
                            return three.includes( fs[0] ) && three.includes( fs[1] );
                        } );
                        for (let e of branches) BrepBoolean.insertPoint( e.curve, r.point, uvOf( e.solids[0], e.faces[0] ), uvOf( e.solids[1], e.faces[1] ), same * 20 );
                    }
                }
            }
        }
        return found.length;
    }

    // Parameters (s, t) where segments p0-p1 and q0-q1 cross (strictly inside both), measured in units of the domain
    // spans so the test is not skewed by the parameterisation; null if they do not.
    private static segCross( p0 : UV, p1 : UV, q0 : UV, q1 : UV, span : Array<number> ) : [number, number] | null {
        let ax = (p1[0] - p0[0]) / span[0], ay = (p1[1] - p0[1]) / span[1];
        let bx = (q1[0] - q0[0]) / span[0], by = (q1[1] - q0[1]) / span[1];
        let cx = (q0[0] - p0[0]) / span[0], cy = (q0[1] - p0[1]) / span[1];
        let den = ax * by - ay * bx;
        if (Math.abs( den ) < 1e-18) return null;
        let s = (cx * by - cy * bx) / den, t = (cx * ay - cy * ax) / den;
        if (s <= 1e-9 || s >= 1 - 1e-9 || t <= 1e-9 || t >= 1 - 1e-9) return null;
        return [s, t];
    }

    // F(a) = G(b) = H(c) by Newton's method.
    private static triple( F : BrepFace, G : BrepFace, H : BrepFace, a : UV, b : UV, c : UV, tol : number ) : { point : Point, uvF : UV, uvG : UV, uvH : UV } | null {
        let DF = BrepSolid.domainOf( F ), DG = BrepSolid.domainOf( G ), DH = BrepSolid.domainOf( H );
        for (let it = 0; it < 40; it++) {
            let f = Eval.rationalSurfaceDerivatives( F.surface, a[0], a[1], 1 );
            let g = Eval.rationalSurfaceDerivatives( G.surface, b[0], b[1], 1 );
            let h = Eval.rationalSurfaceDerivatives( H.surface, c[0], c[1], 1 );
            let r1 = Vec.sub( f[0][0], g[0][0] ), r2 = Vec.sub( f[0][0], h[0][0] );
            if (Vec.norm( r1 ) < tol && Vec.norm( r2 ) < tol) {
                return { point : Vec.mul( 1 / 3, Vec.add( f[0][0], Vec.add( g[0][0], h[0][0] ) ) ), uvF : a, uvG : b, uvH : c };
            }
            let J : Array<Array<number>> = [];
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

    // Insert an exact point into a branch, in the segment it lies on (or replacing a vertex it coincides with).
    private static insertPoint( c : IntersectionCurve, p : Point, uvA : UV, uvB : UV, reach : number ) : void {
        let n = c.points.length, m = c.closed ? n : n - 1;
        let best = -1, bestD = Infinity, bestT = 0, bestL = 0;
        for (let i = 0; i < m; i++) {
            let a = c.points[i], b = c.points[(i + 1) % n];
            let ab = Vec.sub( b, a ), l2 = Vec.dot( ab, ab );
            let t = l2 > 0 ? Math.max( 0, Math.min( 1, Vec.dot( Vec.sub( p, a ), ab ) / l2 ) ) : 0;
            let dd = Vec.dist( p, Vec.add( a, Vec.mul( t, ab ) ) );
            if (dd < bestD) { bestD = dd; best = i; bestT = t; bestL = Math.sqrt( l2 ); }
        }
        // the point lies on the exact curve, which bulges away from a coarse polyline by up to a fraction of the
        // segment's length: allow for that, while a different branch of the same pair of faces stays out of reach
        if (best < 0 || bestD > Math.max( reach, 0.15 * bestL )) return;
        let at = bestT < 1e-6 ? best : bestT > 1 - 1e-6 ? (best + 1) % n : -1;
        if (at >= 0 && c.seamA[at] == 0 && c.seamB[at] == 0) { c.points[at] = p; c.uvA[at] = uvA; c.uvB[at] = uvB; return; }
        let k = best + 1;
        c.points.splice( k, 0, p ); c.uvA.splice( k, 0, uvA ); c.uvB.splice( k, 0, uvB );
        c.seamA.splice( k, 0, 0 ); c.seamB.splice( k, 0, 0 );
    }

    // Ends of open pieces inside a face (where a branch continues on a neighbouring face of the other solid) that
    // share a 3D point also get exactly the same parameters, so the face's triangulation joins them.
    private static joinEnds( f : BrepFace, cuts : Array<FaceCut> ) : void {
        let d = SurfaceIntersect.domain( f.surface );
        let onEdge = (p : UV) => Math.abs( p[0] - d[0] ) < 1e-12 || Math.abs( p[0] - d[1] ) < 1e-12 || Math.abs( p[1] - d[2] ) < 1e-12 || Math.abs( p[1] - d[3] ) < 1e-12;
        let refs : Array<{ c : FaceCut, k : number }> = [];
        for (let c of cuts) if (!c.closed) for (let k of [0, c.uv.length - 1]) if (!onEdge( c.uv[k] )) refs.push( { c : c, k : k } );
        for (let x = 0; x < refs.length; x++) for (let y = x + 1; y < refs.length; y++) {
            let a = refs[x], b = refs[y];
            if (a.c.points[a.k] === b.c.points[b.k]) b.c.uv[b.k] = a.c.uv[a.k];
        }
    }

    // Triangles of a face tessellation grouped into connected regions that do not cross a cut. Adjacency uses the
    // welded vertex ids, so regions continue across periodic seams.
    public static regions( t : FaceTessellation ) : Array<Array<number>> {
        let parent = t.triangles.map( (_, k) => k );
        let find = (x : number) : number => { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        let key = (a : number, b : number) => a < b ? a + "," + b : b + "," + a;
        let cut = new Set<string>();
        for (let e of t.cutEdges) cut.add( key( t.ids[e[0]], t.ids[e[1]] ) );
        let byEdge = new Map<string, number>();
        t.triangles.forEach( (tri, k) => {
            for (let e = 0; e < 3; e++) {
                let a = t.ids[tri[e]], b = t.ids[tri[(e + 1) % 3]];
                if (a == b) continue;
                let kk = key( a, b );
                if (cut.has( kk )) continue;
                let other = byEdge.get( kk );
                if (other == null) byEdge.set( kk, k ); else parent[find( k )] = find( other );
            }
        } );
        let groups = new Map<number, Array<number>>();
        t.triangles.forEach( (tri, k) => {
            if (t.ids[tri[0]] == t.ids[tri[1]] || t.ids[tri[1]] == t.ids[tri[2]] || t.ids[tri[2]] == t.ids[tri[0]]) return;
            let r = find( k );
            let g = groups.get( r );
            if (g == null) groups.set( r, [k] ); else g.push( k );
        } );
        return Array.from( groups.values() );
    }

    // Inside/outside flags of a region against every other solid, by majority over a few of its largest triangles.
    private static classify( t : FaceTessellation, region : Array<number>, own : number, meshes : Array<MeshBVH> ) : Array<boolean> {
        let area = (k : number) => {
            let tri = t.triangles[k];
            return Vec.norm( Vec.cross( Vec.sub( t.points[tri[1]], t.points[tri[0]] ), Vec.sub( t.points[tri[2]], t.points[tri[0]] ) ) );
        };
        let sample = region.slice().sort( (a, b) => area( b ) - area( a ) ).slice( 0, 5 );
        let centres = sample.map( k => {
            let tri = t.triangles[k];
            return Vec.mul( 1 / 3, Vec.add( t.points[tri[0]], Vec.add( t.points[tri[1]], t.points[tri[2]] ) ) );
        } );
        return meshes.map( (m, k) => {
            if (k == own) return false;
            let votes = centres.filter( c => m.contains( c ) ).length;
            return votes * 2 > centres.length;
        } );
    }

    // The boundary loops of a region, in the face's parameters.
    private static loops( t : FaceTessellation, region : Array<number> ) : Array<Array<UV>> {
        let next = new Map<number, number>();
        let has = new Set<string>();
        for (let k of region) { let tri = t.triangles[k]; for (let e = 0; e < 3; e++) has.add( tri[e] + "," + tri[(e + 1) % 3] ); }
        for (let k of region) {
            let tri = t.triangles[k];
            for (let e = 0; e < 3; e++) {
                let a = tri[e], b = tri[(e + 1) % 3];
                if (!has.has( b + "," + a )) next.set( a, b );
            }
        }
        let out : Array<Array<UV>> = [];
        let seen = new Set<number>();
        for (let start of next.keys()) {
            if (seen.has( start )) continue;
            let loop : Array<UV> = [];
            let v = start;
            while (!seen.has( v ) && next.has( v )) { seen.add( v ); loop.push( t.uv[v] ); v = next.get( v ); }
            out.push( BrepBoolean.simplify( loop ) );
        }
        return out;
    }

    // drop vertices in the middle of straight runs along a domain edge
    private static simplify( loop : Array<UV> ) : Array<UV> {
        let n = loop.length;
        if (n < 4) return loop;
        let same = (a : UV, b : UV, c : UV, k : number) => a[k] == b[k] && b[k] == c[k];
        return loop.filter( (p, i) => {
            let a = loop[(i - 1 + n) % n], c = loop[(i + 1) % n];
            return !(same( a, p, c, 0 ) || same( a, p, c, 1 ));
        } );
    }

    private static eval( s : BrepFace["surface"], uv : UV ) : Point {
        return Eval.rationalSurfacePoint( s, uv[0], uv[1] );
    }

    // the smaller grid cell of a face, in model units
    private static cell( f : BrepFace ) : number {
        let b = BrepSolid.faceBox( f );
        let size = Vec.dist( b.min, b.max );
        return size / Math.max( f.divs[0], f.divs[1] );
    }

    // grid used to find intersection branches: the face's own grid, at most 96 cells each way
    private static searchDivs( f : BrepFace ) : [number, number] {
        return [Math.min( 96, Math.max( 8, f.divs[0] ) ), Math.min( 96, Math.max( 8, f.divs[1] ) )];
    }

    private static boxesOverlap( a : { min : Point, max : Point }, b : { min : Point, max : Point } ) : boolean {
        for (let k = 0; k < 3; k++) if (a.max[k] < b.min[k] || b.max[k] < a.min[k]) return false;
        return true;
    }
}

