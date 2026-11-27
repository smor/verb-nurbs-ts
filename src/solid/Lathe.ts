import { NurbsCurveData } from "../core/Data.js";
import { Eval } from "../eval/Eval.js";
import { BrepSolid } from "./Brep.js";
import { Extrusion, ProfileSpec } from "./Extrusion.js";
import { Primitives } from "./primitives/Primitives.js";

/**
 * Exact solids of revolution of 507's profiles (#87): the profile drawn in the (r, z) half-plane, x the radius and y
 * the height, turned a full turn about the z axis. Lines become planes, cylinders and cones, arcs spheres and tori,
 * cubics their exact surfaces of revolution (rational in the angle), and a circle a torus.
 *
 * The path is closed, as for an extrusion. A segment along the axis (r = 0 at both ends) is the axis itself and makes
 * no face; the rest must then run from the axis back to it. A path off the axis (a pulley with its bore) makes a solid
 * with a hole through it. Each other segment is one face, named `outer.k` after its index in the path; the seam of
 * every face is in the half-plane y = 0, x > 0.
 */
export class Lathe {

    /** The solid turned from the profile; `degrees` must be 360 (a part turn needs its end caps: not yet). */
    public static solid( profile : ProfileSpec, degrees : number = 360 ) : BrepSolid {
        if (degrees != 360) throw new Error( "Lathe: only a full turn (360 degrees) is made yet" );
        if (profile == null || profile.outer == null) throw new Error( "Lathe: a profile has an outer path" );
        if ((profile.holes ?? []).length > 0) throw new Error( "Lathe: a revolved profile has no holes yet (revolve each hole and subtract it)" );
        const pieces = Extrusion.pieces( profile.outer, "outer" );
        let size = 0;
        for (const q of pieces) for (const hp of q.curve.controlPoints) {
            const x = hp[0] / hp[3], y = hp[1] / hp[3];
            size = Math.max( size, Math.abs( x ), Math.abs( y ) );
            if (x < -1e-9 * (1 + size)) throw new Error( `Lathe: segment ${q.index} of the profile crosses the axis (x < 0): it is drawn with x the radius, x >= 0` );
        }
        const eps = 1e-9 * (1 + size);
        const onAxis = (q : { curve : NurbsCurveData }) => q.curve.controlPoints.every( hp => Math.abs( hp[0] / hp[3] ) <= eps );
        const axis = pieces.map( (q, k) => onAxis( q ) ? k : -1 ).filter( k => k >= 0 );
        if (axis.length > 1) throw new Error( "Lathe: the profile runs along the axis more than once (it would turn into separate solids)" );
        // from the end of the axis segment round to its start: an open chain from the axis to the axis; with none, the
        // closed path as it is
        const chain = axis.length == 0 ? pieces : pieces.slice( axis[0] + 1 ).concat( pieces.slice( 0, axis[0] ) );
        if (axis.length == 0) {
            for (const q of pieces) for (const t of [0, 0.25, 0.5, 0.75, 1])
                if (Math.abs( Eval.rationalCurvePoint( q.curve, t )[0] ) <= eps) throw new Error( `Lathe: the profile touches the axis at segment ${q.index}: it runs along it, or stays off it` );
        }
        const segs = chain.map( q => ({ curve : q.curve, divs : Lathe.divs( q.curve ), corner : true }) );
        // (Primitives.revolve: each segment its own face, as all are corners; the names follow the segments)
        return Primitives.revolve( segs, 64, chain.map( q => "outer." + q.index ) );
    }

    // divisions along a segment: 4 on a line, 16 per span of a curve (a rational arc spans up to a quarter turn: 64 a
    // turn, as round the axis)
    private static divs( c : NurbsCurveData ) : number {
        if (c.degree == 1) return 4;
        const spans = new Set( c.knots ).size - 1;
        return 16 * spans;
    }
}
