import { Point, UV } from "./Data.js";

export class CurveCurveIntersection {

    //where the intersection took place
    public point0 : Point;

    //where the intersection took place on the second curve
    public point1 : Point;

    //the parameter on the first curve
    public u0 : number;

    //the parameter on the second curve
    public u1 : number;

    constructor(point0 : Point, point1 : Point, u0 : number, u1 : number){
        this.point0 = point0;
        this.point1 = point1;
        this.u0 = u0;
        this.u1 = u1;
    }
}

export class CurveSurfaceIntersection {

    public u : number;
    public uv : UV;
    public curvePoint : Point;
    public surfacePoint : Point;

    constructor(u : number, uv : UV, curvePoint : Point, surfacePoint : Point){
        this.u = u;
        this.uv = uv;
        this.curvePoint = curvePoint;
        this.surfacePoint = surfacePoint;
    }
}

export class MeshIntersectionPoint {

    public uv0 : UV;
    public uv1 : UV;
    public point : Point;

    public faceIndex0 : number;
    public faceIndex1 : number;

    //tags to navigate a segment structure
    public opp : MeshIntersectionPoint = null;
    public adj : MeshIntersectionPoint = null;
    public visited : boolean = false;

    constructor(uv0 : UV, uv1 : UV, point : Point, faceIndex0 : number, faceIndex1 : number){
        this.uv0 = uv0;
        this.uv1 = uv1;
        this.point = point;
        this.faceIndex0;
        this.faceIndex1;
    }
}

export class PolylineMeshIntersection {

    public point : Point;
    public u : number;
    public uv : UV;
    public polylineIndex : number;
    public faceIndex : number;

    constructor(point : Point, u : number, uv : UV, polylineIndex : number, faceIndex : number){
        this.point = point;
        this.u = u;
        this.uv = uv;
        this.polylineIndex = polylineIndex;
        this.faceIndex = faceIndex;
    }
}

export class SurfaceSurfaceIntersectionPoint {

    public uv0 : UV;
    public uv1 : UV;
    public point : Point;
    public dist : number;

    constructor(uv0 : UV, uv1 : UV, point : Point, dist : number){
        this.uv0 = uv0;
        this.uv1 = uv1;
        this.point = point;
        this.dist = dist;
    }
}

export class TriSegmentIntersection {

    //where the intersection took place
    public point : Point;

    //the u param where u is the axis from v0 to v1
    public s : number;

    //the v param where v is the axis from v0 to v2
    public t : number;

    //the parameter along the segment
    public p : number;

    constructor(point : Point, s : number, t : number, r : number){
        this.point = point;
        this.s = s;
        this.t = t;
        this.p = r;
    }
}

export class CurveTriPoint {
    public u : number;
    public uv : UV;
    public point : Point;

    constructor(u : number, point : Point, uv : UV){
        this.u = u;
        this.point = point;
        this.uv = uv;
    }
}

export class SurfacePoint {

    public uv : UV;
    public point : Point;
    public normal : Point;
    public id : number;
    public degen : boolean;

    constructor(point : Point, normal : Point, uv : UV, id? : number, degen? : boolean) { if (id == null) id = -1; if (degen == null) degen = false;
        this.uv = uv;
        this.point = point;
        this.normal = normal;
        this.id = id;
        this.degen = degen;
    }

    public static fromUv(u : number, v : number){
        return new SurfacePoint(null, null, [u,v] );
    }
}

export class CurvePoint {
    public u : number;
    public pt : Point;

    constructor(u : number, pt : Point) {
        this.u = u;
        this.pt = pt;
    }
}
