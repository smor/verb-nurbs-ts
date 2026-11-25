import { NurbsCurveData, NurbsSurfaceData, Point, KnotArray, Matrix } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Mat, LUDecomp } from "../core/Mat.js";
import { Eval } from "./Eval.js";
import { Modify } from "./Modify.js";

// `Fit` builds non-rational B-spline curves and surfaces that interpolate given points.
//
// Unlike `Make.rationalInterpCurve`, the functions here let the caller fix the parameter values and the knot vector.
// That is what makes them useful for generative work: every curve or surface row fitted with the same parameters
// and knots shares one knot vector, so the results can be lofted, offset or compared control point by control point.

export class Fit {

    // Greville abscissae of a knot vector: the average of each run of `degree` interior knots. Interpolating at these
    // parameters always gives a solvable system (Schoenberg-Whitney conditions hold).

    public static grevilleAbscissae( knots : KnotArray, degree : number ) : Array<number> {
        const n = knots.length - degree - 1;
        const out : Array<number> = [];
        for (let i = 0; i < n; i++) {
            let s = 0.0;
            for (let j = 1; j <= degree; j++) s += knots[i + j];
            out.push( degree == 0 ? knots[i] : s / degree );
        }
        return out;
    }

    // Clamped knot vector by averaging parameters (The NURBS Book, eq. 9.8).

    public static knotsByAveraging( params : Array<number>, degree : number ) : KnotArray {
        const n = params.length - 1;
        const knots : KnotArray = [];
        for (let i = 0; i <= degree; i++) knots.push( params[0] );
        for (let j = 1; j <= n - degree; j++) {
            let s = 0.0;
            for (let i = j; i < j + degree; i++) s += params[i];
            knots.push( s / degree );
        }
        for (let i = 0; i <= degree; i++) knots.push( params[n] );
        return knots;
    }

    // Chord length parameters in [0, 1] for a list of points.

    public static chordLengthParams( points : Array<Point> ) : Array<number> {
        const d = [0.0];
        for (let i = 1; i < points.length; i++) {
            let s = 0.0;
            for (let k = 0; k < points[i].length; k++) s += (points[i][k] - points[i-1][k]) * (points[i][k] - points[i-1][k]);
            d.push( d[i-1] + Math.sqrt(s) );
        }
        const total = d[d.length - 1];
        return d.map( x => total > 0 ? x / total : 0 );
    }

    // LU decomposition of the collocation matrix N[i][j] = N_j(params[i]).

    public static collocation( params : Array<number>, degree : number, knots : KnotArray ) : LUDecomp {
        const n = knots.length - degree - 1;
        if (params.length != n) throw "Fit: need exactly one parameter per control point";
        const A : Matrix = [];
        for (let i = 0; i < n; i++) {
            const span = Eval.knotSpanGivenN( n - 1, degree, params[i], knots );
            const basis = Eval.basisFunctionsGivenKnotSpanIndex( span, params[i], degree, knots );
            const row = new Array<number>( n ).fill( 0.0 );
            for (let k = 0; k <= degree; k++) row[ span - degree + k ] = basis[k];
            A.push( row );
        }
        return Mat.LU( A );
    }

    // Solve for control points given an LU-decomposed collocation matrix and the points to interpolate.

    public static solvePoints( lu : LUDecomp, points : Array<Point> ) : Array<Point> {
        const dim = points[0].length;
        const cols : Array<Array<number>> = [];
        for (let k = 0; k < dim; k++) cols.push( Mat.LUsolve( lu, points.map( p => p[k] ) ) );
        return points.map( (_, i) => cols.map( c => c[i] ) );
    }

    // Interpolate `points` at the given parameters with a fixed knot vector. The result is non-rational.

    public static curveWithKnots( points : Array<Point>, params : Array<number>, degree : number, knots : KnotArray ) : NurbsCurveData {
        const cps = Fit.solvePoints( Fit.collocation( params, degree, knots ), points );
        return new NurbsCurveData( degree, knots.slice(), Eval.homogenize1d( cps, null ) );
    }

    // Interpolate `points` with a non-rational curve. Parameters default to chord length, and knots to averaging.

    public static curve( points : Array<Point>, degree? : number, params? : Array<number> ) : NurbsCurveData {
        if (degree == null) degree = 3;
        degree = Math.min( degree, points.length - 1 );
        if (params == null) params = Fit.chordLengthParams( points );
        return Fit.curveWithKnots( points, params, degree, Fit.knotsByAveraging( params, degree ) );
    }

    // Interpolate a grid of points `grid[i][j]` placed at (paramsU[i], paramsV[j]) with fixed knot vectors.

    public static surfaceWithKnots( grid : Array<Array<Point>>,
                                    paramsU : Array<number>, paramsV : Array<number>,
                                    degreeU : number, degreeV : number,
                                    knotsU : KnotArray, knotsV : KnotArray ) : NurbsSurfaceData {
        const luV = Fit.collocation( paramsV, degreeV, knotsV );
        const rows = grid.map( row => Fit.solvePoints( luV, row ) );
        const luU = Fit.collocation( paramsU, degreeU, knotsU );
        const cols = Mat.transpose( rows ).map( col => Fit.solvePoints( luU, col ) );
        const cps = Mat.transpose( cols );
        return new NurbsSurfaceData( degreeU, degreeV, knotsU.slice(), knotsV.slice(), Eval.homogenize2d( cps, null ) );
    }

    // Loft a surface through curves that share the same degree and knot vector (for example curves made with
    // `Fit.periodicCurve` from the same number of control points). The surface interpolates every curve: curve k is the
    // isocurve at u = params[k]. The u direction runs across the curves, the v direction along them.
    //
    // This avoids a weakness of `Make.loftedSurface`, which fits each control point column with its own chord-length
    // parameters and can therefore mix incompatible knot vectors.

    public static loft( curves : Array<NurbsCurveData>, degreeU? : number, params? : Array<number> ) : NurbsSurfaceData {
        if (degreeU == null) degreeU = 3;
        degreeU = Math.min( degreeU, curves.length - 1 );
        const knotsV = curves[0].knots;
        for (const c of curves) {
            if (c.degree != curves[0].degree || c.knots.length != knotsV.length || c.controlPoints.length != curves[0].controlPoints.length)
                throw "Fit.loft: curves must share degree and knot vector";
        }
        if (params == null) {
            // average distance between corresponding control points of consecutive curves
            const acc = [0.0];
            for (let k = 1; k < curves.length; k++) {
                const a = Eval.dehomogenize1d( curves[k-1].controlPoints ), b = Eval.dehomogenize1d( curves[k].controlPoints );
                let d = 0.0;
                for (let i = 0; i < a.length; i++) {
                    let s = 0.0;
                    for (let j = 0; j < a[i].length; j++) s += (a[i][j] - b[i][j]) * (a[i][j] - b[i][j]);
                    d += Math.sqrt(s) / a.length;
                }
                acc.push( acc[k-1] + d );
            }
            params = acc.map( x => x / acc[acc.length - 1] );
        }
        const knotsU = Fit.knotsByAveraging( params, degreeU );
        const luU = Fit.collocation( params, degreeU, knotsU );
        const nV = curves[0].controlPoints.length;
        // interpolate homogeneous control points column by column (exact for curves with matching weights)
        const columns : Array<Array<Point>> = [];
        for (let j = 0; j < nV; j++) columns.push( Fit.solvePoints( luU, curves.map( c => c.controlPoints[j] ) ) );
        return new NurbsSurfaceData( degreeU, curves[0].degree, knotsU, knotsV.slice(), Mat.transpose( columns ) );
    }

    // A closed, smooth (C^(degree-1) everywhere, including the seam) curve from a closed control polygon.
    //
    // The control points describe a periodic uniform B-spline; do not repeat the first point at the end. The result is
    // converted to verb's clamped representation with its domain normalised to [0, 1], so it starts and ends at the
    // same point with matching derivatives.

    public static periodicCurve( controlPoints : Array<Point>, degree? : number ) : NurbsCurveData {
        if (degree == null) degree = 3;
        const m = controlPoints.length;
        if (m <= degree) throw "Fit.periodicCurve: need more control points than the degree";
        const wrapped = controlPoints.concat( controlPoints.slice( 0, degree ) );
        const knots : KnotArray = [];
        for (let i = 0; i < wrapped.length + degree + 1; i++) knots.push( i );
        const a = degree, b = m + degree;
        const ins : Array<number> = [];
        for (let i = 0; i < degree; i++) ins.push( a );
        for (let i = 0; i < degree; i++) ins.push( b );
        const refined = Modify.curveKnotRefine( new NurbsCurveData( degree, knots, Eval.homogenize1d( wrapped, null ) ), ins );
        const k = refined.knots;
        const first = k.indexOf( a );
        const last = k.lastIndexOf( b );
        const subKnots = k.slice( first, last + 1 );
        const numCps = subKnots.length - degree - 1;
        const subCps = refined.controlPoints.slice( first, first + numCps );
        const span = b - a;
        return new NurbsCurveData( degree, subKnots.map( x => (x - a) / span ), subCps );
    }

    // Approximate a parametric curve f(u) with a non-rational B-spline of the given degree to within `tolerance`.
    //
    // The curve interpolates f at the Greville abscissae of the knot vector. The deviation is measured at several
    // points inside each knot span, and spans that deviate by more than the tolerance are split in half; this repeats
    // up to `maxIterations` times. Start from the knots of a related NURBS (for example the curve being offset), so
    // that the result inherits its parameterisation.

    public static approximateCurve( f : (u : number) => Point, degree : number, knots : KnotArray,
                                    tolerance : number, maxIterations? : number ) : { curve : NurbsCurveData, maxError : number, iterations : number } {
        if (maxIterations == null) maxIterations = 10;
        knots = knots.slice();
        let result! : NurbsCurveData;
        let err = Infinity;
        let it = 0;
        for (; it <= maxIterations; it++) {
            const params = Fit.grevilleAbscissae( knots, degree );
            result = Fit.curveWithKnots( params.map( f ), params, degree, knots );
            const bad : Array<number> = [];
            err = 0.0;
            for (const [a, b] of Fit.spans( knots )) {
                let worst = 0.0;
                for (const s of Fit.FRACTIONS) {
                    const u = a + (b - a) * s;
                    worst = Math.max( worst, Vec.dist( Eval.rationalCurvePoint( result, u ), f( u ) ) );
                }
                err = Math.max( err, worst );
                if (worst > tolerance) bad.push( (a + b) / 2 );
            }
            if (bad.length == 0 || it == maxIterations) break;
            knots = Fit.insertKnots( knots, bad );
        }
        return { curve : result, maxError : err, iterations : it };
    }

    // Approximate a parametric surface f(u, v) with a non-rational B-spline surface to within `tolerance`, refining
    // the knot vectors where needed (see `approximateCurve`). Each direction is refined only in the spans where the
    // fit deviates along that direction.

    public static approximateSurface( f : (u : number, v : number) => Point, degreeU : number, degreeV : number,
                                      knotsU : KnotArray, knotsV : KnotArray, tolerance : number,
                                      maxIterations? : number, periodicV? : boolean ) : { surface : NurbsSurfaceData, maxError : number, iterations : number } {
        if (maxIterations == null) maxIterations = 10;
        knotsU = knotsU.slice(); knotsV = knotsV.slice();
        // a periodic v direction is fitted on a periodic knot structure, given by its breakpoints: the distinct knots
        let breaksV = periodicV ? Fit.spans( knotsV ).map( s => s[0] ).concat( [knotsV[knotsV.length - 1]] ) : null;
        let result! : NurbsSurfaceData;
        let err = Infinity;
        let it = 0;
        for (; it <= maxIterations; it++) {
            if (breaksV != null) knotsV = Fit.periodicKnots( breaksV, degreeV );
            const pu = Fit.grevilleAbscissae( knotsU, degreeU );
            const pv = breaksV != null ? Fit.periodicGreville( breaksV, degreeV ) : Fit.grevilleAbscissae( knotsV, degreeV );
            const grid = pu.map( u => pv.map( v => f( u, v ) ) );
            result = breaksV != null ? Fit.surfacePeriodicV( grid, pu, pv, degreeU, degreeV, knotsU, breaksV )
                                     : Fit.surfaceWithKnots( grid, pu, pv, degreeU, degreeV, knotsU, knotsV );

            // test away from the interpolation parameters. The fit interpolates its grid as a tensor product, so along
            // u = (an interpolation parameter) it is the plain interpolant in v of that row, and its error there is
            // the v direction's alone; likewise in u along v = (an interpolation parameter). Each direction is refined
            // only where its own error is too large, so a profile that is exact in v does not gain knots there because
            // the rail needs them in u. Points inside spans in both directions check the whole fit.
            const spansU = Fit.spans( knotsU ), spansV = Fit.spans( breaksV != null ? breaksV : knotsV );
            const inU = spansU.map( s => Fit.FRACTIONS.map( t => s[0] + (s[1] - s[0]) * t ) );
            const inV = spansV.map( s => Fit.FRACTIONS.map( t => s[0] + (s[1] - s[0]) * t ) );
            const allInV = ([] as Array<number>).concat( ...inV ), allInU = ([] as Array<number>).concat( ...inU );
            const dev = (u : number, v : number) => Vec.dist( Eval.rationalSurfacePoint( result, u, v ), f( u, v ) );
            let badU : Array<number> = [], badV : Array<number> = [];
            const mixedU : Array<number> = [], mixedV : Array<number> = [];
            err = 0.0;
            for (let i = 0; i < spansU.length; i++) {
                let own = 0.0, mixed = 0.0;
                for (const u of inU[i]) {
                    for (const v of pv) own = Math.max( own, dev( u, v ) );
                    for (const v of allInV) mixed = Math.max( mixed, dev( u, v ) );
                }
                err = Math.max( err, own, mixed );
                if (own > tolerance) badU.push( (spansU[i][0] + spansU[i][1]) / 2 );
                else if (mixed > tolerance) mixedU.push( (spansU[i][0] + spansU[i][1]) / 2 );
            }
            for (let j = 0; j < spansV.length; j++) {
                let own = 0.0;
                for (const v of inV[j]) for (const u of pu) own = Math.max( own, dev( u, v ) );
                err = Math.max( err, own );
                if (own > tolerance) badV.push( (spansV[j][0] + spansV[j][1]) / 2 );
                else {
                    let mixed = 0.0;
                    for (const v of inV[j]) for (const u of allInU) mixed = Math.max( mixed, dev( u, v ) );
                    if (mixed > tolerance) mixedV.push( (spansV[j][0] + spansV[j][1]) / 2 );
                }
            }
            // where only the combination misses, and neither direction does on its own, refine both there
            if (badU.length == 0 && badV.length == 0) { badU = mixedU; badV = mixedV; }
            if ((badU.length == 0 && badV.length == 0) || it == maxIterations) break;
            knotsU = Fit.insertKnots( knotsU, badU );
            if (breaksV != null) breaksV = Fit.insertKnots( breaksV, badV );
            else knotsV = Fit.insertKnots( knotsV, badV );
        }
        if (breaksV != null) result = Fit.clampV( result, breaksV );
        return { surface : result, maxError : err, iterations : it };
    }

    // ---------- periodic fitting ----------
    //
    // A closed direction fitted on clamped knots meets itself only in position: its tangent jumps across the seam.
    // Fitted on a periodic knot structure instead (the breakpoints repeated by the period on both sides, one control
    // point per span, the first `degree` control points reused at the end) it is as smooth across the seam as
    // anywhere else. The result is then clamped by knot insertion, which leaves its shape unchanged.

    // the knot vector of a periodic B-spline with these breakpoints (first and last are the period's ends)
    public static periodicKnots( breaks : Array<number>, degree : number ) : KnotArray {
        const m = breaks.length - 1, period = breaks[m] - breaks[0];
        const T : KnotArray = [];
        for (let k = -degree; k <= m + degree; k++) {
            const w = ((k % m) + m) % m;
            T.push( breaks[w] + Math.floor( k / m ) * period );
        }
        return T;
    }

    // one interpolation parameter per control point: the Greville abscissae, wrapped into the period
    public static periodicGreville( breaks : Array<number>, degree : number ) : Array<number> {
        const m = breaks.length - 1, a = breaks[0], period = breaks[m] - a;
        const T = Fit.periodicKnots( breaks, degree );
        const out : Array<number> = [];
        for (let j = 0; j < m; j++) {
            let s = 0.0;
            for (let i = 1; i <= degree; i++) s += T[j + i];
            let g = s / degree;
            g = a + (((g - a) % period) + period) % period;
            out.push( g );
        }
        return out;
    }

    // LU decomposition of the cyclic collocation matrix of a periodic B-spline
    public static periodicCollocation( params : Array<number>, degree : number, breaks : Array<number> ) : LUDecomp {
        const m = breaks.length - 1;
        const T = Fit.periodicKnots( breaks, degree );
        const n = m + degree - 1;
        const A : Matrix = [];
        for (let t of params) {
            if (t >= breaks[m]) t = breaks[0];
            const span = Eval.knotSpanGivenN( n, degree, t, T );
            const basis = Eval.basisFunctionsGivenKnotSpanIndex( span, t, degree, T );
            const row = new Array<number>( m ).fill( 0.0 );
            for (let k = 0; k <= degree; k++) row[(span - degree + k) % m] += basis[k];
            A.push( row );
        }
        return Mat.LU( A );
    }

    // Interpolate a grid with clamped knots in u and a periodic structure in v. The surface returned is unclamped in
    // v (its first `degreeV` control point columns repeat at the end); `clampV` makes it clamped.
    public static surfacePeriodicV( grid : Array<Array<Point>>, paramsU : Array<number>, paramsV : Array<number>,
                                    degreeU : number, degreeV : number, knotsU : KnotArray, breaksV : Array<number> ) : NurbsSurfaceData {
        const luV = Fit.periodicCollocation( paramsV, degreeV, breaksV );
        const rows = grid.map( row => Fit.solvePoints( luV, row ) );
        const luU = Fit.collocation( paramsU, degreeU, knotsU );
        const cols = Mat.transpose( rows ).map( col => Fit.solvePoints( luU, col ) );
        const cps = Mat.transpose( cols ).map( row => row.concat( row.slice( 0, degreeV ) ) );
        return new NurbsSurfaceData( degreeU, degreeV, knotsU.slice(), Fit.periodicKnots( breaksV, degreeV ), Eval.homogenize2d( cps, null ) );
    }

    // Clamp the v direction of an unclamped periodic surface at the ends of its period
    public static clampV( s : NurbsSurfaceData, breaks : Array<number> ) : NurbsSurfaceData {
        const p = s.degreeV, a = breaks[0], b = breaks[breaks.length - 1];
        const ins : Array<number> = [];
        for (let i = 0; i < p; i++) ins.push( a );
        for (let i = 0; i < p; i++) ins.push( b );
        const r = Modify.surfaceKnotRefine( s, ins, true );
        const k = r.knotsV;
        const first = k.indexOf( a ), last = k.lastIndexOf( b );
        const knots = k.slice( first, last + 1 );
        const n = knots.length - p - 1;
        return new NurbsSurfaceData( s.degreeU, p, s.knotsU.slice(), knots, r.controlPoints.map( row => row.slice( first, first + n ) ) );
    }

    // where, inside a knot span, a fit is compared with its target (chosen to avoid Greville abscissae)
    private static FRACTIONS = [0.13, 0.31, 0.5, 0.69, 0.87];

    // non-empty knot spans
    public static spans( knots : KnotArray ) : Array<Array<number>> {
        const out : Array<Array<number>> = [];
        for (let i = 0; i < knots.length - 1; i++) if (knots[i+1] - knots[i] > 1e-12) out.push( [knots[i], knots[i+1]] );
        return out;
    }

    // a knot vector with extra knots, kept sorted
    public static insertKnots( knots : KnotArray, values : Array<number> ) : KnotArray {
        return knots.concat( values ).sort( (a, b) => a - b );
    }
}
