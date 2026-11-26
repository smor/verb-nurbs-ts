declare module "cdt2d/lib/monotone.js" {
    function monotoneTriangulate( points : Array<Array<number>>, edges : Array<Array<number>> ) : Array<[number, number, number]>;
    export = monotoneTriangulate;
}
declare module "cdt2d/lib/triangulation.js" {
    function createTriangulation( numVerts : number, edges : Array<Array<number>> ) : unknown;
    export = createTriangulation;
}
declare module "cdt2d/lib/filter.js" {
    function classifyFaces( triangulation : unknown, target : number, infinity? : boolean ) : Array<[number, number, number]>;
    export = classifyFaces;
}
declare module "robust-in-sphere" {
    const inSphere : Array<(...points : Array<ArrayLike<number>>) => number>;
    export = inSphere;
}
