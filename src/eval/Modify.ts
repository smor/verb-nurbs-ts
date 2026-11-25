import { ArrayExtensions } from "../core/ArrayExtensions.js";
import { Binomial } from "../core/Binomial.js";
import { Constants } from "../core/Constants.js";
import { Interval, KnotArray, Matrix, NurbsCurveData, NurbsSurfaceData, Point } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "./Analyze.js";
import { Eval } from "./Eval.js";
import { Make } from "./Make.js";

// `Modify` contains many fundamental algorithms for working with NURBS. These include algorithms for:
//
//* knot insertion
//* knot refinement
//* decomposition into bezier's
//* degree elevation
//* reparameterization
//
// Many of these algorithsm owe their implementation to Piegl & Tiller's, "The NURBS Book"
//
export class Modify {

    //Reverses the parameterization of a NURBS curve. The domain is unaffected.
    //
    //**params**
    //
    //* A NURBS curve to be reversed
    //
    //**returns**
    //
    //* A new NURBS curve with a reversed parameterization

    public static curveReverse( curve : NurbsCurveData ) : NurbsCurveData {
        return new NurbsCurveData( curve.degree, Modify.knotsReverse( curve.knots ), ArrayExtensions.reversed(curve.controlPoints) );
    }

    //Reverse the parameterization of a NURBS surface in the specified direction. The domain is unaffected.
    //
    //**params**
    //
    //* A NURBS surface to be reversed
    //* Whether to use the U direction or V direction
    //
    //**returns**
    //
    //* A new NURBS surface with a reversed parameterization in the given direction

    public static surfaceReverse( surface : NurbsSurfaceData, useV? : boolean) : NurbsSurfaceData { if (useV == null) useV = false;
        if (useV){
            return new NurbsSurfaceData( surface.degreeU, surface.degreeV, surface.knotsU, Modify.knotsReverse(surface.knotsV),
                surface.controlPoints.map((row) => ArrayExtensions.reversed(row)));

        }

        return new NurbsSurfaceData( surface.degreeU, surface.degreeV, Modify.knotsReverse(surface.knotsU), surface.knotsV,
            ArrayExtensions.reversed(surface.controlPoints));
    }

    //Reverse a knot vector
    //
    //**params**
    //
    //* An array of knots
    //
    //**returns**
    //
    //* The reversed array of knots

    public static knotsReverse( knots : KnotArray ) : KnotArray {
        const min = ArrayExtensions.first(knots);

        const l = [ min ];
        const len = knots.length;
        for (let i = 1; i < len; i++) {
            l.push( l[i-1] + ( knots[len-i] - knots[len-i-1] ) );
        }

        return l;
    }

    //Unify the knot vectors of a collection of NURBS curves. This can be used, for example, is used for lofting between curves.
    //
    //**params**
    //
    //* An array of NURBS curves
    //
    //**returns**
    //
    //* A collection of NURBS curves, all with the same knot vector

    public static unifyCurveKnotVectors( curves : Array<NurbsCurveData> ) : Array<NurbsCurveData> {
        curves = curves.map(Make.clonedCurve);

        const maxDegree = curves.reduce(function(a, x){ return Modify.imax(x.degree, a); }, 0 );

        //elevate all curves to the same degree
        for (let i = 0; i < curves.length; i++) {
            if (curves[i].degree < maxDegree){
                curves[i] = Modify.curveElevateDegree( curves[i], maxDegree );
            }
        }

        const knotIntervals = curves.map((c) => new Interval( ArrayExtensions.first(c.knots), ArrayExtensions.last(c.knots) ));

        //shift all knot vectors to start at 0.0
        for (let i = 0; i < curves.length; i++) {
            const min = knotIntervals[i].min;
            curves[i].knots = curves[i].knots.map(function(x){ return x - min; });
        }

        //find the max knot span
        const knotSpans = knotIntervals.map(function(x){ return x.max - x.min; });
        const maxKnotSpan = knotSpans.reduce(function(a, x){ return Math.max(x, a); }, 0.0 );

        //scale all of the knot vectors to match
        for (let i = 0; i < curves.length; i++) {
            const scale = maxKnotSpan / knotSpans[i];
            curves[i].knots = curves[i].knots.map(function(x){ return x * scale; });
        }

        //merge all of the knot vectors
        const mergedKnots = curves.reduce(function(a, x){ return Vec.sortedSetUnion(x.knots,a); }, [] as Array<number>);

        //knot refinement on each curve
        for (let i = 0; i < curves.length; i++) {
            const rem = Vec.sortedSetSub( mergedKnots, curves[i].knots );
            curves[i] = Modify.curveKnotRefine( curves[i], rem  );
        }

        return curves;
    }

    private static imin( a : number, b : number ) : number {
        return a < b ? a : b;
    }

    private static imax( a : number, b : number ) : number {
        return a > b ? a : b;
    }

    //Elevate the degree of a NURBS curve
    //
    //**params**
    //
    //* The curve to elevate
    //* The expected final degree
    //
    //**returns**
    //
    //* The NURBS curve after degree elevation - if the supplied degree is <= the curve is returned unmodified

    public static curveElevateDegree( curve : NurbsCurveData, finalDegree : number ) : NurbsCurveData {

        if (finalDegree <= curve.degree) return curve;

        //args
        const n = curve.knots.length - curve.degree - 2;
        const newDegree = curve.degree;
        const knots = curve.knots;
        const controlPoints = curve.controlPoints;
        const degreeInc = finalDegree - curve.degree;

        const dim = curve.controlPoints[0].length;

        //intermediate values
        const bezalfs = Vec.zeros2d( newDegree + degreeInc + 1, newDegree + 1);
        const bpts = [];
        const ebpts = [];
        const Nextbpts = [];

        const m = n + newDegree + 1;
        const ph = finalDegree;
        const ph2 = Math.floor(ph / 2);

        //return values
        const Qw = [];
        const Uh = [];

        bezalfs[0][0] = 1.0;
        bezalfs[ph][newDegree] = 1.0;

        for (let i = 1; i < ph2+1; i++) {
            const inv = 1.0 / Binomial.get( ph, i );
            const mpi = Modify.imin(newDegree,i);
            for (let j = Modify.imax(0,i-degreeInc); j < mpi+1; j++) {
                bezalfs[i][j] = inv * Binomial.get(newDegree,j) * Binomial.get(degreeInc,i-j);
            }
        }
        for (let i = ph2+1; i < ph; i++) {
            const mpi = Modify.imin(newDegree,i);
            for (let j = Modify.imax(0,i-degreeInc); j < mpi+1; j++) {
                bezalfs[i][j] = bezalfs[ph-i][newDegree-j];
            }
        }
        let mh = ph;
        let kind = ph+1;
        let r = -1;
        let a = newDegree;
        let b = newDegree+1;
        let cind = 1;
        let ua = knots[0];
        Qw[0] = controlPoints[0];
        for (let i = 0; i < ph+1; i++) {
            Uh[i] = ua;
        }
        for (let i = 0; i < newDegree+1; i++) {
            bpts[i] = controlPoints[i];
        }
        while (b < m){
            const i = b;
            while( b < m && knots[b] == knots[b+1]){
                b = b+1;
            }
            const mul = b-i+1;
            mh = mh+mul+degreeInc;
            const ub = knots[b];
            const oldr = r;
            r = newDegree-mul;
            //check for integer arithmetic
            const lbz = oldr > 0 ? Math.floor((oldr+2)/2) : 1;
            const rbz = r > 0 ? Math.floor(ph-(r+1)/2) : ph;
            if (r > 0){
                const numer = ub-ua;
                const alfs = [];
                let k = newDegree;
                while (k > mul){
                    alfs[k-mul-1] = numer/(knots[a+k]-ua); //integer arithmetic?
                    k--;
                }
                for (let j = 1; j < r+1; j++) {
                    const save = r-j;
                    const s = mul+j;
                    let k = newDegree;
                    while ( k >= s ){
                        bpts[k] = Vec.add( Vec.mul(alfs[k-s],bpts[k]), Vec.mul(1.0-alfs[k-s], bpts[k-1]));
                        k--;
                    }
                    Nextbpts[save] = bpts[newDegree];
                }
            }

            for (let i = lbz; i < ph+1; i++) {
                ebpts[i] = Vec.zeros1d( dim );
                const mpi = Modify.imin(newDegree,i);
                for (let j = Modify.imax(0,i-degreeInc); j < mpi+1; j++) {
                    ebpts[i] = Vec.add( ebpts[i], Vec.mul( bezalfs[i][j], bpts[j]));
                }
            }

            if (oldr > 1){
                let first = kind-2;
                let last = kind;
                const den = ub-ua;
                const bet = (ub-Uh[kind-1])/den; //integer arithmetic?
                for (let tr = 1; tr < oldr; tr++) {
                    let i = first;
                    let j = last;
                    let kj = j-kind+1;
                    while (j-i > tr){
                        if (i < cind){
                            const alf = (ub-Uh[i])/(ua-Uh[i]); //integer arithmetic?
                            Qw[i] = Vec.lerp(alf, Qw[i], Qw[i-1]);
                        }
                        if ( j >= lbz ){
                            if ( j-tr <= kind-ph+oldr ){
                                const gam = (ub-Uh[j-tr])/den;
                                ebpts[kj] = Vec.lerp(gam, ebpts[kj], ebpts[kj+1]);
                            }
                        } else {
                            ebpts[kj] = Vec.lerp(bet, ebpts[kj], ebpts[kj+1]);
                        }
                        i = i+1;
                        j = j-1;
                        kj = kj-1;
                    }
                    first = first-1;
                    last = last+1;
                }
            }

            if (a != newDegree){
                for (let i = 0; i < ph-oldr; i++) {
                    Uh[kind] = ua;
                    kind = kind+1;
                }
            }

            for (let j = lbz; j < rbz+1; j++) {
                Qw[cind] = ebpts[j];
                cind = cind + 1;
            }

            if (b < m){
                for (let j = 0; j < r; j++) {
                    bpts[j] = Nextbpts[j];
                }
                for (let j = r; j < newDegree+1; j++) {
                    bpts[j] = controlPoints[b-newDegree+j];
                }
                a = b;
                b = b+1;
                ua = ub;
            }
            else {
                for (let i = 0; i < ph+1; i++) {
                    Uh[kind+i] = ub;
                }
            }
        }

        return new NurbsCurveData( finalDegree, Uh, Qw );
    }

    //Transform a NURBS surface using a matrix
    //
    //**params**
    //
    //* The surface to transform
    //* The matrix to use for the transform - the dimensions should be the dimension of the surface + 1 in both directions
    //
    //**returns**
    //
    //* A new NURBS surface after transformation

    public static rationalSurfaceTransform( surface : NurbsSurfaceData, mat : Matrix ) : NurbsSurfaceData {

        const pts = Eval.dehomogenize2d( surface.controlPoints );

        for (let i = 0; i < pts.length; i++) {
            for (let j = 0; j < pts[i].length; j++) {
                const homoPt = pts[i][j];
                homoPt.push(1.0);

                pts[i][j] = Mat.dot( mat, homoPt ).slice( 0, homoPt.length - 1 );
            }
        }

        return new NurbsSurfaceData( surface.degreeU, surface.degreeV, surface.knotsU.slice(), surface.knotsV.slice(), Eval.homogenize2d(pts, Eval.weight2d( surface.controlPoints)) );
    }

    //Transform a NURBS curve using a matrix
    //
    //**params**
    //
    //* The curve to transform
    //* The matrix to use for the transform - the dimensions should be the dimension of the curve + 1 in both directions
    //
    //**returns**
    //
    //* A new NURBS surface after transformation

    public static rationalCurveTransform( curve : NurbsCurveData, mat : Matrix ) : NurbsCurveData {

        const pts = Eval.dehomogenize1d( curve.controlPoints );

        for (let i = 0; i < pts.length; i++) {

            const homoPt = pts[i];
            homoPt.push(1.0);

            pts[i] = Mat.dot( mat, homoPt ).slice( 0, homoPt.length - 1 );
        }

        return new NurbsCurveData( curve.degree, curve.knots.slice(), Eval.homogenize1d( pts, Eval.weight1d( curve.controlPoints) ) );

    }

    //Perform knot refinement on a NURBS surface by inserting knots at various parameters
    //
    //**params**
    //
    //* The surface to insert the knots into
    //* The knots to insert - an array of parameter positions within the surface domain
    //* Whether to insert in the U direction or V direction of the surface
    //
    //**returns**
    //
    //* A new NURBS surface with the knots inserted

    public static surfaceKnotRefine( surface : NurbsSurfaceData, knotsToInsert : Array<number>, useV : boolean ) : NurbsSurfaceData {

        //TODO: make this faster by taking advantage of repeat computations in every row
        // 			 i.e. no reason to recompute the knot vectors on every row

        let newPts = []
        , knots
        , degree
        , ctrlPts;

        //u dir
        if (!useV){
            ctrlPts = Mat.transpose( surface.controlPoints );
            knots = surface.knotsU;
            degree = surface.degreeU;
        //v dir
        } else {
            ctrlPts = surface.controlPoints;
            knots = surface.knotsV;
            degree = surface.degreeV;
        }

        //do knot refinement on every row
        let c! : NurbsCurveData;
        for (const cptrow of ctrlPts) {
            c = Modify.curveKnotRefine( new NurbsCurveData(degree, knots, cptrow), knotsToInsert );
            newPts.push( c.controlPoints );
        }

        const newknots = c.knots;

        //u dir
        if (!useV){
            newPts = Mat.transpose( newPts );
            return new NurbsSurfaceData( surface.degreeU, surface.degreeV, newknots, surface.knotsV.slice(), newPts );
        //v dir
        } else {
            return new NurbsSurfaceData( surface.degreeU, surface.degreeV, surface.knotsU.slice(), newknots, newPts );
        }
    }

    //Decompose a NURBS curve into a collection of bezier's.  Useful
    //as each bezier fits into it's convex hull.  This is a useful starting
    //point for intersection, closest point, divide & conquer algorithms
    //
    //**params**
    //
    //* NurbsCurveData object representing the curve
    //
    //**returns**
    //
    //* *Array* of NurbsCurveData objects, defined by degree, knots, and control points

    public static decomposeCurveIntoBeziers( curve : NurbsCurveData ) : Array<NurbsCurveData> {

        const degree = curve.degree;
        let controlPoints = curve.controlPoints;
        let knots = curve.knots;

        //find all of the unique knot values and their multiplicity
        //for each, increase their multiplicity to degree + 1

        const knotmults = Analyze.knotMultiplicities( knots );
        const reqMult = degree + 1;

        //insert the knots
        for (const knotmult of knotmults) { // (var i = 0; i < mults.length; i++){
            if ( knotmult.mult < reqMult ){

                const knotsInsert = Vec.rep( reqMult - knotmult.mult, knotmult.knot );
                const res = Modify.curveKnotRefine( new NurbsCurveData(degree, knots, controlPoints), knotsInsert );

                knots = res.knots;
                controlPoints = res.controlPoints;
            }
        }

        const crvKnotLength = reqMult * 2;

        const crvs = [];

        let i = 0;
        while ( i < controlPoints.length){
            const kts = knots.slice( i, i + crvKnotLength );
            const pts = controlPoints.slice( i, i + reqMult );

            crvs.push( new NurbsCurveData(degree, kts, pts ) );

            i += reqMult;
        }

        return crvs;

    }

    //Insert a collection of knots on a curve
    //
    //Corresponds to Algorithm A5.4 (Piegl & Tiller)
    //
    //**params**
    //
    //* NurbsCurveData object representing the curve
    //* array of knots to insert
    //
    //**returns**
    //
    //*  NurbsCurveData object representing the curve
    //

    public static curveKnotRefine( curve : NurbsCurveData, knotsToInsert : Array<number> ) : NurbsCurveData {

        if ( knotsToInsert.length == 0 ) return Make.clonedCurve(curve);

        const degree = curve.degree
        , controlPoints = curve.controlPoints
        , knots = curve.knots;

        const n = controlPoints.length - 1
        , m = n + degree + 1
        , r = knotsToInsert.length - 1
        , a = Eval.knotSpan( degree, knotsToInsert[0], knots )
        , b = Eval.knotSpan( degree, knotsToInsert[r], knots )
        , controlPoints_post = new Array<Point>()
        , knots_post = [];

        //new control pts
        for (let i = 0; i < a-degree+1; i++) {
            controlPoints_post[i] = controlPoints[i];
        }

        for (let i = b-1; i < n+1; i++) {
            controlPoints_post[i+r+1] = controlPoints[i];
        }

        //new knot vector
        for (let i = 0; i < a+1; i++) {
            knots_post[i] = knots[i];
        }

        for (let i = b+degree; i < m+1; i++) {
            knots_post[i+r+1] = knots[i];
        }

        let i = b + degree - 1;
        let k = b + degree + r;
        let j = r;

        while ( j >= 0 ) {

            while (knotsToInsert[j] <= knots[i] && i > a){
                controlPoints_post[k-degree-1] = controlPoints[i-degree-1];
                knots_post[k] = knots[i];
                k = k-1;
                i = i-1;
            }

            controlPoints_post[k-degree-1] = controlPoints_post[k-degree];

            for (let l = 1; l < degree+1; l++) {

                const ind = k-degree+l;
                let alfa = knots_post[k+l] - knotsToInsert[j];

                if (Math.abs(alfa) < Constants.EPSILON){
                    controlPoints_post[ind-1] = controlPoints_post[ind];
                } else {
                    alfa = alfa / (knots_post[k+l] - knots[i-degree+l]);

                    controlPoints_post[ind-1] = Vec.add(
                        Vec.mul( alfa, controlPoints_post[ind-1] ),
                        Vec.mul( (1.0 - alfa), controlPoints_post[ind]) );
                }

            }

            knots_post[k] = knotsToInsert[j];
            k = k - 1;

            j--;

        }

        return new NurbsCurveData(degree, knots_post, controlPoints_post );
    }

    //Insert a knot along a rational curve.  Note that this algorithm only works
    //for r + s <= degree, where s is the initial multiplicity (number of duplicates) of the knot.
    //
    //Corresponds to algorithm A5.1 (Piegl & Tiller)
    //
    //Use the curveKnotRefine for applications like curve splitting.
    //
    //**params**
    //
    //* integer degree
    //* array of nondecreasing knot values
    //* array of control points
    //* parameter at which to insert the knot
    //* number of times to insert the knot
    //
    //**returns**
    //
    //* *Object* the new curve, defined by knots and controlPoints
    //

    public static curveKnotInsert( curve : NurbsCurveData, u : number, r : number ) : NurbsCurveData {

        const degree = curve.degree
        , controlPoints = curve.controlPoints
        , knots = curve.knots;

        //num_pts is num control points for the initial curve
        //k is the span on which the knots are inserted
        //s is the initial multiplicity of the knot
        //r is the number of times to insert the knot
        //controlPoints is initial set of control points

        const s = 0; //assume original multiplicity is 0 - TODO add check for multiplicity in knots

        const num_pts = controlPoints.length
        , k = Eval.knotSpan( degree, u, knots ) //the span in which the knot will be inserted
        , controlPoints_temp = new Array<Point>() //new Array( degree - s )
        , knots_post = [] //new Array( knots.length + r )  //r new knots
        , controlPoints_post = new Array<Point>(); //new Array( num_pts_post )

        //new knot vector

        //insert the k knots that will not be affected
        for (let i = 1; i < k+1; i++) {
            knots_post[i] = knots[i];
        }

        //insert the new repeat knots
        for (let i = 1; i < r+1; i++) {
            knots_post[k+i] = u;
        }

        //insert the rest of the knots
        for (let i = k+1; i < knots.length; i++) {
            knots_post[i+r] = knots[i];
        }

        //control point generation

        //copy the original control points before the insertion span
        for (let i = 0; i < k - degree + 1; i++) {
            controlPoints_post[i] = controlPoints[i];
        }

        //copy the original controls after the insertion span
        for (let i = k-s; i < num_pts; i++) {
            controlPoints_post[i+r] = controlPoints[i];
        }

        //collect the affected control points in this temporary array
        for (let i = 0; i < degree-s+1; i++) {
            controlPoints_temp[i] = controlPoints[k-degree+i];
        }

        let L : number = 0
        , alpha : number = 0;

        //insert knot r times
        for (let j = 1; j < r+1; j++) {

            L = k-degree+j;

            for (let i = 0; i < degree-j-s+1; i++) {

                alpha = ( u - knots[L+i] ) / ( knots[i+k+1] - knots[L+i] );

                controlPoints_temp[i] = Vec.add(
                        Vec.mul( alpha, controlPoints_temp[i+1] ),
                        Vec.mul( (1.0 - alpha), controlPoints_temp[i])
                    );
            }

            controlPoints_post[ L ] = controlPoints_temp[0];
            controlPoints_post[k+r-j-s] = controlPoints_temp[degree-j-s];

        }

        //not so confident about this part
        for (let i = L+1; i < k-s; i++) {
            controlPoints_post[i] = controlPoints_temp[ i - L ];
        }

        return new NurbsCurveData(degree, knots_post, controlPoints_post);
    }

}
