import { ArrayExtensions } from "./ArrayExtensions.js";
import { BoundingBox } from "./BoundingBox.js";
import { MeshData, Pair } from "./Data.js";
import { Mesh } from "./Mesh.js";
import { IBoundingBoxTree } from "../eval/Intersect.js";

export class LazyMeshBoundingBoxTree implements IBoundingBoxTree<number> {
    _mesh : MeshData;
    _faceIndices : Array<number>;
    _boundingBox : BoundingBox | null = null;

    constructor(mesh : MeshData, faceIndices : Array<number> | null = null){
        this._mesh = mesh;
        if (faceIndices == null) {
            faceIndices = Array.from({ length: mesh.faces.length }, (_, i) => i);
        }
        this._faceIndices = faceIndices;
    }

    public split() : Pair<IBoundingBoxTree<number>, IBoundingBoxTree<number>> {
        const as = Mesh.sortTrianglesOnLongestAxis( this.boundingBox(), this._mesh, this._faceIndices )
        , l = ArrayExtensions.left(as)
        , r = ArrayExtensions.right(as);

        return new Pair<IBoundingBoxTree<number>, IBoundingBoxTree<number>>(
            new LazyMeshBoundingBoxTree( this._mesh, l),
            new LazyMeshBoundingBoxTree( this._mesh, r ));
    }

    public boundingBox(){
        if (this._boundingBox == null){
            this._boundingBox = Mesh.makeMeshAabb( this._mesh, this._faceIndices );
        }
        return this._boundingBox;
    }

    public yield(){
        return this._faceIndices[0];
    }

    public indivisible( _tolerance : number ){
        return this._faceIndices.length == 1;
    }

    public empty(){
        return this._faceIndices.length == 0;
    }
}