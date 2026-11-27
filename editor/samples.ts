import type { GraphDocument } from "../src/index.js";
import { SAMPLE } from "./sample.js";
import vase from "./samples/art-nouveau-vase.graph.json";
import column from "./samples/vine-column.graph.json";
import fern from "./samples/fern-sprout.graph.json";
import tulip from "./samples/tulip-lamp.graph.json";
import italy from "./samples/ceramics/italy-by-period.graph.json";
import bracket from "./samples/wall-bracket.graph.json";
import crank from "../test/fixtures/formats/crank.graph.json";
import flywheel from "../test/fixtures/507/A-pin-overhanging-window.graph.json";
import windows from "../test/fixtures/507/D-six-windows.graph.json";
import rimSpoke from "../test/fixtures/507/E-flush-union.graph.json";

// The graphs the editor offers to open: freeform showcases (editor/samples), and mechanisms from the test fixtures,
// the 507 project's among them. `doc` is copied before it is opened.
export interface Sample { group : string, title : string, doc : GraphDocument }

const g = ( d : unknown ) => d as GraphDocument;
export const SAMPLES : Array<Sample> = [
    { group : "Freeform", title : "Art nouveau vase", doc : g( vase ) },
    { group : "Freeform", title : "Vine column", doc : g( column ) },
    { group : "Freeform", title : "Fern sprout", doc : g( fern ) },
    { group : "Freeform", title : "Tulip lamp", doc : g( tulip ) },
    { group : "Collections", title : "Pottery of ancient Italy, by period and form", doc : g( italy ) },
    { group : "Printable parts", title : "Wall bracket, with options (switches, a component)", doc : g( bracket ) },
    { group : "Mechanisms", title : "Box less a cone, rounded", doc : SAMPLE },
    { group : "Mechanisms", title : "Crank and connecting rod", doc : g( crank ) },
    { group : "Mechanisms", title : "507: flywheel with a pin", doc : g( flywheel ) },
    { group : "Mechanisms", title : "507: six windows", doc : g( windows ) },
    { group : "Mechanisms", title : "507: rim and spoke", doc : g( rimSpoke ) },
];

