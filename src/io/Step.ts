import { NurbsCurveData, NurbsSurfaceData, Point } from "../core/Data.js";
import { BooleanResult } from "../solid/BrepBoolean.js";
import { BrepShell, ShellBuilder, ShellTopology } from "../solid/BrepShell.js";

export interface StepOptions {
    // the product's name in the file (default "verb-nurbs-ts solid")
    name? : string;
    // the model's length uncertainty, which tells a reader how closely edges lie on their faces (default 0.01, in the
    // model's units, taken as millimetres). Edge curves are fitted to half of it.
    tolerance? : number;
}

// The topology recovered from a result's welded mesh (see `ShellTopology`).
export type StepTopology = ShellTopology;

// The B-rep written to a STEP file: the result's exact shell (see `BrepShell`).
export type StepModel = BrepShell;

// STEP export (ISO 10303-21) of a B-rep result as a closed shell of trimmed NURBS faces: a MANIFOLD_SOLID_BREP of
// ADVANCED_FACEs on B_SPLINE_SURFACE_WITH_KNOTS (rational where they are), bounded by EDGE_LOOPs of EDGE_CURVEs that
// neighbouring faces share. These entities are common to AP203, AP214 and AP242; the file names the AP214 schema, the
// one readers support most widely.
//
// The shell is the result's exact topology (`ShellBuilder.fromResult`, in `solid/BrepShell.ts`): faces bounded by loops
// of edges that neighbouring faces share, each edge's curve within half the tolerance of both its faces (plus their gap
// where one is fitted).
export class Step {

    // The B-rep that `write` puts in the file: the result's exact shell (`ShellBuilder.fromResult`).
    public static model( r : BooleanResult, options? : StepOptions ) : StepModel {
        return ShellBuilder.fromResult( r, options );
    }

    // The topology recovered from the result's welded mesh (`ShellBuilder.topology`).
    public static topology( r : BooleanResult ) : StepTopology {
        return ShellBuilder.topology( r );
    }

    public static write( r : BooleanResult, options? : StepOptions ) : string {
        const o = options != null ? options : {};
        return Step.writeShell( Step.model( r, o ), o );
    }

    // A shell written as it is. Its p-curves are not written: readers compute them from the 3D edge curves, as they do
    // for most files.
    public static writeShell( M : BrepShell, options? : StepOptions ) : string {
        const o = options != null ? options : {};
        const tol = o.tolerance != null ? o.tolerance : M.tolerance;
        const name = Step.text( o.name != null ? o.name : "verb-nurbs-ts solid" );
        const w = new StepWriter();

        // geometry: surfaces, edge curves, vertex points
        const vertices = M.vertices.map( p => w.add( `VERTEX_POINT('',${w.add( Step.point( p ) )})` ) );
        const edges = M.edges.map( e => w.add( `EDGE_CURVE('',${vertices[e.start]},${vertices[e.end]},${Step.curve( w, e.curve )},.T.)` ) );

        // topology: faces, shell, solid
        const faces = M.faces.map( F => {
            const surface = Step.surface( w, F.surface, F.closed );
            const bounds = F.loops.map( loop => {
                const oriented = loop.edges.map( ([e, fwd]) => w.add( `ORIENTED_EDGE('',*,*,${edges[e]},${fwd ? ".T." : ".F."})` ) );
                return w.add( `${loop.outer ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',${w.add( `EDGE_LOOP('',(${oriented.join( "," )}))` )},.T.)` );
            } );
            return w.add( `ADVANCED_FACE('',(${bounds.join( "," )}),${surface},${F.sameSense ? ".T." : ".F."})` );
        } );
        const shell = w.add( `CLOSED_SHELL('',(${faces.join( "," )}))` );
        const brep = w.add( `MANIFOLD_SOLID_BREP('${name}',${shell})` );

        // the product structure and units (millimetres) around the shape
        const origin = w.add( Step.point( [0, 0, 0] ) );
        const z = w.add( "DIRECTION('',(0.,0.,1.))" ), x = w.add( "DIRECTION('',(1.,0.,0.))" );
        const axis = w.add( `AXIS2_PLACEMENT_3D('',${origin},${z},${x})` );
        const mm = w.add( "( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )" );
        const rad = w.add( "( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )" );
        const sr = w.add( "( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )" );
        const unc = w.add( `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${Step.real( tol )}),${mm},'distance_accuracy_value','maximum model error')` );
        const ctx = w.add( `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') )` );
        const shape = w.add( `ADVANCED_BREP_SHAPE_REPRESENTATION('',(${axis},${brep}),${ctx})` );
        const appCtx = w.add( "APPLICATION_CONTEXT('automotive design')" );
        w.add( `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})` );
        const prodCtx = w.add( `PRODUCT_CONTEXT('',${appCtx},'mechanical')` );
        const product = w.add( `PRODUCT('${name}','${name}','',(${prodCtx}))` );
        const formation = w.add( `PRODUCT_DEFINITION_FORMATION('','',${product})` );
        const defCtx = w.add( `PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')` );
        const def = w.add( `PRODUCT_DEFINITION('design','',${formation},${defCtx})` );
        const defShape = w.add( `PRODUCT_DEFINITION_SHAPE('','',${def})` );
        w.add( `SHAPE_DEFINITION_REPRESENTATION(${defShape},${shape})` );
        w.add( `PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${product}))` );

        const header = [
            "ISO-10303-21;",
            "HEADER;",
            "FILE_DESCRIPTION(('A closed shell of trimmed NURBS faces'),'2;1');",
            `FILE_NAME('${name}','',(''),(''),'verb-nurbs-ts','verb-nurbs-ts','');`,
            "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
            "ENDSEC;",
            "DATA;",
        ];
        return header.concat( w.lines, ["ENDSEC;", "END-ISO-10303-21;", ""] ).join( "\n" );
    }

    // ---------- entities ----------

    private static surface( w : StepWriter, s : NurbsSurfaceData, closed : [boolean, boolean] ) : string {
        const [mu, ku] = Step.knots( s.knotsU ), [mv, kv] = Step.knots( s.knotsV );
        const pts = s.controlPoints.map( row => "(" + row.map( p => w.add( Step.point( Step.dehomogenize( p ) ) ) ).join( "," ) + ")" );
        const net = "(" + pts.join( "," ) + ")";
        const knots = `(${mu.join( "," )}),(${mv.join( "," )}),(${ku.map( Step.real ).join( "," )}),(${kv.map( Step.real ).join( "," )}),.UNSPECIFIED.`;
        const rational = s.controlPoints.some( row => row.some( p => Math.abs( p[3] - 1 ) > 1e-12 ) );
        const flags = `${closed[0] ? ".T." : ".F."},${closed[1] ? ".T." : ".F."},.F.`;
        if (!rational) return w.add( `B_SPLINE_SURFACE_WITH_KNOTS('',${s.degreeU},${s.degreeV},${net},.UNSPECIFIED.,${flags},${knots})` );
        const weights = "(" + s.controlPoints.map( row => "(" + row.map( p => Step.real( p[3] ) ).join( "," ) + ")" ).join( "," ) + ")";
        return w.add( `( BOUNDED_SURFACE() B_SPLINE_SURFACE(${s.degreeU},${s.degreeV},${net},.UNSPECIFIED.,${flags}) ` +
            `B_SPLINE_SURFACE_WITH_KNOTS(${knots}) GEOMETRIC_REPRESENTATION_ITEM() RATIONAL_B_SPLINE_SURFACE(${weights}) ` +
            "REPRESENTATION_ITEM('') SURFACE() )" );
    }

    private static curve( w : StepWriter, c : NurbsCurveData ) : string {
        const [mult, ks] = Step.knots( c.knots );
        const pts = c.controlPoints.map( p => w.add( Step.point( Step.dehomogenize( p ) ) ) );
        return w.add( `B_SPLINE_CURVE_WITH_KNOTS('',${c.degree},(${pts.join( "," )}),.UNSPECIFIED.,.F.,.F.,(${mult.join( "," )}),(${ks.map( Step.real ).join( "," )}),.UNSPECIFIED.)` );
    }

    // Distinct knots and their multiplicities.
    private static knots( knots : Array<number> ) : [Array<number>, Array<number>] {
        const mult : Array<number> = [], ks : Array<number> = [];
        for (const k of knots) {
            if (ks.length > 0 && Math.abs( k - ks[ks.length - 1] ) <= 1e-14 * Math.max( 1, Math.abs( k ) )) mult[mult.length - 1]++;
            else { ks.push( k ); mult.push( 1 ); }
        }
        return [mult, ks];
    }

    private static dehomogenize( p : Array<number> ) : Point {
        return p.length == 4 ? [p[0] / p[3], p[1] / p[3], p[2] / p[3]] : [p[0], p[1], p[2]];
    }

    private static point( p : Point ) : string {
        return `CARTESIAN_POINT('',(${p.map( Step.real ).join( "," )}))`;
    }

    // A STEP real: always with a decimal point.
    public static real( x : number ) : string {
        if (!isFinite( x )) throw new Error( "Step: a coordinate is not finite" );
        const s = String( Object.is( x, -0 ) ? 0 : x ).toUpperCase();
        if (s.includes( "." )) return s;
        return s.includes( "E" ) ? s.replace( "E", ".E" ) : s + ".";
    }

    // A STEP string: apostrophes doubled, non-ASCII characters dropped.
    private static text( s : string ) : string {
        return s.replace( /[^\x20-\x7e]/g, "" ).replace( /'/g, "''" );
    }
}

// Numbered entity instances, in the order they are added.
class StepWriter {
    public lines : Array<string> = [];
    // adds an instance, and returns its reference ("#n")
    public add( entity : string ) : string {
        this.lines.push( `#${this.lines.length + 1}=${entity};` );
        return "#" + this.lines.length;
    }
}
