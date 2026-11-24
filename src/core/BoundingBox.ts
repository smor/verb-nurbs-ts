import { Constants } from "./Constants.js";
import { Point } from "./Data.js";

// `BoundingBox` is an n-dimensional bounding box implementation. It is used by many of verb's intersection algorithms.
//
// The first point added to the `BoundingBox` using `BoundingBox.add` will be used to define the dimensionality of the
// bounding box.

export class BoundingBox {

    initialized : boolean = false;
    dim : number = 3;

    //BoundingBox Constructor
    //
    //**params**
    //
    //* Points to add, if desired.  Otherwise, will not be initialized until add is called.

    constructor(pts : Array<Point> = null) {
        if ( pts != null ) {
            this.addRange( pts );
        }
    }

    // The minimum point of the BoundingBox - the coordinates of this point are always <= max.
    public min : Point = null;

    // The maximum point of the BoundingBox. The coordinates of this point are always >= min.
    public max : Point = null;

    //Create a bounding box initialized with a single element
    //
    //**params**
    //
    //* A array of numbers
    //
    //**returns**
    //
    //* This BoundingBox for chaining

    public fromPoint( pt : Point ){
        return new BoundingBox( [ pt ] );
    }

    //Adds a point to the bounding box, expanding the bounding box if the point is outside of it.
    //If the bounding box is not initialized, this method has that side effect.
    //
    //**params**
    //
    //* A length-n array of numbers
    //
    //**returns**
    //
    //* This BoundingBox for chaining

    public add( point : Point ) : BoundingBox
    {
        if ( !this.initialized )
        {
            this.dim = point.length;
            this.min = point.slice(0);
            this.max = point.slice(0);
            this.initialized = true;

            return this;
        }

        for (let i = 0; i < this.dim; i++) {
            if (point[i] > this.max[i] ) this.max[i] = point[i];
            if (point[i] < this.min[i] ) this.min[i] = point[i];
        }

        return this;

    }

    //Asynchronously add an array of points to the bounding box
    //
    //**params**
    //
    //* An array of length-n array of numbers
    //
    //**returns**
    //
    //* this BoundingBox for chaining

    public addRange( points : Array<Point> ) : BoundingBox
    {
        let l = points.length;

        for (let i = 0; i < l; i++) {
            this.add(points[i]);
        }

        return this;
    }

    //Determines if point is contained in the bounding box
    //
    //**params**
    //
    //* the point
    //* the tolerance
    //
    //**returns**
    //
    //* true if the two intervals overlap, otherwise false

    public contains(point : Point, tol? : number) : boolean { if (tol == null) tol = -1;

        if ( !this.initialized )
        {
            return false;
        }

        return this.intersects( new BoundingBox([point]), tol );
    }

    //Determines if two intervals on the real number line intersect
    //
    //**params**
    //
    //* Beginning of first interval
    //* End of first interval
    //* Beginning of second interval
    //* End of second interval
    //
    //**returns**
    //
    //* true if the two intervals overlap, otherwise false

    public static intervalsOverlap( a1 : number, a2: number, b1: number, b2: number, tol? : number) : boolean { if (tol == null) tol = -1;

        tol = tol < -0.5 ? Constants.TOLERANCE : tol;
        let x1 = Math.min(a1, a2) - tol
        , x2 = Math.max(a1, a2) + tol
        , y1 = Math.min(b1, b2) - tol
        , y2 = Math.max(b1, b2) + tol;

        return (x1 >= y1 && x1 <= y2) || (x2 >= y1 && x2 <= y2) || (y1 >= x1 && y1 <= x2) || (y2 >= x1 && y2 <= x2) ;
    }

    //Determines if this bounding box intersects with another
    //
    //**params**
    //
    //* BoundingBox to check for intersection with this one
    //
    //**returns**
    //
    //*  true if the two bounding boxes intersect, otherwise false

    public intersects( bb : BoundingBox, tol? : number) : boolean { if (tol == null) tol = -1;

        if ( !this.initialized || !bb.initialized ) return false;

        let a1 = this.min
        , a2 = this.max
        , b1 = bb.min
        , b2 = bb.max;

        for (let i = 0; i < this.dim; i++) {
            if (!BoundingBox.intervalsOverlap(a1[i], a2[i], b1[i], b2[i], tol )) return false;
        }

        return true;
    }

    //Clear the bounding box, leaving it in an uninitialized state.  Call add, addRange in order to
    //initialize
    //
    //**returns**
    //
    //* this BoundingBox for chaining

    public clear() : BoundingBox {
        this.initialized = false;
        return this;
    }

    //Get longest axis of bounding box
    //
    //**returns**
    //
    //* Index of longest axis

    public getLongestAxis() : number {

        let max = 0.0;
        let id = 0;

        for (let i = 0; i < this.dim; i++) {
            let l = this.getAxisLength(i);
            if (l > max) {
                max = l;
                id = i;
            }
        }

        return id;
    }

    //Get length of given axis.
    //
    //**params**
    //
    //* Index of axis to inspect (between 0 and 2)
    //
    //**returns**
    //
    //* Length of the given axis.  If axis is out of bounds, returns 0.

    public getAxisLength( i : number ) : number {
        if (i < 0 || i > this.dim-1) return 0.0;
        return Math.abs( this.min[i] - this.max[i] );
    }

    //Compute the boolean intersection of this with another axis-aligned bounding box.  If the two
    //bounding boxes do not intersect, returns null.
    //
    //**params**
    //
    //* BoundingBox to intersect with
    //
    //**returns**
    //
    //* The bounding box formed by the intersection or null if there is no intersection.

    public intersect( bb : BoundingBox, tol : number ) : BoundingBox {

        if ( !this.initialized ) return null;

        let a1 = this.min
        , a2 = this.max
        , b1 = bb.min
        , b2 = bb.max;

        if ( !this.intersects( bb, tol ) ) return null;

        let maxbb = []
        , minbb = [];

        for (let i = 0; i < this.dim; i++) {
            maxbb.push( Math.min( a2[i], b2[i] ) );
            minbb.push( Math.max( a1[i], b1[i] ) );
        }

        return new BoundingBox([minbb, maxbb]);
    }

}