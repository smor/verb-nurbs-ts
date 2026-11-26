import { KnotArray, NurbsCurveData, NurbsSurfaceData, Point } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "./Eval.js";

/** Options for `Fair.curve`. */
export interface FairCurveOptions {
    /** How much smoothness is worth against staying put: 0 leaves the curve as it is; about 1 smooths noise of the
     * size of a control polygon's leg; large values tend to the fairest curve the ends allow. Dimensionless. */
    smoothness : number;
    /** The derivative whose square is integrated: 2 bends least (a spline under tension's limit), 3 (the default)
     * varies its curvature least, as Moreton and Séquin's minimum variation curves. */
    order? : number;
    /** What each end keeps: 0 its point (G0), 1 its tangent too (G1), 2 its curvature too (G2, the default). Kept by
     * fixing the first `keep + 1` control points at each end. */
    keep? : number;
}

/** Options for `Fair.surface`. */
export interface FairSurfaceOptions {
    /** As for curves: 0 leaves the surface alone; large values tend to the thin plate its boundary allows. */
    smoothness : number;
    /** What each boundary keeps: 0 its curve (G0), 1 its cross tangents too (G1, the default), 2 its cross curvature
     * too (G2). Kept by fixing `keep + 1` rows of control points along each side. */
    keep? : number;
    /** Which sides keep their rows, in the order u = 0, u = 1, v = 0, v = 1 (default: all four). A free side moves
     * with the rest. */
    sides? : [boolean, boolean, boolean, boolean];
}

/**
 * Fairing: making a curve or surface smoother while keeping it close to where it was and keeping its boundary.
 *
 * Both minimise, over the free control points, the deviation from the given ones plus `smoothness` times an energy:
 *
 *     E(P) = |P - P0|^2 + lambda * integral |C^(r)(u)|^2 du                (curves)
 *     E(P) = |P - P0|^2 + lambda * integral |S_uu|^2 + 2 |S_uv|^2 + |S_vv|^2  (surfaces: thin plate)
 *
 * The energies are quadratic in the control points, through the Gram matrices of the B-spline basis functions'
 * derivatives (integrated exactly, by Gauss-Legendre quadrature on each knot span), so each is one linear solve:
 * dense LU for curves, conjugate gradients for surfaces, where the thin plate's matrix is a sum of Kronecker products
 * of the two directions' Gram matrices and is never formed. `lambda` is `smoothness` scaled by the energy matrix's
 * mean diagonal, so the same value does the same on any curve.
 *
 * References: H. P. Moreton and C. H. Séquin, "Functional optimization for fair surface design", SIGGRAPH 1992;
 * G. Greiner, "Variational design and fairing of spline surfaces", Computer Graphics Forum 13(3), 1994; G. Farin,
 * Curves and Surfaces for CAGD, chapter 23 (fair curves: few, monotone, curvature extrema).
 *
 * Only non-rational curves and surfaces are faired (every weight 1); others are refused.
 */
export class Fair {

    /** A non-rational curve faired (see `Fair`). Its degree and knots are kept; only the free control points move. */
    public static curve( curve : NurbsCurveData, options : FairCurveOptions ) : NurbsCurveData {
        const P = Fair.points( curve.controlPoints );
        const n = P.length, p = curve.degree;
        const r = options.order ?? 3, keep = options.keep ?? 2;
        if (!(r >= 1 && r <= p)) throw new Error( `Fair: the order ${r} must be between 1 and the degree ${p}` );
        if (!(options.smoothness >= 0)) throw new Error( "Fair: the smoothness must be 0 or more" );
        const fixed = P.map( (_, i) => i <= keep || i >= n - 1 - keep );
        const free = P.map( (_, i) => i ).filter( i => !fixed[i] );
        if (free.length == 0 || options.smoothness == 0) return Fair.curveFrom( curve, P );
        const G = Fair.gram( curve.knots, p, r );
        const lambda = options.smoothness / Fair.meanDiagonal( G );
        // (I + lambda G) restricted to the free points, with the fixed points' share moved to the right
        const A = free.map( i => free.map( j => (i == j ? 1 : 0) + lambda * G[i][j] ) );
        const out = P.map( q => q.slice() as Point );
        for (let c = 0; c < 3; c++) {
            const b = free.map( i => {
                let v = P[i][c];
                for (let j = 0; j < n; j++) if (fixed[j]) v -= lambda * G[i][j] * P[j][c];
                return v;
            } );
            const x = Mat.solve( A, b );
            free.forEach( (i, k) => { out[i][c] = x[k]; } );
        }
        return Fair.curveFrom( curve, out );
    }

    /** A non-rational surface faired by the thin-plate energy (see `Fair`). Degrees and knots are kept. */
    public static surface( surface : NurbsSurfaceData, options : FairSurfaceOptions ) : NurbsSurfaceData {
        const P = surface.controlPoints.map( row => Fair.points( row ) );
        const nu = P.length, nv = P[0].length;
        const keep = options.keep ?? 1, sides = options.sides ?? [true, true, true, true];
        if (!(options.smoothness >= 0)) throw new Error( "Fair: the smoothness must be 0 or more" );
        if (surface.degreeU < 2 || surface.degreeV < 2) throw new Error( "Fair: the thin plate needs degree 2 or more in both directions" );
        const fixed = P.map( (row, i) => row.map( (_, j) =>
            (sides[0] && i <= keep) || (sides[1] && i >= nu - 1 - keep) || (sides[2] && j <= keep) || (sides[3] && j >= nv - 1 - keep) ) );
        const out = P.map( row => row.map( q => q.slice() as Point ) );
        if (options.smoothness == 0 || fixed.every( row => row.every( f => f ) )) return Fair.surfaceFrom( surface, out );
        const U = [0, 1, 2].map( r => Fair.gram( surface.knotsU, surface.degreeU, r ) );
        const V = [0, 1, 2].map( r => Fair.gram( surface.knotsV, surface.degreeV, r ) );
        // E X = Guu X M0v + 2 G1u X G1v + M0u X Gvv, for X the nu x nv grid of one coordinate
        const energy = (X : Array<Array<number>>) => {
            const a = Fair.mul( Fair.mul( U[2], X ), V[0] ), b = Fair.mul( Fair.mul( U[1], X ), V[1] ), c = Fair.mul( Fair.mul( U[0], X ), V[2] );
            return a.map( (row, i) => row.map( (x, j) => x + 2 * b[i][j] + c[i][j] ) );
        };
        let trace = 0;
        for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) trace += U[2][i][i] * V[0][j][j] + 2 * U[1][i][i] * V[1][j][j] + U[0][i][i] * V[2][j][j];
        const lambda = options.smoothness * nu * nv / trace;
        const mask = (X : Array<Array<number>>) => X.map( (row, i) => row.map( (x, j) => fixed[i][j] ? 0 : x ) );
        for (let c = 0; c < 3; c++) {
            const X0 = P.map( row => row.map( q => q[c] ) );
            // A x = b on the free entries: A = I + lambda E; b = X0 - lambda E (fixed part of X0)
            const fixedPart = X0.map( (row, i) => row.map( (x, j) => fixed[i][j] ? x : 0 ) );
            const Ef = energy( fixedPart );
            const b = mask( X0.map( (row, i) => row.map( (x, j) => x - lambda * Ef[i][j] ) ) );
            const apply = (X : Array<Array<number>>) => { const E = energy( X ); return mask( X.map( (row, i) => row.map( (x, j) => x + lambda * E[i][j] ) ) ); };
            const x = Fair.conjugateGradient( apply, b, mask( X0 ), 1e-12, 4 * nu * nv );
            for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) if (!fixed[i][j]) out[i][j][c] = x[i][j];
        }
        return Fair.surfaceFrom( surface, out );
    }

    // ---------- measures of fairness ----------

    /** The curvature at `samples` + 1 parameters evenly spaced over the curve's domain, with the arc length there. */
    public static curvature( curve : NurbsCurveData, samples : number = 400 ) : { u : Array<number>, s : Array<number>, kappa : Array<number> } {
        const a = curve.knots[0], b = curve.knots[curve.knots.length - 1];
        const u : Array<number> = [], s : Array<number> = [], kappa : Array<number> = [];
        let len = 0, prev : Point | null = null;
        for (let i = 0; i <= samples; i++) {
            const t = a + (b - a) * i / samples;
            const d = Eval.rationalCurveDerivatives( curve, t, 2 );
            if (prev != null) len += Vec.dist( prev, d[0] );
            prev = d[0];
            const sp = Vec.norm( d[1] );
            u.push( t ); s.push( len );
            kappa.push( sp > 0 ? Vec.norm( Vec.cross( d[1], d[2] ) ) / (sp * sp * sp) : 0 );
        }
        return { u : u, s : s, kappa : kappa };
    }

    /** The number of curvature extrema along a curve (Farin: a fair curve has few), ignoring wiggles smaller than
     * `tolerance` times the largest curvature. */
    public static curvatureExtrema( curve : NurbsCurveData, samples : number = 400, tolerance : number = 1e-3 ) : number {
        const k = Fair.curvature( curve, samples ).kappa;
        const tol = tolerance * Math.max( ...k );
        // turns of the curvature's direction, by more than the tolerance each (hysteresis)
        let count = 0, dir = 0, ref = k[0];
        for (let i = 1; i < k.length; i++) {
            if (dir == 0) {
                if (k[i] > k[0] + tol) { dir = 1; ref = k[i]; } else if (k[i] < k[0] - tol) { dir = -1; ref = k[i]; }
            } else if (dir > 0) {
                if (k[i] > ref) ref = k[i]; else if (k[i] < ref - tol) { count++; dir = -1; ref = k[i]; }
            } else {
                if (k[i] < ref) ref = k[i]; else if (k[i] > ref + tol) { count++; dir = 1; ref = k[i]; }
            }
        }
        return count;
    }

    /** The integral of the curve's r-th derivative squared over its domain (the energy `Fair.curve` lowers). */
    public static curveEnergy( curve : NurbsCurveData, order : number = 3 ) : number {
        const P = Fair.points( curve.controlPoints );
        const G = Fair.gram( curve.knots, curve.degree, order );
        let e = 0;
        for (let i = 0; i < P.length; i++) for (let j = 0; j < P.length; j++) e += G[i][j] * Vec.dot( P[i], P[j] );
        return e;
    }

    /** The thin-plate energy of a non-rational surface: the integral of |S_uu|^2 + 2 |S_uv|^2 + |S_vv|^2. */
    public static surfaceEnergy( surface : NurbsSurfaceData ) : number {
        const P = surface.controlPoints.map( row => Fair.points( row ) );
        const U = [0, 1, 2].map( r => Fair.gram( surface.knotsU, surface.degreeU, r ) );
        const V = [0, 1, 2].map( r => Fair.gram( surface.knotsV, surface.degreeV, r ) );
        let e = 0;
        for (let c = 0; c < 3; c++) {
            const X = P.map( row => row.map( q => q[c] ) );
            const terms = [[2, 0, 1], [1, 1, 2], [0, 2, 1]];
            for (const [a, b, w] of terms) {
                const Y = Fair.mul( Fair.mul( U[a], X ), V[b] );
                for (let i = 0; i < X.length; i++) for (let j = 0; j < X[0].length; j++) e += w * X[i][j] * Y[i][j];
            }
        }
        return e;
    }

    // ---------- the Gram matrices ----------

    /** G[i][j] = integral of N_i^(r) N_j^(r) over the domain, for the B-spline basis of the knots: exact, by
     * Gauss-Legendre quadrature with degree + 1 points on each knot span. */
    public static gram( knots : KnotArray, degree : number, r : number ) : Array<Array<number>> {
        const n = knots.length - degree - 1;
        const G = Vec.zeros2d( n, n );
        const [xs, ws] = Fair.legendre( degree + 1 );
        for (let s = degree; s < n; s++) {
            const a = knots[s], b = knots[s + 1];
            if (!(b > a)) continue;
            for (let q = 0; q < xs.length; q++) {
                const u = 0.5 * (a + b) + 0.5 * (b - a) * xs[q], w = 0.5 * (b - a) * ws[q];
                const d = Eval.derivativeBasisFunctionsGivenNI( s, u, degree, n - 1, knots );
                const row = d[r] ?? [];
                for (let i = 0; i <= degree; i++) for (let j = 0; j <= degree; j++) G[s - degree + i][s - degree + j] += w * (row[i] ?? 0) * (row[j] ?? 0);
            }
        }
        return G;
    }

    /** Gauss-Legendre nodes and weights on [-1, 1] (m of each), by Newton's method on the Legendre polynomial. */
    public static legendre( m : number ) : [Array<number>, Array<number>] {
        const xs : Array<number> = [], ws : Array<number> = [];
        for (let i = 1; i <= m; i++) {
            let x = Math.cos( Math.PI * (i - 0.25) / (m + 0.5) ), dp = 0;
            for (let it = 0; it < 100; it++) {
                let p0 = 1, p1 = x;
                for (let k = 2; k <= m; k++) { const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k; p0 = p1; p1 = p2; }
                if (m == 1) { p1 = x; p0 = 1; }
                dp = m * (x * p1 - p0) / (x * x - 1);
                const dx = p1 / dp;
                x -= dx;
                if (Math.abs( dx ) < 1e-16) break;
            }
            xs.push( x ); ws.push( 2 / ((1 - x * x) * dp * dp) );
        }
        return [xs, ws];
    }

    // ---------- helpers ----------

    private static points( cps : Array<Point> ) : Array<Point> {
        return cps.map( q => {
            if (q.length == 4 && Math.abs( q[3] - 1 ) > 1e-12) throw new Error( "Fair: only non-rational curves and surfaces (every weight 1) are faired" );
            return [q[0], q[1], q[2]] as Point;
        } );
    }

    private static curveFrom( c : NurbsCurveData, P : Array<Point> ) : NurbsCurveData {
        return new NurbsCurveData( c.degree, c.knots.slice(), Eval.homogenize1d( P, null ) );
    }

    private static surfaceFrom( s : NurbsSurfaceData, P : Array<Array<Point>> ) : NurbsSurfaceData {
        return new NurbsSurfaceData( s.degreeU, s.degreeV, s.knotsU.slice(), s.knotsV.slice(), P.map( row => Eval.homogenize1d( row, null ) ) );
    }

    private static meanDiagonal( G : Array<Array<number>> ) : number {
        let t = 0;
        for (let i = 0; i < G.length; i++) t += G[i][i];
        return t / G.length;
    }

    private static mul( A : Array<Array<number>>, B : Array<Array<number>> ) : Array<Array<number>> {
        const n = A.length, m = B[0].length, k = B.length;
        const C = Vec.zeros2d( n, m );
        for (let i = 0; i < n; i++) for (let l = 0; l < k; l++) {
            const a = A[i][l];
            if (a == 0) continue;
            const Bl = B[l], Ci = C[i];
            for (let j = 0; j < m; j++) Ci[j] += a * Bl[j];
        }
        return C;
    }

    // Conjugate gradients for a symmetric positive definite operator on grids.
    private static conjugateGradient( A : (X : Array<Array<number>>) => Array<Array<number>>, b : Array<Array<number>>,
                                      x0 : Array<Array<number>>, tol : number, maxIt : number ) : Array<Array<number>> {
        const dot = (X : Array<Array<number>>, Y : Array<Array<number>>) => { let s = 0; for (let i = 0; i < X.length; i++) for (let j = 0; j < X[i].length; j++) s += X[i][j] * Y[i][j]; return s; };
        const axpy = (a : number, X : Array<Array<number>>, Y : Array<Array<number>>) => Y.map( (row, i) => row.map( (y, j) => y + a * X[i][j] ) );
        let x = x0.map( row => row.slice() );
        const Ax = A( x );
        let r = b.map( (row, i) => row.map( (v, j) => v - Ax[i][j] ) );
        let p = r.map( row => row.slice() );
        let rr = dot( r, r );
        const bb = Math.max( dot( b, b ), 1e-300 );
        for (let it = 0; it < maxIt && rr > tol * tol * bb; it++) {
            const Ap = A( p );
            const alpha = rr / dot( p, Ap );
            x = axpy( alpha, p, x );
            r = axpy( -alpha, Ap, r );
            const rr2 = dot( r, r );
            p = axpy( rr2 / rr, p, r );
            rr = rr2;
        }
        return x;
    }
}
