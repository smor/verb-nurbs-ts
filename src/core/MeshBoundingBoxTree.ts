import { ArrayExtensions } from "./ArrayExtensions.js";
import { BoundingBox } from "./BoundingBox.js";
import { MeshData, Pair } from "./Data.js";
import { Mesh } from "./Mesh.js";
import { IBoundingBoxTree } from "../eval/Intersect.js";

export class MeshBoundingBoxTree implements IBoundingBoxTree<number> {

    _children : Pair<IBoundingBoxTree<number>, IBoundingBoxTree<number>>;
    _boundingBox : BoundingBox;
    _face : number = -1;
    _empty : boolean = false;

    constructor(mesh : MeshData, faceIndices : Array<number> | null = null){

        if (faceIndices == null) {
            faceIndices = Array.from({ length: mesh.faces.length }, (_, i) => i);
        }

        this._boundingBox = Mesh.makeMeshAabb( mesh, faceIndices );

        if (faceIndices.length < 1) {
            this._empty = true;
            return;
        } else if (faceIndices.length < 2){
            this._face = faceIndices[0];
            return;
        }

        const as = Mesh.sortTrianglesOnLongestAxis( this._boundingBox, mesh, faceIndices );
        const l = ArrayExtensions.left(as);
        const r = ArrayExtensions.right(as);

        this._children = new Pair<IBoundingBoxTree<number>, IBoundingBoxTree<number>>(
            new MeshBoundingBoxTree(mesh, l),
            new MeshBoundingBoxTree(mesh, r)
        );
    }

    public split() : Pair<IBoundingBoxTree<number>, IBoundingBoxTree<number>> {
        return this._children;
    }

    public boundingBox(){
        return this._boundingBox;
    }

    public yield(){
        return this._face;
    }

    public indivisible( _tolerance : number ){
        return this._children == null;
    }

    public empty(){
        return this._empty;
    }
}
