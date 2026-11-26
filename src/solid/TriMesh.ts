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

    // The connected pieces of the surface (triangles joined through shared vertices), each with its number of
    // triangles and its signed volume: in a closed, outward mesh a positive piece is a body, a negative one a sealed
    // void inside a body.
    public pieces() : Array<{ triangles : number, volume : number }> {
        const parent = new Int32Array( this.vertices.length );
        for (let i = 0; i < parent.length; i++) parent[i] = i;
        const find = (x : number) : number => { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        for (const t of this.triangles) {
            const a = find( t[0] );
            for (let k = 1; k < 3; k++) { const b = find( t[k] ); if (b != a) parent[b] = a; }
        }
        const index = new Map<number, number>();
        const out : Array<{ triangles : number, volume : number }> = [];
        for (const t of this.triangles) {
            const r = find( t[0] );
            let k = index.get( r );
            if (k == null) { index.set( r, k = out.length ); out.push( { triangles : 0, volume : 0 } ); }
            const a = this.vertices[t[0]], b = this.vertices[t[1]], c = this.vertices[t[2]];
            out[k].triangles++;
            out[k].volume += Vec.dot( a, Vec.cross( b, c ) ) / 6;
        }
        return out;
    }

    // The number of connected pieces of the surface (bodies and sealed voids).
    public components() : number { return this.pieces().length; }

    public checkClosedManifold() : ManifoldReport {
        // edges keyed by number (a * n + b), exact below 2^53: meshes of up to 94 million vertices. The half-edges
        // are sorted, directed and undirected, and counted in runs.
        const n = this.vertices.length;
        let degenerate = 0;
        const used = new Uint8Array( n );
        const directed = new Float64Array( 3 * this.triangles.length ), undirected = new Float64Array( 3 * this.triangles.length );
        let h = 0;
        for (const t of this.triangles) {
            if (t[0] == t[1] || t[1] == t[2] || t[0] == t[2]) { degenerate++; continue; }
            for (let k = 0; k < 3; k++) {
                const a = t[k], b = t[(k + 1) % 3];
                used[a] = 1;
                directed[h] = a * n + b;
                undirected[h++] = Math.min( a, b ) * n + Math.max( a, b );
            }
        }
        const D = directed.subarray( 0, h ).sort(), U = undirected.subarray( 0, h ).sort();
        let boundary = 0, bad = 0, edges = 0;
        for (let i = 0; i < h;) {
            let j = i + 1;
            while (j < h && U[j] == U[i]) j++;
            edges++;
            if (j - i == 1) boundary++;
            else if (j - i > 2) bad++;
            i = j;
        }
        // an edge shared by exactly two triangles is bad when both run it the same way: that directed key then
        // occurs twice and its reverse never
        const has = (key : number) => {
            let l = 0, r = h;
            while (l < r) { const m = (l + r) >> 1; if (D[m] < key) l = m + 1; else r = m; }
            return l < h && D[l] == key;
        };
        for (let i = 0; i < h;) {
            let j = i + 1;
            while (j < h && D[j] == D[i]) j++;
            if (j - i == 2) {
                const a = Math.floor( D[i] / n ), b = D[i] - a * n;
                if (!has( b * n + a )) bad++;
            }
            i = j;
        }
        let unused = 0;
        for (let i = 0; i < used.length; i++) if (!used[i]) unused++;
        const chi = (this.vertices.length - unused) - edges + (this.triangles.length - degenerate);
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

    // Where the surface passes through itself: pairs of triangles that share no vertex and cross. A closed, oriented
    // mesh can still cross itself (a sweep whose section is wider than the rail bends, a fold), and such a mesh
    // encloses no well-defined solid. Triangles are binned in a uniform grid of cells about twice the mean edge
    // length, then each pair in a cell is tested edge against triangle. Returns the number of crossing pairs and up
    // to `maxPoints` points on the crossings, for display.
    public selfIntersections( maxPoints : number = 32 ) : { pairs : number, points : Array<Point> } {
        const r = this.crossings( maxPoints );
        return { pairs : r.pairs, points : r.points };
    }

    // The indices of the triangles in `selfIntersections`' crossing pairs.
    public selfIntersectingTriangles() : Array<number> {
        return this.crossings( 0 ).triangles;
    }

    private crossings( maxPoints : number ) : { pairs : number, points : Array<Point>, triangles : Array<number> } {
        const V = this.vertices, T = this.triangles;
        if (T.length < 2) return { pairs : 0, points : [], triangles : [] };
        let edge = 0;
        for (const t of T) edge += Vec.dist( V[t[0]], V[t[1]] );
        const hit = new Set<number>();
        const h = Math.max( 2 * edge / T.length, 1e-12 );
        const bb = this.boundingBox();
        const m0 = bb.min[0], m1 = bb.min[1], m2 = bb.min[2];
        const nx = Math.floor( (bb.max[0] - m0) / h ) + 1, ny = Math.floor( (bb.max[1] - m1) / h ) + 1;
        // cells keyed by integer index; boxes in flat arrays (a degenerate triangle gets an empty box)
        const cells = new Map<number, Array<number>>();
        const lo = new Float64Array( 3 * T.length ), hi = new Float64Array( 3 * T.length );
        for (let i = 0; i < T.length; i++) {
            const t = T[i];
            if (t[0] == t[1] || t[1] == t[2] || t[2] == t[0]) {
                lo.fill( Infinity, 3 * i, 3 * i + 3 ); hi.fill( -Infinity, 3 * i, 3 * i + 3 ); continue;
            }
            const a = V[t[0]], b = V[t[1]], c = V[t[2]];
            for (let k = 0; k < 3; k++) { lo[3 * i + k] = Math.min( a[k], b[k], c[k] ); hi[3 * i + k] = Math.max( a[k], b[k], c[k] ); }
            const x0 = Math.floor( (lo[3 * i] - m0) / h ), x1 = Math.floor( (hi[3 * i] - m0) / h );
            const y0 = Math.floor( (lo[3 * i + 1] - m1) / h ), y1 = Math.floor( (hi[3 * i + 1] - m1) / h );
            const z0 = Math.floor( (lo[3 * i + 2] - m2) / h ), z1 = Math.floor( (hi[3 * i + 2] - m2) / h );
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
                const key = x + nx * (y + ny * z);
                let l = cells.get( key );
                if (l == null) cells.set( key, l = [] );
                l.push( i );
            }
        }
        const owner = (x : number, y : number, z : number) =>
            Math.floor( (x - m0) / h ) + nx * (Math.floor( (y - m1) / h ) + ny * Math.floor( (z - m2) / h ));
        const points : Array<Point> = [];
        let pairs = 0;
        for (const [key, l] of cells) for (let p = 0; p < l.length; p++) for (let q = p + 1; q < l.length; q++) {
            const i = Math.min( l[p], l[q] ), j = Math.max( l[p], l[q] );
            const I = 3 * i, J = 3 * j;
            if (lo[I] > hi[J] || lo[J] > hi[I] || lo[I + 1] > hi[J + 1] || lo[J + 1] > hi[I + 1] || lo[I + 2] > hi[J + 2] || lo[J + 2] > hi[I + 2]) continue;
            const ti = T[i], tj = T[j];
            if (ti[0] == tj[0] || ti[0] == tj[1] || ti[0] == tj[2] || ti[1] == tj[0] || ti[1] == tj[1] || ti[1] == tj[2]
                || ti[2] == tj[0] || ti[2] == tj[1] || ti[2] == tj[2]) continue;
            // test each pair once: in the cell holding the low corner of where the two boxes overlap
            if (owner( Math.max( lo[I], lo[J] ), Math.max( lo[I + 1], lo[J + 1] ), Math.max( lo[I + 2], lo[J + 2] ) ) != key) continue;
            const x = TriMesh.trianglesCross( V[ti[0]], V[ti[1]], V[ti[2]], V[tj[0]], V[tj[1]], V[tj[2]] );
            if (x != null) { pairs++; hit.add( i ); hit.add( j ); if (points.length < maxPoints) points.push( x ); }
        }
        return { pairs : pairs, points : points, triangles : [...hit] };
    }

    // A point where triangle abc and triangle def cross (an edge of one through the other), or null.
    private static trianglesCross( a : Point, b : Point, c : Point, d : Point, e : Point, f : Point ) : Point | null {
        return TriMesh.segmentTriangle( d, e, a, b, c ) ?? TriMesh.segmentTriangle( e, f, a, b, c ) ?? TriMesh.segmentTriangle( f, d, a, b, c )
            ?? TriMesh.segmentTriangle( a, b, d, e, f ) ?? TriMesh.segmentTriangle( b, c, d, e, f ) ?? TriMesh.segmentTriangle( c, a, d, e, f );
    }

    // Where segment pq passes through the inside of triangle abc (Möller–Trumbore), or null. Touching at an edge or a
    // vertex does not count, so neighbours that only meet along the surface are not reported.
    private static segmentTriangle( p : Point, q : Point, a : Point, b : Point, c : Point ) : Point | null {
        const d = Vec.sub( q, p ), e1 = Vec.sub( b, a ), e2 = Vec.sub( c, a );
        const s = Vec.cross( d, e2 ), det = Vec.dot( e1, s );
        const scale = Vec.norm( d ) * Vec.norm( e1 ) * Vec.norm( e2 );
        if (Math.abs( det ) <= 1e-12 * scale) return null;
        const r = Vec.sub( p, a ), inv = 1 / det;
        const u = Vec.dot( r, s ) * inv;
        const eps = 1e-9;
        if (u <= eps || u >= 1 - eps) return null;
        const w = Vec.cross( r, e1 ), v = Vec.dot( d, w ) * inv;
        if (v <= eps || u + v >= 1 - eps) return null;
        const t = Vec.dot( e2, w ) * inv;
        if (t <= eps || t >= 1 - eps) return null;
        return Vec.add( p, Vec.mul( t, d ) );
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
