import { ArrayExtensions } from "../core/ArrayExtensions.js";
import { Binomial } from "../core/Binomial.js";
import { Constants } from "../core/Constants.js";
import { KnotArray, NurbsCurveData, NurbsSurfaceData, Pair, Point, VolumeData } from "../core/Data.js";
import { Vec } from "../core/Vec.js";

// `Eval` provides all of the core algorithms for evaluating points and derivatives on NURBS curves and surfaces. Most of the
// time, it makes more sense to use the tools in verb.geom for this, but in some cases this will make more sense.
//
// Eval also provides experimental tools for evaluating points in NURBS volumes.
//
// Many of these algorithms owe their implementation to Piegl & Tiller's "The NURBS Book"

export class Eval {

    //Compute the tangent at a point on a NURBS curve
    //
    //**params**
    //
    //* NurbsCurveData object representing the curve
    //* u parameter
    //* v parameter
    //
    //**returns**
    //
    //* a Vector represented by an array of length (dim)

    public static rationalCurveTangent( curve : NurbsCurveData, u : number ) : Array<number> {
        const derivs = Eval.rationalCurveDerivatives( curve, u, 1 );
        return derivs[1];
    }

    //Compute the derivatives at a point on a NURBS surface
    //
    //**params**
    //
    //* NurbsSurfaceData object representing the surface
    //* u parameter
    //* v parameter
    //
    //**returns**
    //
    //* a Vector represented by an array of length (dim)

    public static rationalSurfaceNormal( surface : NurbsSurfaceData, u : number, v : number) : Array<number> {
        const derivs = Eval.rationalSurfaceDerivatives( surface, u, v, 1 );
        return Vec.cross( derivs[1][0], derivs[0][1] );
    }

    //Compute the derivatives at a point on a NURBS surface
    //
    //**params**
    //
    //* NurbsSurfaceData object representing the surface
    //* number of derivatives to evaluate
    //* u parameter at which to evaluate the derivatives
    //* v parameter at which to evaluate the derivatives
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static rationalSurfaceDerivatives( 	surface : NurbsSurfaceData,
                                                        u : number,
                                                        v : number,
                                                        numDerivs? : number) : Array<Array<Array<number>>> { if (numDerivs == null) numDerivs = 1;

        const ders = Eval.surfaceDerivatives( surface, u, v, numDerivs)
        , Aders = Eval.rational2d(ders)
        , wders = Eval.weight2d(ders)
        , SKL = new Array<Array<Array<number>>>()
        , dim = Aders[0][0].length;

        for (let k = 0; k < numDerivs+1; k++) {
            SKL.push( new Array<Array<number>>() );

            for (let l = 0; l < numDerivs-k+1; l++) {
                const v = Aders[k][l];

                for (let j = 1; j < l+1; j++) {
                    Vec.subMulMutate( v, Binomial.get(l, j) * wders[0][j], SKL[k][l-j] );
                }

                for (let i = 1; i < k+1; i++) {
                    Vec.subMulMutate( v, Binomial.get(k, i) * wders[i][0], SKL[k-i][l] );

                    const v2 = Vec.zeros1d(dim);

                    for (let j = 1; j < l+1; j++) {
                        Vec.addMulMutate( v2, Binomial.get(l, j) * wders[i][j], SKL[k-i][l-j] );
                    }

                    Vec.subMulMutate( v, Binomial.get(k, i), v2 );
                }

                Vec.mulMutate(1 / wders[0][0], v );
                SKL[k].push( v ); //demogenize
            }
        }

        return SKL;
    }

    //Compute a point on a NURBS surface
    //
    //**params**
    //
    //* integer degree of surface in u direction
    //* array of nondecreasing knot values in u direction
    //* integer degree of surface in v direction
    //* array of nondecreasing knot values in v direction
    //* 3d array of control points (tensor), top to bottom is increasing u direction, left to right is increasing v direction,
    //and where each control point is an array of length (dim+1)
    //* u parameter at which to evaluate the surface point
    //* v parameter at which to evaluate the surface point
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static rationalSurfacePoint( surface : NurbsSurfaceData, u : number, v : number ) : Point {
        return Eval.dehomogenize( Eval.surfacePoint( surface, u, v ) );
    }

    //Determine the derivatives of a NURBS curve at a given parameter
    //
    //**params**
    //
    //* NurbsCurveData object representing the curve - the control points are in homogeneous coordinates
    //* parameter on the curve at which the point is to be evaluated
    //* number of derivatives to evaluate
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static rationalCurveDerivatives( curve : NurbsCurveData, u : number, numDerivs? : number) : Array<Point> { if (numDerivs == null) numDerivs = 1;

        const ders = Eval.curveDerivatives( curve, u, numDerivs )
        , Aders = Eval.rational1d(ders)
        , wders = Eval.weight1d(ders)
        , CK = [];

        for (let k = 0; k < numDerivs+1; k++) {
            const v = Aders[k];

            for (let i = 1; i < k+1; i++) {
                Vec.subMulMutate( v, Binomial.get(k, i) * wders[i], CK[k-i] );
            }
            
            Vec.mulMutate( 1/wders[0], v );
            CK.push( v ); //demogenize
        }

        return CK;

    }

    //Compute a point on a NURBS curve
    //
    //**params**
    //
    //* integer degree of curve
    //* array of nondecreasing knot values
    //* 2d array of homogeneous control points, where each control point is an array of length (dim+1)
    //and form (wi*pi, wi)
    //* parameter on the curve at which the point is to be evaluated
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static rationalCurvePoint( curve : NurbsCurveData, u : number) : Point {
        return Eval.dehomogenize( Eval.curvePoint( curve, u) );
    }

    //Compute the derivatives on a non-uniform, non-rational B spline surface
    //
    //**params**
    //
    //* NurbsSurfaceData object representing the surface
    //* number of derivatives to evaluate
    //* u parameter at which to evaluate the derivatives
    //* v parameter at which to evaluate the derivatives
    //
    //**returns**
    //
    //* a 2d jagged array representing the derivatives - u derivatives increase by row, v by column

    public static surfaceDerivatives( surface : NurbsSurfaceData, u : number, v : number, numDerivs : number ) : Array<Array<Point>> {

        const n = surface.knotsU.length - surface.degreeU - 2
        , m = surface.knotsV.length - surface.degreeV - 2;

        return Eval.surfaceDerivativesGivenNM( n, m, surface, u, v, numDerivs );

    }

    // Compute the derivatives on a non-uniform, non-rational B spline surface
    // (corresponds to algorithm 3.6 from The NURBS book, Piegl & Tiller 2nd edition)
    //
    //**params**
    //
    //* integer number of basis functions in u dir - 1 = knotsU.length - degreeU - 2
    //* integer number of basis functions in v dir - 1 = knotsU.length - degreeU - 2
    //* NurbsSurfaceData object representing the surface
    //* u parameter at which to evaluate the derivatives
    //* v parameter at which to evaluate the derivatives
    //
    //**returns**
    //
    //* a 2d jagged array representing the derivatives - u derivatives increase by row, v by column

    public static surfaceDerivativesGivenNM( n : number,
                                                     m : number,
                                                     surface : NurbsSurfaceData,
                                                     u : number,
                                                     v: number,
                                                     numDerivs : number ) : Array<Array<Point>>{

        const degreeU = surface.degreeU
        , degreeV = surface.degreeV
        , controlPoints = surface.controlPoints
        , knotsU = surface.knotsU
        , knotsV = surface.knotsV;

        if ( !Eval.areValidRelations(degreeU, controlPoints.length, knotsU.length ) ||
            !Eval.areValidRelations(degreeV, controlPoints[0].length, knotsV.length ) ) {

            throw 'Invalid relations between control points, knot vector, and n';
        }

        const dim = controlPoints[0][0].length;
        const du = numDerivs < degreeU ? numDerivs : degreeU;
        const dv = numDerivs < degreeV ? numDerivs : degreeV;
        const SKL = Vec.zeros3d( numDerivs+1, numDerivs+1, dim );
        const knotSpan_index_u = Eval.knotSpanGivenN( n, degreeU, u, knotsU );
        const knotSpan_index_v = Eval.knotSpanGivenN( m, degreeV, v, knotsV );
        // only the derivatives used (at most the degree: higher ones vanish). Asking for n of them, as upstream verb
        // did, made every evaluation cost in proportion to the number of control points
        const uders = Eval.derivativeBasisFunctionsGivenNI( knotSpan_index_u, u, degreeU, du, knotsU );
        const vders = Eval.derivativeBasisFunctionsGivenNI( knotSpan_index_v, v, degreeV, dv, knotsV );
        const temp = Vec.zeros2d( degreeV+1, dim );
        const iu = knotSpan_index_u - degreeU, iv = knotSpan_index_v - degreeV;
        let dd = 0;

        // the sums of Vec.addMulMutate, in the same order, without the allocations: this runs for every Newton step
        // of every projection and intersection
        for (let k = 0; k < du+1; k++) {
            const uk = uders[k];
            for (let s = 0; s < degreeV+1; s++) {
                const ts = temp[s];
                for (let i = 0; i < dim; i++) ts[i] = 0.0;

                for (let r = 0; r < degreeU+1; r++) {
                    const c = uk[r], P = controlPoints[iu+r][iv+s];
                    for (let i = 0; i < dim; i++) ts[i] = ts[i] + c * P[i];
                }
            }

            const nk = numDerivs - k;
            dd = nk < dv ? nk : dv;

            for (let l = 0; l < dd+1; l++) {
                const out = SKL[k][l], vl = vders[l];

                for (let s = 0; s < degreeV+1; s++) {
                    const c = vl[s], ts = temp[s];
                    for (let i = 0; i < dim; i++) out[i] = out[i] + c * ts[i];
                }
            }
        }

        return SKL;
    }

    //Compute a point on a non-uniform, non-rational B-spline surface
    //
    //**params**
    //
    //* NurbsSurfaceData object representing the surface
    //* u parameter at which to evaluate the surface point
    //* v parameter at which to evaluate the surface point
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static surfacePoint( surface : NurbsSurfaceData, u : number, v : number) : Point {

        const n = surface.knotsU.length - surface.degreeU - 2
        , m = surface.knotsV.length - surface.degreeV - 2;

        return Eval.surfacePointGivenNM( n, m, surface, u, v );

    }

    //Compute a point on a non-uniform, non-rational B spline surface
    // (corresponds to algorithm 3.5 from The NURBS book, Piegl & Tiller 2nd edition)
    //
    //**params**
    //
    //* integer number of basis functions in u dir - 1 = knotsU.length - degreeU - 2
    //* integer number of basis functions in v dir - 1 = knotsV.length - degreeV - 2
    //* NurbsSurfaceData object representing the surface
    //* u parameter at which to evaluate the surface point
    //* v parameter at which to evaluate the surface point
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static surfacePointGivenNM( n : number, m : number, surface : NurbsSurfaceData, u : number, v : number ) : Point {

        const degreeU = surface.degreeU
        , degreeV = surface.degreeV
        , controlPoints = surface.controlPoints
        , knotsU = surface.knotsU
        , knotsV = surface.knotsV;

        if ( !Eval.areValidRelations(degreeU, controlPoints.length, knotsU.length ) ||
            !Eval.areValidRelations(degreeV, controlPoints[0].length, knotsV.length ) ) {

            throw 'Invalid relations between control points, knot vector, and n';
        }

        const dim = controlPoints[0][0].length;
        const knotSpan_index_u = Eval.knotSpanGivenN( n, degreeU, u, knotsU );
        const knotSpan_index_v = Eval.knotSpanGivenN( m, degreeV, v, knotsV );
        const u_basis_vals = Eval.basisFunctionsGivenKnotSpanIndex( knotSpan_index_u, u, degreeU, knotsU );
        const v_basis_vals = Eval.basisFunctionsGivenKnotSpanIndex( knotSpan_index_v, v, degreeV, knotsV );
        const uind = knotSpan_index_u - degreeU;
        const position = Vec.zeros1d( dim );
        const temp = Vec.zeros1d( dim );

        for (let l = 0; l < degreeV + 1; l++) {

            for (let i = 0; i < dim; i++) temp[i] = 0.0;
            const vind = knotSpan_index_v - degreeV + l;

            //sample u isoline
            for (let k = 0; k < degreeU + 1; k++) {
                const c = u_basis_vals[k], P = controlPoints[uind+k][vind];
                for (let i = 0; i < dim; i++) temp[i] = temp[i] + c * P[i];
            }

            //add point from u isoline
            const c = v_basis_vals[l];
            for (let i = 0; i < dim; i++) position[i] = position[i] + c * temp[i];
        }

        return position;
    }

    public static curveRegularSamplePoints( crv : NurbsCurveData, divs : number ){

        // initialize the derivative set
        const derivs = Eval.curveDerivatives( crv, crv.knots[0], crv.degree );

        // expand the taylor series

        const t = 1.0 / divs;
        const temp = t * t;

        const f = derivs[0];
        const fd = Vec.mul(t, derivs[1] );
        const fdd_per2 = Vec.mul( temp * 0.5, derivs[2] );
        const fddd_per2 = Vec.mul( temp * t * 0.5, derivs[3] );

        const fdd = Vec.add( fdd_per2, fdd_per2 );
        const fddd = Vec.add( fddd_per2, fddd_per2 );
        const fddd_per6 = Vec.mul( 1/3, fddd_per2 );

        // evaluate the points
        const pts = [];

        for (let i = 0; i < divs+1; i++) {

            pts.push(Eval.dehomogenize(f));

            Vec.addAllMutate([ f, fd, fdd_per2, fddd_per6 ]);
            Vec.addAllMutate([ fd, fdd, fddd_per2 ]);
            Vec.addAllMutate([ fdd, fddd ]);
            Vec.addAllMutate([ fdd_per2, fddd_per2 ]);
        }

        return pts;

    }

    public static curveRegularSamplePoints2( crv : NurbsCurveData, divs : number ){

        // initialize the derivative set
        const derivs = Eval.curveDerivatives( crv, crv.knots[0], crv.degree );

        // expand the taylor series

        const t = 1.0 / divs;
        const temp = t * t;

        const f = derivs[0];
        const fd = Vec.mul(t, derivs[1] );
        const fdd_per2 = Vec.mul( temp * 0.5, derivs[2] );
        const fddd_per2 = Vec.mul( temp * t * 0.5, derivs[3] );

        const fdd = Vec.add( fdd_per2, fdd_per2 );
        const fddd = Vec.add( fddd_per2, fddd_per2 );
        const fddd_per6 = Vec.mul( 1/3, fddd_per2 );

        // evaluate the points
        const pts = [];

        for (let i = 0; i < divs+1; i++) {
            pts.push(Eval.dehomogenize(f));

            Vec.addAllMutate([ f, fd, fdd_per2, fddd_per6 ]);
            Vec.addAllMutate([ fd, fdd, fddd_per2 ]);
            Vec.addAllMutate([ fdd, fddd ]);
            Vec.addAllMutate([ fdd_per2, fddd_per2 ]);
        }

        return pts;
    }

    // Compute a regularly spaced grid of derivatives on a non-uniform, rational, B spline surface. Generally, this algorithm
    // is faster than directly evaluating these as we can pre-compute all of the basis function arrays
    //
    //**params**
    //
    //* NurbsSurfaceData object representing the surface
    //* number of divisions in the U direction
    //* number of divisions in the V direction
    //* number of derivatives
    //
    //**returns**
    //
    //* a 2d array of dimension (divsU+1, divsV+1) of derivative values where each entry is similar to that returned by `rationalSurfaceDerivatives`

    public static rationalSurfaceRegularSampleDerivatives( surface : NurbsSurfaceData, divsU : number, divsV : number, numDerivs : number ) {

        const allders = Eval.surfaceRegularSampleDerivatives( surface, divsU, divsV, numDerivs );

        const allratders = [];
        const divsU1 = divsU+1;
        const divsV1 = divsV+1;
        const numDerivs1 = numDerivs+1;

        for (let i = 0; i < divsU1; i++) {

            const rowders : any[] = [];
            allratders.push(rowders);

            for (let j = 0; j < divsV1; j++) {

                const ders = allders[i][j]
                , Aders = Eval.rational2d(ders)
                , wders = Eval.weight2d(ders)
                , SKL = new Array<Array<Array<number>>>()
                , dim = Aders[0][0].length;

                for (let k = 0; k < numDerivs1; k++) {
                    SKL.push( new Array<Array<number>>() );

                    for (let l = 0; l < numDerivs1-k; l++) {
                        const v = Aders[k][l];

                        for (let j = 1; j < l+1; j++) {
                            Vec.subMulMutate( v, Binomial.get(l, j) * wders[0][j], SKL[k][l-j] );
                        }

                        for (let i = 1; i < k+1; i++) {
                            Vec.subMulMutate( v, Binomial.get(k, i) * wders[i][0], SKL[k-i][l] );

                            const v2 = Vec.zeros1d(dim);

                            for (let j = 1; j < l+1; j++) {
                                Vec.addMulMutate( v2, Binomial.get(l, j) * wders[i][j], SKL[k-i][l-j] );
                            }

                            Vec.subMulMutate( v, Binomial.get(k, i), v2 );

                        }
                            
                        Vec.mulMutate(1 / wders[0][0], v );
                        SKL[k].push( v ); //demogenize
                    }
                }

                rowders.push(SKL);
            }
        }

        return allratders;
    }

    // Compute a regularly spaced grid of derivatives on a non-uniform, non-rational, B spline surface. Generally, this algorithm
    // is faster than directly evaluating these as we can pre-compute all of the basis function arrays
    //
    //**params**
    //
    //* NurbsSurfaceData object representing the surface
    //* number of divisions in the U direction
    //* number of divisions in the V direction
    //
    //**returns**
    //
    //* a 2d array of dimension (divsU+1, divsV+1) of derivative values where each entry is similar to that returned by surfaceDerivatives

    public static surfaceRegularSampleDerivatives( surface : NurbsSurfaceData, divsU : number, divsV : number, numDerivs : number ) {

        const degreeU = surface.degreeU
        , degreeV = surface.degreeV
        , controlPoints = surface.controlPoints
        , knotsU = surface.knotsU
        , knotsV = surface.knotsV;

        const dim = controlPoints[0][0].length
        , knotSpansBasesU = Eval.regularlySpacedDerivativeBasisFunctions( degreeU, knotsU, divsU )
        , knotSpansU = knotSpansBasesU.item0
        , basesU = knotSpansBasesU.item1
        , knotSpansBasesV = Eval.regularlySpacedDerivativeBasisFunctions( degreeV, knotsV, divsV )
        , knotSpansV = knotSpansBasesV.item0
        , basesV = knotSpansBasesV.item1
        , pts = []
        , divsU1 = divsU+1
        , divsV1 = divsV+1;

        for (let i = 0; i < divsU1; i++) {
            const ptsi : any[] = [];
            pts.push( ptsi );

            for (let j = 0; j < divsV1; j++) {
                ptsi.push( Eval.surfaceDerivativesGivenBasesKnotSpans( degreeU, degreeV, controlPoints, knotSpansU[i], knotSpansV[j], basesU[i], basesV[j], dim, numDerivs ) );
            }
        }

        return pts;
    }

    // Compute a regularly spaced grid of points on a non-uniform, rational, B spline surface. Generally, this algorithm
    // is faster than directly evaluating these as we can pre-compute all of the basis function arrays
    //
    //**params**
    //
    //* NurbsSurfaceData object representing the surface
    //* number of divisions in the U direction
    //* number of divisions in the V direction
    //
    //**returns**
    //
    //* a 2d array of dimension (divsU+1, divsV+1) of points

    public static rationalSurfaceRegularSamplePoints( surface : NurbsSurfaceData, divsU : number, divsV : number ) : Array<Array<Point>> {
        return Eval.dehomogenize2d( Eval.surfaceRegularSamplePoints( surface, divsU, divsV ) );
    }

    // Compute a regularly spaced grid of points on a non-uniform, non-rational, B spline surface. Generally, this algorithm
    // is faster than directly evaluating these as we can pre-compute all of the basis function arrays
    //
    //**params**
    //
    //* NurbsSurfaceData object representing the surface
    //* number of divisions in the U direction
    //* number of divisions in the V direction
    //
    //**returns**
    //
    //* a 2d array of dimension (divsU+1, divsV+1) of points

    public static surfaceRegularSamplePoints( surface : NurbsSurfaceData, divsU : number, divsV : number ) : Array<Array<Point>> {

        const degreeU = surface.degreeU
        , degreeV = surface.degreeV
        , controlPoints = surface.controlPoints
        , knotsU = surface.knotsU
        , knotsV = surface.knotsV;

        const dim = controlPoints[0][0].length
        , knotSpansBasesU = Eval.regularlySpacedBasisFunctions( degreeU, knotsU, divsU )
        , knotSpansU = knotSpansBasesU.item0
        , basesU = knotSpansBasesU.item1
        , knotSpansBasesV = Eval.regularlySpacedBasisFunctions( degreeV, knotsV, divsV )
        , knotSpansV = knotSpansBasesV.item0
        , basesV = knotSpansBasesV.item1
        , pts = []
        , divsU1 = divsU+1
        , divsV1 = divsV+1;

        for (let i = 0; i < divsU1; i++) {
            const ptsi : any[] = [];
            pts.push( ptsi );

            for (let j = 0; j < divsV1; j++) {
                ptsi.push( Eval.surfacePointGivenBasesKnotSpans( degreeU, degreeV, controlPoints, knotSpansU[i], knotSpansV[j], basesU[i], basesV[j], dim ) );
            }
        }

        return pts;
    }

    private static regularlySpacedBasisFunctions( degree : number, knots : KnotArray, divs : number ) : Pair<Array<number>, Array<Array<number>>> {

        const n : number = knots.length - degree - 2;
        const span : number = (ArrayExtensions.last(knots) - knots[0]) / divs;

        const bases = [];
        const knotspans = [];
        let u = knots[0];
        let knotIndex = Eval.knotSpanGivenN( n, degree, u, knots );
        const div1 = divs + 1;

        // compute all of the basis functions in given dir
        for (let i = 0; i < div1; i++) {
            while ( u >= knots[knotIndex+1] ) knotIndex++;
            knotspans.push( knotIndex );
            bases.push( Eval.basisFunctionsGivenKnotSpanIndex( knotIndex, u, degree, knots ) );
            u += span;
        }

        return new Pair<Array<number>, Array<Array<number>>>( knotspans, bases );
    }

    private static regularlySpacedDerivativeBasisFunctions(degree : number, knots : KnotArray, divs : number){

        const n : number = knots.length - degree - 2;
        const span : number = (ArrayExtensions.last(knots) - knots[0]) / divs;

        const bases = [];
        const knotspans = [];
        let u = knots[0];
        let knotIndex = Eval.knotSpanGivenN( n, degree, u, knots );
        const div1 = divs + 1;

        // compute all of the basis functions in given dir
        for (let i = 0; i < div1; i++) {
            while ( u >= knots[knotIndex+1] ) knotIndex++;
            knotspans.push( knotIndex );
            bases.push( Eval.derivativeBasisFunctionsGivenNI( knotIndex, u, degree, n, knots ) );
            u += span;
        }

        return new Pair<Array<number>, Array<Array<Array<number>>>>( knotspans, bases );
    }

    private static surfacePointGivenBasesKnotSpans( degreeU : number,
                                                             degreeV : number,
                                                             controlPoints : Array<Array<Point>>,
                                                             knotSpanU : number,
                                                             knotSpanV : number,
                                                             basesU : Array<number>,
                                                             basesV : Array<number>,
                                                             dim : number) : Point {

        const position = Vec.zeros1d( dim );
        let temp : Array<number>;

        // could be precomputed
        const uind = knotSpanU - degreeU;
        let vind = knotSpanV - degreeV;

        for (let l = 0; l < degreeV + 1; l++) {

            temp = Vec.zeros1d( dim );

            for (let k = 0; k < degreeU + 1; k++) {
                Vec.addMulMutate( temp, basesU[k], controlPoints[uind+k][vind] );
            }

            vind++;

            Vec.addMulMutate( position, basesV[l], temp );
        }

        return position;
    }

    private static surfaceDerivativesGivenBasesKnotSpans(degreeU : number,
                                                                  degreeV : number,
                                                                  controlPoints : Array<Array<Point>>,
                                                                  knotSpanU : number,
                                                                  knotSpanV : number,
                                                                  basesU : Array<Array<number>>,
                                                                  basesV : Array<Array<number>>,
                                                                  dim : number,
                                                                  numDerivs : number ){

        dim = controlPoints[0][0].length;
        const du = numDerivs < degreeU ? numDerivs : degreeU;
        const dv = numDerivs < degreeV ? numDerivs : degreeV;
        const SKL = Vec.zeros3d( du+1, dv+1, dim );
        const temp = Vec.zeros2d( degreeV+1, dim );
        let dd = 0;

        for (let k = 0; k < du+1; k++) {
            for (let s = 0; s < degreeV+1; s++) {
                temp[s] = Vec.zeros1d( dim );

                for (let r = 0; r < degreeU+1; r++) {
                    Vec.addMulMutate( temp[s], basesU[k][r], controlPoints[knotSpanU-degreeU+r][knotSpanV-degreeV+s] );
                }
            }

            const nk = numDerivs - k;
            dd = nk < dv ? nk : dv;

            for (let l = 0; l < dd+1; l++) {
                SKL[k][l] = Vec.zeros1d( dim );

                for (let s = 0; s < degreeV+1; s++) {
                    Vec.addMulMutate( SKL[k][l], basesV[l][s], temp[s] );
                }
            }
        }

        return SKL;
    }

    //Determine the derivatives of a non-uniform, non-rational B-spline curve at a given parameter
    //
    //**params**
    //
    //* NurbsCurveData object representing the curve
    //* parameter on the curve at which the point is to be evaluated
    //* number of derivatives to evaluate
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static curveDerivatives( crv : NurbsCurveData, u : number, numDerivs : number ) : Array<Point> {

        const n = crv.knots.length - crv.degree - 2;
        return Eval.curveDerivativesGivenN( n, crv, u, numDerivs);

    }

    //Determine the derivatives of a non-uniform, non-rational B-spline curve at a given parameter
    // (corresponds to algorithm 3.1 from The NURBS book, Piegl & Tiller 2nd edition)
    //
    //**params**
    //
    //* integer number of basis functions - 1 = knots.length - degree - 2
    //* NurbsCurveData object representing the curve
    //* parameter on the curve at which the point is to be evaluated
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static curveDerivativesGivenN( n : number, curve : NurbsCurveData, u : number, numDerivs : number ) : Array<Point> {

        const degree = curve.degree
        , controlPoints = curve.controlPoints
        , knots = curve.knots;

        if ( !Eval.areValidRelations( degree, controlPoints.length, knots.length ) ) {
            throw 'Invalid relations between control points, knot vector, and n';
        }

        const dim = controlPoints[0].length
        , du = numDerivs < degree ? numDerivs : degree
        , CK = Vec.zeros2d( numDerivs+1, dim )
        , knotSpan_index = Eval.knotSpanGivenN( n, degree, u, knots )
        , nders = Eval.derivativeBasisFunctionsGivenNI( knotSpan_index, u, degree, du, knots );

        for (let k = 0; k < du+1; k++) {
            for (let j = 0; j < degree+1; j++) {
                Vec.addMulMutate( CK[k], nders[k][j], controlPoints[ knotSpan_index - degree + j ] );
            }
        }
        return CK;
    }

    //Compute a point on a non-uniform, non-rational b-spline curve
    //
    //**params**
    //
    //* NurbsCurveData object representing the curve
    //* parameter on the curve at which the point is to be evaluated
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static curvePoint( curve : NurbsCurveData, u : number) {
        const n = curve.knots.length - curve.degree - 2;
        return Eval.curvePointGivenN( n, curve, u);
    }

    //Confirm the relations between degree (p), number of control points(n+1), and the number of knots (m+1)
    //via The NURBS Book (section 3.2, Second Edition)
    //
    //**params**
    //
    //* integer degree
    //* integer number of control points
    //* integer length of the knot Array (including duplicate knots)
    //
    //**returns**
    //
    //* whether the values are correct

    public static areValidRelations( degree : number, num_controlPoints : number, knots_length : number ) : boolean {
        return num_controlPoints + degree + 1 - knots_length == 0;
    }

    //Compute a point on a non-uniform, non-rational b-spline curve
    // (corresponds to algorithm 3.1 from The NURBS book, Piegl & Tiller 2nd edition)
    //
    //**params**
    //
    //* integer number of basis functions - 1 = knots.length - degree - 2
    //* NurbsCurveData object representing the curve
    //* parameter on the curve at which the point is to be evaluated
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static curvePointGivenN( n : number, curve : NurbsCurveData, u : number) : Point {

        const degree = curve.degree
            , controlPoints = curve.controlPoints
            , knots = curve.knots;

        if ( !Eval.areValidRelations( degree, controlPoints.length, knots.length ) ) {
            throw 'Invalid relations between control points, knot Array, and n';
        }

        const knotSpan_index = Eval.knotSpanGivenN( n, degree, u, knots );
        const basis_values = Eval.basisFunctionsGivenKnotSpanIndex( knotSpan_index, u, degree, knots );
        const position = Vec.zeros1d( controlPoints[0].length );

        for (let j = 0; j < degree+1; j++) {
            Vec.addMulMutate( position, basis_values[j], controlPoints[ knotSpan_index - degree + j ] );
        }

        return position;
    }

    //Compute a point in a non-uniform, non-rational B spline volume
    //
    //**params**
    //
    //* VolumeData
    //* u parameter at which to evaluate the volume point
    //* v parameter at which to evaluate the volume point
    //* w parameter at which to evaluate the volume point
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static volumePoint( volume : VolumeData, u : number, v : number, w : number ) : Point {
        const n = volume.knotsU.length - volume.degreeU - 2
        , m = volume.knotsV.length - volume.degreeV - 2
        , l = volume.knotsW.length - volume.degreeW - 2;

        return Eval.volumePointGivenNML( volume, n, m, l, u, v, w );
    }

    //Compute a point in a non-uniform, non-rational B spline volume
    //
    //**params**
    //
    //* VolumeData
    //* u parameter at which to evaluate the volume point
    //* v parameter at which to evaluate the volume point
    //* w parameter at which to evaluate the volume point
    //
    //**returns**
    //
    //* a point represented by an array of length (dim)

    public static volumePointGivenNML( volume : VolumeData,
                                                n : number,
                                                m : number,
                                                l : number,
                                                u : number,
                                                v : number,
                                                w : number  ) : Point {

        if ( !Eval.areValidRelations(volume.degreeU, volume.controlPoints.length, volume.knotsU.length ) ||
        !Eval.areValidRelations(volume.degreeV, volume.controlPoints[0].length, volume.knotsV.length ) ||
        !Eval.areValidRelations(volume.degreeW, volume.controlPoints[0][0].length, volume.knotsW.length ) ) {
            throw 'Invalid relations between control points and knot vector';
        }

        const controlPoints = volume.controlPoints
        , degreeU = volume.degreeU
        , degreeV = volume.degreeV
        , degreeW = volume.degreeW
        , knotsU = volume.knotsU
        , knotsV = volume.knotsV
        , knotsW = volume.knotsW;

        const dim = controlPoints[0][0][0].length;
        const knotSpan_index_u = Eval.knotSpanGivenN( n, degreeU, u, knotsU );
        const knotSpan_index_v = Eval.knotSpanGivenN( m, degreeV, v, knotsV );
        const knotSpan_index_w = Eval.knotSpanGivenN( l, degreeW, w, knotsW );
        const u_basis_vals = Eval.basisFunctionsGivenKnotSpanIndex( knotSpan_index_u, u, degreeU, knotsU );
        const v_basis_vals = Eval.basisFunctionsGivenKnotSpanIndex( knotSpan_index_v, v, degreeV, knotsV );
        const w_basis_vals = Eval.basisFunctionsGivenKnotSpanIndex( knotSpan_index_w, w, degreeW, knotsW );
        const uind = knotSpan_index_u - degreeU;
        const position = Vec.zeros1d( dim );
        let temp = Vec.zeros1d( dim );
        let temp2 = Vec.zeros1d( dim );

        for (let i = 0; i < degreeW + 1; i++) {

            temp2 = Vec.zeros1d( dim );
            const wind = knotSpan_index_w - degreeW + i;

            for (let j = 0; j < degreeV + 1; j++) {

                temp = Vec.zeros1d( dim );
                const vind = knotSpan_index_v  - degreeV + j;

                for (let k = 0; k < degreeU + 1; k++) {
                    Vec.addMulMutate( temp, u_basis_vals[k], controlPoints[uind+k][vind][wind] );
                }

             //add weighted contribution of u isoline
                Vec.addMulMutate( temp2, v_basis_vals[j], temp );
            }

            //add weighted contribution from uv isosurfaces
            Vec.addMulMutate( position, w_basis_vals[i], temp2 );
        }

        return position;
    }

    //Compute the non-vanishing basis functions and their derivatives
    //
    //**params**
    //
    //* float parameter
    //* integer degree
    //* array of nondecreasing knot values
    //
    //**returns**
    //
    //* 2d array of basis and derivative values of size (n+1, p+1) The nth row is the nth derivative and the first row is made up of the basis function values.

    public static derivativeBasisFunctions( u : number, degree : number, knots : KnotArray ): Array<Array<number>>
    {
        const knotSpan_index = Eval.knotSpan( degree, u, knots )
        , m = knots.length - 1
        , n = m - degree - 1;

        return Eval.derivativeBasisFunctionsGivenNI( knotSpan_index, u, degree, n, knots );
    }

    // Compute the non-vanishing basis functions and their derivatives
    // (corresponds to algorithm 2.3 from The NURBS book, Piegl & Tiller 2nd edition)
    //
    //**params**
    //
    //* integer knot span index
    //* float parameter
    //* integer degree
    //* integer number of basis functions - 1 = knots.length - degree - 2
    //* array of nondecreasing knot values
    //
    //**returns**
    //
    //* 2d array of basis and derivative values of size (n+1, p+1) The nth row is the nth derivative and the first row is made up of the basis function values.

    public static derivativeBasisFunctionsGivenNI( knotIndex : number, u : number, p : number,
                                                            n : number, knots : KnotArray ) : Array<Array<number>>
    {
        const ndu = Vec.zeros2d( p+1, p+1 );
        const left = Vec.zeros1d( p + 1 );
        const right = Vec.zeros1d( p + 1 );
        let saved = 0.0;
        let temp = 0.0;

        ndu[0][0] = 1.0;

        for (let j = 1; j < p+1; j++) {
            left[j] = u - knots[knotIndex+1-j];
            right[j] = knots[knotIndex+j] - u;
            saved = 0.0;

            for (let r = 0; r < j; r++) {
                ndu[j][r] = right[r+1] + left[j-r];
                temp = ndu[r][j-1] / ndu[j][r];

                ndu[r][j] = saved + right[r+1]*temp;
                saved = left[j-r]*temp;

            }
            ndu[j][j] = saved;
        }

        const ders = Vec.zeros2d(n+1, p+1);
        const a = Vec.zeros2d(2, p+1);
        let s1 : number = 0;
        let s2 : number = 1;
        let d : number = 0.0;
        let rk : number = 0;
        let pk : number = 0;
        let j1 : number = 0;
        let j2 : number = 0;

        for (let j = 0; j < p+1; j++) {
            ders[0][j] = ndu[j][p];
        }

        for (let r = 0; r < p+1; r++) {
            s1 = 0;
            s2 = 1;
            a[0][0] = 1.0;

            for (let k = 1; k < n+1; k++) 
            {
                d = 0.0;
                rk = r - k;
                pk = p - k;

                if (r >= k) {
                    a[s2][0] = a[s1][0] / ndu[pk+1][rk];
                    d = a[s2][0] * ndu[rk][pk];
                }

                if (rk >= -1) {
                    j1 = 1;
                } else {
                    j1 = -rk;
                }

                if (r-1 <= pk) {
                    j2 = k-1;
                } else {
                    j2 = p - r;
                }

                for (let j = j1; j < j2+1; j++) {
                    a[s2][j] = ( a[s1][j] - a[s1][ j - 1 ] ) / ndu[ pk + 1 ][ rk + j ];
                    d += a[s2][j]*ndu[rk+j][pk];
                }

                if (r <= pk){
                    a[s2][k] = -a[s1][k-1]/ndu[pk+1][r];
                    d += a[s2][k] * ndu[r][pk];
                }

                ders[k][r] = d;

                const temp = s1;
                s1 = s2;
                s2 = temp;
            }
        }

        let acc = p;
        for (let k = 1; k < n+1; k++) {
            for (let j = 0; j < p+1; j++) {
                ders[k][j] *= acc;
            }
            acc *= (p-k);
        }

        return ders;
    }


    //Compute the non-vanishing basis functions
    //
    //**params**
    //
    //* float parameter
    //* integer degree of function
    //* array of nondecreasing knot values
    //
    //**returns**
    //
    //* list of non-vanishing basis functions
    //

    public static basisFunctions( u : number, degree : number, knots : KnotArray) : Array<number>
    {
        const knotSpan_index = Eval.knotSpan(degree, u, knots);
        return Eval.basisFunctionsGivenKnotSpanIndex( knotSpan_index, u, degree, knots );
    }

    //Compute the non-vanishing basis functions
    // (corresponds to algorithm 2.2 from The NURBS book, Piegl & Tiller 2nd edition)
    //
    //**params**
    //
    //* *Number*, integer knot span index
    //* *Number*, float parameter
    //* *Number*, integer degree of function
    //* array of nondecreasing knot values
    //
    //**returns**
    //
    //* list of non-vanishing basis functions
    //

    public static basisFunctionsGivenKnotSpanIndex( knotSpan_index : number,
                                                                  u : number,
                                                                  degree : number,
                                                                  knots : KnotArray ) : Array<number>
    {
        const basisFunctions = Vec.zeros1d( degree + 1 );
        const left = Vec.zeros1d( degree + 1 );
        const right = Vec.zeros1d( degree + 1 );
        let saved : number = 0;
        let temp : number = 0;

        basisFunctions[0] = 1.0;

        for (let j = 1; j < degree+1; j++) {
            left[j] = u - knots[knotSpan_index+1-j];
            right[j] = knots[knotSpan_index+j] - u;
            saved = 0.0;

            for (let r = 0; r < j; r++) {
                temp = basisFunctions[r] / ( right[r+1] + left[j-r] );
                basisFunctions[r] = saved + right[r+1]*temp;
                saved = left[j-r]*temp;
            }

            basisFunctions[j] = saved;
        }

        return basisFunctions;
    }

    //Find the span on the knot Array without supplying n
    //
    //**params**
    //
    //* integer degree of function
    //* float parameter
    //* array of nondecreasing knot values
    //
    //**returns**
    //
    //* the index of the knot span
    //

    public static knotSpan( degree : number, u : number, knots : Array<number> ) : number
    {
        return Eval.knotSpanGivenN(knots.length - degree - 2, degree, u, knots);
    }

    //Find the span on the knot Array knots of the given parameter
    // (corresponds to algorithm 2.1 from The NURBS book, Piegl & Tiller 2nd edition)
    //
    //**params**
    //
    //* integer number of basis functions - 1 = knots.length - degree - 2
    //* integer degree of function
    //* parameter
    //* array of nondecreasing knot values
    //
    //**returns**
    //
    //* the index of the knot span
    //

    public static knotSpanGivenN( n : number, degree : number, u : number, knots : Array<number> ) : number
    {
        if ( u > knots[n+1] - Constants.EPSILON )
        {
            return n;
        }

        if ( u < knots[degree] + Constants.EPSILON )
        {
            return degree;
        }

        let low = degree
            , high = n+1
            , mid = Math.floor( (low + high) / 2 );

        while( u < knots[ mid ] || u >= knots[ mid + 1 ] )
        {
            if ( u < knots[ mid ] )
            {
                high = mid;
            }
            else
            {
                low = mid;
            }
            mid = Math.floor( (low + high) / 2 );
        }

        return mid;
    }

    //Dehomogenize a point
    //
    //**params**
    //
    //* a point represented by an array (wi*pi, wi) with length (dim+1)
    //
    //**returns**
    //
    //* a point represented by an array pi with length (dim)

    public static dehomogenize( homoPoint : Point ) : Point {

        const dim = homoPoint.length
        , point = []
        , wt = homoPoint[dim-1]
        , l = homoPoint.length - 1;

        for (let i = 0; i < l; i++) {
            point.push( homoPoint[i] / wt );
        }

        return point;
    }

    //Obtain the point from a point in homogeneous space without dehomogenization, assuming all are the same
    //length
    //
    //**params**
    //
    //* array of points represented by an array (wi*pi, wi) with length (dim+1)
    //
    //**returns**
    //
    //* array of points represented by an array (wi*pi) with length (dim)

    public static rational1d( homoPoints : Array<Point> ) : Array<Point> {
        const dim = homoPoints[0].length - 1;
        return homoPoints.map(function(x : Point){ return x.slice(0,dim); });
    }

    //Obtain the weight from a collection of points in homogeneous space, assuming all
    //are the same dimension
    //
    //**params**
    //
    //* array of arrays of of points represented by an array (wi*pi, wi) with length (dim+1)
    //
    //**returns**
    //
    //*  array of arrays of points, each represented by an array pi with length (dim)

    public static rational2d( homoPoints : Array<Array<Point>> ) : Array<Array<Point>> {
        return homoPoints.map(Eval.rational1d);
    }

    //Obtain the weight from a collection of points in homogeneous space, assuming all
    //are the same dimension
    //
    //**params**
    //
    //* array of points represented by an array (wi*pi, wi) with length (dim+1)
    //
    //**returns**
    //
    //* a point represented by an array pi with length (dim)

    public static weight1d( homoPoints : Array<Point> ) : Array<number> {
        const dim = homoPoints[0].length - 1;
        return homoPoints.map(function(x){ return x[dim]; });
    }

    //Obtain the weight from a collection of points in homogeneous space, assuming all
    //are the same dimension
    //
    //**params**
    //
    //* array of arrays of of points represented by an array (wi*pi, wi) with length (dim+1)
    //
    //**returns**
    //
    //*  array of arrays of points, each represented by an array pi with length (dim)

    public static weight2d( homoPoints : Array<Array<Point>> ) : Array<Array<number>> {
        return homoPoints.map(Eval.weight1d);
    }

    //Dehomogenize an array of points
    //
    //**params**
    //
    //* array of points represented by an array (wi*pi, wi) with length (dim+1)
    //
    //**returns**
    //
    //* an array of points, each of length dim

    public static dehomogenize1d( homoPoints : Array<Point> ) : Array<Point>{
        return homoPoints.map(Eval.dehomogenize);
    }

    //Dehomogenize a 2d array of pts
    //
    //**params**
    //
    //* array of arrays of points represented by an array (wi*pi, wi) with length (dim+1)
    //
    //**returns**
    //
    //* array of arrays of points, each of length dim

    public static dehomogenize2d( homoPoints : Array<Array<Point>> ) : Array<Array<Point>> {
        return homoPoints.map(Eval.dehomogenize1d);
    }

    //Transform a 1d array of points into their homogeneous equivalents
    //
    //**params**
    //
    //* 1d array of control points, (actually a 2d array of size (m x dim) )
    //* array of control point weights, the same size as the array of control points (m x 1)
    //
    //**returns**
    //
    //* 1d array of control points where each point is (wi*pi, wi) where wi
    //i the ith control point weight and pi is the ith control point,
    //hence the dimension of the point is dim + 1

    public static homogenize1d( controlPoints : Array<Point>, weights : Array<number> | null = null) : Array<Point> {

        const rows = controlPoints.length;
        const dim = controlPoints[0].length;
        const homo_controlPoints = new Array<Point>();
        let wt : number = 0.0;
        let ref_pt = [];
        weights = weights != null ? weights : Vec.rep( controlPoints.length, 1.0 );

        for (let i = 0; i < rows; i++) {

            const pt = [];
            ref_pt = controlPoints[i];
            wt = weights[i];

            for (let k = 0; k < dim; k++) {
                pt.push( ref_pt[k] * wt );
            }

            //append the weight
            pt.push(wt);

            homo_controlPoints.push(pt);
        }

        return homo_controlPoints;

    }

    //**params**
    //
    //* 2d array of control points, (actually a 3d array of size m x n x dim)
    //* array of control point weights, the same size as the control points array (m x n x 1)
    //
    //**returns**
    //
    //* 1d array of control points where each point is (wi*pi, wi) where wi
    //i the ith control point weight and pi is the ith control point, the size is
    // (m x n x dim+1)

    public static homogenize2d( controlPoints : Array<Array<Point>>,
                                         weights: Array<Array<number>> | null = null ) : Array<Array<Point>> {
        const rows = controlPoints.length
        , homo_controlPoints = new Array<Array<Point>>()
        ;
        weights = weights != null ? weights : Array.from({ length: rows }, () => Vec.rep( controlPoints[0].length, 1.0 ));

        for (let i = 0; i < rows; i++) {
            homo_controlPoints.push( Eval.homogenize1d(controlPoints[i], weights[i]) );
        }

        return homo_controlPoints;
    }

}

/*
//
//Compute the gaussian curvature on a non-uniform, non-rational B spline surface
//
//**params**
//* integer degree of surface in u direction
//* array of nondecreasing knot values in u direction
//* integer degree of surface in v direction
//* array of nondecreasing knot values in v direction
//* 3d array of control points, where rows are the u dir, and columns run alonsg the positive v direction,
//and where each control point is an array of length (dim)
//* u parameter at which to evaluate the derivatives
//* v parameter at which to evaluate the derivatives
//
//**returns**
//* a point represented by an array of length (dim)
//

public static function rational_surface_curvature( degree_u, knots_u, degree_v, knots_v, homo_control_points, u, v ) {

//compute the first fundamental form

//symmetric matrix where
//
//I = [ E F; F G ]
//
//where:
//
//E = Xu * Xu
//F = Xu * Xv
//G = Xv * Xv

//second fundamental form (shape operator)

//symmetric matrix where
//
//II = [ L M; M N ]
//
//where:
//
//L = Xuu * n
//M = Xuv * n
//N = Xvv * n

//principal curvatures are the eigenvalues of the second fundamental form

var derivs = rational_surface_derivs( 	degree_u,
knots_u,
degree_v,
knots_v,
homo_control_points,
2, u, v );


//structure of the derivatives

//pos  du  vuu
//dv   duv
//dvv

var du = derivs[0][1];
var dv = derivs[1][0];
var duu = derivs[0][2];
var dvv = derivs[2][0];
var duv = derivs[1][1];

var n = Vec.cross( du, dv );
var L = Vec.dot( duu, n );
var M = Vec.dot( duv, n );
var N = Vec.dot( dvv, n );

var shapeOperator = [ [ L, M ], [ M, N ] ];

var eigs = Vec.eig( shapeOperator );

//contains: lambda - x
// 			     E - x

var k1 = eigs.lambda.x[0];
var k2 = eigs.lambda.x[1];
var mean = 0.5 * ( k1 + k2 );
var gaussian = k1 * k2;
var p1 = Vec.add( Vec.mul( eigs.E.x[0][0], du ), Vec.mul( eigs.E.x[0][1], dv ) );
var p2 = Vec.add( Vec.mul( eigs.E.x[1][0], du ), Vec.mul( eigs.E.x[1][1], dv ) );

return { point: derivs[0][0], normal: n, mean: mean, gaussian: gaussian, shapeOperator: shapeOperator, k1: k1, k2: k2, p1: p1, p2: p2, p1p : eigs.E.x[0], p2p: eigs.E.x[1]  };

};
*/
