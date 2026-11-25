import { NurbsSurfaceData, Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { TriMesh } from "./TriMesh.js";

// Options for `Shell.openVessel`.
export interface VesselMeshOptions {
    // number of rows of quads along each wall, from base to rim (default 48)
    divsU? : number;
    // number of quads around the vessel (default 192)
    divsV? : number;
}

// `Shell` turns NURBS walls into closed, watertight triangle meshes.

export class Shell {

    // Sample a surface on a regular grid over its whole domain. When `closedV` is true the last column (which repeats
    // the first on a closed surface) is left out, so the caller can wrap around instead of duplicating vertices.

    public static sampleGrid( surface : NurbsSurfaceData, divsU : number, divsV : number, closedV : boolean ) : Array<Array<Point>> {
        let u0 = surface.knotsU[0], u1 = surface.knotsU[surface.knotsU.length - 1];
        let v0 = surface.knotsV[0], v1 = surface.knotsV[surface.knotsV.length - 1];
        let rows : Array<Array<Point>> = [];
        let nv = closedV ? divsV : divsV + 1;
        for (let i = 0; i <= divsU; i++) {
            let u = u0 + (u1 - u0) * i / divsU;
            let row : Array<Point> = [];
            for (let j = 0; j < nv; j++) row.push( Eval.rationalSurfacePoint( surface, u, v0 + (v1 - v0) * j / divsV ) );
            rows.push( row );
        }
        return rows;
    }

    // Build a closed solid vessel from two walls.
    //
    // Both surfaces run from the base (u = start of domain) to the rim (u = end of domain) and are closed around in v.
    // The outer wall's base edge is closed with a flat floor, the inner wall's base edge with the inside floor, and a
    // band joins the two rims. Corresponding samples share vertices, so the result is watertight by construction.
    // The two floors are fans around the centroid of their edge, which requires that edge to be star-shaped around it
    // (true for any vessel whose section is a polar function r(theta)); this is checked.
    //
    //**returns**
    //
    //* an outward-facing TriMesh

    public static openVessel( outer : NurbsSurfaceData, inner : NurbsSurfaceData, options? : VesselMeshOptions ) : TriMesh {
        let divsU = options != null && options.divsU != null ? options.divsU : 48;
        let divsV = options != null && options.divsV != null ? options.divsV : 192;
        let O = Shell.sampleGrid( outer, divsU, divsV, true );
        let I = Shell.sampleGrid( inner, divsU, divsV, true );
        let mesh = new TriMesh();
        let oi = O.map( row => row.map( p => mesh.addVertex( p ) ) );
        let ii = I.map( row => row.map( p => mesh.addVertex( p ) ) );
        let n = divsV, top = divsU;
        for (let i = 0; i < divsU; i++) {
            for (let j = 0; j < n; j++) {
                let jn = (j + 1) % n;
                mesh.addQuad( oi[i][j], oi[i][jn], oi[i+1][jn], oi[i+1][j] );
                mesh.addQuad( ii[i][j], ii[i+1][j], ii[i+1][jn], ii[i][jn] );
            }
        }
        for (let j = 0; j < n; j++) {
            let jn = (j + 1) % n;
            mesh.addQuad( oi[top][j], oi[top][jn], ii[top][jn], ii[top][j] );
        }
        let c0 = mesh.addVertex( Shell.centroid( O[0] ) );
        let c1 = mesh.addVertex( Shell.centroid( I[0] ) );
        Shell.checkStarShaped( O[0], mesh.vertices[c0], "outer base" );
        Shell.checkStarShaped( I[0], mesh.vertices[c1], "inner floor" );
        for (let j = 0; j < n; j++) {
            let jn = (j + 1) % n;
            mesh.addTriangle( c0, oi[0][jn], oi[0][j] );
            mesh.addTriangle( c1, ii[0][j], ii[0][jn] );
        }
        if (mesh.signedVolume() < 0) mesh.flip();
        return mesh;
    }

    // Mesh a surface that is closed in v (a tube) into a solid. When it is also closed in u (a ring, like a swept
    // closed rail) the result is a torus-like solid of genus 1; otherwise both ends are capped with flat fans around
    // the centroid of each end ring (each ring must be star-shaped around it, which is checked).
    //
    //**returns**
    //
    //* an outward-facing TriMesh

    public static tube( surface : NurbsSurfaceData, closedU : boolean, options? : VesselMeshOptions ) : TriMesh {
        let divsU = options != null && options.divsU != null ? options.divsU : 128;
        let divsV = options != null && options.divsV != null ? options.divsV : 48;
        let G = Shell.sampleGrid( surface, divsU, divsV, true );
        if (closedU) G.pop();
        let mesh = new TriMesh();
        let idx = G.map( row => row.map( p => mesh.addVertex( p ) ) );
        let rows = idx.length, n = divsV;
        let quadRows = closedU ? rows : rows - 1;
        for (let i = 0; i < quadRows; i++) {
            let inext = (i + 1) % rows;
            for (let j = 0; j < n; j++) {
                let jn = (j + 1) % n;
                mesh.addQuad( idx[i][j], idx[i][jn], idx[inext][jn], idx[inext][j] );
            }
        }
        if (!closedU) {
            let c0 = mesh.addVertex( Shell.centroid( G[0] ) );
            let c1 = mesh.addVertex( Shell.centroid( G[rows - 1] ) );
            Shell.checkStarShaped( G[0], mesh.vertices[c0], "start cap" );
            Shell.checkStarShaped( G[rows - 1], mesh.vertices[c1], "end cap" );
            for (let j = 0; j < n; j++) {
                let jn = (j + 1) % n;
                mesh.addTriangle( c0, idx[0][jn], idx[0][j] );
                mesh.addTriangle( c1, idx[rows - 1][j], idx[rows - 1][jn] );
            }
        }
        if (mesh.signedVolume() < 0) mesh.flip();
        return mesh;
    }

    // Mesh a surface as an open sheet, with no thickness: for visual work only (it encloses no volume and cannot be
    // made). Directions marked closed wrap around instead of repeating their seam vertices.
    public static sheet( surface : NurbsSurfaceData, closed : [boolean, boolean], options? : VesselMeshOptions ) : TriMesh {
        let divsU = options != null && options.divsU != null ? options.divsU : 128;
        let divsV = options != null && options.divsV != null ? options.divsV : 16;
        let G = Shell.sampleGrid( surface, divsU, divsV, closed[1] );
        if (closed[0]) G.pop();
        let mesh = new TriMesh();
        let idx = G.map( row => row.map( p => mesh.addVertex( p ) ) );
        let rows = idx.length, cols = idx[0].length;
        let qi = closed[0] ? rows : rows - 1, qj = closed[1] ? cols : cols - 1;
        for (let i = 0; i < qi; i++) for (let j = 0; j < qj; j++) {
            let a = (i + 1) % rows, b = (j + 1) % cols;
            mesh.addQuad( idx[i][j], idx[i][b], idx[a][b], idx[a][j] );
        }
        return mesh;
    }

    // Check that a closed ring of points, seen along its average normal, turns around `center` monotonically, so a fan
    // of triangles from `center` does not fold over itself.

    public static checkStarShaped( ring : Array<Point>, center : Point, what : string ) : void {
        let normal = [0.0, 0.0, 0.0];
        for (let j = 0; j < ring.length; j++) {
            let a = Vec.sub( ring[j], center ), b = Vec.sub( ring[(j + 1) % ring.length], center );
            normal = Vec.add( normal, Vec.cross( a, b ) );
        }
        for (let j = 0; j < ring.length; j++) {
            let a = Vec.sub( ring[j], center ), b = Vec.sub( ring[(j + 1) % ring.length], center );
            if (Vec.dot( Vec.cross( a, b ), normal ) <= 0) throw "Shell: the " + what + " edge is not star-shaped around its centroid";
        }
    }

    public static centroid( pts : Array<Point> ) : Point {
        let c = [0.0, 0.0, 0.0];
        for (let p of pts) c = Vec.add( c, p );
        return Vec.mul( 1 / pts.length, c );
    }

    // True when a closed polygon, projected onto the XY plane, does not cross itself. Use it to check that a wall
    // offset has not folded over in a concave region.

    public static ringIsSimpleXY( ring : Array<Point> ) : boolean {
        let n = ring.length;
        let cross = (o : Point, a : Point, b : Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        for (let i = 0; i < n; i++) {
            let a = ring[i], b = ring[(i + 1) % n];
            for (let j = i + 2; j < n; j++) {
                if (i == 0 && j == n - 1) continue;
                let c = ring[j], d = ring[(j + 1) % n];
                let d1 = cross( c, d, a ), d2 = cross( c, d, b ), d3 = cross( a, b, c ), d4 = cross( a, b, d );
                if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return false;
            }
        }
        return true;
    }
}
