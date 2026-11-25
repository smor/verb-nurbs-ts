import { Vec } from "./Vec.js";
import { ArrayExtensions } from "./ArrayExtensions.js";
import { BoundingBox } from "./BoundingBox.js";
import { NurbsSurfaceData, Pair } from "./Data.js";
import { Divide } from "../eval/Divide.js";
import { Eval } from "../eval/Eval.js";
import { IBoundingBoxTree } from "../eval/Intersect.js";

export class LazySurfaceBoundingBoxTree implements IBoundingBoxTree<NurbsSurfaceData> {

    _surface : NurbsSurfaceData;
    _boundingBox : BoundingBox | null = null;
    _splitV : boolean;
    _knotTolU : number;
    _knotTolV : number;

    constructor(surface : NurbsSurfaceData, splitV? : boolean, knotTolU : number | null = null, knotTolV : number | null = null){ if (splitV == null) splitV = false;
        this._surface = surface;
        this._splitV = splitV;

        if (knotTolU == null){
            knotTolU = (Vec.domain(surface.knotsU)) / 16;
        }

        if (knotTolV == null){
            knotTolV = (Vec.domain(surface.knotsV)) / 16;
        }

        this._knotTolU = knotTolU;
        this._knotTolV = knotTolV;
    }

    public split() : Pair<IBoundingBoxTree<NurbsSurfaceData>, IBoundingBoxTree<NurbsSurfaceData>> {
        let min : number;
        let max : number;

        if (this._splitV){
            min = ArrayExtensions.first(this._surface.knotsV);
            max = ArrayExtensions.last(this._surface.knotsV);
        } else {
            min = ArrayExtensions.first(this._surface.knotsU);
            max = ArrayExtensions.last(this._surface.knotsU);
        }

        const pivot = (min + max) / 2.0; //* dom * 0.01 * Math.random();

        const srfs = Divide.surfaceSplit( this._surface, pivot, this._splitV );

        return new Pair<IBoundingBoxTree<NurbsSurfaceData>, IBoundingBoxTree<NurbsSurfaceData>>(
            new LazySurfaceBoundingBoxTree( srfs[0], !this._splitV, this._knotTolU, this._knotTolV ),
            new LazySurfaceBoundingBoxTree( srfs[1], !this._splitV, this._knotTolU, this._knotTolV ));
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

    public indivisible( _tolerance : number ){
        return Vec.domain(this._surface.knotsV) < this._knotTolV && Vec.domain(this._surface.knotsU) < this._knotTolU;
    }

    public empty(){
        return false;
    }
}