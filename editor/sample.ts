import type { GraphDocument } from "../src/index.js";

// The graph the editor opens with: a box with a truncated cone taken out of it, its box edges rounded.
export const SAMPLE : GraphDocument = {
    version : 2,
    nodes : {
        h : { type : "number", in : { value : 24 }, label : "Height h" },
        box : { type : "primitive/box", in : { width : 60, depth : 40, height : "@h" } },
        coneH : { type : "expression", in : { expr : "h + 10" }, label : "Cone height" },
        coneShape : { type : "primitive/cone", in : { radius : 13, height : "@coneH", top_radius : 6 }, label : "Truncated cone" },
        cone : { type : "transform/move", in : { of : "@coneShape", z : -5 }, label : "Sink the cone" },
        cut : { type : "boolean/difference", in : { from : "@box", minus : "@cone" } },
        round : { type : "finish/round", in : { of : "@cut", radius : 3, edges : "box.*|box.*" }, label : "Round box edges" },
    },
    outputs : { solid : "@round" },
    view : { nodes : { h : { x : 0, y : 180 }, box : { x : 300, y : 0 }, coneH : { x : 0, y : 420 }, coneShape : { x : 300, y : 300 },
        cone : { x : 600, y : 330 }, cut : { x : 880, y : 140 }, round : { x : 1160, y : 140 } } },
};
