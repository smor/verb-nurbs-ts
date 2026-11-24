import { Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";

// The flat arrays that manifold-3d's `Mesh` constructor takes: `new Manifold(new Mesh(trimesh.toManifoldMesh()))`.
export interface ManifoldMeshArrays {
    numProp : number;
    vertProperties : Float32Array;
    triVerts : Uint32Array;
}

// The outcome of `TriMesh.checkClosedManifold`.
export interface ManifoldReport {
    // true when every edge is shared by exactly two triangles that use it in opposite directions
    closedManifold : boolean;
    // edges used by only one triangle (holes)
    boundaryEdges : number;
    // edges used by more than two triangles, or twice in the same direction (bad orientation)
    badEdges : number;
    // triangles with a repeated vertex index
    degenerateTriangles : number;
    // vertices that no triangle uses
    unusedVertices : number;
    // Euler characteristic V - E + F; a closed orientable surface of genus g has 2 - 2g
    eulerCharacteristic : number;
    genus : number;
}

// An indexed triangle mesh built for solids: vertices are shared between triangles, so the mesh can be checked for
// watertightness and handed to manifold-3d for booleans.

export class TriMesh {

    public vertices : Array<Point> = [];
    public triangles : Array<Array<number>> = [];

    public addVertex( p : Point ) : number {
        this.vertices.push( p );
        return this.vertices.length - 1;
    }

    public addTriangle( a : number, b : number, c : number ) : void {
        this.triangles.push( [a, b, c] );
    }

    // Add a quad a-b-c-d (counter-clockwise seen from outside) as two triangles, split along the shorter diagonal.
    public addQuad( a : number, b : number, c : number, d : number ) : void {
        let v = this.vertices;
        if (Vec.distSquared( v[a], v[c] ) <= Vec.distSquared( v[b], v[d] )) {
            this.addTriangle( a, b, c );
            this.addTriangle( a, c, d );
        } else {
            this.addTriangle( a, b, d );
            this.addTriangle( b, c, d );
        }
    }

    public flip() : void {
        this.triangles = this.triangles.map( t => [t[0], t[2], t[1]] );
    }

    // Signed volume (positive when the triangles face outward).
    public signedVolume() : number {
        let vol = 0.0;
        for (let t of this.triangles) {
            let a = this.vertices[t[0]], b = this.vertices[t[1]], c = this.vertices[t[2]];
            vol += Vec.dot( a, Vec.cross( b, c ) ) / 6.0;
        }
        return vol;
    }

    public area() : number {
        let s = 0.0;
        for (let t of this.triangles) {
            let a = this.vertices[t[0]], b = this.vertices[t[1]], c = this.vertices[t[2]];
            s += Vec.norm( Vec.cross( Vec.sub( b, a ), Vec.sub( c, a ) ) ) / 2.0;
        }
        return s;
    }

    public boundingBox() : { min : Point, max : Point } {
        let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let p of this.vertices) for (let k = 0; k < 3; k++) { min[k] = Math.min( min[k], p[k] ); max[k] = Math.max( max[k], p[k] ); }
        return { min : min, max : max };
    }

    // Check that the mesh is a closed, consistently oriented 2-manifold, using only its connectivity.
    public checkClosedManifold() : ManifoldReport {
        let directed = new Map<string, number>();
        let undirected = new Map<string, number>();
        let degenerate = 0;
        let used = new Uint8Array( this.vertices.length );
        for (let t of this.triangles) {
            if (t[0] == t[1] || t[1] == t[2] || t[0] == t[2]) { degenerate++; continue; }
            for (let k = 0; k < 3; k++) {
                let a = t[k], b = t[(k + 1) % 3];
                used[a] = 1;
                let dk = a + "," + b;
                directed.set( dk, (directed.get( dk ) || 0) + 1 );
                let uk = Math.min( a, b ) + "," + Math.max( a, b );
                undirected.set( uk, (undirected.get( uk ) || 0) + 1 );
            }
        }
        let boundary = 0, bad = 0;
        for (let [k, n] of undirected) {
            if (n == 1) boundary++;
            else if (n > 2) bad++;
            else {
                let [a, b] = k.split( "," );
                if (directed.get( a + "," + b ) != 1 || directed.get( b + "," + a ) != 1) bad++;
            }
        }
        let unused = 0;
        for (let i = 0; i < used.length; i++) if (!used[i]) unused++;
        let chi = (this.vertices.length - unused) - undirected.size + (this.triangles.length - degenerate);
        let ok = boundary == 0 && bad == 0 && degenerate == 0;
        return {
            closedManifold : ok,
            boundaryEdges : boundary,
            badEdges : bad,
            degenerateTriangles : degenerate,
            unusedVertices : unused,
            eulerCharacteristic : chi,
            genus : ok ? (2 - chi) / 2 : NaN
        };
    }

    // Arrays for manifold-3d's `Mesh`.
    public toManifoldMesh() : ManifoldMeshArrays {
        let vp = new Float32Array( this.vertices.length * 3 );
        this.vertices.forEach( (p, i) => { vp[3*i] = p[0]; vp[3*i+1] = p[1]; vp[3*i+2] = p[2]; } );
        let tv = new Uint32Array( this.triangles.length * 3 );
        this.triangles.forEach( (t, i) => { tv[3*i] = t[0]; tv[3*i+1] = t[1]; tv[3*i+2] = t[2]; } );
        return { numProp : 3, vertProperties : vp, triVerts : tv };
    }

    public toOBJ() : string {
        let lines = this.vertices.map( p => "v " + p[0] + " " + p[1] + " " + p[2] );
        for (let t of this.triangles) lines.push( "f " + (t[0] + 1) + " " + (t[1] + 1) + " " + (t[2] + 1) );
        return lines.join( "\n" ) + "\n";
    }

    // ASCII STL
    public toSTL( name : string = "verb" ) : string {
        let out = ["solid " + name];
        for (let t of this.triangles) {
            let a = this.vertices[t[0]], b = this.vertices[t[1]], c = this.vertices[t[2]];
            let n = Vec.cross( Vec.sub( b, a ), Vec.sub( c, a ) );
            let len = Vec.norm( n );
            if (len > 0) n = Vec.mul( 1 / len, n );
            out.push( "  facet normal " + n.join( " " ) );
            out.push( "    outer loop" );
            for (let p of [a, b, c]) out.push( "      vertex " + p.join( " " ) );
            out.push( "    endloop" );
            out.push( "  endfacet" );
        }
        out.push( "endsolid " + name );
        return out.join( "\n" ) + "\n";
    }
}
