import { BoundingBox } from "./BoundingBox.js";
import { Interval, Pair, PolylineData } from "./Data.js";
import { IBoundingBoxTree } from "../eval/Intersect.js";

export class LazyPolylineBoundingBoxTree implements IBoundingBoxTree<number> {

    _interval : Interval<number>;
    _polyline : PolylineData;
    _boundingBox : BoundingBox = null;

    constructor(polyline : PolylineData, interval : Interval<number> = null){
        this._polyline = polyline;

        if (interval == null) {
            interval = new Interval<number>(0, polyline.points.length != 0 ? polyline.points.length-1 : 0);
        }
        this._interval = interval;
    }

    public split() : Pair<IBoundingBoxTree<number>, IBoundingBoxTree<number>> {
        let min = this._interval.min;
        let max = this._interval.max;

        let pivot = min + Math.ceil( (max-min) / 2 );

        let l = new Interval( min, pivot )
        , r = new Interval( pivot, max );

        return new Pair<IBoundingBoxTree<number>, IBoundingBoxTree<number>>(
            new LazyPolylineBoundingBoxTree( this._polyline, l ),
            new LazyPolylineBoundingBoxTree( this._polyline, r ));

    }

    public boundingBox(){
        if (this._boundingBox == null){
            this._boundingBox = new BoundingBox( this._polyline.points );
        }

        return this._boundingBox;
    }

    public yield(){
        return this._interval.min;
    }

    public indivisible( tolerance : number ){
        return this._interval.max - this._interval.min == 1;
    }

    public empty(){
        return this._interval.max - this._interval.min == 0;
    }
}