import { NurbsSurfaceData, UV } from "../core/Data.js";
import { Eval } from "./Eval.js";
import { Fair } from "./Fair.js";
import { THB, THBBasis, THBSpace } from "./THB.js";

/**
 * A Poisson problem, -Δu = f on a planar domain with u = g on its boundary. The domain is the image of a NURBS surface
 * (its x and y; z is ignored), whose parameter rectangle the THB space covers.
 */
export interface PoissonProblem {
    /** the map from the parameter rectangle onto the domain, exact (a NURBS surface in the xy plane) */
    geometry : NurbsSurfaceData;
    /** the space the solution is sought in, pushed forward by the geometry */
    space : THBSpace;
    /** f, the source */
    source : (x : number, y : number) => number;
    /** g, the solution's values on the boundary (default 0) */
    boundary? : (x : number, y : number) => number;
}

/** A discrete solution: the basis, one coefficient per function, and its values. */
export interface PoissonSolution {
    problem : PoissonProblem;
    basis : THBBasis;
    coefficients : Array<number>;
    /** functions held by the boundary condition */
    fixed : number;
    /** functions solved for */
    free : number;
}

/** A cell of the hierarchy with no finer cells over it: where every THB function is one polynomial. */
export interface IGACell { level : number; i : number; j : number; u : [number, number]; v : [number, number]; }

/** Options of `IGA.adaptive`. */
export interface IGAAdaptiveOptions {
    /** rounds of solve, estimate, mark, refine (default 6) */
    steps? : number;
    /** Dörfler's bulk fraction: the cells with the largest indicators that make up this share of the estimate (default 0.5) */
    fraction? : number;
    /** the deepest level (default 8) */
    maxLevel? : number;
}

/**
 * Isogeometric analysis (Hughes, Cottrell and Bazilevs, "Isogeometric analysis: CAD, finite elements, NURBS, exact
 * geometry and mesh refinement", CMAME 194, 2005): the Poisson equation solved by Galerkin's method in the spline
 * space of the geometry, so the domain is exact at every refinement, with no mesh.
 *
 * * **Space.** THB-splines on the parameter rectangle, pushed forward by the geometry map. One level is an ordinary
 *   tensor-product B-spline space; more levels refine locally (`THB`), which is how adaptive IGA is done (Buffa and
 *   Giannelli, "Adaptive isogeometric methods with hierarchical splines", M3AS 26, 2016).
 * * **Integration.** Gauss-Legendre on each cell of the hierarchy that no finer cell covers (every function is one
 *   polynomial there), with one point more per direction than the degree needs, for the rational geometry.
 * * **Boundary.** Dirichlet values are imposed strongly. The functions that do not vanish on the boundary take the
 *   least-squares fit of g along it; the others are solved for, with K_II c_I = F_I - K_IB c_B, by conjugate gradients.
 * * **Errors.** `errors` measures the L2 and H1-seminorm errors against an exact solution. `estimate` is the residual
 *   estimator: η_K² = h_K² ∫_K (f + Δu_h)². Splines of degree 2 or more are C¹ across cells, so no flux jumps arise.
 *   It needs the Laplacian of u_h in x and y, from the Hessians of the functions and of the map.
 * * **Adaptivity.** `adaptive` runs solve, estimate, mark and refine. Marking is Dörfler's: the largest indicators
 *   that make up a fixed share of the estimate. Refinement refines those cells.
 */
export class IGA {

    /** Solves the problem in its space. */
    public static poisson( problem : PoissonProblem ) : PoissonSolution {
        const basis = THB.basis( problem.space ), n = basis.functions.length;
        const [p, q] = problem.space.degree;
        const K : Array<Map<number, number>> = Array.from( { length : n }, () => new Map() );
        const F = new Array( n ).fill( 0 );
        for (const cell of IGA.cells( problem.space )) {
            for (const pt of IGA.gauss( cell, p + 2, q + 2 )) {
                const g = IGA.point( problem.geometry, pt.uv, 1 );
                if (g.det == 0) continue;
                const w = pt.w * Math.abs( g.det );
                const fs = IGA.functions( basis, pt.uv, 1 ).map( b => ({ f : b.f, v : b.v, grad : IGA.gradient( g, b.du, b.dv ) }) );
                const fx = problem.source( g.x, g.y );
                for (const a of fs) {
                    F[a.f] += w * fx * a.v;
                    for (const b of fs) K[a.f].set( b.f, (K[a.f].get( b.f ) ?? 0) + w * (a.grad[0] * b.grad[0] + a.grad[1] * b.grad[1]) );
                }
            }
        }
        // the functions that do not vanish on the boundary: those using a finest B-spline at an edge of the net
        const [mu, mv] = basis.count, onEdge = new Set<number>();
        basis.users.forEach( (us, key) => {
            const i = key % mu, j = (key - i) / mu;
            if (i == 0 || j == 0 || i == mu - 1 || j == mv - 1) for (const [f] of us) onEdge.add( f );
        } );
        const c = new Array( n ).fill( 0 );
        const fixed = Array.from( onEdge ).sort( (a, b) => a - b );
        if (problem.boundary != null) {
            // least squares along the four sides
            const g = problem.boundary, idx = new Map( fixed.map( (f, k) => [f, k] ) );
            const M : Array<Map<number, number>> = fixed.map( () => new Map() ), r = new Array( fixed.length ).fill( 0 );
            const dom = [basis.knots[0][0], basis.knots[0][basis.knots[0].length - 1], basis.knots[1][0], basis.knots[1][basis.knots[1].length - 1]];
            const side = (dir : number, at : number) => {
                const k = basis.knots[dir], deg = problem.space.degree[dir], [xs, ws] = Fair.legendre( deg + 2 );
                for (let s = deg; s < k.length - deg - 1; s++) {
                    const a = k[s], b = k[s + 1];
                    if (!(b > a)) continue;
                    xs.forEach( (x, m) => {
                        const t = 0.5 * (a + b) + 0.5 * (b - a) * x, uv : UV = dir == 0 ? [t, at] : [at, t];
                        const P = Eval.rationalSurfacePoint( problem.geometry, uv[0], uv[1] );
                        const vals = THB.evaluate( basis, uv ).filter( e => idx.has( e[0] ) );
                        const gv = g( P[0], P[1] ), w = 0.5 * (b - a) * ws[m];
                        for (const [fa, va] of vals) {
                            const ia = idx.get( fa ) as number;
                            r[ia] += w * gv * va;
                            for (const [fb, vb] of vals) M[ia].set( idx.get( fb ) as number, (M[ia].get( idx.get( fb ) as number ) ?? 0) + w * va * vb );
                        }
                    } );
                }
            };
            side( 0, dom[2] ); side( 0, dom[3] ); side( 1, dom[0] ); side( 1, dom[1] );
            const x = IGA.cg( M.map( m => Array.from( m.entries() ) ), r );
            fixed.forEach( (f, k) => { c[f] = x[k]; } );
        }
        const free = basis.functions.map( (_, k) => k ).filter( k => !onEdge.has( k ) ), at = new Map( free.map( (f, k) => [f, k] ) );
        const A = free.map( f => Array.from( K[f].entries() ).filter( e => at.has( e[0] ) ).map( e => [at.get( e[0] ) as number, e[1]] as [number, number] ) );
        const b = free.map( f => { let s = F[f]; for (const [j, x] of K[f]) if (onEdge.has( j )) s -= x * c[j]; return s; } );
        const x = IGA.cg( A, b );
        free.forEach( (f, k) => { c[f] = x[k]; } );
        return { problem : problem, basis : basis, coefficients : c, fixed : fixed.length, free : free.length };
    }

    /** The solution at a parameter point: where it is (x, y), its value, and its gradient in x and y. */
    public static value( s : PoissonSolution, uv : UV ) : { x : number, y : number, u : number, grad : [number, number] } {
        const g = IGA.point( s.problem.geometry, uv, 1 );
        let u = 0, du = 0, dv = 0;
        for (const b of IGA.functions( s.basis, uv, 1 )) { const c = s.coefficients[b.f]; u += c * b.v; du += c * b.du; dv += c * b.dv; }
        return { x : g.x, y : g.y, u : u, grad : IGA.gradient( g, du, dv ) };
    }

    /** The L2 and H1-seminorm errors against an exact solution and its gradient. */
    public static errors( s : PoissonSolution, exact : (x : number, y : number) => number, gradient : (x : number, y : number) => [number, number] )
        : { l2 : number, h1 : number } {
        let l2 = 0, h1 = 0;
        const [p, q] = s.problem.space.degree;
        for (const cell of IGA.cells( s.problem.space )) for (const pt of IGA.gauss( cell, p + 3, q + 3 )) {
            const g = IGA.point( s.problem.geometry, pt.uv, 1 ), w = pt.w * Math.abs( g.det );
            const v = IGA.value( s, pt.uv ), e = exact( g.x, g.y ) - v.u, ge = gradient( g.x, g.y );
            l2 += w * e * e;
            h1 += w * ((ge[0] - v.grad[0]) ** 2 + (ge[1] - v.grad[1]) ** 2);
        }
        return { l2 : Math.sqrt( l2 ), h1 : Math.sqrt( h1 ) };
    }

    /** The residual estimator per cell: η_K² = h_K² ∫_K (f + Δu_h)², with h_K the square root of the cell's area. */
    public static estimate( s : PoissonSolution ) : Array<{ cell : IGACell, eta : number }> {
        const [p, q] = s.problem.space.degree;
        return IGA.cells( s.problem.space ).map( cell => {
            let area = 0, res = 0;
            for (const pt of IGA.gauss( cell, p + 2, q + 2 )) {
                const g = IGA.point( s.problem.geometry, pt.uv, 2 ), w = pt.w * Math.abs( g.det );
                // the Laplacian in x and y: H_x = J^-T (H_uv - Σ_k (∂u/∂x_k) H_uv(x_k)) J^-1
                let du = 0, dv = 0, duu = 0, duv = 0, dvv = 0;
                for (const b of IGA.functions( s.basis, pt.uv, 2 )) {
                    const c = s.coefficients[b.f];
                    du += c * b.du; dv += c * b.dv; duu += c * b.duu; duv += c * b.duv; dvv += c * b.dvv;
                }
                const grad = IGA.gradient( g, du, dv );
                const H = [[duu - grad[0] * g.xuu - grad[1] * g.yuu, duv - grad[0] * g.xuv - grad[1] * g.yuv],
                           [duv - grad[0] * g.xuv - grad[1] * g.yuv, dvv - grad[0] * g.xvv - grad[1] * g.yvv]];
                // J = [[xu, xv], [yu, yv]]; Laplacian = trace( J^-T H J^-1 ) = Σ (J^-1)_{ai} (J^-1)_{bi} H_ab
                const inv = [[g.yv / g.det, -g.xv / g.det], [-g.yu / g.det, g.xu / g.det]];
                let lap = 0;
                for (let i = 0; i < 2; i++) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) lap += inv[a][i] * inv[b][i] * H[a][b];
                const r = s.problem.source( g.x, g.y ) + lap;
                area += w;
                res += w * r * r;
            }
            return { cell : cell, eta : Math.sqrt( area * res ) };
        } );
    }

    /**
     * Adaptive refinement: solve, estimate, mark the cells with the largest indicators that make up `fraction` of the
     * estimate (Dörfler), refine them, and again. Returns every round's solution and estimate.
     */
    public static adaptive( problem : PoissonProblem, options? : IGAAdaptiveOptions ) : Array<{ solution : PoissonSolution, estimate : number }> {
        const steps = options?.steps ?? 6, theta = options?.fraction ?? 0.5, maxLevel = options?.maxLevel ?? 8;
        const out : Array<{ solution : PoissonSolution, estimate : number }> = [];
        let space = problem.space;
        for (let step = 0; ; step++) {
            const s = IGA.poisson( { ...problem, space : space } );
            const eta = IGA.estimate( s );
            const total = eta.reduce( (a, e) => a + e.eta * e.eta, 0 );
            out.push( { solution : s, estimate : Math.sqrt( total ) } );
            if (step + 1 >= steps) return out;
            const sorted = eta.filter( e => e.cell.level < maxLevel ).sort( (a, b) => b.eta - a.eta );
            let acc = 0;
            const byLevel = new Map<number, Array<[number, number]>>();
            for (const e of sorted) {
                if (acc >= theta * total) break;
                acc += e.eta * e.eta;
                let l = byLevel.get( e.cell.level );
                if (l == null) byLevel.set( e.cell.level, l = [] );
                l.push( [e.cell.i, e.cell.j] );
            }
            if (byLevel.size == 0) return out;
            for (const [l, cells] of Array.from( byLevel.entries() ).sort( (a, b) => a[0] - b[0] )) space = THB.refine( space, l, cells );
        }
    }

    /** The cells of a hierarchy that no finer cell covers. */
    public static cells( space : THBSpace ) : Array<IGACell> {
        const out : Array<IGACell> = [];
        for (let l = 0; l < space.omega.length; l++) {
            const bu = THB.breakpoints( space, l, 0 ), bv = THB.breakpoints( space, l, 1 ), [nu, nv] = THB.cells( space, l );
            const finer = space.omega[l + 1];
            for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
                if (space.omega[l][i + j * nu] != 1) continue;
                if (finer != null && finer[2 * i + 2 * j * 2 * nu] == 1) continue;
                out.push( { level : l, i : i, j : j, u : [bu[i], bu[i + 1]], v : [bv[j], bv[j + 1]] } );
            }
        }
        return out;
    }

    // ---------- helpers ----------

    private static gauss( cell : IGACell, mu : number, mv : number ) : Array<{ uv : UV, w : number }> {
        const [xu, wu] = Fair.legendre( mu ), [xv, wv] = Fair.legendre( mv );
        const out : Array<{ uv : UV, w : number }> = [];
        const hu = cell.u[1] - cell.u[0], hv = cell.v[1] - cell.v[0];
        xu.forEach( (a, i) => xv.forEach( (b, j) => {
            out.push( { uv : [cell.u[0] + 0.5 * hu * (a + 1), cell.v[0] + 0.5 * hv * (b + 1)], w : 0.25 * hu * hv * wu[i] * wv[j] } );
        } ) );
        return out;
    }

    // The map and its derivatives at a parameter point (second ones when order is 2).
    private static point( geometry : NurbsSurfaceData, uv : UV, order : number ) {
        const d = Eval.rationalSurfaceDerivatives( geometry, uv[0], uv[1], order );
        const xu = d[1][0][0], yu = d[1][0][1], xv = d[0][1][0], yv = d[0][1][1];
        const two = order >= 2;
        return { x : d[0][0][0], y : d[0][0][1], xu : xu, yu : yu, xv : xv, yv : yv, det : xu * yv - xv * yu,
                 xuu : two ? d[2][0][0] : 0, yuu : two ? d[2][0][1] : 0, xuv : two ? d[1][1][0] : 0, yuv : two ? d[1][1][1] : 0,
                 xvv : two ? d[0][2][0] : 0, yvv : two ? d[0][2][1] : 0 };
    }

    // ∇u in x and y from its parameter derivatives: J^-T (u_u, u_v)
    private static gradient( g : { xu : number, yu : number, xv : number, yv : number, det : number }, du : number, dv : number ) : [number, number] {
        return [(g.yv * du - g.yu * dv) / g.det, (-g.xv * du + g.xu * dv) / g.det];
    }

    // The THB functions not zero at a point, with their parameter derivatives up to the order.
    private static functions( basis : THBBasis, uv : UV, order : number )
        : Array<{ f : number, v : number, du : number, dv : number, duu : number, duv : number, dvv : number }> {
        const [p, q] = basis.space.degree, [ku, kv] = basis.knots, [mu, mv] = basis.count;
        const su = Eval.knotSpanGivenN( mu - 1, p, uv[0], ku ), sv = Eval.knotSpanGivenN( mv - 1, q, uv[1], kv );
        const Nu = Eval.derivativeBasisFunctionsGivenNI( su, uv[0], p, order, ku ), Nv = Eval.derivativeBasisFunctionsGivenNI( sv, uv[1], q, order, kv );
        const acc = new Map<number, Array<number>>();
        const at = (N : Array<Array<number>>, k : number, a : number) => k < N.length ? N[k][a] : 0;
        for (let b = 0; b <= q; b++) for (let a = 0; a <= p; a++) {
            const vals = [at( Nu, 0, a ) * at( Nv, 0, b ), at( Nu, 1, a ) * at( Nv, 0, b ), at( Nu, 0, a ) * at( Nv, 1, b ),
                          at( Nu, 2, a ) * at( Nv, 0, b ), at( Nu, 1, a ) * at( Nv, 1, b ), at( Nu, 0, a ) * at( Nv, 2, b )];
            for (const [f, x] of basis.users[(su - p + a) + (sv - q + b) * mu]) {
                let r = acc.get( f );
                if (r == null) acc.set( f, r = [0, 0, 0, 0, 0, 0] );
                for (let k = 0; k < 6; k++) r[k] += x * vals[k];
            }
        }
        return Array.from( acc.entries() ).map( ([f, r]) => ({ f : f, v : r[0], du : r[1], dv : r[2], duu : r[3], duv : r[4], dvv : r[5] }) );
    }

    // Conjugate gradients with a Jacobi preconditioner, for a sparse symmetric positive definite matrix by rows.
    private static cg( A : Array<Array<[number, number]>>, b : Array<number> ) : Array<number> {
        const n = b.length, x = new Array( n ).fill( 0 );
        if (n == 0) return x;
        const diag = A.map( (r, i) => { const e = r.find( t => t[0] == i ); return e != null && e[1] > 0 ? e[1] : 1; } );
        const mul = (v : Array<number>) => A.map( r => { let s = 0; for (const [j, a] of r) s += a * v[j]; return s; } );
        const r = b.slice(), z = r.map( (v, i) => v / diag[i] ), d = z.slice();
        let rz = r.reduce( (s, v, i) => s + v * z[i], 0 );
        const bn = Math.sqrt( b.reduce( (s, v) => s + v * v, 0 ) );
        if (bn == 0) return x;
        for (let it = 0; it < 10 * n + 100; it++) {
            const Ad = mul( d );
            const dAd = d.reduce( (s, v, i) => s + v * Ad[i], 0 );
            if (dAd <= 0) break;
            const al = rz / dAd;
            for (let i = 0; i < n; i++) { x[i] += al * d[i]; r[i] -= al * Ad[i]; }
            if (Math.sqrt( r.reduce( (s, v) => s + v * v, 0 ) ) <= 1e-12 * bn) break;
            for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
            const rz1 = r.reduce( (s, v, i) => s + v * z[i], 0 );
            const be = rz1 / rz;
            rz = rz1;
            for (let i = 0; i < n; i++) d[i] = z[i] + be * d[i];
        }
        return x;
    }
}
