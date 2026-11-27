// Looks in the 3D view: each face's material (glTF's metallic-roughness: base colour, roughness, metalness, a clear
// coat for a glaze) and the paint over it, bands and friezes in the solid's own coordinates (the angle round its
// vertical axis, and the height as a fraction of its own), drawn by the shader. A coarse clay's grain is a speckle in
// colour and roughness. Nothing here changes what is built (docs/visual-programming.md, "Looks").
import * as THREE from "three";

/** A look as the worker sends it: its values, and the names of the faces it covers. */
export interface Look { id : string; kind : "material" | "band" | "motif"; values : { [k : string] : number | string }; faces : Array<string> }

const MOTIFS = ["band", "meander", "wave", "zigzag", "dots", "rays", "checker"];
const MAX_LAYERS = 8;

// what one face wears: its material (null: the view's own) and the paint over it, bottom layer first
interface Style { material : Look["values"] | null; paint : Array<Look> }

/** Materials the editor offers as presets for a Material node: glTF values for the wares of ancient pottery and more. */
export const PRESETS : Array<{ name : string, values : { color : string, roughness : number, metalness : number, clearcoat : number, grain : number } }> = [
    { name : "Terracotta", values : { color : "#b5653a", roughness : 0.88, metalness : 0, clearcoat : 0, grain : 0.35 } },
    { name : "Impasto", values : { color : "#4b3a2e", roughness : 0.93, metalness : 0, clearcoat : 0, grain : 0.6 } },
    { name : "Black gloss", values : { color : "#17120f", roughness : 0.32, metalness : 0, clearcoat : 0.35, grain : 0.05 } },
    { name : "Red slip", values : { color : "#a8452a", roughness : 0.55, metalness : 0, clearcoat : 0.1, grain : 0.1 } },
    { name : "White slip", values : { color : "#e6dcc8", roughness : 0.8, metalness : 0, clearcoat : 0, grain : 0.2 } },
    { name : "Glaze", values : { color : "#2f6f78", roughness : 0.15, metalness : 0, clearcoat : 0.9, grain : 0 } },
    { name : "Bronze", values : { color : "#8c6a3f", roughness : 0.4, metalness : 1, clearcoat : 0, grain : 0.1 } },
];

const GLSL_COMMON = /* glsl */`
varying vec3 vObj;
uniform int uLayers;
uniform int uKind[${MAX_LAYERS}];
uniform vec3 uPaint[${MAX_LAYERS}];
uniform vec3 uSpan[${MAX_LAYERS}];
uniform vec4 uBox;
uniform float uGrain;
float lookHash( vec3 p ) { return fract( sin( dot( p, vec3( 127.1, 311.7, 74.7 ) ) ) * 43758.5453 ); }
float lookNoise( vec3 p ) {
    vec3 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( mix( lookHash( i ), lookHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( lookHash( i + vec3( 0, 1, 0 ) ), lookHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                mix( mix( lookHash( i + vec3( 0, 0, 1 ) ), lookHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( lookHash( i + vec3( 0, 1, 1 ) ), lookHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
// a Greek key, 6 cells wide and 5 high: the line's cells, bottom row first
float lookMeander( float u, float v ) {
    int x = int( floor( u * 6.0 ) ), y = int( floor( v * 5.0 ) );
    int rows[5] = int[5]( 63, 33, 45, 41, 47 );
    return float( ( rows[clamp( y, 0, 4 )] >> ( 5 - clamp( x, 0, 5 ) ) ) & 1 );
}
// how much of a motif covers (u, v): u across one repeat, v across the band, both 0 to 1
float lookMotif( int kind, float u, float v ) {
    if (kind == 0) return 1.0;
    if (kind == 1) return lookMeander( u, v );
    if (kind == 2) return 1.0 - smoothstep( 0.08, 0.12, abs( v - 0.5 - 0.3 * sin( 6.2831853 * u ) ) );
    if (kind == 3) return 1.0 - smoothstep( 0.08, 0.12, abs( v - 0.15 - 0.7 * abs( 2.0 * u - 1.0 ) ) );
    if (kind == 4) return 1.0 - smoothstep( 0.28, 0.32, length( vec2( u - 0.5, v - 0.5 ) ) );
    if (kind == 5) return step( v, 1.0 - abs( 2.0 * u - 1.0 ) );
    if (kind == 6) return mod( floor( u * 2.0 ) + floor( v * 2.0 ), 2.0 );
    return 0.0;
}
vec3 lookPaint( vec3 base ) {
    float h = ( vObj.z - uBox.z ) / max( uBox.w - uBox.z, 1e-6 );
    float a = atan( vObj.y - uBox.y, vObj.x - uBox.x ) / 6.2831853 + 0.5;
    if (uGrain > 0.0) {
        float n = lookNoise( vObj * 1.7 ) * 0.6 + lookNoise( vObj * 6.0 ) * 0.4;
        base *= 1.0 - uGrain * 0.35 * ( n - 0.5 ) - uGrain * 0.25 * step( 0.92, lookHash( floor( vObj * 3.0 ) ) );
    }
    for (int i = 0; i < ${MAX_LAYERS}; i++) {
        if (i >= uLayers) break;
        // a band that reaches the foot or the top takes in the flat face there (no flicker at exactly 0 or 1)
        float f = uSpan[i].x <= 0.001 ? -1.0 : uSpan[i].x, t = uSpan[i].y >= 0.999 ? 2.0 : uSpan[i].y;
        if (h < f || h > t) continue;
        float m = lookMotif( uKind[i], fract( a * uSpan[i].z ), clamp( ( h - uSpan[i].x ) / max( uSpan[i].y - uSpan[i].x, 1e-6 ), 0.0, 1.0 ) );
        base = mix( base, uPaint[i], m );
    }
    return base;
}
`;

// a material for one style: physical, with the paint and the grain in its shader
function material( style : Style, box : THREE.Box3, fallback : { color : string, roughness : number, metalness : number } ) : THREE.MeshPhysicalMaterial {
    const v = style.material;
    const m = new THREE.MeshPhysicalMaterial( {
        color : new THREE.Color( String( v?.color ?? fallback.color ) ),
        roughness : Number( v?.roughness ?? fallback.roughness ), metalness : Number( v?.metalness ?? fallback.metalness ),
        clearcoat : Number( v?.clearcoat ?? 0 ), clearcoatRoughness : 0.08, vertexColors : true,
    } );
    const layers = style.paint.slice( -MAX_LAYERS );
    const c = new THREE.Vector3(), s = new THREE.Vector3();
    box.getCenter( c ); box.getSize( s );
    const uniforms = {
        uLayers : { value : layers.length },
        uKind : { value : Array.from( { length : MAX_LAYERS }, ( _, i ) => layers[i] == null ? 0 : layers[i].kind == "band" ? 0 : Math.max( 1, MOTIFS.indexOf( String( layers[i].values.motif ) ) ) ) },
        uPaint : { value : Array.from( { length : MAX_LAYERS }, ( _, i ) => { const col = new THREE.Color( String( layers[i]?.values.color ?? "#000000" ) ); return new THREE.Vector3( col.r, col.g, col.b ); } ) },
        uSpan : { value : Array.from( { length : MAX_LAYERS }, ( _, i ) => new THREE.Vector3( Number( layers[i]?.values.from ?? 0 ), Number( layers[i]?.values.to ?? 0 ), Math.max( 1, Math.round( Number( layers[i]?.values.count ?? 1 ) ) ) ) ) },
        uBox : { value : new THREE.Vector4( c.x, c.y, box.min.z, box.max.z ) },
        uGrain : { value : Number( v?.grain ?? 0 ) },
    };
    m.onBeforeCompile = shader => {
        Object.assign( shader.uniforms, uniforms );
        shader.vertexShader = shader.vertexShader.replace( "#include <common>", "#include <common>\nvarying vec3 vObj;" )
            .replace( "#include <begin_vertex>", "#include <begin_vertex>\nvObj = position;" );
        shader.fragmentShader = shader.fragmentShader.replace( "#include <common>", "#include <common>\n" + GLSL_COMMON )
            .replace( "#include <color_fragment>", "diffuseColor.rgb = lookPaint( diffuseColor.rgb );\n#include <color_fragment>" )
            .replace( "#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = clamp( roughnessFactor + uGrain * 0.2 * ( lookNoise( vObj * 2.3 ) - 0.5 ), 0.04, 1.0 );" );
    };
    // one program per number of layers and kinds is enough: the values are uniforms
    m.customProgramCacheKey = () => "look";
    return m;
}

/**
 * Dresses a geometry (from the editor's `toGeometry`: a face index per triangle in `userData.face`, names in
 * `userData.names`) in its looks: its triangles regrouped by what they wear, one material per group. Without looks,
 * the view's own material. The triangles' faces (`userData.face`) are reordered with them, so picking still works.
 */
export function dress( g : THREE.BufferGeometry, looks : Array<Look> | undefined, plain : THREE.Material,
    fallback : { color : string, roughness : number, metalness : number } ) : THREE.Material | Array<THREE.Material> {
    for (const m of (g.userData.looks ?? []) as Array<THREE.Material>) m.dispose();
    g.userData.looks = [];
    g.clearGroups();
    const u = g.userData as { face? : Uint32Array, names? : Array<string> };
    const index = g.getIndex();
    if (looks == null || looks.length == 0 || u.face == null || u.names == null || index == null) return plain;
    // each face's style: the last material over it, and every paint over it in order
    const styleOf = new Map<string, Style>();
    for (const l of looks) for (const f of l.faces) {
        const s = styleOf.get( f ) ?? { material : null, paint : [] };
        if (l.kind == "material") s.material = l.values; else s.paint.push( l );
        styleOf.set( f, s );
    }
    const keyOf = ( s : Style | undefined ) => s == null ? "" : JSON.stringify( [s.material, s.paint.map( p => p.values )] );
    const faceKey = u.names.map( n => keyOf( styleOf.get( n ) ) );
    const keys = [...new Set( faceKey )];
    // the triangles in groups, a group per style
    const tri = u.face.length, idx = index.array, order = Array.from( { length : tri }, ( _, t ) => t );
    const k = ( t : number ) => keys.indexOf( faceKey[u.face![t]] );
    const rank = order.map( k );
    order.sort( (a, b) => rank[a] - rank[b] || a - b );
    const out = new Uint32Array( idx.length ), face = new Uint32Array( tri );
    order.forEach( ( t, i ) => { out[3 * i] = idx[3 * t]; out[3 * i + 1] = idx[3 * t + 1]; out[3 * i + 2] = idx[3 * t + 2]; face[i] = u.face![t]; } );
    g.setIndex( new THREE.BufferAttribute( out, 1 ) );
    u.face = face;
    if (g.boundingBox == null) g.computeBoundingBox();
    const mats : Array<THREE.Material> = keys.map( key => key == "" ? plain : material( styleOf.get( u.names![faceKey.indexOf( key )] )!, g.boundingBox!, fallback ) );
    let start = 0;
    keys.forEach( ( _, m ) => { const n = order.filter( t => rank[t] == m ).length; g.addGroup( start * 3, n * 3, m ); start += n; } );
    g.userData.looks = mats.filter( m => m !== plain );
    return mats;
}
