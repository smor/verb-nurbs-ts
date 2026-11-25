import { BoundingBox } from "./BoundingBox.js";
import { Interval, Pair, PolylineData } from "./Data.js";
import { IBoundingBoxTree } from "../eval/Intersect.js";

export class LazyPolylineBoundingBoxTree implements IBoundingBoxTree<number> {

    _interval : Interval<number>;
    _polyline : PolylineData;
    _boundingBox : BoundingBox | null = null;

    constructor(polyline : PolylineData, interval : Interval<number> | null = null){
        this._polyline = polyline;

        if (interval == null) {
            interval = new Interval<number>(0, polyline.points.length != 0 ? polyline.points.length-1 : 0);
        }
        this._interval = interval;
    }

    public split() : Pair<IBoundingBoxTree<number>, IBoundingBoxTree<number>> {
        const min = this._interval.min;
        const max = this._interval.max;

        const pivot = min + Math.ceil( (max-min) / 2 );

        const l = new Interval( min, pivot )
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

    public indivisible( _tolerance : number ){
        return this._interval.max - this._interval.min == 1;
    }

    public empty(){
        return this._interval.max - this._interval.min == 0;
    }
}