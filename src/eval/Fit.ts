import { NurbsCurveData, NurbsSurfaceData, Point, KnotArray, Matrix } from "../core/Data.js";
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
        let n = knots.length - degree - 1;
        let out : Array<number> = [];
        for (let i = 0; i < n; i++) {
            let s = 0.0;
            for (let j = 1; j <= degree; j++) s += knots[i + j];
            out.push( degree == 0 ? knots[i] : s / degree );
        }
        return out;
    }

    // Clamped knot vector by averaging parameters (The NURBS Book, eq. 9.8).

    public static knotsByAveraging( params : Array<number>, degree : number ) : KnotArray {
        let n = params.length - 1;
        let knots : KnotArray = [];
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
        let d = [0.0];
        for (let i = 1; i < points.length; i++) {
            let s = 0.0;
            for (let k = 0; k < points[i].length; k++) s += (points[i][k] - points[i-1][k]) * (points[i][k] - points[i-1][k]);
            d.push( d[i-1] + Math.sqrt(s) );
        }
        let total = d[d.length - 1];
        return d.map( x => total > 0 ? x / total : 0 );
    }

    // LU decomposition of the collocation matrix N[i][j] = N_j(params[i]).

    public static collocation( params : Array<number>, degree : number, knots : KnotArray ) : LUDecomp {
        let n = knots.length - degree - 1;
        if (params.length != n) throw "Fit: need exactly one parameter per control point";
        let A : Matrix = [];
        for (let i = 0; i < n; i++) {
            let span = Eval.knotSpanGivenN( n - 1, degree, params[i], knots );
            let basis = Eval.basisFunctionsGivenKnotSpanIndex( span, params[i], degree, knots );
            let row = new Array<number>( n ).fill( 0.0 );
            for (let k = 0; k <= degree; k++) row[ span - degree + k ] = basis[k];
            A.push( row );
        }
        return Mat.LU( A );
    }

    // Solve for control points given an LU-decomposed collocation matrix and the points to interpolate.

    public static solvePoints( lu : LUDecomp, points : Array<Point> ) : Array<Point> {
        let dim = points[0].length;
        let cols : Array<Array<number>> = [];
        for (let k = 0; k < dim; k++) cols.push( Mat.LUsolve( lu, points.map( p => p[k] ) ) );
        return points.map( (_, i) => cols.map( c => c[i] ) );
    }

    // Interpolate `points` at the given parameters with a fixed knot vector. The result is non-rational.

    public static curveWithKnots( points : Array<Point>, params : Array<number>, degree : number, knots : KnotArray ) : NurbsCurveData {
        let cps = Fit.solvePoints( Fit.collocation( params, degree, knots ), points );
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
        let luV = Fit.collocation( paramsV, degreeV, knotsV );
        let rows = grid.map( row => Fit.solvePoints( luV, row ) );
        let luU = Fit.collocation( paramsU, degreeU, knotsU );
        let cols = Mat.transpose( rows ).map( col => Fit.solvePoints( luU, col ) );
        let cps = Mat.transpose( cols );
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
        let knotsV = curves[0].knots;
        for (let c of curves) {
            if (c.degree != curves[0].degree || c.knots.length != knotsV.length || c.controlPoints.length != curves[0].controlPoints.length)
                throw "Fit.loft: curves must share degree and knot vector";
        }
        if (params == null) {
            // average distance between corresponding control points of consecutive curves
            let acc = [0.0];
            for (let k = 1; k < curves.length; k++) {
                let a = Eval.dehomogenize1d( curves[k-1].controlPoints ), b = Eval.dehomogenize1d( curves[k].controlPoints );
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
        let knotsU = Fit.knotsByAveraging( params, degreeU );
        let luU = Fit.collocation( params, degreeU, knotsU );
        let nV = curves[0].controlPoints.length;
        // interpolate homogeneous control points column by column (exact for curves with matching weights)
        let columns : Array<Array<Point>> = [];
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
        let m = controlPoints.length;
        if (m <= degree) throw "Fit.periodicCurve: need more control points than the degree";
        let wrapped = controlPoints.concat( controlPoints.slice( 0, degree ) );
        let knots : KnotArray = [];
        for (let i = 0; i < wrapped.length + degree + 1; i++) knots.push( i );
        let a = degree, b = m + degree;
        let ins : Array<number> = [];
        for (let i = 0; i < degree; i++) ins.push( a );
        for (let i = 0; i < degree; i++) ins.push( b );
        let refined = Modify.curveKnotRefine( new NurbsCurveData( degree, knots, Eval.homogenize1d( wrapped, null ) ), ins );
        let k = refined.knots;
        let first = k.indexOf( a );
        let last = k.lastIndexOf( b );
        let subKnots = k.slice( first, last + 1 );
        let numCps = subKnots.length - degree - 1;
        let subCps = refined.controlPoints.slice( first, first + numCps );
        let span = b - a;
        return new NurbsCurveData( degree, subKnots.map( x => (x - a) / span ), subCps );
    }
}
