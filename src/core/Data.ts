import { SerializableBase } from "./Serialization.js";

// A `Point` in verb is represented simply by an array of floating point numbers.
//
// So, in JavaScript, one would write simply `[0,0,0]` to create a Point at the origin.

export type Point = Array<number>;

// Like a `Point`, a `Vector` is simply an array of floating point numbers
//
// So, in JavaScript, one would write simply `[1,0,0]` to create the a unit vector in the x direction

export type Vector = Array<number>;

// `Matrix` is represented by a nested array of floating point number arrays
//
// So, in JavaScript, one would write simply `[[1,0],[0,1]]` to create a 2x2 identity matrix

export type Matrix = Array<Array<number>>;

// A `KnotArray` is a non-decreasing sequence of floating point . Use the methods in `Check` to validate `KnotArray`'s

export type KnotArray = Array<number>;

// A `Plane` is simply an origin point and normal

export class Plane extends SerializableBase {

    public normal : Vector;
    public origin : Point;

    constructor(origin : Point, normal : Vector){
        super();
        this.origin = origin;
        this.normal = normal;
    }
}

// A `Ray` is simply an origin point and a direction

export class Ray extends SerializableBase {

    public dir : Vector;
    public origin : Point;

    constructor(origin : Point, dir : Vector){
        super();
        this.origin = origin;
        this.dir = dir;
    }
}

// A simple data structure representing a NURBS curve. `NurbsCurveData` does no checks for legality. You can use
// `verb.eval.Check` for that.

export class NurbsCurveData extends SerializableBase {

    constructor(degree : number, knots : Array<number>, controlPoints : Array<Point>){
        super();
        this.degree = degree;
        this.controlPoints = controlPoints;
        this.knots = knots;
    }

    //integer degree of curve
    public degree : number;

    // 2d array of control points, where each control point is an array of length (dim)
    public controlPoints : Array<Point>;

    //array of nondecreasing knot values
    public knots : Array<number>;

}

// A simple data structure representing a NURBS surface. `NurbsSurfaceData` does no checks for legality. You can use
// `verb.eval.Check` for that.

export class NurbsSurfaceData extends SerializableBase {

    constructor(degreeU : number, degreeV : number, knotsU : KnotArray, knotsV : KnotArray, controlPoints : Array<Array<Point>>){
        super();
        this.degreeU = degreeU;
        this.degreeV = degreeV;
        this.knotsU = knotsU;
        this.knotsV = knotsV;
        this.controlPoints = controlPoints;
    }

    //integer degree of surface in u direction
    public degreeU : number;

    //integer degree of surface in v direction
    public degreeV : number;

    //array of nondecreasing knot values in u direction
    public knotsU : KnotArray;

    //array of nondecreasing knot values in v direction
    public knotsV : KnotArray;

    // 2d array of control points, the vertical direction (u) increases from top to bottom, the v direction from left to right,
    //and where each control point is an array of length (dim)
    public controlPoints : Array<Array<Point>>;

}

// A triangular face of a mesh

export type Tri = Array<number>;

// A `UV` is simply an array of floating point numbers.
//
// So, in JavaScript, one would write simply `[1,0]` to create a UV

export type UV = Array<number>;

// A simple data structure representing a mesh. `MeshData` does not check for legality.

export class MeshData extends SerializableBase {

    public faces : Array<Tri>;
    public points : Array<Point>;
    public normals : Array<Point>;
    public uvs : Array<UV>;

    constructor(faces : Array<Tri>, points : Array<Point>, normals : Array<Point>, uvs : Array<UV>) {
        super();
        this.faces = faces;
        this.points = points;
        this.normals = normals;
        this.uvs = uvs;
    }

    public static empty() : MeshData {
        return new MeshData([],[],[],[]);
    }
}

// A simple data structure representing a polyline. `PolylineData` is useful, for example, as the result of a curve tessellation.

export class PolylineData extends SerializableBase {

    // The points in the polyline
    public points : Array<Point>;

    // The parameters of the individual points
    public params : Array<number>;

    constructor(points : Array<Point>, params : Array<number>){
        super();
        this.points = points;
        this.params = params;
    }
}

// A simple data structure representing a NURBS volume. This data structure is largely experimental in intent. Like CurveData
// and SurfaceData, this data structure does no legality checks.

export class VolumeData extends SerializableBase {

    constructor(degreeU : number, degreeV : number, degreeW : number, knotsU : KnotArray, knotsV : KnotArray, knotsW : KnotArray, controlPoints : Array<Array<Array<Point>>>){
        super();
        this.degreeU = degreeU;
        this.degreeV = degreeV;
        this.degreeW = degreeW;
        this.knotsU = knotsU;
        this.knotsV = knotsV;
        this.knotsW = knotsW;
        this.controlPoints = controlPoints;
    }

    //integer degree in u direction
    public degreeU : number;

    //integer degree in v direction
    public degreeV : number;

    //integer degree in w direction
    public degreeW : number;

    //array of nondecreasing knot values in u direction
    public knotsU : KnotArray;

    //array of nondecreasing knot values in v direction
    public knotsV : KnotArray;

    //array of nondecreasing knot values in w direction
    public knotsW : KnotArray;

    // 3d array of control points, where rows are the u dir, and columns run along the positive v direction,
    //and where each control point is an array of length (dim)
    public controlPoints : Array<Array<Array<Point>>>;

}

// A simple parametric data type representing a pair of two objects

export class Pair<T1, T2> {
    public item0 : T1;
    public item1 : T2;

    constructor(item1 : T1, item2 : T2) {
        this.item0 = item1;
        this.item1 = item2;
    }
}

// A simple parametric data type representing an "interval" between two numbers. This data structure does no legality checks.

export class Interval<T> {
    public min : T;
    public max : T;

    constructor(min : T, max : T){
        this.min = min;
        this.max = max;
    }
}