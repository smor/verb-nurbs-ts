// Builds the examples and turns them, or a dropped file, into views, off the main thread.
import { ApplianceRecipe, BooleanObjectsRecipe, BrepSolid, FreeformVesselRecipe, Inspect, Make, NurbsCurveData, NurbsSurfaceData, Sweep, TriMesh } from "../src/index.js";
import type { View } from "../src/index.js";

import { EXAMPLES } from "./examples.js";
export { EXAMPLES };

let appliance : ReturnType<typeof ApplianceRecipe.build> | null = null;
const app = () => appliance != null ? appliance : (appliance = ApplianceRecipe.build( { fine : false } ));
let mugCache : ReturnType<typeof BooleanObjectsRecipe.mug> | null = null;
const mug = () => mugCache != null ? mugCache : (mugCache = BooleanObjectsRecipe.mug( {
    fillet : 3, handleSection : [20, 11], handleSwell : 1.25, handleReach : 36, divsU : 32, divsV : 128, offsetTolerance : 0.05 } ));

function trefoil() : NurbsCurveData {
    let pts : Array<Array<number>> = [];
    for (let i = 0; i <= 24; i++) {
        let t = 2 * Math.PI * i / 24;
        pts.push( [20 * (Math.sin( t ) + 2 * Math.sin( 2 * t )), 20 * (Math.cos( t ) - 2 * Math.cos( 2 * t )), -20 * Math.sin( 3 * t )] );
    }
    return Make.rationalInterpCurve( pts, 3 );
}

function cube( o : Array<number>, s : number, m : TriMesh ) {
    let v = [];
    for (let k = 0; k < 8; k++) v.push( m.addVertex( [o[0] + s * (k & 1), o[1] + s * ((k >> 1) & 1), o[2] + s * ((k >> 2) & 1)] ) );
    let q = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    for (let f of q) m.addQuad( v[f[0]], v[f[1]], v[f[2]], v[f[3]] );
}

function build( id : string ) : View {
    switch (id) {
        case "circle": return Inspect.curve( Make.arc( [0, 0, 0], [1, 0, 0], [0, 1, 0], 40, 0, 2 * Math.PI ), "Exact circle" );
        case "trefoil": return Inspect.curve( trefoil(), "Interpolated trefoil" );
        case "superellipse": return Inspect.curve( BooleanObjectsRecipe.superellipse( 50, 32, 3.2, 32 ), "Fitted superellipse" );
        case "rail": return Inspect.curve( mug().handleRail, "Handle rail" );
        case "sphere": return Inspect.surface( Make.sphericalSurface( [0, 0, 0], [0, 0, 1], [1, 0, 0], 40 ), "Sphere" );
        case "torus": return Inspect.surface( Make.revolvedSurface( Make.arc( [60, 0, 0], [1, 0, 0], [0, 0, 1], 22, 0, 2 * Math.PI ), [0, 0, 0], [0, 0, 1], 2 * Math.PI ), "Torus" );
        case "saddle": {
            let cps : Array<Array<Array<number>>> = [];
            for (let i = 0; i < 3; i++) { cps.push( [] ); for (let j = 0; j < 3; j++) { let x = (i - 1) * 50, y = (j - 1) * 50; cps[i].push( [x, y, (x * x - y * y) / 50, 1] ); } }
            return Inspect.surface( new NurbsSurfaceData( 2, 2, [0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1, 1], cps ), "Saddle" );
        }
        case "wall": return Inspect.surface( FreeformVesselRecipe.outerWall( {} ).outerWall, "Vessel wall", { samples : 96 } );
        case "grip": return Inspect.surface( mug().handle.faces[0].surface, "Sculpted grip", { samples : 96 } );
        case "mug": return Inspect.brep( mug().result, "Mug with filleted handle" );
        case "lid": return Inspect.brep( appliance != null ? appliance.lid : ApplianceRecipe.lid( {}, 170, [58, 76], 2.5, 0.6, false ), "Appliance lid" );
        case "cup": return Inspect.brep( appliance != null ? appliance.cup : ApplianceRecipe.cup( {}, 176, 0.6, false ), "Measuring cup" );
        case "base": return Inspect.brep( app().base, "Appliance base" );
        case "pipe": {
            let rail = Make.rationalInterpCurve( [[0, 0, 0], [30, 10, 40], [0, 40, 80], [-30, 10, 120]], 3 );
            return Inspect.brep( BrepSolid.cappedTube( Sweep.pipe( rail, 12 ).surface, [48, 48] ), "Capped pipe" );
        }
        case "baseMesh": return Inspect.mesh( app().base.mesh, "Appliance base mesh" );
        case "open": {
            let src = mug().result.mesh;
            let m = new TriMesh();
            m.vertices = src.vertices.slice();
            m.triangles = src.triangles.filter( (_, k) => k % 997 > 2 );
            return Inspect.mesh( m, "Mesh with holes", { thickness : false } );
        }
        case "nonManifold": {
            let m = new TriMesh();
            cube( [0, 0, 0], 40, m ); cube( [40, 40, 0], 40, m );
            // weld the shared edge
            let key = (p : Array<number>) => p.join( "," );
            let first = new Map<string, number>();
            let map = m.vertices.map( (p, i) => { let k = key( p ); if (!first.has( k )) first.set( k, i ); return first.get( k )!; } );
            m.triangles = m.triangles.map( t => t.map( i => map[i] ) );
            m.compact();
            return Inspect.mesh( m, "Two cubes on one edge", { thickness : false } );
        }
    }
    throw new Error( "Unknown example " + id );
}

// ---------- files ----------

function parseSTL( buf : ArrayBuffer ) : TriMesh {
    let m = new TriMesh();
    let ids = new Map<string, number>();
    let vid = (x : number, y : number, z : number) => {
        let k = x + "," + y + "," + z;
        let i = ids.get( k );
        if (i == null) { i = m.addVertex( [x, y, z] ); ids.set( k, i ); }
        return i;
    };
    let dv = new DataView( buf );
    let n = buf.byteLength >= 84 ? dv.getUint32( 80, true ) : 0;
    if (buf.byteLength == 84 + 50 * n) {
        for (let t = 0; t < n; t++) {
            let o = 84 + 50 * t + 12, v = [];
            for (let k = 0; k < 3; k++) v.push( vid( dv.getFloat32( o + 12 * k, true ), dv.getFloat32( o + 12 * k + 4, true ), dv.getFloat32( o + 12 * k + 8, true ) ) );
            m.addTriangle( v[0], v[1], v[2] );
        }
    } else {
        let txt = new TextDecoder().decode( buf ), v : Array<number> = [];
        for (let mt of txt.matchAll( /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g )) {
            v.push( vid( +mt[1], +mt[2], +mt[3] ) );
            if (v.length == 3) { m.addTriangle( v[0], v[1], v[2] ); v = []; }
        }
    }
    return m;
}

function parseOBJ( txt : string ) : TriMesh {
    let m = new TriMesh();
    for (let line of txt.split( /\r?\n/ )) {
        let p = line.trim().split( /\s+/ );
        if (p[0] == "v") m.addVertex( [+p[1], +p[2], +p[3]] );
        else if (p[0] == "f") {
            let ix = p.slice( 1 ).map( s => { let i = parseInt( s.split( "/" )[0] ); return i < 0 ? m.vertices.length + i : i - 1; } );
            for (let k = 1; k + 1 < ix.length; k++) m.addTriangle( ix[0], ix[k], ix[k + 1] );
        }
    }
    return m;
}

// verb's JSON for a curve or a surface: { degree, knots, controlPoints } or { degreeU, degreeV, knotsU, knotsV, controlPoints },
// with homogeneous control points ([wx, wy, wz, w]) or plain ones ([x, y, z])
function parseJSON( txt : string, name : string ) : View {
    let d = JSON.parse( txt );
    let hom = (p : Array<number>) => p.length == 4 ? p : [p[0], p[1], p[2], 1];
    if (d.degreeU != null) return Inspect.surface( new NurbsSurfaceData( d.degreeU, d.degreeV, d.knotsU, d.knotsV, d.controlPoints.map( (r : Array<Array<number>>) => r.map( hom ) ) ), name );
    if (d.degree != null) return Inspect.curve( new NurbsCurveData( d.degree, d.knots, d.controlPoints.map( hom ) ), name );
    throw new Error( "The JSON is neither a NURBS curve nor a NURBS surface." );
}

function pack( v : View ) {
    let transfer : Array<ArrayBuffer> = [];
    let layer = (l : View["layers"][0]) => {
        let pos = new Float32Array( l.positions ), idx = l.indices != null ? new Uint32Array( l.indices ) : null;
        let pick = l.pick != null ? new Int32Array( l.pick ) : null;
        let fields : Record<string, any> = {};
        for (let k in l.fields ?? {}) { let f = l.fields![k]; fields[k] = { values : new Float32Array( f.values.map( x => isFinite( x ) ? x : NaN ) ), unit : f.unit, symmetric : f.symmetric }; transfer.push( fields[k].values.buffer ); }
        transfer.push( pos.buffer ); if (idx) transfer.push( idx.buffer ); if (pick) transfer.push( pick.buffer );
        return { name : l.name, kind : l.kind, color : l.color, visible : l.visible, dashed : !!l.dashed, itemColors : !!l.itemColors, pos, idx, pick, fields };
    };
    return { msg : { ok : true, title : v.title, kind : v.kind, facts : v.facts, layers : v.layers.map( layer ),
                     items : v.items.map( it => ({ label : it.label, type : it.type, facts : it.facts, overlay : it.overlay.map( layer ) }) ) }, transfer };
}

self.onmessage = (e : MessageEvent) => {
    let q = e.data;
    try {
        let t0 = performance.now();
        let v : View;
        if (q.file != null) {
            let name : string = q.file.name, lower = name.toLowerCase();
            if (lower.endsWith( ".stl" )) v = Inspect.mesh( parseSTL( q.file.data ), name );
            else if (lower.endsWith( ".obj" )) v = Inspect.mesh( parseOBJ( new TextDecoder().decode( q.file.data ) ), name );
            else if (lower.endsWith( ".json" )) v = parseJSON( new TextDecoder().decode( q.file.data ), name );
            else throw new Error( "Drop an .stl or .obj mesh, or a .json NURBS curve or surface." );
        } else v = build( q.example );
        let p = pack( v );
        (p.msg as any).id = q.id; (p.msg as any).ms = performance.now() - t0;
        (self as any).postMessage( p.msg, p.transfer );
    } catch (err) {
        (self as any).postMessage( { id : q.id, ok : false, message : String( (err as Error).message ?? err ) } );
    }
};
