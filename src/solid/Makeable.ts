import { Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { MeshBVH } from "./MeshBVH.js";
import { TriMesh } from "./TriMesh.js";

// What a fabrication process can make: its working volume and the thinnest wall it holds reliably (mm).
export interface Machine {
    name : string;
    buildVolume : [number, number, number];
    minWall : number;
}

// The result of `Makeable.check`. A shape is makeable when it is a closed, consistently oriented solid that fits
// the machine and has no wall thinner than the machine allows.
export interface MakeableReport {
    makeable : boolean;
    // one plain sentence per problem found
    issues : Array<string>;
    machine : Machine;
    watertight : boolean;
    genus : number | null;
    volume : number;
    size : [number, number, number];
    fits : boolean;
    wall : {
        // thinnest wall measured, and the 1st percentile (less sensitive to a single sliver)
        min : number;
        p01 : number;
        median : number;
        // share of the surface area where the wall is thinner than the machine's minimum
        thinAreaFraction : number;
    };
    // up to 32 points where the wall is thinner than the machine's minimum, thinnest first
    thinSpots : Array<Point>;
}

// Checks that a mesh can be made: 3D printed, milled or cut. Visual work does not need any of this; run it when
// the shape is meant to be fabricated.
//
// Wall thickness is measured by the inscribed-ray method: from points spread over the surface in proportion to
// area, cast a ray inward along the normal and take the distance to the first surface it meets. It is exact on
// parallel walls and slightly overestimates at sharp inside corners.

export class Makeable {

    public static MACHINES : { [key : string] : Machine } = {
        fdm : { name : "FDM printer (0.4 mm nozzle)", buildVolume : [220, 220, 250], minWall : 0.8 },
        sla : { name : "Resin printer", buildVolume : [145, 145, 175], minWall : 0.5 },
        sls : { name : "SLS nylon service", buildVolume : [300, 300, 300], minWall : 0.7 },
        cnc : { name : "3-axis CNC, 3 mm end mill", buildVolume : [600, 400, 120], minWall : 1.5 },
        ceramic : { name : "Ceramic slip casting", buildVolume : [400, 400, 400], minWall : 2.5 },
    };

    public static check( mesh : TriMesh, machine? : Machine | string, samples : number = 4000 ) : MakeableReport {
        let m : Machine = machine == null ? Makeable.MACHINES.fdm : typeof machine == "string" ? Makeable.MACHINES[machine] : machine;
        if (m == null) throw "Makeable: unknown machine " + machine;
        let issues : Array<string> = [];
        let rep = mesh.checkClosedManifold();
        let volume = mesh.signedVolume();
        let bb = mesh.boundingBox();
        let size : [number, number, number] = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];

        if (!rep.closedManifold) {
            let parts = [];
            if (rep.boundaryEdges > 0) parts.push( rep.boundaryEdges + " open edges" );
            if (rep.badEdges > 0) parts.push( rep.badEdges + " edges shared wrongly" );
            if (rep.degenerateTriangles > 0) parts.push( rep.degenerateTriangles + " degenerate triangles" );
            issues.push( "Not a closed solid: " + parts.join( ", " ) + "." );
        }
        if (rep.closedManifold && volume <= 0) issues.push( "The surface faces inward (negative volume)." );

        // fit, allowing any rotation of the part about z by ordering both sizes
        let a = size.slice( 0, 2 ).sort( (x, y) => x - y ), b = m.buildVolume.slice( 0, 2 ).sort( (x, y) => x - y );
        let fits = a[0] <= b[0] && a[1] <= b[1] && size[2] <= m.buildVolume[2];
        if (!fits) issues.push( "Larger than the " + m.name + " (" + size.map( x => x.toFixed( 0 ) ).join( " x " ) + " mm vs " + m.buildVolume.join( " x " ) + " mm)." );

        let wall = { min : Infinity, p01 : Infinity, median : Infinity, thinAreaFraction : 0 };
        let thinSpots : Array<Point> = [];
        if (rep.closedManifold && volume > 0) {
            let r = Makeable.wallThickness( mesh, samples, m.minWall );
            wall = r.wall; thinSpots = r.thin;
            if (wall.p01 < m.minWall) issues.push( "Walls down to " + wall.p01.toFixed( 2 ) + " mm, thinner than the " + m.minWall + " mm the " + m.name + " holds (" + (100 * wall.thinAreaFraction).toFixed( 1 ) + "% of the surface)." );
        }
        return { makeable : issues.length == 0, issues : issues, machine : m, watertight : rep.closedManifold, genus : rep.genus,
                 volume : volume, size : size, fits : fits, wall : wall, thinSpots : thinSpots };
    }

    public static wallThickness( mesh : TriMesh, samples : number, threshold : number ) {
        let bvh = new MeshBVH( mesh );
        let v = mesh.vertices;
        let areas = mesh.triangles.map( t => Vec.norm( Vec.cross( Vec.sub( v[t[1]], v[t[0]] ), Vec.sub( v[t[2]], v[t[0]] ) ) ) / 2 );
        let total = areas.reduce( (s, x) => s + x, 0 );
        let bb = mesh.boundingBox();
        let eps = Vec.dist( bb.min, bb.max ) * 1e-7;
        // stratified sampling by cumulative area: sample k sits at area (k + 0.5) / samples of the total
        let out : Array<{ t : number, a : number, p : Point }> = [];
        let acc = 0, k = 0;
        let step = total / samples;
        mesh.triangles.forEach( (tri, i) => {
            let a0 = acc; acc += areas[i];
            if (areas[i] <= 0) return;
            let A = v[tri[0]], B = v[tri[1]], C = v[tri[2]];
            let n = Vec.normalized( Vec.cross( Vec.sub( B, A ), Vec.sub( C, A ) ) );
            let inward = Vec.mul( -1, n );
            while ((k + 0.5) * step < acc && k < samples) {
                // a point inside the triangle that varies with k
                let s = ((k + 0.5) * step - a0) / areas[i];
                let r1 = Math.sqrt( Math.min( 1, Math.max( 0, s ) ) ), r2 = ((k * 0.618034) % 1);
                let p = Vec.add( Vec.mul( 1 - r1, A ), Vec.add( Vec.mul( r1 * (1 - r2), B ), Vec.mul( r1 * r2, C ) ) );
                let t = bvh.raycast( Vec.add( p, Vec.mul( eps, inward ) ), inward, 0 );
                if (isFinite( t )) out.push( { t : t + eps, a : step, p : p } );
                k++;
            }
        } );
        if (out.length == 0) return { wall : { min : Infinity, p01 : Infinity, median : Infinity, thinAreaFraction : 0 }, thin : [] as Array<Point> };
        let ts = out.map( o => o.t ).sort( (x, y) => x - y );
        let pick = (q : number) => ts[Math.min( ts.length - 1, Math.floor( q * ts.length ) )];
        let thin = out.filter( o => o.t < threshold ).sort( (x, y) => x.t - y.t );
        return {
            wall : { min : ts[0], p01 : pick( 0.01 ), median : pick( 0.5 ), thinAreaFraction : thin.length / out.length },
            thin : thin.slice( 0, 32 ).map( o => o.p )
        };
    }
}
