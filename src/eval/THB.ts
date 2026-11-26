import { NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Eval } from "./Eval.js";

/**
 * A hierarchy of tensor-product B-spline spaces on nested domains: level 0 covers the whole parameter rectangle, and
 * each level halves the spans of the one before over the cells refined there. `omega[l]` marks, cell by cell of
 * level l's grid, the domain Ω_l of level l (all ones at level 0).
 */
export interface THBSpace {
    degree : [number, number];
    /** level 0's breakpoints (distinct, increasing) in u and v */
    breaks : [Array<number>, Array<number>];
    /** per level, its cells (u index + v index × cells in u) that lie in Ω_l: 1 inside, 0 outside */
    omega : Array<Uint8Array>;
}

/** A THB-spline basis function: a B-spline of its level, truncated by the finer levels, as finest-level coefficients. */
export interface THBFunction {
    level : number;
    /** the B-spline's index in u and v among its level's */
    index : [number, number];
    /** its coefficients in the finest level's B-splines (u index + v index × count in u) */
    coefficients : Map<number, number>;
}

/** The truncated hierarchical basis of a space, and the finest level's tensor-product B-spline space it lives in. */
export interface THBBasis {
    space : THBSpace;
    functions : Array<THBFunction>;
    /** the finest level's knot vectors */
    knots : [Array<number>, Array<number>];
    /** the finest level's B-spline count in u and v */
    count : [number, number];
    /** per finest B-spline, the THB functions that use it and with what coefficient */
    users : Array<Array<[number, number]>>;
}

/** A sample to fit: a parameter point and the point the surface should pass through there. */
export interface THBSample { uv : UV; point : Point; }

/** Options of `THB.adaptiveFit`. */
export interface THBFitOptions {
    /** the largest distance allowed between a sample and the surface */
    tolerance : number;
    /** the deepest level to refine to (default 5) */
    maxLevel? : number;
    /** a small weight on the coefficients' size, which keeps functions that few samples see in check (default 1e-9) */
    ridge? : number;
}

/**
 * Truncated hierarchical B-splines (THB-splines): local refinement of tensor-product B-spline surfaces.
 *
 * A tensor-product B-spline can only be refined along whole knot lines. Hierarchical B-splines refine where they are
 * told, by levels: level l + 1 halves the spans of level l over a subdomain Ω_{l+1} ⊆ Ω_l. The basis is the one of
 * Kraft ("Adaptive and linearly independent multilevel B-splines", 1997): a B-spline of level l is active when its
 * support lies in Ω_l but not in Ω_{l+1}. Those functions are linearly independent and span nested spaces, but they
 * overlap across levels and do not sum to one.
 *
 * Truncation (Giannelli, Jüttler and Speleers, "THB-splines: the truncated basis for hierarchical splines", CAGD 29,
 * 2012) repairs that: each active function is written in the B-splines of the next level (by knot insertion, the
 * two-scale relation), and the parts on B-splines of that level whose support lies in Ω_{l+1} are dropped, then the
 * same at each finer level. The truncated functions are non-negative, still linearly independent, span the same
 * space, form a partition of unity, and have smaller supports. This class builds them as coefficient vectors in the
 * finest level's B-splines, so a THB-spline surface converts exactly to a NURBS surface of the finest level
 * (`surface`), and everything that evaluates, tessellates or exports NURBS works on it.
 *
 * `adaptiveFit` fits points by least squares, then refines the cells where the fit misses by more than a tolerance,
 * level by level: refinement goes only where the shape needs it.
 */
export class THB {

    /** A one-level space: degrees and breakpoints in u and v (default: one span each way). */
    public static space( degree : [number, number], breaksU : Array<number> = [0, 1], breaksV : Array<number> = [0, 1] ) : THBSpace {
        for (const b of [breaksU, breaksV]) {
            if (b.length < 2) throw new Error( "THB: at least two breakpoints in each direction" );
            for (let k = 1; k < b.length; k++) if (!(b[k] > b[k - 1])) throw new Error( "THB: breakpoints must increase" );
        }
        return { degree : [degree[0], degree[1]], breaks : [breaksU.slice(), breaksV.slice()],
                 omega : [new Uint8Array( (breaksU.length - 1) * (breaksV.length - 1) ).fill( 1 )] };
    }

    /** Cells of level l in u and v. */
    public static cells( space : THBSpace, level : number ) : [number, number] {
        return [(space.breaks[0].length - 1) << level, (space.breaks[1].length - 1) << level];
    }

    /** Level l's breakpoints in one direction (0: u, 1: v): level 0's, with each span halved l times. */
    public static breakpoints( space : THBSpace, level : number, dir : number ) : Array<number> {
        let b = space.breaks[dir].slice();
        for (let l = 0; l < level; l++) {
            const out = [b[0]];
            for (let k = 1; k < b.length; k++) out.push( 0.5 * (b[k - 1] + b[k]), b[k] );
            b = out;
        }
        return b;
    }

    /** Level l's open knot vector in one direction. */
    public static knots( space : THBSpace, level : number, dir : number ) : Array<number> {
        const b = THB.breakpoints( space, level, dir ), p = space.degree[dir];
        const k : Array<number> = [];
        for (let i = 0; i < p; i++) k.push( b[0] );
        for (const x of b) k.push( x );
        for (let i = 0; i < p; i++) k.push( b[b.length - 1] );
        return k;
    }

    /**
     * The space with the given cells of a level refined: they join Ω_{level+1}, each as its four children. Every cell
     * must lie in Ω_level.
     */
    public static refine( space : THBSpace, level : number, cells : Array<[number, number]> ) : THBSpace {
        if (level < 0 || level >= space.omega.length) throw new Error( "THB: no such level" );
        const [nu] = THB.cells( space, level );
        const omega = space.omega.map( o => o.slice() );
        if (omega.length == level + 1) { const [a, b] = THB.cells( space, level + 1 ); omega.push( new Uint8Array( a * b ) ); }
        const fine = omega[level + 1], nuf = 2 * nu;
        for (const [i, j] of cells) {
            if (omega[level][i + j * nu] != 1) throw new Error( "THB: a cell to refine must lie in its level's domain" );
            for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) fine[2 * i + a + (2 * j + b) * nuf] = 1;
        }
        return { degree : space.degree, breaks : space.breaks, omega : omega };
    }

    /** The space with every cell of a level that the test picks (by its parameter box) refined. */
    public static refineWhere( space : THBSpace, level : number, pick : (u0 : number, u1 : number, v0 : number, v1 : number) => boolean ) : THBSpace {
        const bu = THB.breakpoints( space, level, 0 ), bv = THB.breakpoints( space, level, 1 ), [nu, nv] = THB.cells( space, level );
        const cells : Array<[number, number]> = [];
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++)
            if (space.omega[level][i + j * nu] == 1 && pick( bu[i], bu[i + 1], bv[j], bv[j + 1] )) cells.push( [i, j] );
        return cells.length == 0 ? space : THB.refine( space, level, cells );
    }

    /** The truncated basis of a space. */
    public static basis( space : THBSpace ) : THBBasis {
        const L = space.omega.length - 1, [p, q] = space.degree;
        // a summed-area table per level, to tell whether a block of cells lies in Ω_l
        const tables = space.omega.map( (o, l) => {
            const [nu, nv] = THB.cells( space, l ), t = new Int32Array( (nu + 1) * (nv + 1) );
            for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++)
                t[i + 1 + (j + 1) * (nu + 1)] = o[i + j * nu] + t[i + (j + 1) * (nu + 1)] + t[i + 1 + j * (nu + 1)] - t[i + j * (nu + 1)];
            return t;
        } );
        // whether B-spline (a, b) of level l has its support in Ω_m, m = l or l + 1 (never past the finest level)
        const inside = (l : number, a : number, b : number, m : number = l) : boolean => {
            if (m > L) return false;
            const [nl, ml] = THB.cells( space, l ), [nu] = THB.cells( space, m ), t = tables[m], f = 1 << (m - l);
            const i0 = f * Math.max( 0, a - p ), i1 = f * (Math.min( nl - 1, a ) + 1) - 1;
            const j0 = f * Math.max( 0, b - q ), j1 = f * (Math.min( ml - 1, b ) + 1) - 1;
            const w = nu + 1;
            const sum = t[i1 + 1 + (j1 + 1) * w] - t[i0 + (j1 + 1) * w] - t[i1 + 1 + j0 * w] + t[i0 + j0 * w];
            return sum == (i1 - i0 + 1) * (j1 - j0 + 1);
        };
        // the two-scale relation of each level to the next, per direction
        const R = [0, 1].map( dir => Array.from( { length : L }, (_, l) =>
            THB.refinement( THB.knots( space, l, dir ), THB.knots( space, l + 1, dir ), space.degree[dir] ) ) );
        const functions : Array<THBFunction> = [];
        for (let l = 0; l <= L; l++) {
            const [nu, nv] = THB.cells( space, l ), mu = nu + p, mv = nv + q;
            for (let b = 0; b < mv; b++) for (let a = 0; a < mu; a++) {
                if (!inside( l, a, b ) || inside( l, a, b, l + 1 )) continue;
                let c = new Map<number, number>( [[a + b * mu, 1]] );
                let width = mu;
                for (let k = l; k < L; k++) {
                    const ru = R[0][k], rv = R[1][k], nw = THB.cells( space, k + 1 )[0] + p;
                    const next = new Map<number, number>();
                    for (const [key, x] of c) {
                        const i = key % width, j = (key - i) / width;
                        for (const [ii, xu] of ru[i]) for (const [jj, xv] of rv[j]) {
                            if (inside( k + 1, ii, jj )) continue; // truncation
                            const kk = ii + jj * nw;
                            next.set( kk, (next.get( kk ) ?? 0) + x * xu * xv );
                        }
                    }
                    c = next; width = nw;
                }
                for (const [key, x] of c) if (Math.abs( x ) < 1e-15) c.delete( key );
                functions.push( { level : l, index : [a, b], coefficients : c } );
            }
        }
        const [nu, nv] = THB.cells( space, L ), count : [number, number] = [nu + p, nv + q];
        const users : Array<Array<[number, number]>> = Array.from( { length : count[0] * count[1] }, () => [] );
        functions.forEach( (f, k) => { for (const [key, x] of f.coefficients) users[key].push( [k, x] ); } );
        return { space : space, functions : functions, knots : [THB.knots( space, L, 0 ), THB.knots( space, L, 1 )], count : count, users : users };
    }

    /** The THB functions that are not zero at a parameter point, and their values. */
    public static evaluate( basis : THBBasis, uv : UV ) : Array<[number, number]> {
        const [p, q] = basis.space.degree, [ku, kv] = basis.knots;
        const su = Eval.knotSpanGivenN( basis.count[0] - 1, p, uv[0], ku ), sv = Eval.knotSpanGivenN( basis.count[1] - 1, q, uv[1], kv );
        const nu = Eval.basisFunctionsGivenKnotSpanIndex( su, uv[0], p, ku ), nv = Eval.basisFunctionsGivenKnotSpanIndex( sv, uv[1], q, kv );
        const acc = new Map<number, number>();
        for (let b = 0; b <= q; b++) for (let a = 0; a <= p; a++) {
            const w = nu[a] * nv[b];
            if (w == 0) continue;
            for (const [f, x] of basis.users[(su - p + a) + (sv - q + b) * basis.count[0]]) acc.set( f, (acc.get( f ) ?? 0) + w * x );
        }
        return Array.from( acc.entries() );
    }

    /** The surface with these control points (one per THB function), exactly, as a B-spline surface of the finest level. */
    public static surface( basis : THBBasis, points : Array<Point> ) : NurbsSurfaceData {
        if (points.length != basis.functions.length) throw new Error( "THB: one control point per function" );
        const [mu, mv] = basis.count, dim = points.length > 0 ? points[0].length : 3;
        const net : Array<Array<Point>> = [];
        for (let i = 0; i < mu; i++) {
            const row : Array<Point> = [];
            for (let j = 0; j < mv; j++) {
                const Q = new Array( dim ).fill( 0 );
                for (const [f, x] of basis.users[i + j * mu]) for (let d = 0; d < dim; d++) Q[d] += x * points[f][d];
                Q.push( 1 );
                row.push( Q );
            }
            net.push( row );
        }
        return new NurbsSurfaceData( basis.space.degree[0], basis.space.degree[1], basis.knots[0].slice(), basis.knots[1].slice(), net );
    }

    /**
     * Control points for a basis that reproduce a surface of a coarser space exactly (the spaces are nested), from its
     * finest-level net: the least-squares solution of the finest coefficients, which is exact when the surface lies in
     * the space.
     */
    public static transfer( from : THBBasis, points : Array<Point>, to : THBBasis ) : Array<Point> {
        const S = THB.surface( from, points );
        // sample on a grid fine enough to pin every function, then fit
        const samples : Array<THBSample> = [];
        const [ku, kv] = to.knots, [p, q] = to.space.degree;
        const grid = (k : Array<number>, d : number) => {
            const out : Array<number> = [];
            for (let s = d; s < k.length - d - 1; s++) for (let t = 0; t <= d; t++) out.push( k[s] + (k[s + 1] - k[s]) * (t + 0.5) / (d + 1) );
            return out;
        };
        for (const u of grid( ku, p )) for (const v of grid( kv, q )) samples.push( { uv : [u, v], point : Eval.rationalSurfacePoint( S, u, v ) } );
        return THB.fit( to, samples, 0 );
    }

    /**
     * Least-squares control points: those that bring the surface closest to the samples (sum of squared distances),
     * plus `ridge` times the squared size of the points, solved by conjugate gradients on the normal equations.
     */
    public static fit( basis : THBBasis, samples : Array<THBSample>, ridge : number = 1e-9 ) : Array<Point> {
        const n = basis.functions.length, dim = samples.length > 0 ? samples[0].point.length : 3;
        // the normal matrix, sparse by rows, and the right-hand sides
        const rows : Array<Map<number, number>> = Array.from( { length : n }, () => new Map() );
        const rhs : Array<Array<number>> = Array.from( { length : n }, () => new Array( dim ).fill( 0 ) );
        for (const s of samples) {
            const vals = THB.evaluate( basis, s.uv );
            for (const [i, a] of vals) {
                for (let d = 0; d < dim; d++) rhs[i][d] += a * s.point[d];
                for (const [j, b] of vals) rows[i].set( j, (rows[i].get( j ) ?? 0) + a * b );
            }
        }
        let scale = 0;
        rows.forEach( (r, i) => { scale = Math.max( scale, r.get( i ) ?? 0 ); } );
        const lambda = ridge * Math.max( scale, 1e-300 );
        rows.forEach( (r, i) => r.set( i, (r.get( i ) ?? 0) + lambda ) );
        const A = rows.map( r => Array.from( r.entries() ) );
        const out : Array<Point> = Array.from( { length : n }, () => new Array( dim ).fill( 0 ) );
        for (let d = 0; d < dim; d++) {
            const x = THB.cg( A, rhs.map( r => r[d] ) );
            for (let i = 0; i < n; i++) out[i][d] = x[i];
        }
        return out;
    }

    /**
     * Fits samples within a tolerance by refining where the fit misses: fit on the current space, find the samples
     * further than the tolerance from the surface, refine the cells of the finest level holding each of them (each
     * at its own level), and fit again, until every sample is within the tolerance or the deepest level is reached.
     */
    public static adaptiveFit( space : THBSpace, samples : Array<THBSample>, options : THBFitOptions )
        : { space : THBSpace, basis : THBBasis, points : Array<Point>, error : number, rounds : number } {
        const maxLevel = options.maxLevel ?? 5, ridge = options.ridge ?? 1e-9;
        let rounds = 0;
        for (;;) {
            const basis = THB.basis( space );
            const points = THB.fit( basis, samples, ridge );
            const S = THB.surface( basis, points );
            let error = 0;
            const bad : Array<UV> = [];
            for (const s of samples) {
                const p = Eval.rationalSurfacePoint( S, s.uv[0], s.uv[1] );
                let d = 0;
                for (let k = 0; k < p.length; k++) d += (p[k] - s.point[k]) * (p[k] - s.point[k]);
                d = Math.sqrt( d );
                error = Math.max( error, d );
                if (d > options.tolerance) bad.push( s.uv );
            }
            if (bad.length == 0) return { space : space, basis : basis, points : points, error : error, rounds : rounds };
            // the deepest cell holding each bad sample, refined (if not at the deepest level)
            let next = space, changed = false;
            const byLevel = new Map<number, Array<[number, number]>>();
            for (const uv of bad) {
                const [l, i, j] = THB.leaf( space, uv );
                if (l >= maxLevel) continue;
                let list = byLevel.get( l );
                if (list == null) byLevel.set( l, list = [] );
                list.push( [i, j] );
            }
            for (const [l, cells] of Array.from( byLevel.entries() ).sort( (a, b) => b[0] - a[0] )) {
                // around each cell its neighbours too, inside Ω_l: the error spreads a little past the cell it shows in
                const [nu, nv] = THB.cells( next, l ), pick = new Set<number>();
                for (const [i, j] of cells) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
                    const ii = i + a, jj = j + b;
                    if (ii >= 0 && jj >= 0 && ii < nu && jj < nv && next.omega[l][ii + jj * nu] == 1) pick.add( ii + jj * nu );
                }
                next = THB.refine( next, l, Array.from( pick ).map( k => [k % nu, Math.floor( k / nu )] as [number, number] ) );
                changed = true;
            }
            rounds++;
            if (!changed) return { space : space, basis : basis, points : points, error : error, rounds : rounds };
            space = next;
        }
    }

    /** The deepest level whose domain holds a parameter point, and that level's cell there. */
    public static leaf( space : THBSpace, uv : UV ) : [number, number, number] {
        for (let l = space.omega.length - 1; l >= 0; l--) {
            const i = THB.cellIndex( THB.breakpoints( space, l, 0 ), uv[0] ), j = THB.cellIndex( THB.breakpoints( space, l, 1 ), uv[1] );
            const nu = THB.cells( space, l )[0];
            if (space.omega[l][i + j * nu] == 1) return [l, i, j];
        }
        return [0, 0, 0];
    }

    // ---------- helpers ----------

    private static cellIndex( b : Array<number>, x : number ) : number {
        let lo = 0, hi = b.length - 2;
        if (x >= b[hi]) return hi;
        while (lo < hi) {
            const m = (lo + hi + 1) >> 1;
            if (b[m] <= x) lo = m; else hi = m - 1;
        }
        return lo;
    }

    // The two-scale relation: B-spline i of the coarse knots as a sum of B-splines j of the fine knots (a superset),
    // [j, coefficient] per i, by inserting the new knots one at a time (Boehm).
    private static refinement( coarse : Array<number>, fine : Array<number>, p : number ) : Array<Array<[number, number]>> {
        const n = coarse.length - p - 1;
        // rows: the coarse B-splines, as coefficients in the current knots' B-splines
        let rows = Array.from( { length : n }, (_, i) => { const r = new Array( n ).fill( 0 ); r[i] = 1; return r; } );
        const knots = coarse.slice();
        const extra : Array<number> = [];
        let a = 0;
        for (const x of fine) { if (a < coarse.length && coarse[a] == x) a++; else extra.push( x ); }
        for (const x of extra) {
            const k = Eval.knotSpan( p, x, knots );
            const m = knots.length - p - 1;
            rows = rows.map( c => {
                const out = new Array( m + 1 ).fill( 0 );
                for (let i = 0; i <= m; i++) {
                    if (i <= k - p) out[i] = c[i];
                    else if (i > k) out[i] = c[i - 1];
                    else {
                        const al = (x - knots[i]) / (knots[i + p] - knots[i]);
                        out[i] = al * c[i] + (1 - al) * c[i - 1];
                    }
                }
                return out;
            } );
            knots.splice( k + 1, 0, x );
        }
        return rows.map( r => r.map( (x, j) => [j, x] as [number, number] ).filter( e => Math.abs( e[1] ) > 1e-15 ) );
    }

    // Conjugate gradients with a Jacobi preconditioner, for a sparse symmetric positive definite matrix by rows.
    private static cg( A : Array<Array<[number, number]>>, b : Array<number> ) : Array<number> {
        const n = b.length, x = new Array( n ).fill( 0 );
        const diag = A.map( (r, i) => { const e = r.find( t => t[0] == i ); return e != null && e[1] > 0 ? e[1] : 1; } );
        const mul = (v : Array<number>) => A.map( r => { let s = 0; for (const [j, a] of r) s += a * v[j]; return s; } );
        const r = b.slice(), z = r.map( (v, i) => v / diag[i] ), d = z.slice();
        let rz = r.reduce( (s, v, i) => s + v * z[i], 0 );
        const bn = Math.sqrt( b.reduce( (s, v) => s + v * v, 0 ) );
        if (bn == 0) return x;
        for (let it = 0; it < 4 * n + 100; it++) {
            const Ad = mul( d );
            const dAd = d.reduce( (s, v, i) => s + v * Ad[i], 0 );
            if (dAd <= 0) break;
            const al = rz / dAd;
            for (let i = 0; i < n; i++) { x[i] += al * d[i]; r[i] -= al * Ad[i]; }
            if (Math.sqrt( r.reduce( (s, v) => s + v * v, 0 ) ) <= 1e-13 * bn) break;
            for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
            const rz1 = r.reduce( (s, v, i) => s + v * z[i], 0 );
            const be = rz1 / rz;
            rz = rz1;
            for (let i = 0; i < n; i++) d[i] = z[i] + be * d[i];
        }
        return x;
    }
}
