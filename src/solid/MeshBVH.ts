import { Point } from "../core/Data.js";
import { TriMesh } from "./TriMesh.js";

// A bounding volume hierarchy over the triangles of a TriMesh, for fast ray casts: the nearest hit along a ray, and
// the number of crossings (for inside/outside tests). Built once; rebuild it if the mesh changes.

export class MeshBVH {
    private tri : Float64Array;          // 9 coordinates per triangle
    private order : Int32Array;          // triangle indices, grouped by leaf
    private box : Float64Array;          // 6 per node: min xyz, max xyz
    private child : Int32Array;          // 2 per node: left, right (-1 for a leaf)
    private span : Int32Array;           // 2 per node: start, count in `order`
    private nodes = 0;

    constructor( mesh : TriMesh ) {
        const n = mesh.triangles.length;
        this.tri = new Float64Array( n * 9 );
        const cen = new Float64Array( n * 3 );
        mesh.triangles.forEach( (t, i) => {
            for (let k = 0; k < 3; k++) {
                const p = mesh.vertices[t[k]];
                for (let c = 0; c < 3; c++) { this.tri[9 * i + 3 * k + c] = p[c]; cen[3 * i + c] += p[c] / 3; }
            }
        } );
        this.order = new Int32Array( n );
        for (let i = 0; i < n; i++) this.order[i] = i;
        const cap = Math.max( 1, 2 * n );
        this.box = new Float64Array( cap * 6 );
        this.child = new Int32Array( cap * 2 );
        this.span = new Int32Array( cap * 2 );
        if (n > 0) this.build( 0, n, cen );
    }

    private build( start : number, count : number, cen : Float64Array ) : number {
        const id = this.nodes++;
        const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        const cb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let k = start; k < start + count; k++) {
            const t = this.order[k];
            for (let v = 0; v < 3; v++) for (let c = 0; c < 3; c++) {
                const x = this.tri[9 * t + 3 * v + c];
                if (x < b[c]) b[c] = x; if (x > b[3 + c]) b[3 + c] = x;
            }
            for (let c = 0; c < 3; c++) { const x = cen[3 * t + c]; if (x < cb[c]) cb[c] = x; if (x > cb[3 + c]) cb[3 + c] = x; }
        }
        for (let c = 0; c < 6; c++) this.box[6 * id + c] = b[c];
        this.span[2 * id] = start; this.span[2 * id + 1] = count;
        if (count <= 4) { this.child[2 * id] = -1; this.child[2 * id + 1] = -1; return id; }
        let axis = 0;
        for (let c = 1; c < 3; c++) if (cb[3 + c] - cb[c] > cb[3 + axis] - cb[axis]) axis = c;
        const mid = (cb[axis] + cb[3 + axis]) / 2;
        let i = start, j = start + count - 1;
        while (i <= j) {
            if (cen[3 * this.order[i] + axis] < mid) i++;
            else { const tmp = this.order[i]; this.order[i] = this.order[j]; this.order[j] = tmp; j--; }
        }
        let left = i - start;
        if (left == 0 || left == count) left = count >> 1; // all centroids equal along the axis
        const l = this.build( start, left, cen );
        const r = this.build( start + left, count - left, cen );
        this.child[2 * id] = l; this.child[2 * id + 1] = r;
        return id;
    }

    // Distance to the nearest triangle hit by the ray o + t d with t > tmin, or Infinity.
    public raycast( o : Point, d : Point, tmin : number = 0 ) : number {
        let best = Infinity;
        this.walk( o, d, (t) => { if (t > tmin && t < best) best = t; }, () => best );
        return best;
    }

    // Number of triangles crossed by the ray o + t d, t > 0.
    public crossings( o : Point, d : Point ) : number {
        let n = 0;
        this.walk( o, d, (t) => { if (t > 0) n++; }, () => Infinity );
        return n;
    }

    // Inside a closed mesh, by majority over three rays.
    public contains( p : Point ) : boolean {
        const dirs : Array<Point> = [[0.5773, 0.6123, 0.5401], [-0.7071, 0.1234, 0.6963], [0.2357, -0.9101, 0.3405]];
        let v = 0;
        for (const d of dirs) {
            const l = Math.hypot( d[0], d[1], d[2] );
            if (this.crossings( p, [d[0] / l, d[1] / l, d[2] / l] ) % 2 == 1) v++;
        }
        return v >= 2;
    }

    // Whether any triangle's box meets the box [min, max].
    public overlaps( min : Point, max : Point ) : boolean {
        if (this.nodes == 0) return false;
        const T = this.tri, B = this.box;
        const stack = [0];
        while (stack.length > 0) {
            const id = stack.pop() as number;
            if (B[6 * id] > max[0] || B[6 * id + 1] > max[1] || B[6 * id + 2] > max[2] ||
                B[6 * id + 3] < min[0] || B[6 * id + 4] < min[1] || B[6 * id + 5] < min[2]) continue;
            if (this.child[2 * id] >= 0) { stack.push( this.child[2 * id] ); stack.push( this.child[2 * id + 1] ); continue; }
            const s = this.span[2 * id], c = this.span[2 * id + 1];
            for (let k = s; k < s + c; k++) {
                const t = 9 * this.order[k];
                let hit = true;
                for (let a = 0; a < 3 && hit; a++) {
                    const lo = Math.min( T[t + a], T[t + 3 + a], T[t + 6 + a] ), hi = Math.max( T[t + a], T[t + 3 + a], T[t + 6 + a] );
                    if (lo > max[a] || hi < min[a]) hit = false;
                }
                if (hit) return true;
            }
        }
        return false;
    }

    private walk( o : Point, d : Point, hit : (t : number) => void, limit : () => number ) : void {
        if (this.nodes == 0) return;
        const ix = 1 / d[0], iy = 1 / d[1], iz = 1 / d[2];
        const stack = [0];
        const T = this.tri, B = this.box;
        while (stack.length > 0) {
            const id = stack.pop() as number;
            // slab test
            const tx0 = (B[6 * id] - o[0]) * ix, tx1 = (B[6 * id + 3] - o[0]) * ix;
            const ty0 = (B[6 * id + 1] - o[1]) * iy, ty1 = (B[6 * id + 4] - o[1]) * iy;
            const tz0 = (B[6 * id + 2] - o[2]) * iz, tz1 = (B[6 * id + 5] - o[2]) * iz;
            const tn = Math.max( Math.min( tx0, tx1 ), Math.min( ty0, ty1 ), Math.min( tz0, tz1 ) );
            const tf = Math.min( Math.max( tx0, tx1 ), Math.max( ty0, ty1 ), Math.max( tz0, tz1 ) );
            if (!(tf >= Math.max( tn, 0 )) || tn > limit()) continue;
            if (this.child[2 * id] < 0) {
                const s = this.span[2 * id], c = this.span[2 * id + 1];
                for (let k = s; k < s + c; k++) {
                    const t = MeshBVH.intersect( T, this.order[k], o, d );
                    if (t != null) hit( t );
                }
            } else { stack.push( this.child[2 * id] ); stack.push( this.child[2 * id + 1] ); }
        }
    }

    private static intersect( T : Float64Array, i : number, o : Point, d : Point ) : number | null {
        const b = 9 * i;
        const ax = T[b], ay = T[b + 1], az = T[b + 2];
        const e1x = T[b + 3] - ax, e1y = T[b + 4] - ay, e1z = T[b + 5] - az;
        const e2x = T[b + 6] - ax, e2y = T[b + 7] - ay, e2z = T[b + 8] - az;
        const hx = d[1] * e2z - d[2] * e2y, hy = d[2] * e2x - d[0] * e2z, hz = d[0] * e2y - d[1] * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (det > -1e-14 && det < 1e-14) return null;
        const f = 1 / det;
        const sx = o[0] - ax, sy = o[1] - ay, sz = o[2] - az;
        const u = f * (sx * hx + sy * hy + sz * hz);
        if (u < 0 || u > 1) return null;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = f * (d[0] * qx + d[1] * qy + d[2] * qz);
        if (v < 0 || u + v > 1) return null;
        return f * (e2x * qx + e2y * qy + e2z * qz);
    }
}
