import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";

declare const WORKER_SOURCE : string;

type ModelId = "vessel" | "knot" | "ring" | "mug" | "pierced" | "ribbon" | "appliance" | "block" | "grown" | "primitive";
// `labels`: names for a slider's whole-number positions (a choice among a few kinds)
interface Slider { key : string; label : string; min : number; max : number; step : number; value : number; unit? : string; labels? : Array<string> }

// the models built from B-rep solids: they go out as STEP, and their seams can be proven complete
const BREP : Array<ModelId> = ["mug", "pierced", "appliance", "block", "primitive"];

const MODELS : Record<ModelId, { name : string; note : string; sliders : Slider[] }> = {
    vessel : {
        name : "Vessel",
        note : "Seven folded sections lofted into a wall, offset inward for thickness, floor cut and capped.",
        sliders : [
            { key : "height", label : "Height", min : 80, max : 260, step : 1, value : 160, unit : "mm" },
            { key : "baseRadius", label : "Base radius", min : 35, max : 110, step : 1, value : 70, unit : "mm" },
            { key : "rimRadius", label : "Rim radius", min : 35, max : 120, step : 1, value : 80, unit : "mm" },
            { key : "belly", label : "Belly", min : -15, max : 25, step : 0.5, value : 1.5, unit : "mm" },
            { key : "lean", label : "Lean", min : -20, max : 20, step : 0.5, value : 4, unit : "mm" },
            { key : "folds", label : "Fold depth", min : 0, max : 1.8, step : 0.05, value : 1, unit : "×" },
            { key : "drift", label : "Fold drift", min : 0, max : 3, step : 0.05, value : 1, unit : "×" },
            { key : "turn", label : "Fold turn", min : -1.5, max : 1.5, step : 0.05, value : 0, unit : "rad" },
            { key : "wall", label : "Wall", min : 1.2, max : 8, step : 0.1, value : 3, unit : "mm" },
            { key : "floor", label : "Floor", min : 1.5, max : 15, step : 0.5, value : 4, unit : "mm" },
        ]
    },
    knot : {
        name : "Knot pipe",
        note : "A circle swept on rotation-minimising frames along a (p, q) torus knot, radius swelling as it goes.",
        sliders : [
            { key : "p", label : "Loops p", min : 2, max : 5, step : 1, value : 2 },
            { key : "q", label : "Winds q", min : 3, max : 7, step : 1, value : 3 },
            { key : "radius", label : "Knot radius", min : 15, max : 60, step : 1, value : 30, unit : "mm" },
            { key : "tube", label : "Torus tube", min : 4, max : 25, step : 0.5, value : 12, unit : "mm" },
            { key : "pipe", label : "Pipe radius", min : 1, max : 9, step : 0.1, value : 5, unit : "mm" },
            { key : "swell", label : "Swell", min : 0, max : 0.8, step : 0.01, value : 0.35, unit : "×" },
        ]
    },
    ring : {
        name : "Twisted ring",
        note : "A rounded-square section swept along a wavy ring, turning about the rail as it goes.",
        sliders : [
            { key : "radius", label : "Ring radius", min : 15, max : 60, step : 0.5, value : 32, unit : "mm" },
            { key : "wave", label : "Wave height", min : 0, max : 12, step : 0.25, value : 4, unit : "mm" },
            { key : "waves", label : "Waves", min : 0, max : 8, step : 1, value : 3 },
            { key : "width", label : "Section width", min : 1, max : 14, step : 0.25, value : 6, unit : "mm" },
            { key : "height", label : "Section height", min : 1, max : 10, step : 0.25, value : 3, unit : "mm" },
            { key : "exponent", label : "Squareness", min : 2, max : 8, step : 0.25, value : 4 },
            { key : "turns", label : "Turns", min : 0, max : 4, step : 1, value : 1 },
        ]
    },
    mug : {
        name : "Mug",
        note : "NURBS Boolean: (body + handle) − cavity. Seams are exact surface/surface intersections; the handle joint is blended by a rolling-ball fillet.",
        sliders : [
            { key : "height", label : "Height", min : 70, max : 160, step : 1, value : 110, unit : "mm" },
            { key : "baseRadius", label : "Base radius", min : 28, max : 70, step : 1, value : 40, unit : "mm" },
            { key : "rimRadius", label : "Rim radius", min : 28, max : 75, step : 1, value : 44, unit : "mm" },
            { key : "folds", label : "Fold depth", min : 0, max : 1.4, step : 0.05, value : 1, unit : "×" },
            { key : "wall", label : "Wall", min : 2, max : 6, step : 0.1, value : 3, unit : "mm" },
            { key : "handle", label : "Handle radius", min : 3, max : 9, step : 0.1, value : 5.5, unit : "mm" },
            { key : "reach", label : "Handle reach", min : 20, max : 50, step : 1, value : 32, unit : "mm" },
            { key : "low", label : "Lower joint", min : 0.12, max : 0.45, step : 0.01, value : 0.25, unit : "×H" },
            { key : "high", label : "Upper joint", min : 0.55, max : 0.85, step : 0.01, value : 0.75, unit : "×H" },
            { key : "fillet", label : "Joint fillet", min : 0, max : 6, step : 0.25, value : 3, unit : "mm" },
        ]
    },
    pierced : {
        name : "Pierced vessel",
        note : "NURBS Boolean: body − cavity − round tools. Holes go through the wall; notches cut the rim, where three faces meet at exact triple points. Hole edges are rounded by rolling-ball fillets.",
        sliders : [
            { key : "height", label : "Height", min : 80, max : 220, step : 1, value : 140, unit : "mm" },
            { key : "baseRadius", label : "Base radius", min : 40, max : 90, step : 1, value : 55, unit : "mm" },
            { key : "rimRadius", label : "Rim radius", min : 40, max : 95, step : 1, value : 62, unit : "mm" },
            { key : "folds", label : "Fold depth", min : 0, max : 1.4, step : 0.05, value : 1, unit : "×" },
            { key : "wall", label : "Wall", min : 2, max : 6, step : 0.1, value : 3, unit : "mm" },
            { key : "holes", label : "Holes per row", min : 0, max : 14, step : 1, value : 9 },
            { key : "rows", label : "Rows", min : 1, max : 3, step : 1, value : 2 },
            { key : "hole", label : "Hole radius", min : 3, max : 12, step : 0.5, value : 7, unit : "mm" },
            { key : "notches", label : "Rim notches", min : 0, max : 14, step : 1, value : 9 },
            { key : "notch", label : "Notch radius", min : 3, max : 9, step : 0.5, value : 7, unit : "mm" },
            { key : "fillet", label : "Hole edge fillet", min : 0, max : 1.4, step : 0.05, value : 0.8, unit : "mm" },
        ]
    },
    appliance : {
        name : "Appliance",
        note : "Four parts, each a closed solid: a base (tapered block − sloped slab − conical seat − key pocket + carry arch), a bowl with a sculpted grip and a lobed foot that keys into the pocket, a lid with a lobed tab, a plug and a filler hole, and a measuring cup with a teardrop flange that plugs the hole. Every new edge is a rolling-ball fillet.",
        sliders : [
            { key : "width", label : "Base width", min : 160, max : 260, step : 1, value : 200, unit : "mm" },
            { key : "depth", label : "Base depth", min : 200, max : 320, step : 1, value : 250, unit : "mm" },
            { key : "front", label : "Front height", min : 100, max : 160, step : 1, value : 120, unit : "mm" },
            { key : "back", label : "Back height", min : 150, max : 240, step : 1, value : 190, unit : "mm" },
            { key : "square", label : "Squareness", min : 2, max : 5, step : 0.1, value : 3.2 },
            { key : "bowlH", label : "Bowl height", min : 120, max : 220, step : 1, value : 170, unit : "mm" },
            { key : "foot", label : "Bowl foot radius", min : 45, max : 70, step : 0.5, value : 58, unit : "mm" },
            { key : "rim", label : "Bowl rim radius", min : 55, max : 85, step : 0.5, value : 76, unit : "mm" },
            { key : "seat", label : "Seat depth", min : 50, max : 100, step : 1, value : 80, unit : "mm" },
            { key : "gap", label : "Clearance", min : 0.2, max : 2, step : 0.05, value : 0.6, unit : "mm" },
            { key : "arch", label : "Arch height", min : 40, max : 110, step : 1, value : 70, unit : "mm" },
            { key : "topF", label : "Top edge fillet", min : 0, max : 16, step : 0.5, value : 10, unit : "mm" },
            { key : "seatF", label : "Seat edge fillet", min : 0, max : 8, step : 0.25, value : 4, unit : "mm" },
            { key : "archF", label : "Arch foot fillet", min : 0, max : 10, step : 0.25, value : 6, unit : "mm" },
            { key : "handleF", label : "Handle fillet", min : 0, max : 6, step : 0.25, value : 4, unit : "mm" },
            { key : "ribs", label : "Bowl ribs", min : 0, max : 6, step : 1, value : 3 },
            { key : "swell", label : "Grip swell", min : 0.8, max : 1.5, step : 0.05, value : 1.2 },
            { key : "key", label : "Coupling radius", min : 0, max : 44, step : 1, value : 34, unit : "mm" },
            { key : "tab", label : "Lid tab", min : 0, max : 24, step : 1, value : 16, unit : "mm" },
            { key : "hole", label : "Lid hole radius", min : 10, max : 40, step : 1, value : 24, unit : "mm" },
            { key : "lip", label : "Cup lip", min : 0, max : 30, step : 1, value : 18, unit : "mm" },
        ]
    },
    ribbon : {
        name : "Ribbon knot",
        note : "A flat ribbon swept along a torus knot, twisting as it goes. At zero thickness it is a bare sheet: fine to look at, impossible to make.",
        sliders : [
            { key : "p", label : "Loops p", min : 2, max : 5, step : 1, value : 3 },
            { key : "q", label : "Winds q", min : 3, max : 8, step : 1, value : 5 },
            { key : "radius", label : "Knot radius", min : 20, max : 60, step : 1, value : 34, unit : "mm" },
            { key : "tube", label : "Torus tube", min : 6, max : 25, step : 0.5, value : 13, unit : "mm" },
            { key : "width", label : "Ribbon width", min : 2, max : 20, step : 0.5, value : 9, unit : "mm" },
            { key : "thickness", label : "Thickness", min : 0, max : 4, step : 0.1, value : 1.6, unit : "mm" },
            { key : "turns", label : "Twist turns", min : 0, max : 8, step : 1, value : 2 },
        ]
    },
    block : {
        name : "Block",
        note : "A model document rather than a recipe: a box with a bore, its edges rounded by rules over the faces' persistent names, hollowed into a tray open at the top, or filled with a lattice inside a skin. Only the features a slider touches are rebuilt.",
        sliders : [
            { key : "width", label : "Width", min : 30, max : 120, step : 1, value : 60, unit : "mm" },
            { key : "depth", label : "Depth", min : 30, max : 90, step : 1, value : 45, unit : "mm" },
            { key : "height", label : "Height", min : 15, max : 60, step : 1, value : 30, unit : "mm" },
            { key : "edge", label : "Edge radius", min : 0, max : 8, step : 0.25, value : 3, unit : "mm" },
            { key : "bore", label : "Bore radius", min : 3, max : 12, step : 0.5, value : 6, unit : "mm" },
            { key : "shell", label : "Shell wall (0: solid)", min : 0, max : 4, step : 0.25, value : 0, unit : "mm" },
            { key : "cell", label : "Infill cell (0: none)", min : 0, max : 20, step : 1, value : 0, unit : "mm" },
            { key : "pattern", label : "Infill pattern", min : 0, max : 5, step : 1, value : 0, labels : ["gyroid", "Schwarz P", "diamond", "octet", "BCC", "cubic"] },
            { key : "wall", label : "Infill wall", min : 0.8, max : 3, step : 0.1, value : 1.6, unit : "mm" },
            { key : "skin", label : "Skin", min : 0, max : 3, step : 0.1, value : 1.6, unit : "mm" },
        ]
    },
    primitive : {
        name : "Primitive",
        note : "A primitive solid from the catalogue (docs/primitives.md): boxes, prisms over any profile, pyramids, cones, spheres, tori, tubes, eggs and polyhedra, each an exact closed B-rep. Round its edges to see which ones a fillet can take.",
        // the shape's own sliders come from the catalogue, which the worker sends (see `primitiveSliders`)
        sliders : [
            { key : "round", label : "Edge radius (0: sharp)", min : 0, max : 5, step : 0.25, value : 0, unit : "mm" },
        ]
    },
    grown : {
        name : "Grown sheet",
        note : "Differential growth: a disc whose rim, centre or whole surface grows faster than the rest, so it buckles into ruffles. Folds are kept apart as it grows, and the final model thickens the sheet into a closed solid.",
        sliders : [
            { key : "radius", label : "Disc radius", min : 15, max : 50, step : 1, value : 30, unit : "mm" },
            { key : "zone", label : "Where it grows", min : 0, max : 2, step : 1, value : 0, labels : ["rim", "centre", "everywhere"] },
            { key : "rate", label : "Growth rate", min : 0.002, max : 0.02, step : 0.001, value : 0.012, unit : "/step" },
            { key : "reach", label : "Zone reach", min : 2, max : 15, step : 0.5, value : 6, unit : "mm" },
            { key : "steps", label : "Steps", min : 10, max : 140, step : 5, value : 90 },
            { key : "bending", label : "Stiffness", min : 0.05, max : 0.6, step : 0.01, value : 0.3 },
            { key : "thickness", label : "Thickness", min : 0.8, max : 4, step : 0.1, value : 2, unit : "mm" },
        ]
    }
};

const MACHINES : [string, string][] = [
    ["fdm", "FDM printer, 0.8 mm walls"], ["sla", "Resin printer, 0.5 mm walls"], ["sls", "SLS nylon, 0.7 mm walls"],
    ["cnc", "3-axis CNC, 1.5 mm walls"], ["ceramic", "Ceramic slip casting, 2.5 mm walls"]];

const $ = (id : string) => document.getElementById( id )!;
let current : ModelId = "vessel";
const values : Record<ModelId, Record<string, number>> = { vessel : {}, knot : {}, ring : {}, mug : {}, pierced : {}, ribbon : {}, appliance : {}, block : {}, grown : {}, primitive : {} };
let mode : "free" | "make" = "free", machine = "fdm";
for (const m of Object.keys( MODELS ) as ModelId[]) for (const s of MODELS[m].sliders) values[m][s.key] = s.value;
try {
    const saved = JSON.parse( localStorage.getItem( "verb-playground" ) || "null" );
    if (saved && saved.values) for (const m of Object.keys( values ) as ModelId[]) Object.assign( values[m], saved.values[m] || {} );
    if (saved && MODELS[saved.current as ModelId]) current = saved.current;
    if (saved && (saved.mode == "free" || saved.mode == "make")) mode = saved.mode;
    if (saved && MACHINES.some( m => m[0] == saved.machine )) machine = saved.machine;
} catch (e) { /* storage unavailable */ }
// The primitive catalogue, as the worker sends it: each shape's name, family and parameters. A shape's sliders are
// keyed by its index and the parameter's, so every shape keeps its own values.
interface CatalogParam { name : string; value : number; min : number; max : number; integer? : boolean; degrees? : boolean }
let catalog : Array<{ name : string; family : string; parameters : Array<CatalogParam> }> = [];
const shapeKey = (e : number, i : number) => "e" + e + "p" + i;
function primitiveSliders() : Slider[] {
    const e = Math.min( Math.max( 0, Math.round( values.primitive.shape ?? 0 ) ), Math.max( 0, catalog.length - 1 ) );
    const entry = catalog[e];
    if (entry == null) return MODELS.primitive.sliders;
    const own = entry.parameters.map( (p, i) : Slider => {
        if (p.integer) return { key : shapeKey( e, i ), label : p.name, min : p.min, max : Math.min( p.max, 24 ), step : 1, value : p.value };
        if (p.degrees) return { key : shapeKey( e, i ), label : p.name, min : p.min, max : Math.min( p.max, 360 ), step : 1, value : p.value, unit : "°" };
        const a = Math.abs( p.value ) || 1;
        const lo = p.min >= 0 ? p.min : Math.max( p.min, -3 * a ), hi = Math.min( p.max, Math.max( 3 * a, 1 ) );
        const step = hi - lo > 40 ? 0.5 : hi - lo > 4 ? 0.1 : 0.01;
        return { key : shapeKey( e, i ), label : p.name, min : p.min > 0 ? Math.max( lo, step ) : lo, max : hi, step, value : p.value, unit : p.max > 100 ? "mm" : "" };
    } );
    for (const s of own) if (values.primitive[s.key] == null) values.primitive[s.key] = s.value;
    return own.concat( MODELS.primitive.sliders );
}
const slidersOf = (m : ModelId) : Slider[] => m == "primitive" ? primitiveSliders() : MODELS[m].sliders;
// the values a build gets: for a primitive, its shape's name and parameters by name
function buildParams() : Record<string, number | string> {
    if (current != "primitive") return values[current];
    const e = Math.round( values.primitive.shape ?? 0 ), entry = catalog[e];
    const out : Record<string, number | string> = { round : values.primitive.round ?? 0, shape : entry != null ? entry.name : "box" };
    if (entry != null) entry.parameters.forEach( (p, i) => { const v = values.primitive[shapeKey( e, i )]; if (v != null) out["p:" + p.name] = v; } );
    return out;
}

const remember = () => { try { localStorage.setItem( "verb-playground", JSON.stringify( { current, values, mode, machine } ) ); } catch (e) { /* ignore */ } };

// ---------- three.js view ----------
const canvas = $( "view" ) as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer( { canvas, antialias : true, alpha : true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator( renderer ).fromScene( new RoomEnvironment(), 0.04 ).texture;
const camera = new THREE.PerspectiveCamera( 35, 1, 1, 5000 );
camera.up.set( 0, 0, 1 );
const controls = new OrbitControls( camera, canvas );
controls.enableDamping = true;
const sun = new THREE.DirectionalLight( 0xffffff, 1.4 );
sun.position.set( 200, -300, 500 );
sun.castShadow = true;
sun.shadow.mapSize.set( 2048, 2048 );
scene.add( sun, sun.target );
const material = new THREE.MeshPhysicalMaterial( { color : 0x3f9c95, roughness : 0.18, metalness : 0.0, clearcoat : 1, clearcoatRoughness : 0.08, side : THREE.DoubleSide } );
const mesh = new THREE.Mesh( new THREE.BufferGeometry(), material );
mesh.castShadow = true;
scene.add( mesh );
const floor = new THREE.Mesh( new THREE.CircleGeometry( 1, 64 ), new THREE.ShadowMaterial( { opacity : 0.18 } ) );
floor.receiveShadow = true;
scene.add( floor );
let framed = "";

function resize() {
    const r = canvas.parentElement!.getBoundingClientRect();
    renderer.setSize( r.width, r.height, false );
    camera.aspect = r.width / Math.max( r.height, 1 );
    camera.updateProjectionMatrix();
}
new ResizeObserver( resize ).observe( canvas.parentElement! );
renderer.setAnimationLoop( () => { controls.update(); renderer.render( scene, camera ); } );

function frame( force : boolean ) {
    const g = mesh.geometry;
    g.computeBoundingSphere();
    const bs = g.boundingSphere!;
    g.computeBoundingBox();
    floor.position.set( bs.center.x, bs.center.y, g.boundingBox!.min.z - 0.01 );
    floor.scale.setScalar( bs.radius * 3 );
    sun.target.position.copy( bs.center );
    sun.position.copy( bs.center ).add( new THREE.Vector3( 0.25, -0.35, 1 ).normalize().multiplyScalar( bs.radius * 4 ) );
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -bs.radius * 1.5; sc.right = sc.top = bs.radius * 1.5; sc.near = 1; sc.far = bs.radius * 8;
    sc.updateProjectionMatrix();
    if (!force && framed == current) return;
    framed = current;
    controls.target.copy( bs.center );
    const vfov = THREE.MathUtils.degToRad( camera.fov );
    const hfov = 2 * Math.atan( Math.tan( vfov / 2 ) * camera.aspect );
    const d = bs.radius / Math.sin( Math.min( vfov, hfov ) / 2 ) * 1.05;
    camera.position.copy( bs.center ).add( new THREE.Vector3( 0.55, -0.75, 0.42 ).normalize().multiplyScalar( d ) );
}

// ---------- worker ----------
const worker = new Worker( URL.createObjectURL( new Blob( [WORKER_SOURCE], { type : "text/javascript" } ) ) );
let seq = 0, latest = 0, busy = false, queued : { fine : boolean, certify : boolean } | null = null;
let lastPos : Float32Array | null = null, lastIdx : Uint32Array | null = null;
// whether the model on show is a final build with B-rep parts (STEP can be written), and whether its seams were proven
let stepReady = false, certified = false;

// `certify`: prove the seams complete (the intersection certificate). It takes minutes on the larger models, so it
// runs only when asked, on the final model.
function request( fine : boolean, certify : boolean = false ) {
    if (busy) { queued = { fine : fine || certify || (queued != null && queued.fine), certify : certify || (queued != null && queued.certify) }; return; }
    busy = true;
    latest = ++seq;
    $( "status" ).textContent = certify ? "Proving the seams complete: this can take a few minutes…" : fine ? "Refining…" : "Building…";
    $( "status" ).dataset.state = "busy";
    stepReady = false; renderExport();
    worker.postMessage( { id : latest, model : current, params : buildParams(), fine : fine || certify, make : mode == "make", machine, certify } );
}

let fineTimer = 0;
worker.onmessage = (e : MessageEvent) => {
    const r = e.data;
    if (r.type == "step") { saveStep( r ); return; }
    if (r.type == "catalog") { catalog = r.entries; if (current == "primitive") renderControls(); return; }
    busy = false;
    if (queued) { const q = queued; queued = null; request( q.fine, q.certify ); }
    if (r.model != current) return; // a build for a model the user has since left
    if (!r.ok) {
        // a coarse preview can fail where the final resolution works: go on to the final build before giving up
        if (!r.fine && !queued) {
            $( "status" ).textContent = "Preview failed, building at final resolution…";
            clearTimeout( fineTimer ); fineTimer = window.setTimeout( () => request( true ), 50 );
            return;
        }
        showError( r.message ); return;
    }
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute( "position", new THREE.BufferAttribute( r.pos, 3 ) );
    indexed.setIndex( new THREE.BufferAttribute( r.idx, 1 ) );
    // smooth shading, but keep sharp edges (rims, hole edges) sharp
    const g = toCreasedNormals( indexed, Math.PI / 5 );
    indexed.dispose();
    mesh.geometry.dispose();
    mesh.geometry = g;
    lastPos = r.pos; lastIdx = r.idx;
    stepReady = r.fine && r.stats.step; certified = r.certified === true;
    frame( false );
    showStats( r.stats, r.ms, r.fine );
    if (!r.fine && !queued) { clearTimeout( fineTimer ); fineTimer = window.setTimeout( () => request( true ), 450 ); }
};

function showError( msg : string ) {
    $( "status" ).textContent = "Can't build this shape: " + msg.replace( /^Shell: /, "" );
    $( "status" ).dataset.state = "bad";
}

function showStats( s : any, ms : number, fine : boolean ) {
    const m = s.manifold;
    const st = $( "status" );
    const issues = $( "issues" );
    issues.innerHTML = "";
    let canSave = true;
    if (mode == "free") {
        st.textContent = (m.closedManifold ? "Closed solid" : "Open surface, visual only") + (fine ? ", final resolution" : ", preview");
        st.dataset.state = "good";
    } else if (!fine || !s.check) {
        st.textContent = "Preview: making checks run on the final model";
        st.dataset.state = "busy";
        canSave = false;
    } else {
        const c = s.check;
        st.textContent = c.kind != null
            ? (c.makeable ? "Buildable: makeable on " + c.machine : "Visual only, not buildable yet: " + c.issues.length + (c.issues.length == 1 ? " issue" : " issues"))
            : (c.makeable ? "Makeable: " + c.machine : "Not makeable yet: " + c.issues.length + (c.issues.length == 1 ? " issue" : " issues"));
        st.dataset.state = c.makeable ? "good" : "bad";
        issues.innerHTML = c.issues.map( (x : string) => `<li>${x.replace( /&/g, "&amp;" ).replace( /</g, "&lt;" )}</li>` ).join( "" );
        canSave = c.makeable;
    }
    const notes : Array<string> = mode == "make" && s.check ? (s.check.notes ?? []) : (s.notes ?? []);
    issues.innerHTML += notes.map( (x : string) => `<li class="note">${x.replace( /&/g, "&amp;" ).replace( /</g, "&lt;" )}</li>` ).join( "" );
    const rows : [string, string][] = [
        ["Triangles", s.triangles.toLocaleString( "en" )],
        ["Watertight", m.closedManifold ? "yes" : "no, " + m.boundaryEdges + " open edges"],
        ["Genus", m.genus == null || isNaN( m.genus ) ? "–" : String( m.genus )],
        ["Material", m.closedManifold ? (s.volume / 1000).toFixed( 1 ) + " cm³" : "–"],
        ["Size", s.size ? s.size.map( (x : number) => x.toFixed( 0 ) ).join( " × " ) + " mm" : "–"],
        BREP.includes( current ) ? ["Seam error", isFinite( s.error ) ? s.error.toExponential( 1 ) + " mm" : "–"] : ["Fit error", isFinite( s.error ) ? s.error.toFixed( 3 ) + " mm" : "–"],
    ];
    if (s.fillets != null && (s.fillets > 0 || s.filletsFailed > 0))
        rows.push( ["Fillets", s.fillets + (s.filletsFailed > 0 ? ", " + s.filletsFailed + " too big to fit" : "") + (s.filletsSkipped > 0 ? ", " + s.filletsSkipped + " sharp at corners" : "")] );
    if (s.check && isFinite( s.check.wall )) rows.push( ["Thinnest wall", s.check.wall.toFixed( 2 ) + " mm"] );
    rows.push( ["Build", Math.round( ms ) + " ms"] );
    $( "stats" ).innerHTML = rows.map( ([k, v]) => `<div><dt>${k}</dt><dd>${v.replace( /&/g, "&amp;" ).replace( /</g, "&lt;" )}</dd></div>` ).join( "" );
    ($( "save" ) as HTMLButtonElement).disabled = !canSave;
    saveAllowed = canSave;
    renderExport();
}

let saveAllowed = false;
// STEP goes with B-rep models, on the final build (in makeable mode, once it passes); proving the seams with B-rep
// models in makeable mode, on a final build not yet proven
function renderExport() {
    const brep = BREP.includes( current );
    const step = $( "saveStep" ) as HTMLButtonElement, prove = $( "prove" ) as HTMLButtonElement;
    step.hidden = !brep;
    step.disabled = !(stepReady && saveAllowed);
    prove.hidden = !(brep && mode == "make");
    prove.disabled = !stepReady || certified || busy;
    prove.textContent = certified ? "Seams proven" : "Prove seams";
}

function renderMode() {
    document.querySelectorAll<HTMLButtonElement>( "#mode button" ).forEach( b => b.setAttribute( "aria-pressed", String( b.dataset.mode == mode ) ) );
    $( "machineRow" ).hidden = mode != "make";
    $( "modeHint" ).textContent = mode == "free"
        ? "Anything goes: open sheets and thin or self-crossing shapes are fine for images and animation."
        : "Each final model is checked: closed solid, every fillet in place, wall thickness for the machine, and fit in its build volume. Prove seams also checks that no seam between faces was missed.";
    renderExport();
    const sel = $( "machine" ) as HTMLSelectElement;
    if (!sel.options.length) sel.innerHTML = MACHINES.map( ([k, n]) => `<option value="${k}">${n}</option>` ).join( "" );
    sel.value = machine;
}

$( "mode" ).addEventListener( "click", (e) => {
    const b = (e.target as HTMLElement).closest( "button" );
    if (!b) return;
    mode = b.dataset.mode as "free" | "make";
    remember(); renderMode(); request( mode == "make" );
} );
$( "machine" ).addEventListener( "change", (e) => {
    machine = (e.target as HTMLSelectElement).value;
    remember(); request( true );
} );

// ---------- controls ----------
function fmt( s : Slider, v : number ) {
    if (s.labels != null) return s.labels[Math.round( v )] ?? String( v );
    return (s.step >= 1 ? v.toFixed( 0 ) : s.step >= 0.1 ? v.toFixed( 1 ) : s.step >= 0.01 ? v.toFixed( 2 ) : v.toFixed( 3 )) + (s.unit ? " " + s.unit : "");
}

function renderControls() {
    const m = MODELS[current];
    document.querySelectorAll<HTMLButtonElement>( "#models button" ).forEach( b => b.setAttribute( "aria-pressed", String( b.dataset.m == current ) ) );
    $( "note" ).textContent = m.note;
    const shapes = current == "primitive" && catalog.length > 0
        ? `<label class="row" for="s-shape"><span class="lab">Shape</span><output></output>
             <select id="s-shape" data-k="shape">${catalog.map( (c, k) => `<option value="${k}"${k == Math.round( values.primitive.shape ?? 0 ) ? " selected" : ""}>${c.family}: ${c.name}</option>` ).join( "" )}</select></label>`
        : "";
    $( "sliders" ).innerHTML = shapes + slidersOf( current ).map( s => `
        <label class="row" for="s-${s.key}">
          <span class="lab">${s.label}</span><output id="o-${s.key}">${fmt( s, values[current][s.key] )}</output>
          <input type="range" id="s-${s.key}" data-k="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${values[current][s.key]}">
        </label>` ).join( "" );
}

$( "sliders" ).addEventListener( "input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.k == "shape") {
        values.primitive.shape = Number( t.value );
        framed = ""; remember(); renderControls(); request( false );
        return;
    }
    const s = slidersOf( current ).find( x => x.key == t.dataset.k )!;
    values[current][s.key] = Number( t.value );
    $( "o-" + s.key ).textContent = fmt( s, values[current][s.key] );
    remember();
    request( false );
} );

$( "models" ).addEventListener( "click", (e) => {
    const b = (e.target as HTMLElement).closest( "button" );
    if (!b) return;
    current = b.dataset.m as ModelId;
    stepReady = false; certified = false;
    remember(); renderControls(); renderExport(); request( false );
} );

$( "reset" ).addEventListener( "click", () => {
    for (const s of slidersOf( current )) values[current][s.key] = s.value;
    remember(); renderControls(); request( false );
} );

$( "shuffle" ).addEventListener( "click", () => {
    for (const s of slidersOf( current )) {
        const span = (s.max - s.min) * 0.35;
        const v = s.value + (Math.random() * 2 - 1) * span;
        values[current][s.key] = Math.min( s.max, Math.max( s.min, Math.round( v / s.step ) * s.step ) );
    }
    remember(); renderControls(); request( false );
} );

$( "recenter" ).addEventListener( "click", () => frame( true ) );

function binarySTL() : Uint8Array {
    const pos = lastPos!, idx = lastIdx!;
    const n = idx.length / 3;
    const buf = new ArrayBuffer( 84 + n * 50 );
    const dv = new DataView( buf );
    dv.setUint32( 80, n, true );
    let o = 84;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nr = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
        a.fromArray( pos, idx[3*i] * 3 ); b.fromArray( pos, idx[3*i+1] * 3 ); c.fromArray( pos, idx[3*i+2] * 3 );
        nr.subVectors( b, a ).cross( c.clone().sub( a ) ).normalize();
        for (const v of [nr, a, b, c]) { dv.setFloat32( o, v.x, true ); dv.setFloat32( o + 4, v.y, true ); dv.setFloat32( o + 8, v.z, true ); o += 12; }
        o += 2;
    }
    return new Uint8Array( buf );
}

// A zip of stored (uncompressed) files. The artifact viewer only lets pages save common formats, and .stl and .step
// are not among them, so there they travel inside a zip; several STEP files (the appliance's parts) always do.
function crc32( data : Uint8Array ) : number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function zip( files : Array<{ name : string, data : Uint8Array }> ) : Uint8Array {
    const enc = files.map( f => ({ fn : new TextEncoder().encode( f.name ), data : f.data, crc : crc32( f.data ), at : 0 }) );
    const size = enc.reduce( (a, f) => a + 30 + f.fn.length + f.data.length + 46 + f.fn.length, 0 ) + 22;
    const out = new Uint8Array( size );
    const dv = new DataView( out.buffer );
    let o = 0;
    const head = (sig : number, central : boolean, f : typeof enc[number]) => {
        dv.setUint32( o, sig, true ); o += 4;
        if (central) { dv.setUint16( o, 20, true ); o += 2; }
        dv.setUint16( o, 20, true ); dv.setUint16( o + 2, 0, true ); dv.setUint16( o + 4, 0, true );
        dv.setUint16( o + 6, 0, true ); dv.setUint16( o + 8, 0x21, true ); dv.setUint32( o + 10, f.crc, true );
        dv.setUint32( o + 14, f.data.length, true ); dv.setUint32( o + 18, f.data.length, true );
        dv.setUint16( o + 22, f.fn.length, true ); dv.setUint16( o + 24, 0, true ); o += 26;
    };
    for (const f of enc) {
        f.at = o;
        head( 0x04034b50, false, f );
        out.set( f.fn, o ); o += f.fn.length;
        out.set( f.data, o ); o += f.data.length;
    }
    const cd = o;
    for (const f of enc) {
        head( 0x02014b50, true, f );
        dv.setUint16( o, 0, true ); dv.setUint16( o + 2, 0, true ); dv.setUint16( o + 4, 0, true ); dv.setUint32( o + 6, 0, true ); dv.setUint32( o + 10, f.at, true ); o += 14;
        out.set( f.fn, o ); o += f.fn.length;
    }
    dv.setUint32( o, 0x06054b50, true ); dv.setUint16( o + 4, 0, true ); dv.setUint16( o + 6, 0, true );
    dv.setUint16( o + 8, enc.length, true ); dv.setUint16( o + 10, enc.length, true ); dv.setUint32( o + 12, o - cd, true );
    dv.setUint32( o + 16, cd, true ); dv.setUint16( o + 20, 0, true );
    return out;
}

let downloads : any = null;
(window as any).claude?.use?.( "downloads" ).then( (d : any) => { downloads = d; } ).catch( () => {} );

// Saves files: alone as themselves in a plain browser, zipped in the artifact viewer or when there are several.
async function saveFiles( base : string, files : Array<{ name : string, data : Uint8Array, type : string }> ) {
    try {
        if (downloads || files.length > 1) {
            const z = new Blob( [zip( files ).buffer as ArrayBuffer], { type : "application/zip" } );
            if (downloads) { await downloads.save( { filename : base + ".zip", data : z } ); return; }
            link( base + ".zip", z );
            return;
        }
        link( files[0].name, new Blob( [files[0].data.buffer as ArrayBuffer], { type : files[0].type } ) );
    } catch (err) {
        if (err != null && (err as { code? : string }).code == "declined") return;
        $( "status" ).textContent = "The download was not saved.";
        $( "status" ).dataset.state = "bad";
    }
}

function link( name : string, blob : Blob ) {
    const a = document.createElement( "a" );
    a.href = URL.createObjectURL( blob );
    a.download = name;
    a.click();
}

const slug = () => MODELS[current].name.toLowerCase().replace( / /g, "-" );

$( "save" ).addEventListener( "click", () => {
    if (!lastPos) return;
    saveFiles( slug() + "-stl", [{ name : slug() + ".stl", data : binarySTL(), type : "model/stl" }] );
} );

$( "saveStep" ).addEventListener( "click", () => {
    if (!stepReady) return;
    ($( "saveStep" ) as HTMLButtonElement).disabled = true;
    $( "status" ).textContent = "Writing STEP…";
    worker.postMessage( { type : "step", id : ++seq } );
} );

function saveStep( r : { ok : boolean, model : string, message? : string, files? : Array<{ name : string, text : string }> } ) {
    renderExport();
    if (!r.ok || r.files == null || r.files.length == 0 || r.model != current) {
        $( "status" ).textContent = "Could not write STEP" + (r.message ? ": " + r.message : ".");
        $( "status" ).dataset.state = "bad";
        return;
    }
    $( "status" ).textContent = "STEP written: " + r.files.map( f => f.name ).join( ", " );
    saveFiles( slug() + "-step", r.files.map( f => ({ name : f.name, data : new TextEncoder().encode( f.text ), type : "model/step" }) ) );
}

$( "prove" ).addEventListener( "click", () => request( true, true ) );

renderControls();
renderMode();
resize();
request( false );
