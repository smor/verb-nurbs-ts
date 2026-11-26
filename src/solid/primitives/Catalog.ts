import { BrepSolid } from "../Brep.js";
import { Make } from "../../eval/Make.js";
import { Nodes } from "./Nodes.js";
import { Primitives } from "./Primitives.js";
import { Polyhedra } from "./Polyhedra.js";
import { Profiles } from "./Profiles.js";

// One parameter of a catalogued primitive: its name, default, and range (for sliders and checks).
export interface CatalogParameter {
    name : string;
    value : number;
    min : number;
    max : number;
    // a whole number (sides, points)
    integer? : boolean;
    // an angle, in degrees
    degrees? : boolean;
}

// A primitive by name, with its parameters and its builder: what the model's `primitive` feature and the playground
// list. Families and parameters follow docs/primitives.md.
export interface CatalogEntry {
    name : string;
    family : string;
    parameters : Array<CatalogParameter>;
    build : (v : { [name : string] : number }) => BrepSolid;
}

const P = (name : string, value : number, min : number, max : number, extra : { integer? : boolean, degrees? : boolean } = {}) : CatalogParameter =>
    ({ name : name, value : value, min : min, max : max, ...extra });
const RAD = Math.PI / 180;

// The Catalan solids, by the Archimedean solid each is the dual of.
const CATALAN : { [name : string] : string } = {
    triakisTetrahedron : "truncatedTetrahedron", rhombicDodecahedron : "cuboctahedron", triakisOctahedron : "truncatedCube",
    tetrakisHexahedron : "truncatedOctahedron", deltoidalIcositetrahedron : "rhombicuboctahedron", disdyakisDodecahedron : "truncatedCuboctahedron",
    pentagonalIcositetrahedron : "snubCube", rhombicTriacontahedron : "icosidodecahedron", triakisIcosahedron : "truncatedDodecahedron",
    pentakisDodecahedron : "truncatedIcosahedron", deltoidalHexecontahedron : "rhombicosidodecahedron", disdyakisTriacontahedron : "truncatedIcosidodecahedron",
};

// The catalogue of primitives that take only numbers: every family of docs/primitives.md that is built, by name.
export class Catalog {

    public static ENTRIES : Array<CatalogEntry> = Catalog.entries();

    public static entry( name : string ) : CatalogEntry {
        const e = Catalog.ENTRIES.find( x => x.name == name );
        if (e == null) throw new Error( `Catalog: no primitive named "${name}"` );
        return e;
    }

    // The primitive `name` with the given values (missing ones take their defaults; integers are rounded, angles are
    // in degrees). Values outside a parameter's range are refused.
    public static build( name : string, values : { [name : string] : number } = {} ) : BrepSolid {
        const e = Catalog.entry( name );
        for (const k of Object.keys( values )) if (!e.parameters.some( p => p.name == k )) throw new Error( `Catalog: "${name}" has no parameter "${k}"` );
        const v : { [name : string] : number } = {};
        for (const p of e.parameters) {
            let x = values[p.name] != null ? values[p.name] : p.value;
            if (p.integer) x = Math.round( x );
            if (!(x >= p.min && x <= p.max)) throw new Error( `Catalog: "${name}" takes ${p.name} from ${p.min} to ${p.max}, not ${x}` );
            v[p.name] = p.degrees ? x * RAD : x;
        }
        return e.build( v );
    }

    private static entries() : Array<CatalogEntry> {
        const out : Array<CatalogEntry> = [];
        const add = (name : string, family : string, parameters : Array<CatalogParameter>, build : (v : { [name : string] : number }) => BrepSolid) =>
            out.push( { name : name, family : family, parameters : parameters, build : build } );
        const L = 1000; // largest length, mm

        // boxes
        add( "box", "boxes", [P( "width", 40, 0.01, L ), P( "depth", 30, 0.01, L ), P( "height", 20, 0.01, L )], v => Primitives.box( v.width, v.depth, v.height ) );
        add( "cube", "boxes", [P( "edge", 30, 0.01, L )], v => Primitives.cube( v.edge ) );
        add( "wedge", "boxes", [P( "dx", 40, 0.01, L ), P( "dy", 30, 0.01, L ), P( "dz", 20, 0.01, L ), P( "xmin", 10, -L, L ), P( "xmax", 30, -L, L )],
            v => Primitives.wedge( v.dx, v.dy, v.dz, v.xmin, v.xmax ) );

        // prisms and pyramids
        const prismOpts = [P( "twist", 0, -720, 720, { degrees : true } ), P( "top scale", 1, 0, 10 )];
        add( "polygon prism", "prisms", [P( "sides", 6, 3, 64, { integer : true } ), P( "radius", 15, 0.01, L ), P( "height", 30, 0.01, L ), ...prismOpts],
            v => Primitives.prism( Profiles.regular( v.sides, v.radius ), v.height, { twist : v.twist, scale : v["top scale"] } ) );
        add( "star prism", "prisms", [P( "points", 5, 2, 64, { integer : true } ), P( "outer", 20, 0.01, L ), P( "inner", 9, 0.01, L ), P( "height", 10, 0.01, L ), ...prismOpts],
            v => Primitives.prism( Profiles.star( v.points, v.outer, v.inner ), v.height, { twist : v.twist, scale : v["top scale"] } ) );
        add( "rounded rectangle prism", "prisms", [P( "width", 40, 0.01, L ), P( "depth", 25, 0.01, L ), P( "corner", 5, 0, L ), P( "height", 10, 0.01, L )],
            v => Primitives.prism( Profiles.roundedRectangle( v.width, v.depth, v.corner ), v.height ) );
        add( "rounded polygon prism", "prisms", [P( "sides", 6, 3, 64, { integer : true } ), P( "radius", 15, 0.01, L ), P( "corner", 3, 0.01, L ), P( "height", 10, 0.01, L )],
            v => Primitives.prism( Profiles.roundedRegular( v.sides, v.radius, v.corner ), v.height ) );
        add( "stadium prism", "prisms", [P( "length", 30, 0, L ), P( "radius", 8, 0.01, L ), P( "height", 10, 0.01, L )], v => Primitives.prism( Profiles.stadium( v.length, v.radius ), v.height ) );
        add( "heart prism", "prisms", [P( "width", 40, 0.01, L ), P( "height", 8, 0.01, L )], v => Primitives.prism( Profiles.heart( v.width ), v.height ) );
        add( "cross prism", "prisms", [P( "size", 30, 0.01, L ), P( "arm", 10, 0.01, L ), P( "height", 8, 0.01, L )], v => Primitives.prism( Profiles.cross( v.size, v.arm ), v.height ) );
        add( "arrow prism", "prisms", [P( "length", 40, 0.01, L ), P( "shaft", 6, 0.01, L ), P( "head", 16, 0.01, L ), P( "head length", 12, 0.01, L ), P( "height", 5, 0.01, L )],
            v => Primitives.prism( Profiles.arrow( v.length, v.shaft, v.head, v["head length"] ), v.height ) );
        add( "Reuleaux prism", "prisms", [P( "sides", 3, 3, 31, { integer : true } ), P( "width", 30, 0.01, L ), P( "height", 8, 0.01, L )],
            v => Primitives.prism( Profiles.reuleaux( v.sides, v.width ), v.height ) );
        add( "elliptic cylinder", "prisms", [P( "rx", 20, 0.01, L ), P( "ry", 10, 0.01, L ), P( "height", 20, 0.01, L )], v => Primitives.prism( Profiles.ellipse( v.rx, v.ry ), v.height ) );
        add( "cylinder sector", "prisms", [P( "radius", 20, 0.01, L ), P( "angle", 270, 1, 359, { degrees : true } ), P( "height", 10, 0.01, L )],
            v => Primitives.prism( Profiles.sector( v.radius, v.angle ), v.height ) );
        add( "angle section", "sections", [P( "width", 30, 0.01, L ), P( "height", 30, 0.01, L ), P( "thickness", 4, 0.01, L ), P( "length", 60, 0.01, L )],
            v => Primitives.prism( Profiles.angleSection( v.width, v.height, v.thickness ), v.length ) );
        add( "T section", "sections", [P( "width", 30, 0.01, L ), P( "height", 30, 0.01, L ), P( "flange", 4, 0.01, L ), P( "web", 4, 0.01, L ), P( "length", 60, 0.01, L )],
            v => Primitives.prism( Profiles.teeSection( v.width, v.height, v.flange, v.web ), v.length ) );
        add( "I section", "sections", [P( "width", 30, 0.01, L ), P( "height", 40, 0.01, L ), P( "flange", 4, 0.01, L ), P( "web", 3, 0.01, L ), P( "length", 60, 0.01, L )],
            v => Primitives.prism( Profiles.iSection( v.width, v.height, v.flange, v.web ), v.length ) );
        add( "U section", "sections", [P( "width", 30, 0.01, L ), P( "height", 25, 0.01, L ), P( "thickness", 3, 0.01, L ), P( "length", 60, 0.01, L )],
            v => Primitives.prism( Profiles.channelSection( v.width, v.height, v.thickness ), v.length ) );
        add( "pyramid", "pyramids", [P( "sides", 4, 3, 64, { integer : true } ), P( "radius", 20, 0.01, L ), P( "height", 30, 0.01, L ), P( "apex x", 0, -L, L ), P( "apex y", 0, -L, L )],
            v => Primitives.regularPyramid( v.sides, v.radius, v.height, [v["apex x"], v["apex y"]] ) );
        add( "star pyramid", "pyramids", [P( "points", 5, 2, 64, { integer : true } ), P( "outer", 20, 0.01, L ), P( "inner", 9, 0.01, L ), P( "height", 15, 0.01, L )],
            v => Primitives.pyramid( Profiles.star( v.points, v.outer, v.inner ), [0, 0, v.height] ) );
        add( "frustum", "pyramids", [P( "sides", 4, 3, 64, { integer : true } ), P( "radius", 20, 0.01, L ), P( "height", 15, 0.01, L ), P( "top scale", 0.5, 0.01, 10 )],
            v => Primitives.frustum( Profiles.regular( v.sides, v.radius ), v.height, v["top scale"] ) );
        add( "antiprism", "pyramids", [P( "sides", 5, 3, 64, { integer : true } ), P( "radius", 15, 0.01, L )], v => Primitives.antiprism( v.sides, v.radius ) );
        add( "bipyramid", "pyramids", [P( "sides", 5, 3, 64, { integer : true } ), P( "radius", 15, 0.01, L ), P( "up", 20, 0.01, L ), P( "down", 20, 0.01, L )],
            v => Primitives.bipyramid( v.sides, v.radius, v.up, v.down ) );

        // round solids
        add( "cylinder", "round", [P( "radius", 15, 0.01, L ), P( "height", 30, 0.01, L )], v => Primitives.cylinder( v.radius, v.height ) );
        add( "cone", "round", [P( "radius", 15, 0.01, L ), P( "height", 30, 0.01, L ), P( "top radius", 0, 0, L )], v => Primitives.cone( v.radius, v.height, v["top radius"] ) );
        add( "rounded cone", "round", [P( "radius", 15, 0.01, L ), P( "height", 30, 0.01, L ), P( "tip", 3, 0.01, L )], v => Primitives.roundedCone( v.radius, v.height, v.tip ) );
        add( "ogive", "round", [P( "radius", 10, 0.01, L ), P( "length", 30, 0.01, L )], v => Primitives.ogive( v.radius, v.length ) );
        add( "sphere", "round", [P( "radius", 15, 0.01, L )], v => Primitives.sphere( v.radius ) );
        add( "hemisphere", "round", [P( "radius", 15, 0.01, L )], v => Primitives.hemisphere( v.radius ) );
        add( "spherical cap", "round", [P( "radius", 15, 0.01, L ), P( "height", 8, 0.01, 2 * L )], v => Primitives.sphericalCap( v.radius, v.height ) );
        add( "spherical zone", "round", [P( "radius", 15, 0.01, L ), P( "z0", -5, -L, L ), P( "z1", 10, -L, L )], v => Primitives.sphericalZone( v.radius, v.z0, v.z1 ) );
        add( "spherical sector", "round", [P( "radius", 15, 0.01, L ), P( "half angle", 40, 1, 179, { degrees : true } )], v => Primitives.sphericalSector( v.radius, v["half angle"] ) );
        add( "spheroid", "round", [P( "radius", 15, 0.01, L ), P( "height", 20, 0.01, L )], v => Primitives.spheroid( v.radius, v.height ) );
        add( "ellipsoid", "round", [P( "rx", 20, 0.01, L ), P( "ry", 12, 0.01, L ), P( "rz", 8, 0.01, L )], v => Primitives.ellipsoid( v.rx, v.ry, v.rz ) );
        add( "capsule", "round", [P( "radius", 8, 0.01, L ), P( "length", 20, 0, L )], v => Primitives.capsule( v.radius, v.length ) );
        add( "paraboloid", "round", [P( "radius", 15, 0.01, L ), P( "height", 20, 0.01, L )], v => Primitives.paraboloid( v.radius, v.height ) );
        add( "lens", "round", [P( "r1", 25, 0.01, L ), P( "r2", 40, 0.01, L ), P( "diameter", 30, 0.01, L )], v => Primitives.lens( v.r1, v.r2, v.diameter ) );
        add( "torus", "rings", [P( "major", 20, 0.01, L ), P( "minor", 6, 0.01, L ), P( "minor z", 6, 0.01, L )], v => Primitives.torus( v.major, v.minor, v["minor z"] ) );
        add( "tube", "rings", [P( "outer", 15, 0.01, L ), P( "inner", 12, 0.01, L ), P( "height", 30, 0.01, L )], v => Primitives.tube( v.outer, v.inner, v.height ) );
        add( "conical tube", "rings", [P( "outer bottom", 15, 0.01, L ), P( "inner bottom", 12, 0.01, L ), P( "outer top", 9, 0.01, L ), P( "inner top", 6, 0.01, L ), P( "height", 20, 0.01, L )],
            v => Primitives.conicalTube( v["outer bottom"], v["inner bottom"], v["outer top"], v["inner top"], v.height ) );
        add( "egg", "eggs", [P( "radius", 15, 0.01, L ), P( "top", 22, 0.01, L ), P( "bottom", 15, 0.01, L )], v => Primitives.egg( v.radius, v.top, v.bottom ) );
        add( "Moss egg", "eggs", [P( "radius", 15, 0.01, L )], v => Primitives.mossEgg( v.radius ) );

        // polyhedra, by circumradius
        const poly = (name : string, family : string, of : string) =>
            add( name, family, [P( "radius", 20, 0.01, L )], v => Primitives.platonic( of, v.radius ) );
        for (const n of Polyhedra.PLATONIC) poly( n, "Platonic", n );
        for (const n of Polyhedra.ARCHIMEDEAN) poly( n, "Archimedean", n );
        for (const n of Object.keys( CATALAN )) poly( n, "Catalan", "dual:" + CATALAN[n] );
        add( "trapezohedron", "polyhedra", [P( "sides", 5, 3, 32, { integer : true } ), P( "radius", 20, 0.01, L )], v => {
            const t = Polyhedra.trapezohedron( v.sides );
            const R = Math.max( ...t.vertices.map( p => Math.hypot( p[0], p[1], p[2] ) ) );
            return Primitives.polyhedron( { vertices : t.vertices.map( p => p.map( x => x * v.radius / R ) ), faces : t.faces } );
        } );

        // Grasshopper-style builders (Nodes) on simple curves
        const circle = (r : number, z : number) => Make.arc( [0, 0, z], [1, 0, 0], [0, 1, 0], r, 0, 2 * Math.PI );
        add( "lofted vase", "nodes", [P( "bottom", 12, 0.01, L ), P( "waist", 6, 0.01, L ), P( "top", 10, 0.01, L ), P( "height", 30, 0.01, L )],
            v => Nodes.loftSolid( [circle( v.bottom, 0 ), circle( v.waist, v.height / 2 ), circle( v.top, v.height )] ) );
        add( "bent pipe", "nodes", [P( "bend radius", 30, 0.01, L ), P( "radius", 5, 0.01, L ), P( "angle", 90, 1, 359, { degrees : true } ), P( "round caps", 1, 0, 1, { integer : true } )],
            v => Nodes.pipeSolid( Make.arc( [0, 0, 0], [1, 0, 0], [0, 0, 1], v["bend radius"], 0, v.angle ), v.radius, v["round caps"] ? "round" : "flat" ) );
        return out;
    }
}
