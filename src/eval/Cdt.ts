import monotoneTriangulate from "cdt2d/lib/monotone.js";
import createTriangulation from "cdt2d/lib/triangulation.js";
import classifyFaces from "cdt2d/lib/filter.js";
import inSphere from "robust-in-sphere";

// Constrained Delaunay triangulation: cdt2d's sweep, constraint index and inside/outside filter, with its edge
// flipping redone around a filtered in-circle predicate. cdt2d evaluates every in-circle test with exact
// expansion arithmetic, which was most of the time spent meshing trimmed faces; here a test is settled in plain
// floating point whenever its sign is certain (Shewchuk's error bound A), and falls back to the same exact
// predicate otherwise, so the triangles are the ones cdt2d would make.

const exactInCircle = inSphere[4];
const EPS = Math.pow( 2, -53 );
const BOUND = (10 + 96 * EPS) * EPS;

type P = ArrayLike<number>;

/** The sign convention of robust-in-sphere: negative when d lies inside the circle through a, b, c (for the
 * orientation cdt2d hands it). */
export function inCircle( a : P, b : P, c : P, d : P ) : number {
    const adx = a[0] - d[0], ady = a[1] - d[1];
    const bdx = b[0] - d[0], bdy = b[1] - d[1];
    const cdx = c[0] - d[0], cdy = c[1] - d[1];
    const alift = adx * adx + ady * ady, blift = bdx * bdx + bdy * bdy, clift = cdx * cdx + cdy * cdy;
    const bc = bdx * cdy - cdx * bdy, ca = cdx * ady - adx * cdy, ab = adx * bdy - bdx * ady;
    const det = alift * bc + blift * ca + clift * ab;
    const permanent = (Math.abs( bdx * cdy ) + Math.abs( cdx * bdy )) * alift
                    + (Math.abs( cdx * ady ) + Math.abs( adx * cdy )) * blift
                    + (Math.abs( adx * bdy ) + Math.abs( bdx * ady )) * clift;
    if (det > BOUND * permanent || -det > BOUND * permanent) return det;
    return exactInCircle( a, b, c, d );
}

type Tri = {
    stars : Array<Array<number>>;
    isConstraint( a : number, b : number ) : boolean;
    opposite( a : number, b : number ) : number;
    flip( a : number, b : number ) : void;
    addTriangle( a : number, b : number, c : number ) : void;
    cells() : Array<[number, number, number]>;
};

function testFlip( points : Array<P>, tri : Tri, stack : Array<number>, a : number, b : number, x : number ) : void {
    let y = tri.opposite( a, b );
    if (y < 0) return;
    if (b < a) { const t = a; a = b; b = t; const s = x; x = y; y = s; }
    if (tri.isConstraint( a, b )) return;
    if (inCircle( points[a], points[b], points[x], points[y] ) < 0) stack.push( a, b );
}

// cdt2d's delaunayRefine, step for step
function refine( points : Array<P>, tri : Tri ) : void {
    const stack : Array<number> = [];
    const stars = tri.stars;
    for (let a = 0; a < points.length; ++a) {
        const star = stars[a];
        for (let j = 1; j < star.length; j += 2) {
            const b = star[j];
            if (b < a || tri.isConstraint( a, b )) continue;
            const x = star[j - 1];
            let y = -1;
            for (let k = 1; k < star.length; k += 2) if (star[k - 1] === b) { y = star[k]; break; }
            if (y < 0) continue;
            if (inCircle( points[a], points[b], points[x], points[y] ) < 0) stack.push( a, b );
        }
    }
    while (stack.length > 0) {
        const b = stack.pop()!, a = stack.pop()!;
        let x = -1, y = -1;
        const star = stars[a];
        for (let i = 1; i < star.length; i += 2) {
            const s = star[i - 1], t = star[i];
            if (s === b) y = t;
            else if (t === b) x = s;
        }
        if (x < 0 || y < 0) continue;
        if (inCircle( points[a], points[b], points[x], points[y] ) >= 0) continue;
        tri.flip( a, b );
        testFlip( points, tri, stack, x, a, y );
        testFlip( points, tri, stack, a, y, x );
        testFlip( points, tri, stack, y, b, x );
        testFlip( points, tri, stack, b, x, y );
    }
}

/** Drop-in for cdt2d( points, edges, { exterior } ) with Delaunay refinement on and interior kept. */
export function triangulate( points : Array<Array<number>>, edges : Array<Array<number>>,
                             options : { exterior : boolean } ) : Array<[number, number, number]> {
    if (points.length === 0) return [];
    const cells = monotoneTriangulate( points, edges );
    const canon = edges.map( e => [Math.min( e[0], e[1] ), Math.max( e[0], e[1] )] )
                       .sort( (p, q) => p[0] - q[0] || p[1] - q[1] );
    const tri = createTriangulation( points.length, canon ) as Tri;
    for (const f of cells) tri.addTriangle( f[0], f[1], f[2] );
    refine( points, tri );
    return options.exterior ? tri.cells() : classifyFaces( tri, -1 );
}
