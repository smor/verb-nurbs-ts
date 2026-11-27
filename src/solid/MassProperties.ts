import { NurbsSurfaceData, Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { BrepShell, ShellBuilder } from "./BrepShell.js";

/**
 * The mass properties of a solid: its volume, mass, centre of mass and inertia tensor.
 *
 * `inertia` is the inertia tensor about the centre of mass, in the solid's axes:
 * `[[Ixx, -Pxy, -Pxz], [-Pxy, Iyy, -Pyz], [-Pxz, -Pyz, Izz]]`, with `Ixx = ∫ (y² + z²) dm` and the products
 * `Pxy = ∫ x y dm` (of coordinates taken from the centre of mass). `principal` holds its eigenvalues (the principal
 * moments, ascending) and `axes` the matching unit axes, one per row.
 */
export interface MassProperties {
    volume : number;
    mass : number;
    centroid : Point;
    inertia : Array<Array<number>>;
    principal : [number, number, number];
    axes : Array<Point>;
}

/**
 * Mass properties of exact B-rep shells, integrated on their trimmed NURBS faces, and of sets of solids each of its
 * own density.
 *
 * Every volume integral becomes a surface integral by the divergence theorem, and each face's surface integral a
 * line integral round its loops by Green's theorem, so only the faces and their edges' p-curves are integrated, by
 * Gauss–Legendre quadrature, with no mesh. This is the method of `ShellBuilder.volume` carried to the ten moments up
 * to the second order (Mirtich, "Fast and accurate computation of polyhedral mass properties", Journal of Graphics
 * Tools 1(2), 1996, for the reduction chain; here on curved faces):
 *
 *     ∫ 1 dV = ⅓ ∮ p·n dA      ∫ x dV = ½ ∮ x² nx dA      ∫ x² dV = ⅓ ∮ x³ nx dA      ∫ x y dV = ½ ∮ x² y nx dA
 *
 * and the same for the other axes (∫ y z dV = ½ ∮ y² z ny dA, ∫ z x dV = ½ ∮ z² x nz dA).
 */
export class MassPropertiesOf {

    /**
     * The mass properties of the solid a closed shell bounds, of uniform `density` (mass per unit volume, 1 by
     * default: the mass is then the volume). `order` is the number of Gauss points per knot span on rational faces
     * and edges (polynomial ones take enough to be exact, as in `ShellBuilder.volume`).
     */
    public static shell( shell : BrepShell, density : number = 1, order : number = 12 ) : MassProperties {
        const m = MassPropertiesOf.moments( shell, order );
        return MassPropertiesOf.fromMoments( m.map( x => x * density ), m[0] );
    }

    /**
     * The mass properties of a set of solids, each with its own density: the masses add, the centres of mass
     * average by mass, and the inertia tensors add once moved to the common centre (the parallel axis theorem). The
     * volume is the sum of the parts' volumes: parts that overlap count twice, so give the parts as disjoint solids.
     */
    public static combine( parts : Array<MassProperties> ) : MassProperties {
        if (parts.length == 0) throw new Error( "MassProperties: no parts to combine" );
        // the second moments about the origin of each part, added: ∫ x² dm = Ixx-part + m cx², ...
        const sum = new Array<number>( 10 ).fill( 0 );
        let volume = 0;
        for (const p of parts) {
            const c = p.centroid, I = p.inertia, mm = p.mass;
            volume += p.volume;
            // the central second moments from the inertia tensor: ∫ x² = (Iyy + Izz - Ixx) / 2, ∫ x y = -Ixy
            const xx = 0.5 * (I[1][1] + I[2][2] - I[0][0]), yy = 0.5 * (I[0][0] + I[2][2] - I[1][1]), zz = 0.5 * (I[0][0] + I[1][1] - I[2][2]);
            const add = [mm, mm * c[0], mm * c[1], mm * c[2],
                xx + mm * c[0] * c[0], yy + mm * c[1] * c[1], zz + mm * c[2] * c[2],
                -I[0][1] + mm * c[0] * c[1], -I[1][2] + mm * c[1] * c[2], -I[0][2] + mm * c[2] * c[0]];
            add.forEach( (x, k) => sum[k] += x );
        }
        return MassPropertiesOf.fromMoments( sum, volume );
    }

    // The ten moments of the unit-density solid: [V, ∫x, ∫y, ∫z, ∫x², ∫y², ∫z², ∫xy, ∫yz, ∫zx].
    private static moments( shell : BrepShell, order : number ) : Array<number> {
        const tables = new Map<number, [Array<number>, Array<number>]>();
        const rule = (n : number) => { let t = tables.get( n ); if (t == null) { t = ShellBuilder.gauss( n ); tables.set( n, t ); } return t; };
        const polynomial = (pts : Array<Array<number>>) => pts.every( p => p[p.length - 1] == 1 );
        const spans = (ks : Array<number>) => {
            const out : Array<[number, number]> = [];
            for (let i = 0; i + 1 < ks.length; i++) if (ks[i + 1] > ks[i]) out.push( [ks[i], ks[i + 1]] );
            return out;
        };
        const total = new Array<number>( 10 ).fill( 0 );
        for (const F of shell.faces) {
            const s : NurbsSurfaceData = F.surface, u0 = s.knotsU[0], uSpans = spans( s.knotsU );
            const poly = polynomial( s.controlPoints.flat() );
            // the integrands are of degree 5 pu - 1 in u at most (x³ (Su × Sv)), so ceil(5 pu / 2) points are exact
            const [xs, ws] = rule( poly ? Math.max( 1, Math.ceil( 5 * s.degreeU / 2 ) ) : order );
            const f = (u : number, v : number) : Array<number> => {
                const D = Eval.rationalSurfaceDerivatives( s, u, v, 1 );
                const p = D[0][0], n = Vec.cross( D[1][0], D[0][1] ), [x, y, z] = p;
                return [Vec.dot( p, n ) / 3, x * x * n[0] / 2, y * y * n[1] / 2, z * z * n[2] / 2,
                    x * x * x * n[0] / 3, y * y * y * n[1] / 3, z * z * z * n[2] / 3,
                    x * x * y * n[0] / 2, y * y * z * n[1] / 2, z * z * x * n[2] / 2];
            };
            // F(u, v) = ∫ from u0 to u of f(·, v)
            const Fu = (u : number, v : number) : Array<number> => {
                const sum = new Array<number>( 10 ).fill( 0 );
                for (const [a, b0] of uSpans) {
                    if (a >= u) break;
                    const b = Math.min( b0, u ), h = 0.5 * (b - a), m = 0.5 * (a + b);
                    for (let k = 0; k < xs.length; k++) {
                        const g = f( m + h * xs[k], v ), w = ws[k] * h;
                        for (let c = 0; c < 10; c++) sum[c] += w * g[c];
                    }
                }
                return sum;
            };
            const flux = new Array<number>( 10 ).fill( 0 );
            let area = 0.0;
            for (const loop of F.loops) for (const [ei, fwd] of loop.edges) {
                const e = shell.edges[ei], pc = e.pcurves[fwd ? 0 : 1];
                const c0 = pc.controlPoints[0], isoU = pc.controlPoints.every( p => p[0] / p[p.length - 1] == c0[0] / c0[c0.length - 1] );
                // along the p-curve: F is of degree 5 pu in u and 5 pv - 1 in v, composed with a p-curve of degree q
                const [ys, vs] = rule( poly && polynomial( pc.controlPoints ) ? Math.max( 1, Math.ceil( pc.degree * (isoU ? 5 * s.degreeV : 5 * s.degreeU + 5 * s.degreeV) / 2 ) ) : order );
                const ts = Array.from( new Set( pc.knots.concat( e.curve.knots ) ) ).sort( (x, y) => x - y );
                for (let i = 0; i + 1 < ts.length; i++) {
                    const a = ts[i], b = ts[i + 1], h = 0.5 * (b - a), m = 0.5 * (a + b);
                    if (!(b > a)) continue;
                    for (let k = 0; k < ys.length; k++) {
                        const D = Eval.rationalCurveDerivatives( pc, m + h * ys[k], 1 );
                        const w = vs[k] * h * D[1][1] * (fwd ? 1 : -1);
                        const g = Fu( D[0][0], D[0][1] );
                        for (let c = 0; c < 10; c++) flux[c] += w * g[c];
                        area += w * (D[0][0] - u0);
                    }
                }
            }
            // the region's orientation in the parameters, then the face's sense (as in `ShellBuilder.volume`)
            const sign = (area >= 0 ? 1 : -1) * (F.sameSense ? 1 : -1);
            for (let c = 0; c < 10; c++) total[c] += sign * flux[c];
        }
        return total;
    }

    // Mass properties from the ten moments of mass about the origin, and the volume.
    private static fromMoments( m : Array<number>, volume : number ) : MassProperties {
        const mass = m[0];
        if (!(Math.abs( mass ) > 0)) throw new Error( "MassProperties: the solid has no mass" );
        const c : Point = [m[1] / mass, m[2] / mass, m[3] / mass];
        // central second moments
        const xx = m[4] - mass * c[0] * c[0], yy = m[5] - mass * c[1] * c[1], zz = m[6] - mass * c[2] * c[2];
        const xy = m[7] - mass * c[0] * c[1], yz = m[8] - mass * c[1] * c[2], zx = m[9] - mass * c[2] * c[0];
        const I = [[yy + zz, -xy, -zx], [-xy, xx + zz, -yz], [-zx, -yz, xx + yy]];
        const { values, vectors } = MassPropertiesOf.eigen( I );
        return { volume : volume, mass : mass, centroid : c, inertia : I, principal : values as [number, number, number], axes : vectors };
    }

    // The eigenvalues (ascending) and unit eigenvectors of a symmetric 3x3 matrix, by Jacobi rotations (Golub and Van
    // Loan, "Matrix Computations", 4th ed., Johns Hopkins, 2013, §8.5): each rotation zeroes one off-diagonal entry and
    // the sum of their squares falls every sweep, so it converges for any symmetric matrix, repeated eigenvalues too.
    private static eigen( M : Array<Array<number>> ) : { values : Array<number>, vectors : Array<Point> } {
        const a = M.map( r => r.slice() ), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const scale = Math.abs( a[0][0] ) + Math.abs( a[1][1] ) + Math.abs( a[2][2] );
        for (let sweep = 0; sweep < 50; sweep++) {
            const off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
            if (off <= 1e-30 * scale * scale) break;
            for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
                if (a[p][q] == 0) continue;
                const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
                const t = Math.sign( theta || 1 ) / (Math.abs( theta ) + Math.sqrt( theta * theta + 1 ));
                const cs = 1 / Math.sqrt( t * t + 1 ), sn = t * cs;
                for (let k = 0; k < 3; k++) { // A <- A J
                    const akp = a[k][p], akq = a[k][q];
                    a[k][p] = cs * akp - sn * akq; a[k][q] = sn * akp + cs * akq;
                }
                for (let k = 0; k < 3; k++) { // A <- J^T A
                    const apk = a[p][k], aqk = a[q][k];
                    a[p][k] = cs * apk - sn * aqk; a[q][k] = sn * apk + cs * aqk;
                }
                for (let k = 0; k < 3; k++) { // V <- V J
                    const vkp = v[k][p], vkq = v[k][q];
                    v[k][p] = cs * vkp - sn * vkq; v[k][q] = sn * vkp + cs * vkq;
                }
            }
        }
        const idx = [0, 1, 2].sort( (i, j) => a[i][i] - a[j][j] );
        return { values : idx.map( i => a[i][i] ), vectors : idx.map( i => [v[0][i], v[1][i], v[2][i]] as Point ) };
    }
}
