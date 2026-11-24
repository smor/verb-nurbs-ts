import { Vec } from "./Vec.js";
import { ArrayExtensions } from "./ArrayExtensions.js";
import { BoundingBox } from "./BoundingBox.js";
import { NurbsSurfaceData, Pair } from "./Data.js";
import { Divide } from "../eval/Divide.js";
import { Eval } from "../eval/Eval.js";
import { IBoundingBoxTree } from "../eval/Intersect.js";

export class SurfaceBoundingBoxTree implements IBoundingBoxTree<NurbsSurfaceData> {

    _children : Pair<IBoundingBoxTree<NurbsSurfaceData>, IBoundingBoxTree<NurbsSurfaceData>>;
    _surface : NurbsSurfaceData;
    _boundingBox : BoundingBox = null;

    constructor(surface : NurbsSurfaceData, splitV? : boolean, knotTolU : number = null, knotTolV : number = null){ if (splitV == null) splitV = false;
        this._surface = surface;

        if (knotTolU == null){
            knotTolU = (Vec.domain(surface.knotsU)) / 16;
        }

        if (knotTolV == null){
            knotTolV = (Vec.domain(surface.knotsV)) / 16;
        }

        let divisible = false;

        if (splitV){
            divisible = Vec.domain(this._surface.knotsV) > knotTolV;
        } else {
            divisible = Vec.domain(this._surface.knotsU) > knotTolU;
        }

        if ( !divisible ) return;

        let min : number;
        let max : number;

        if (splitV){
            min = ArrayExtensions.first(this._surface.knotsV);
            max = ArrayExtensions.last(this._surface.knotsV);
        } else {
            min = ArrayExtensions.first(this._surface.knotsU);
            max = ArrayExtensions.last(this._surface.knotsU);
        }

        let dom = max - min;
        let pivot = (min + max) / 2.0 + dom * 0.1 * Math.random();

        let srfs = Divide.surfaceSplit( this._surface, pivot, splitV );

        this._children = new Pair<IBoundingBoxTree<NurbsSurfaceData>, IBoundingBoxTree<NurbsSurfaceData>>(
            new SurfaceBoundingBoxTree( srfs[0], !splitV, knotTolU, knotTolV ),
            new SurfaceBoundingBoxTree( srfs[1], !splitV, knotTolU, knotTolV ));

    }

    public split() : Pair<IBoundingBoxTree<NurbsSurfaceData>, IBoundingBoxTree<NurbsSurfaceData>> {
        return this._children;
    }

    public boundingBox(){
        if (this._boundingBox == null){
            this._boundingBox = new BoundingBox();
            for (const row of this._surface.controlPoints) {
                this._boundingBox.addRange( Eval.dehomogenize1d(row) );
            }
        }
        return this._boundingBox;
    }

    public yield(){
        return this._surface;
    }

    public indivisible( tolerance : number ){
        return this._children == null;
    }

    public empty(){
        return false;
    }
}