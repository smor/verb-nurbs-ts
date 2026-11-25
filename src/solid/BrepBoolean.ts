import { Point, UV } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { BrepFace, BrepSolid, FaceCut, FaceMesher, FaceTessellation, Welder } from "./Brep.js";
import { IntersectionCurve, SurfaceIntersect } from "./SurfaceIntersect.js";
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
}

export interface BooleanResult {
    mesh : TriMesh;
    faces : Array<TrimmedFace>;
    curves : Array<{ solids : [number, number], faces : [number, number], curve : IntersectionCurve }>;
    report : {
        manifold : ManifoldReport;
        volume : number;
        intersectionCurves : number;
        // the largest distance between the two surfaces at the vertices of the intersection curves
        maxCurveError : number;
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
        let meshes = solids.map( s => s.tessellate() );

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
                for (let c of found) {
                    if (!c.closed) throw "Boolean: faces '" + fa.name + "' and '" + fb.name + "' meet along an open curve, which is not supported yet";
                    curves.push( { solids : [i, j], faces : [ia, ib], curve : c } );
                    cuts[i][ia].push( ...BrepBoolean.facePieces( fa, c.uvA, c.seamA, c.points ) );
                    cuts[j][ib].push( ...BrepBoolean.facePieces( fb, c.uvB, c.seamB, c.points ) );
                    for (let k = 0; k < c.points.length; k++) {
                        let pa = BrepSolid.domainOf( fa ), pb = BrepSolid.domainOf( fb );
                        let e = Vec.dist( BrepBoolean.eval( pa.surface, c.uvA[k] ), BrepBoolean.eval( pb.surface, c.uvB[k] ) );
                        maxErr = Math.max( maxErr, e );
                    }
                }
            } ) );
        }

        // 2.-5. tessellate, group, classify, keep
        let welder = new Welder( weldTol );
        let out = new TriMesh();
        let faces : Array<TrimmedFace> = [];
        solids.forEach( (solid, si) => solid.faces.forEach( (face, fi) => {
            let t = FaceMesher.mesh( face, cuts[si][fi], welder );
            let regions = BrepBoolean.regions( t );
            for (let reg of regions) {
                let inside = BrepBoolean.classify( t, reg, si, meshes );
                let fin = expr( inside.map( (x, k) => k == si ? true : x ) );
                let fout = expr( inside.map( (x, k) => k == si ? false : x ) );
                if (fin == fout) continue;
                let flip = face.reversed != !fin; // keep the material side of the result behind the face
                for (let k of reg) {
                    let tri = t.triangles[k];
                    let a = t.ids[tri[0]], b = t.ids[tri[1]], c = t.ids[tri[2]];
                    if (flip) out.addTriangle( a, c, b ); else out.addTriangle( a, b, c );
                }
                faces.push( { solid : si, face : fi, name : face.name != null ? face.name : "", surface : face.surface,
                              reversed : flip, loops : BrepBoolean.loops( t, reg ) } );
            }
        } ) );
        out.vertices = welder.mesh.vertices;
        out.compact();
        return { mesh : out, faces : faces, curves : curves, report : {
            manifold : out.checkClosedManifold(), volume : out.signedVolume(), intersectionCurves : curves.length, maxCurveError : maxErr } };
    }

    // Split a curve, given by its parameters on one face, into the polylines it makes in that face's domain: a loop
    // that crosses a seam is cut there, and the seam vertex appears at both ends of the domain.
    public static facePieces( f : BrepFace, uv : Array<UV>, seam : Array<number>, points : Array<Point> ) : Array<FaceCut> {
        let n = uv.length;
        let first = seam.findIndex( m => m != 0 );
        if (first < 0) return [{ uv : uv.slice(), points : points.slice(), closed : true }];
        let d = SurfaceIntersect.domain( f.surface );
        // the parameters of a seam vertex as seen from a neighbouring vertex
        let side = (k : number, nb : number) : UV => {
            let p : UV = [uv[k][0], uv[k][1]];
            for (let a = 0; a < 2; a++) {
                if ((seam[k] & (1 << a)) == 0) continue;
                let lo = d[2 * a], hi = d[2 * a + 1];
                p[a] = uv[nb][a] > (lo + hi) / 2 ? hi : lo;
            }
            return p;
        };
        let pieces : Array<FaceCut> = [];
        let cur : FaceCut = { uv : [side( first, (first + 1) % n )], points : [points[first]], closed : false };
        for (let s = 1; s <= n; s++) {
            let k = (first + s) % n;
            if (seam[k] != 0) {
                let prev = (k - 1 + n) % n;
                cur.uv.push( side( k, prev ) ); cur.points.push( points[k] );
                if (cur.uv.length >= 2) pieces.push( cur );
                cur = { uv : [side( k, (k + 1) % n )], points : [points[k]], closed : false };
            } else {
                cur.uv.push( uv[k] ); cur.points.push( points[k] );
            }
        }
        return pieces;
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
    private static classify( t : FaceTessellation, region : Array<number>, own : number, meshes : Array<TriMesh> ) : Array<boolean> {
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
            let votes = centres.filter( c => m.containsPoint( c ) ).length;
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

