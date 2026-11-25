// verb-nurbs-ts entry point.
//
// Every class is available as a named export (e.g. `import { NurbsCurve } from "verb-nurbs-ts"`), and the
// upstream namespace layout (`verb.core`, `verb.eval`, `verb.geom`, `verb.exe`) is kept on the default export,
// next to the new `verb.solid` (watertight meshes) and `verb.recipes` (parametric models) namespaces.

import { ArrayExtensions } from "./core/ArrayExtensions.js";
import { Binomial } from "./core/Binomial.js";
import { BoundingBox } from "./core/BoundingBox.js";
import { Constants } from "./core/Constants.js";
import { Plane, Ray, NurbsCurveData, NurbsSurfaceData, MeshData, PolylineData, VolumeData, Pair, Interval } from "./core/Data.js";
export type { Point, Vector, Matrix, KnotArray, Tri, UV } from "./core/Data.js";
import { CurveCurveIntersection, CurveSurfaceIntersection, MeshIntersectionPoint, PolylineMeshIntersection, SurfaceSurfaceIntersectionPoint, TriSegmentIntersection, CurveTriPoint, SurfacePoint, CurvePoint } from "./core/Intersections.js";
import { KdTree, BinaryHeap, KdPoint, KdNode } from "./core/KdTree.js";
import { LazyCurveBoundingBoxTree } from "./core/LazyCurveBoundingBoxTree.js";
import { LazyMeshBoundingBoxTree } from "./core/LazyMeshBoundingBoxTree.js";
import { LazyPolylineBoundingBoxTree } from "./core/LazyPolylineBoundingBoxTree.js";
import { LazySurfaceBoundingBoxTree } from "./core/LazySurfaceBoundingBoxTree.js";
import { Mat, LUDecomp } from "./core/Mat.js";
import { Mesh } from "./core/Mesh.js";
import { MeshBoundingBoxTree } from "./core/MeshBoundingBoxTree.js";
import { Minimizer, MinimizationResult } from "./core/Minimizer.js";
import { SerializableBase, Deserializer } from "./core/Serialization.js";
export type { ISerializable } from "./core/Serialization.js";
import { SurfaceBoundingBoxTree } from "./core/SurfaceBoundingBoxTree.js";
import { Trig } from "./core/Trig.js";
import { Vec } from "./core/Vec.js";
import { Analyze, KnotMultiplicity } from "./eval/Analyze.js";
import { Check } from "./eval/Check.js";
import { Divide, CurveLengthSample } from "./eval/Divide.js";
import { Eval } from "./eval/Eval.js";
import { Fit } from "./eval/Fit.js";
import { Transfinite } from "./eval/Transfinite.js";
export type { Ribbon } from "./eval/Transfinite.js";
import { Intersect as EvalIntersect } from "./eval/Intersect.js";
export type { IBoundingBoxTree } from "./eval/Intersect.js";
import { Make } from "./eval/Make.js";
import { Modify } from "./eval/Modify.js";
import { Offset } from "./eval/Offset.js";
export type { OffsetOptions, OffsetResult } from "./eval/Offset.js";
import { RotationMinimizingFrames, Sweep } from "./eval/Sweep.js";
export type { Frame, FrameOptions, SweepOptions, SweepResult } from "./eval/Sweep.js";
import { Tess, AdaptiveRefinementOptions, AdaptiveRefinementNode } from "./eval/Tess.js";
import { Arc } from "./geom/Arc.js";
import { BezierCurve } from "./geom/BezierCurve.js";
import { Circle } from "./geom/Circle.js";
import { ConicalSurface } from "./geom/ConicalSurface.js";
import { CylindricalSurface } from "./geom/CylindricalSurface.js";
import { Ellipse } from "./geom/Ellipse.js";
import { EllipseArc } from "./geom/EllipseArc.js";
import { ExtrudedSurface } from "./geom/ExtrudedSurface.js";
export type { ICurve } from "./geom/ICurve.js";
export type { ISurface } from "./geom/ISurface.js";
import { Intersect } from "./geom/Intersect.js";
import { Line } from "./geom/Line.js";
import { NurbsCurve } from "./geom/NurbsCurve.js";
import { NurbsSurface } from "./geom/NurbsSurface.js";
import { RevolvedSurface } from "./geom/RevolvedSurface.js";
import { SphericalSurface } from "./geom/SphericalSurface.js";
import { SweptSurface } from "./geom/SweptSurface.js";
import { Dispatcher } from "./exe/Dispatcher.js";
import { Welder, BrepSolid, FaceMesher } from "./solid/Brep.js";
export type { BrepFace, FaceCut, FaceTessellation } from "./solid/Brep.js";
import { BrepBoolean } from "./solid/BrepBoolean.js";
export type { TrimmedFace, BooleanOptions, BooleanResult } from "./solid/BrepBoolean.js";
import { Fillet } from "./solid/Fillet.js";
export type { FilletSide, FilletSection, FilletResult, FilletRadius, FilletShape } from "./solid/Fillet.js";
import { FilletCorner } from "./solid/FilletCorner.js";
export type { OpenBlend, TrimPoint, ThirdEdge, CornerPatch } from "./solid/FilletCorner.js";
import { Makeable } from "./solid/Makeable.js";
export type { Machine, MakeableReport } from "./solid/Makeable.js";
import { MeshBVH } from "./solid/MeshBVH.js";
import { Shell } from "./solid/Shell.js";
export type { VesselMeshOptions } from "./solid/Shell.js";
import { SurfaceIntersect } from "./solid/SurfaceIntersect.js";
export type { SurfaceDomain, IntersectionCurve, SurfaceIntersectOptions } from "./solid/SurfaceIntersect.js";
import { TriMesh } from "./solid/TriMesh.js";
export type { ManifoldMeshArrays, ManifoldReport } from "./solid/TriMesh.js";
import { ApplianceRecipe } from "./recipes/Appliance.js";
export type { ApplianceParams, Appliance } from "./recipes/Appliance.js";
import { BooleanObjectsRecipe } from "./recipes/BooleanObjects.js";
export type { MugParams, Mug, PierceParams, PiercedVessel } from "./recipes/BooleanObjects.js";
import { FreeformVesselRecipe } from "./recipes/FreeformVessel.js";
export type { VesselHarmonic, FreeformVesselParams, FreeformVessel } from "./recipes/FreeformVessel.js";
import { SweptObjectsRecipe } from "./recipes/SweptObjects.js";
export type { SweptObject, KnotPipeParams, TwistedRingParams, RibbonKnotParams } from "./recipes/SweptObjects.js";
import { Inspect } from "./view/Inspect.js";
export type { LayerKind, ViewLayer, ViewItem, View, InspectOptions } from "./view/Inspect.js";
import { registerSerializable } from "./core/Serialization.js";

export {
    ArrayExtensions,
    Binomial,
    BoundingBox,
    Constants,
    Plane,
    Ray,
    NurbsCurveData,
    NurbsSurfaceData,
    MeshData,
    PolylineData,
    VolumeData,
    Pair,
    Interval,
    CurveCurveIntersection,
    CurveSurfaceIntersection,
    MeshIntersectionPoint,
    PolylineMeshIntersection,
    SurfaceSurfaceIntersectionPoint,
    TriSegmentIntersection,
    CurveTriPoint,
    SurfacePoint,
    CurvePoint,
    KdTree,
    BinaryHeap,
    KdPoint,
    KdNode,
    LazyCurveBoundingBoxTree,
    LazyMeshBoundingBoxTree,
    LazyPolylineBoundingBoxTree,
    LazySurfaceBoundingBoxTree,
    Mat,
    LUDecomp,
    Mesh,
    MeshBoundingBoxTree,
    Minimizer,
    MinimizationResult,
    SerializableBase,
    Deserializer,
    SurfaceBoundingBoxTree,
    Trig,
    Vec,
    Analyze,
    KnotMultiplicity,
    Check,
    Divide,
    CurveLengthSample,
    Eval,
    Fit,
    Transfinite,
    EvalIntersect,
    Make,
    Modify,
    Offset,
    RotationMinimizingFrames,
    Sweep,
    Tess,
    AdaptiveRefinementOptions,
    AdaptiveRefinementNode,
    Arc,
    BezierCurve,
    Circle,
    ConicalSurface,
    CylindricalSurface,
    Ellipse,
    EllipseArc,
    ExtrudedSurface,
    Intersect,
    Line,
    NurbsCurve,
    NurbsSurface,
    RevolvedSurface,
    SphericalSurface,
    SweptSurface,
    Dispatcher,
    Welder,
    BrepSolid,
    FaceMesher,
    BrepBoolean,
    Fillet,
    FilletCorner,
    Makeable,
    MeshBVH,
    Shell,
    SurfaceIntersect,
    TriMesh,
    ApplianceRecipe,
    BooleanObjectsRecipe,
    FreeformVesselRecipe,
    SweptObjectsRecipe,
    Inspect,
    registerSerializable,
};

export const core = {
    ArrayExtensions,
    Binomial,
    BoundingBox,
    Constants,
    Plane,
    Ray,
    NurbsCurveData,
    NurbsSurfaceData,
    MeshData,
    PolylineData,
    VolumeData,
    Pair,
    Interval,
    CurveCurveIntersection,
    CurveSurfaceIntersection,
    MeshIntersectionPoint,
    PolylineMeshIntersection,
    SurfaceSurfaceIntersectionPoint,
    TriSegmentIntersection,
    CurveTriPoint,
    SurfacePoint,
    CurvePoint,
    KdTree,
    BinaryHeap,
    KdPoint,
    KdNode,
    LazyCurveBoundingBoxTree,
    LazyMeshBoundingBoxTree,
    LazyPolylineBoundingBoxTree,
    LazySurfaceBoundingBoxTree,
    Mat,
    LUDecomp,
    Mesh,
    MeshBoundingBoxTree,
    Minimizer,
    MinimizationResult,
    SerializableBase,
    Deserializer,
    SurfaceBoundingBoxTree,
    Trig,
    Vec,
};
export const eval_ = {
    Analyze,
    KnotMultiplicity,
    Check,
    Divide,
    CurveLengthSample,
    Eval,
    Fit,
    Transfinite,
    Intersect: EvalIntersect,
    Make,
    Modify,
    Offset,
    RotationMinimizingFrames,
    Sweep,
    Tess,
    AdaptiveRefinementOptions,
    AdaptiveRefinementNode,
};
export const geom = {
    Arc,
    BezierCurve,
    Circle,
    ConicalSurface,
    CylindricalSurface,
    Ellipse,
    EllipseArc,
    ExtrudedSurface,
    Intersect,
    Line,
    NurbsCurve,
    NurbsSurface,
    RevolvedSurface,
    SphericalSurface,
    SweptSurface,
};
export const exe = {
    Dispatcher,
};
export const solid = {
    Welder,
    BrepSolid,
    FaceMesher,
    BrepBoolean,
    Fillet,
    FilletCorner,
    Makeable,
    MeshBVH,
    Shell,
    SurfaceIntersect,
    TriMesh,
};
export const recipes = {
    ApplianceRecipe,
    BooleanObjectsRecipe,
    FreeformVesselRecipe,
    SweptObjectsRecipe,
};
export const view = {
    Inspect,
};

const verb = { core, eval: eval_, geom, exe, solid, recipes, view };
export default verb;

// register every class so that `Deserializer.deserialize` can rebuild serialized objects
for (const [nsName, members] of Object.entries(verb)) {
    for (const [name, value] of Object.entries(members)) {
        if (typeof value === "function" && /^[A-Z]/.test(name)) registerSerializable(nsName + "." + name, value);
    }
}
