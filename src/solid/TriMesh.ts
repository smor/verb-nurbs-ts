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
        const v = this.vertices;
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
        for (const t of this.triangles) {
            const a = this.vertices[t[0]], b = this.vertices[t[1]], c = this.vertices[t[2]];
            vol += Vec.dot( a, Vec.cross( b, c ) ) / 6.0;
        }
        return vol;
    }

    public area() : number {
        let s = 0.0;
        for (const t of this.triangles) {
            const a = this.vertices[t[0]], b = this.vertices[t[1]], c = this.vertices[t[2]];
            s += Vec.norm( Vec.cross( Vec.sub( b, a ), Vec.sub( c, a ) ) ) / 2.0;
        }
        return s;
    }

    public boundingBox() : { min : Point, max : Point } {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const p of this.vertices) for (let k = 0; k < 3; k++) { min[k] = Math.min( min[k], p[k] ); max[k] = Math.max( max[k], p[k] ); }
        return { min : min, max : max };
    }

    // Check that the mesh is a closed, consistently oriented 2-manifold, using only its connectivity.
    // Whether a point is inside the closed mesh, by the parity of ray crossings. Three rays in unrelated directions
    // vote, so a ray that grazes an edge or a vertex cannot decide alone. The mesh must be closed; its orientation
    // does not matter.
    public containsPoint( p : Point ) : boolean {
        const dirs : Array<Point> = [[0.5773, 0.6123, 0.5401], [-0.7071, 0.1234, 0.6963], [0.2357, -0.9101, 0.3405]];
        let votes = 0;
        for (const d of dirs) if (this.rayCrossings( p, Vec.normalized( d ) ) % 2 == 1) votes++;
        return votes >= 2;
    }

    // Number of triangles hit by the ray p + t d, t > 0 (Moller-Trumbore, without allocation).
    public rayCrossings( p : Point, d : Point ) : number {
        let n = 0;
        const v = this.vertices;
        const px = p[0], py = p[1], pz = p[2], dx = d[0], dy = d[1], dz = d[2];
        for (const t of this.triangles) {
            const a = v[t[0]], b = v[t[1]], c = v[t[2]];
            const ax = a[0], ay = a[1], az = a[2];
            const e1x = b[0] - ax, e1y = b[1] - ay, e1z = b[2] - az;
            const e2x = c[0] - ax, e2y = c[1] - ay, e2z = c[2] - az;
            const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
            const det = e1x * hx + e1y * hy + e1z * hz;
            if (det > -1e-14 && det < 1e-14) continue;
            const f = 1.0 / det;
            const sx = px - ax, sy = py - ay, sz = pz - az;
            const u = f * (sx * hx + sy * hy + sz * hz);
            if (u < 0.0 || u > 1.0) continue;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            const w = f * (dx * qx + dy * qy + dz * qz);
            if (w < 0.0 || u + w > 1.0) continue;
            if (f * (e2x * qx + e2y * qy + e2z * qz) > 0.0) n++;
        }
        return n;
    }

    // Drop triangles with a repeated vertex and vertices no triangle uses (renumbering the rest).
    public compact() : void {
        this.triangles = this.triangles.filter( t => t[0] != t[1] && t[1] != t[2] && t[2] != t[0] );
        const used = new Int32Array( this.vertices.length ).fill( -1 );
        const verts : Array<Point> = [];
        for (const t of this.triangles) for (let k = 0; k < 3; k++) {
            if (used[t[k]] < 0) { used[t[k]] = verts.length; verts.push( this.vertices[t[k]] ); }
            t[k] = used[t[k]];
        }
        this.vertices = verts;
    }

    public checkClosedManifold() : ManifoldReport {
        const directed = new Map<string, number>();
        const undirected = new Map<string, number>();
        let degenerate = 0;
        const used = new Uint8Array( this.vertices.length );
        for (const t of this.triangles) {
            if (t[0] == t[1] || t[1] == t[2] || t[0] == t[2]) { degenerate++; continue; }
            for (let k = 0; k < 3; k++) {
                const a = t[k], b = t[(k + 1) % 3];
                used[a] = 1;
                const dk = a + "," + b;
                directed.set( dk, (directed.get( dk ) || 0) + 1 );
                const uk = Math.min( a, b ) + "," + Math.max( a, b );
                undirected.set( uk, (undirected.get( uk ) || 0) + 1 );
            }
        }
        let boundary = 0, bad = 0;
        for (const [k, n] of undirected) {
            if (n == 1) boundary++;
            else if (n > 2) bad++;
            else {
                const [a, b] = k.split( "," );
                if (directed.get( a + "," + b ) != 1 || directed.get( b + "," + a ) != 1) bad++;
            }
        }
        let unused = 0;
        for (let i = 0; i < used.length; i++) if (!used[i]) unused++;
        const chi = (this.vertices.length - unused) - undirected.size + (this.triangles.length - degenerate);
        const ok = boundary == 0 && bad == 0 && degenerate == 0;
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
        const vp = new Float32Array( this.vertices.length * 3 );
        this.vertices.forEach( (p, i) => { vp[3*i] = p[0]; vp[3*i+1] = p[1]; vp[3*i+2] = p[2]; } );
        const tv = new Uint32Array( this.triangles.length * 3 );
        this.triangles.forEach( (t, i) => { tv[3*i] = t[0]; tv[3*i+1] = t[1]; tv[3*i+2] = t[2]; } );
        return { numProp : 3, vertProperties : vp, triVerts : tv };
    }

    public toOBJ() : string {
        const lines = this.vertices.map( p => "v " + p[0] + " " + p[1] + " " + p[2] );
        for (const t of this.triangles) lines.push( "f " + (t[0] + 1) + " " + (t[1] + 1) + " " + (t[2] + 1) );
        return lines.join( "\n" ) + "\n";
    }

    // ASCII STL
    public toSTL( name : string = "verb" ) : string {
        const out = ["solid " + name];
        for (const t of this.triangles) {
            const a = this.vertices[t[0]], b = this.vertices[t[1]], c = this.vertices[t[2]];
            let n = Vec.cross( Vec.sub( b, a ), Vec.sub( c, a ) );
            const len = Vec.norm( n );
            if (len > 0) n = Vec.mul( 1 / len, n );
            out.push( "  facet normal " + n.join( " " ) );
            out.push( "    outer loop" );
            for (const p of [a, b, c]) out.push( "      vertex " + p.join( " " ) );
            out.push( "    endloop" );
            out.push( "  endfacet" );
        }
        out.push( "endsolid " + name );
        return out.join( "\n" ) + "\n";
    }
}
