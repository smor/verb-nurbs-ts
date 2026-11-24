import { Vec } from "./Vec.js";
import { ArrayExtensions } from "./ArrayExtensions.js";
import { BoundingBox } from "./BoundingBox.js";
import { NurbsCurveData, Pair } from "./Data.js";
import { Divide } from "../eval/Divide.js";
import { Eval } from "../eval/Eval.js";
import { IBoundingBoxTree } from "../eval/Intersect.js";

export class LazyCurveBoundingBoxTree implements IBoundingBoxTree<NurbsCurveData> {

    _curve : NurbsCurveData;
    _boundingBox : BoundingBox = null;
    _knotTol : number;

    constructor(curve : NurbsCurveData, knotTol : number = null){
        this._curve = curve;
        if (knotTol == null){
            knotTol = Vec.domain(this._curve.knots) / 64;
        }
        this._knotTol = knotTol;
    }

    public split() : Pair<IBoundingBoxTree<NurbsCurveData>, IBoundingBoxTree<NurbsCurveData>> {
        let min = ArrayExtensions.first(this._curve.knots);
        let max = ArrayExtensions.last(this._curve.knots);
        let dom = max - min;

        let crvs = Divide.curveSplit( this._curve, (max + min) / 2.0 + dom * 0.1 * Math.random());

        return new Pair<IBoundingBoxTree<NurbsCurveData>, IBoundingBoxTree<NurbsCurveData>>(
            new LazyCurveBoundingBoxTree( crvs[0], this._knotTol ),
            new LazyCurveBoundingBoxTree( crvs[1], this._knotTol ));
    }

    public boundingBox(){
        if (this._boundingBox == null){
            this._boundingBox = new BoundingBox( Eval.dehomogenize1d(this._curve.controlPoints) );
        }
        return this._boundingBox;
    }

    public yield(){
        return this._curve;
    }

    public indivisible( tolerance : number ){
        return Vec.domain(this._curve.knots) < this._knotTol;
    }

    public empty(){
        return false;
    }
}