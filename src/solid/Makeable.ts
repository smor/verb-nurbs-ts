import { Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { MeshBVH } from "./MeshBVH.js";
import { TriMesh } from "./TriMesh.js";

// What a fabrication process can make: its working volume and the thinnest wall it holds reliably (mm).
export interface Machine {
    name : string;
    buildVolume : [number, number, number];
    minWall : number;
    // whether every cavity must open to the outside, for the uncured resin or loose powder to drain
    drains? : boolean;
    // the steepest overhang the process builds without supports, in degrees from vertical (a note, not an issue:
    // supports can be added)
    overhang? : number;
    // the least draft a moulded part needs to come out of its mould, in degrees (an issue below it, and for undercuts)
    draft? : number;
}

// The result of `Makeable.check`. A shape is makeable when it is a closed, consistently oriented solid that fits
// the machine and has no wall thinner than the machine allows, nor (where the process needs it to drain) any sealed
// void.
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
    // sealed voids: cavities with no way out (an issue where the machine `drains`)
    voids : number;
    // for a machine with an `overhang`: the build direction (of the six axes) that leaves the least area overhanging,
    // and that area, as a share of the surface
    orientation? : { up : Point, overhang : number };
    // for a machine with a `draft`: the pull direction (of the three axes, the mould parted across it) with the least
    // trouble, and the shares of the surface with too little draft and in undercuts
    release? : { pull : Point, lowDraft : number, undercut : number };
    // what is worth knowing but does not stop the part being made (supports needed, ...)
    notes : Array<string>;
}

// Checks that a mesh can be made: 3D printed, milled or cut. Visual work does not need any of this; run it when
// the shape is meant to be fabricated.
//
// Wall thickness is measured by the inscribed-ray method: from points spread over the surface in proportion to
// area, cast a ray inward along the normal and take the distance to the first surface it meets. It is exact on
// parallel walls and slightly overestimates at sharp inside corners.

export class Makeable {

    public static MACHINES : { [key : string] : Machine } = {
        fdm : { name : "FDM printer (0.4 mm nozzle)", buildVolume : [220, 220, 250], minWall : 0.8, overhang : 45 },
        sla : { name : "Resin printer", buildVolume : [145, 145, 175], minWall : 0.5, drains : true, overhang : 45 },
        sls : { name : "SLS nylon service", buildVolume : [300, 300, 300], minWall : 0.7, drains : true },
        cnc : { name : "3-axis CNC, 3 mm end mill", buildVolume : [600, 400, 120], minWall : 1.5 },
        ceramic : { name : "Ceramic slip casting", buildVolume : [400, 400, 400], minWall : 2.5, drains : true, draft : 1 },
    };

    public static check( mesh : TriMesh, machine? : Machine | string, samples : number = 4000 ) : MakeableReport {
        const m : Machine = machine == null ? Makeable.MACHINES.fdm : typeof machine == "string" ? Makeable.MACHINES[machine] : machine;
        if (m == null) throw "Makeable: unknown machine " + machine;
        const issues : Array<string> = [];
        const rep = mesh.checkClosedManifold();
        const volume = mesh.signedVolume();
        const bb = mesh.boundingBox();
        const size : [number, number, number] = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];

        if (!rep.closedManifold) {
            const parts = [];
            if (rep.boundaryEdges > 0) parts.push( rep.boundaryEdges + " open edges" );
            if (rep.badEdges > 0) parts.push( rep.badEdges + " edges shared wrongly" );
            if (rep.degenerateTriangles > 0) parts.push( rep.degenerateTriangles + " degenerate triangles" );
            issues.push( "Not a closed solid: " + parts.join( ", " ) + "." );
        }
        if (rep.closedManifold && volume <= 0) issues.push( "The surface faces inward (negative volume)." );
        // sealed voids: pieces of a closed, outward surface that face in
        const voids = rep.closedManifold && volume > 0 ? mesh.pieces().filter( p => p.volume < 0 ).length : 0;
        if (voids > 0 && m.drains === true) issues.push( voids + " sealed void(s) inside: the " + m.name + "'s material would be trapped (open them to the outside)." );

        // fit, allowing any rotation of the part about z by ordering both sizes
        const a = size.slice( 0, 2 ).sort( (x, y) => x - y ), b = m.buildVolume.slice( 0, 2 ).sort( (x, y) => x - y );
        const fits = a[0] <= b[0] && a[1] <= b[1] && size[2] <= m.buildVolume[2];
        if (!fits) issues.push( "Larger than the " + m.name + " (" + size.map( x => x.toFixed( 0 ) ).join( " x " ) + " mm vs " + m.buildVolume.join( " x " ) + " mm)." );

        let wall = { min : Infinity, p01 : Infinity, median : Infinity, thinAreaFraction : 0 };
        let thinSpots : Array<Point> = [];
        if (rep.closedManifold && volume > 0) {
            const r = Makeable.wallThickness( mesh, samples, m.minWall );
            wall = r.wall; thinSpots = r.thin;
            if (wall.p01 < m.minWall) issues.push( "Walls down to " + wall.p01.toFixed( 2 ) + " mm, thinner than the " + m.minWall + " mm the " + m.name + " holds (" + (100 * wall.thinAreaFraction).toFixed( 1 ) + "% of the surface)." );
        }
        const notes : Array<string> = [];
        let orientation : MakeableReport["orientation"], release : MakeableReport["release"];
        if (rep.closedManifold && volume > 0 && m.overhang != null) {
            orientation = Makeable.orient( mesh, m.overhang );
            if (orientation.overhang > 0.01)
                notes.push( `Needs supports: ${(100 * orientation.overhang).toFixed( 1 )}% of the surface overhangs past ${m.overhang}° even built with ${Makeable.axisName( orientation.up )} up.` );
            else notes.push( `Builds without supports with ${Makeable.axisName( orientation.up )} up.` );
        }
        if (rep.closedManifold && volume > 0 && m.draft != null) {
            release = Makeable.release( mesh, m.draft );
            const along = Makeable.axisName( release.pull ).slice( 1 );
            if (release.lowDraft > 0.01) issues.push( `${(100 * release.lowDraft).toFixed( 1 )}% of the surface has less than ${m.draft}° of draft along ${along}, the best pull: it would stick in the mould.` );
            if (release.undercut > 0.01) issues.push( `${(100 * release.undercut).toFixed( 1 )}% of the surface is undercut along ${along}: a two-part mould cannot release it.` );
        }
        return { makeable : issues.length == 0, issues : issues, machine : m, watertight : rep.closedManifold, genus : rep.genus,
                 volume : volume, size : size, fits : fits, wall : wall, thinSpots : thinSpots, voids : voids,
                 orientation : orientation, release : release, notes : notes };
    }

    private static AXES : Array<Point> = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];

    private static axisName( d : Point ) : string {
        const k = d.findIndex( x => x != 0 );
        return (d[k] > 0 ? "+" : "-") + "xyz"[k];
    }

    // Each triangle's area and unit normal, and the total area.
    private static facets( mesh : TriMesh ) : { area : Array<number>, normal : Array<Point>, total : number } {
        const v = mesh.vertices;
        const area : Array<number> = [], normal : Array<Point> = [];
        let total = 0;
        for (const t of mesh.triangles) {
            const n = Vec.cross( Vec.sub( v[t[1]], v[t[0]] ), Vec.sub( v[t[2]], v[t[0]] ) );
            const l = Vec.norm( n );
            area.push( l / 2 ); normal.push( l > 0 ? Vec.mul( 1 / l, n ) : [0, 0, 0] ); total += l / 2;
        }
        return { area : area, normal : normal, total : total };
    }

    /**
     * The build direction, of the six axes, that leaves the least of the surface overhanging: facing down more
     * steeply than `overhang` degrees from vertical, and not resting on the bed (the lowest plane). The area is a
     * share of the surface.
     */
    public static orient( mesh : TriMesh, overhang : number ) : { up : Point, overhang : number } {
        const f = Makeable.facets( mesh ), v = mesh.vertices;
        const limit = Math.cos( overhang * Math.PI / 180 );
        let best = { up : Makeable.AXES[0], overhang : Infinity };
        for (const up of Makeable.AXES) {
            let low = Infinity, high = -Infinity;
            for (const p of v) { const h = Vec.dot( p, up ); low = Math.min( low, h ); high = Math.max( high, h ); }
            const eps = 1e-6 * Math.max( 1, high - low );
            let area = 0;
            mesh.triangles.forEach( (t, k) => {
                // facing down within `overhang` of straight down
                if (-Vec.dot( f.normal[k], up ) <= limit) return;
                if (t.every( i => Vec.dot( v[i], up ) < low + eps )) return;
                area += f.area[k];
            } );
            if (area / f.total < best.overhang - 1e-12) best = { up : up, overhang : area / f.total };
        }
        return best;
    }

    /**
     * How a part comes out of a two-part mould parted across a pull direction (of the three axes): the share of its
     * surface with less than `draft` degrees of draft (nearly parallel to the pull), and the share undercut (facing a
     * half of the mould with more of the part in the way, by a ray from the facet's centre along the pull). The
     * direction with the least of both together is taken.
     */
    public static release( mesh : TriMesh, draft : number ) : { pull : Point, lowDraft : number, undercut : number } {
        const f = Makeable.facets( mesh ), v = mesh.vertices, bvh = new MeshBVH( mesh );
        const sin = Math.sin( draft * Math.PI / 180 );
        const bb = mesh.boundingBox(), eps = 1e-7 * Vec.dist( bb.min, bb.max );
        let best = { pull : Makeable.AXES[0], lowDraft : Infinity, undercut : Infinity };
        for (const pull of [Makeable.AXES[0], Makeable.AXES[2], Makeable.AXES[4]]) {
            let low = 0, under = 0;
            mesh.triangles.forEach( (t, k) => {
                if (f.area[k] <= 0) return;
                const c = Vec.dot( f.normal[k], pull );
                if (Math.abs( c ) < sin) { low += f.area[k]; return; }
                // the facet leaves the mould half it faces; part of the solid in the way traps it
                const dir = c > 0 ? pull : Vec.mul( -1, pull );
                const o = Vec.mul( 1 / 3, Vec.add( v[t[0]], Vec.add( v[t[1]], v[t[2]] ) ) );
                if (isFinite( bvh.raycast( Vec.add( o, Vec.mul( eps, dir ) ), dir, 0 ) )) under += f.area[k];
            } );
            const r = { pull : pull, lowDraft : low / f.total, undercut : under / f.total };
            if (r.lowDraft + r.undercut < best.lowDraft + best.undercut - 1e-12) best = r;
        }
        return best;
    }

    public static wallThickness( mesh : TriMesh, samples : number, threshold : number ) {
        const bvh = new MeshBVH( mesh );
        const v = mesh.vertices;
        const areas = mesh.triangles.map( t => Vec.norm( Vec.cross( Vec.sub( v[t[1]], v[t[0]] ), Vec.sub( v[t[2]], v[t[0]] ) ) ) / 2 );
        const total = areas.reduce( (s, x) => s + x, 0 );
        const bb = mesh.boundingBox();
        const eps = Vec.dist( bb.min, bb.max ) * 1e-7;
        // stratified sampling by cumulative area: sample k sits at area (k + 0.5) / samples of the total
        const out : Array<{ t : number, a : number, p : Point }> = [];
        let acc = 0, k = 0;
        const step = total / samples;
        mesh.triangles.forEach( (tri, i) => {
            const a0 = acc; acc += areas[i];
            if (areas[i] <= 0) return;
            const A = v[tri[0]], B = v[tri[1]], C = v[tri[2]];
            const n = Vec.normalized( Vec.cross( Vec.sub( B, A ), Vec.sub( C, A ) ) );
            const inward = Vec.mul( -1, n );
            while ((k + 0.5) * step < acc && k < samples) {
                // a point inside the triangle that varies with k
                const s = ((k + 0.5) * step - a0) / areas[i];
                const r1 = Math.sqrt( Math.min( 1, Math.max( 0, s ) ) ), r2 = ((k * 0.618034) % 1);
                const p = Vec.add( Vec.mul( 1 - r1, A ), Vec.add( Vec.mul( r1 * (1 - r2), B ), Vec.mul( r1 * r2, C ) ) );
                const t = bvh.raycast( Vec.add( p, Vec.mul( eps, inward ) ), inward, 0 );
                if (isFinite( t )) out.push( { t : t + eps, a : step, p : p } );
                k++;
            }
        } );
        if (out.length == 0) return { wall : { min : Infinity, p01 : Infinity, median : Infinity, thinAreaFraction : 0 }, thin : [] as Array<Point> };
        const ts = out.map( o => o.t ).sort( (x, y) => x - y );
        const pick = (q : number) => ts[Math.min( ts.length - 1, Math.floor( q * ts.length ) )];
        const thin = out.filter( o => o.t < threshold ).sort( (x, y) => x.t - y.t );
        return {
            wall : { min : ts[0], p01 : pick( 0.01 ), median : pick( 0.5 ), thinAreaFraction : thin.length / out.length },
            thin : thin.slice( 0, 32 ).map( o => o.p )
        };
    }
}
