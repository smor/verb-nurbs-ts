import { NurbsCurveData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "../eval/Analyze.js";
import { Eval } from "../eval/Eval.js";
import { Fit } from "../eval/Fit.js";
import { BooleanResult } from "../solid/BrepBoolean.js";
import { SurfaceLoops } from "../solid/SurfaceLoops.js";
import { SeamCut, SeamEdge, SeamFace, SeamLoop, Seams } from "./Seams.js";

export interface StepOptions {
    // the product's name in the file (default "verb-nurbs-ts solid")
    name? : string;
    // the model's length uncertainty, which tells a reader how closely edges lie on their faces (default 0.01, in the
    // model's units, taken as millimetres). Edge curves are fitted to half of it.
    tolerance? : number;
    // write each edge's curves on its faces' surfaces (p-curves) as well (default true): some readers need them
    pcurves? : boolean;
}

// The topology of a B-rep result, recovered from its welded mesh: the edges between faces, as chains of mesh vertices,
// and each face's boundary loops as cycles of oriented edges.
export interface StepTopology {
    // chain end points (mesh vertex indices): where three or more faces meet, or one point of a closed chain
    vertices : Array<number>;
    // each edge: its chain of mesh vertices (first and last are in `vertices`; equal for a closed chain), and the faces
    // on its left and right when walked from first to last, seen from outside
    edges : Array<{ chain : Array<number>, left : number, right : number }>;
    // for each face, its loops: lists of [edge, forward] in order round the loop, the face on the left
    loops : Array<Array<Array<[number, boolean]>>>;
}

// The B-rep written to a STEP file (see `Step.model`).
export interface StepModel {
    vertices : Array<Point>;
    // each edge's curve, and its curves in the parameters of its left and right faces' surfaces (p-curves, 2D, in the
    // same parameter as the curve); a seam's are on the low and the high side of its face's cut
    edges : Array<{ curve : NurbsCurveData, start : number, end : number, left : number, right : number, pcurves : [NurbsCurveData, NurbsCurveData] }>;
    faces : Array<{ surface : NurbsSurfaceData, sameSense : boolean, closed : [boolean, boolean], loops : Array<SeamLoop> }>;
}

// STEP export (ISO 10303-21) of a B-rep result as a closed shell of trimmed NURBS faces: a MANIFOLD_SOLID_BREP of
// ADVANCED_FACEs on B_SPLINE_SURFACE_WITH_KNOTS (rational where they are), bounded by EDGE_LOOPs of EDGE_CURVEs that
// neighbouring faces share. These entities are common to AP203, AP214 and AP242; the file names the AP214 schema, the
// one readers support most widely.
//
// The faces are the result's surfaces (operands' faces, fillets, corner patches). The edges are recovered from the
// welded mesh, where neighbouring faces share their boundary vertices exactly: each run of mesh edges between the same
// two faces, from a point where three or more faces meet to the next, is one edge. Its curve follows the faces'
// intersection, not the mesh: the run is refined by alternating projections onto the two surfaces until its chords
// stray from them by less than a quarter of the tolerance, then a cubic B-spline is fitted to it within another
// quarter, so the curve lies within half the tolerance of both faces wherever they meet (where they do not quite
// meet, as a fitted patch beside an exact one, within half the tolerance plus their gap). Edges are shared by
// construction, so the shell is closed exactly when the mesh is (`report.manifold.closedManifold`). Each edge also
// carries its curves in its two faces' parameters (p-curves), which some readers need.
export class Step {

    // The B-rep that `write` puts in the file: its vertices, its edges (each a curve from its start vertex to its end
    // vertex, with the faces on its left and right; a seam has the same face on both), and its faces (each surface,
    // whether its normal points out of the solid, and its loops of oriented edges, the face on their left, one of
    // them outer where the surface has a parameter rectangle to bound). Faces on surfaces closed in one direction
    // are cut along their seams (`Seams`).
    public static model( r : BooleanResult, options? : StepOptions ) : StepModel {
        const tol = options != null && options.tolerance != null ? options.tolerance : 0.01;
        const T = Step.topology( r );
        const faces : Array<SeamFace> = r.faces.map( (f, fi) => ({ surface : f.surface, sameSense : Step.sameSense( r, fi ), project : Step.projector( f.surface ) }) );
        const on = faces.map( F => (p : Point) => F.project( p ).p );
        const onBoth = (e : { left : number, right : number }, p : Point) => { let q = p; for (let k = 0; k < 4; k++) q = on[e.right]( on[e.left]( q ) ); return q; };
        const vertices : Array<Point> = [], index = new Map<number, number>();
        const vertexOf = (m : number) => {
            let k = index.get( m );
            if (k == null) { k = vertices.length; vertices.push( r.mesh.vertices[m] ); index.set( m, k ); }
            return k;
        };
        const edges : Array<SeamEdge> = T.edges.map( e => ({
            pts : Step.refine( e.chain.map( i => r.mesh.vertices[i] ), on[e.left], on[e.right], 0.25 * tol ),
            start : vertexOf( e.chain[0] ), end : vertexOf( e.chain[e.chain.length - 1] ), left : e.left, right : e.right,
        }) );
        const cut = Seams.cut( faces, edges, vertices, T.loops, tol, onBoth );
        // only the vertices that edges use, renumbered in order
        const used = new Map<number, number>(), vs : Array<Point> = [];
        const keep = (v : number) => { let k = used.get( v ); if (k == null) { k = vs.length; vs.push( vertices[v] ); used.set( v, k ); } return k; };
        return {
            vertices : vs,
            edges : cut.edges.map( e => {
                const curve = e.curve != null ? e.curve : Step.fitChain( e.pts, 0.25 * tol );
                // the ends exactly at the vertices (clamped: the end control points are the ends)
                const cp = curve.controlPoints, a = vertices[e.start], b = vertices[e.end];
                const at = (p : Point, w : number) => cp[0].length == 4 ? [p[0] * w, p[1] * w, p[2] * w, w] : p.slice();
                cp[0] = at( a, cp[0].length == 4 ? cp[0][3] : 1 );
                cp[cp.length - 1] = at( b, cp[0].length == 4 ? cp[cp.length - 1][3] : 1 );
                const pcurves = (e.seam != null
                    ? [Step.seamCurve( faces[e.left], cut.cuts[e.left] as SeamCut, e.seam, e.seam.lowForward ), Step.seamCurve( faces[e.left], cut.cuts[e.left] as SeamCut, e.seam, !e.seam.lowForward )]
                    : [Step.pcurve( curve, faces[e.left], cut.cuts[e.left], tol ), Step.pcurve( curve, faces[e.right], cut.cuts[e.right], tol )]) as [NurbsCurveData, NurbsCurveData];
                return { curve : curve, start : keep( e.start ), end : keep( e.end ), left : e.left, right : e.right, pcurves : pcurves };
            } ),
            faces : faces.map( (F, fi) => ({
                surface : F.surface, sameSense : F.sameSense,
                closed : [Analyze.isRationalSurfaceClosed( F.surface, true ), Analyze.isRationalSurfaceClosed( F.surface, false )] as [boolean, boolean],
                loops : cut.loops[fi],
            }) ),
        };
    }

    public static write( r : BooleanResult, options? : StepOptions ) : string {
        const o = options != null ? options : {};
        const tol = o.tolerance != null ? o.tolerance : 0.01;
        const name = Step.text( o.name != null ? o.name : "verb-nurbs-ts solid" );
        const M = Step.model( r, o );
        const w = new StepWriter();

        // geometry: surfaces, edge curves (with their p-curves), vertex points
        const surfaces = M.faces.map( F => Step.surface( w, F.surface, F.closed ) );
        const vertices = M.vertices.map( p => w.add( `VERTEX_POINT('',${w.add( Step.point( p ) )})` ) );
        const uvContext = o.pcurves === false ? "" : w.add( "( GEOMETRIC_REPRESENTATION_CONTEXT(2) PARAMETRIC_REPRESENTATION_CONTEXT() REPRESENTATION_CONTEXT('2D SPACE','') )" );
        const edges = M.edges.map( e => {
            let geometry = Step.curve( w, e.curve );
            if (o.pcurves !== false) {
                const pc = [e.left, e.right].map( (f, k) => {
                    const c2 = Step.curve( w, e.pcurves[k], 2 );
                    return w.add( `PCURVE('',${surfaces[f]},${w.add( `DEFINITIONAL_REPRESENTATION('',(${c2}),${uvContext})` )})` );
                } );
                geometry = w.add( `${e.left == e.right ? "SEAM_CURVE" : "SURFACE_CURVE"}('',${geometry},(${pc.join( "," )}),.CURVE_3D.)` );
            }
            return w.add( `EDGE_CURVE('',${vertices[e.start]},${vertices[e.end]},${geometry},.T.)` );
        } );

        // topology: faces, shell, solid
        const faces = M.faces.map( (F, fi) => {
            const surface = surfaces[fi];
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

    // ---------- topology from the welded mesh ----------

    public static topology( r : BooleanResult ) : StepTopology {
        const m = r.mesh;
        // directed boundary edges a -> b: on the face of the triangle that has them in its winding (outward), so that
        // face is on the left; the face across is on the right
        const across = new Map<string, number>(); // "a,b" -> face of the triangle with a -> b
        m.triangles.forEach( (t, k) => {
            for (let x = 0; x < 3; x++) across.set( t[x] + "," + t[(x + 1) % 3], r.faceOf[k] );
        } );
        const out = new Map<number, Array<{ to : number, left : number, right : number }>>();
        const facesAt = new Map<number, Set<number>>();
        for (const [key, left] of across) {
            const [a, b] = key.split( "," ).map( Number );
            const right = across.get( b + "," + a );
            if (right == null) throw new Error( "Step: the mesh is not closed (edge " + a + "-" + b + " has one side)" );
            if (right == left) continue;
            let l = out.get( a ); if (l == null) out.set( a, l = [] );
            l.push( { to : b, left : left, right : right } );
            for (const v of [a, b]) { let s = facesAt.get( v ); if (s == null) facesAt.set( v, s = new Set() ); s.add( left ); s.add( right ); }
        }
        // chains break where three or more faces meet, or where two faces touch at a vertex more than once (more than
        // two boundary edges there)
        const isEnd = (v : number) => (facesAt.get( v ) as Set<number>).size >= 3 || new Set( (out.get( v ) as Array<{ to : number }>).map( s => s.to ) ).size != 2;
        const vertices : Array<number> = [];
        const vertexSet = new Set<number>();
        const addVertex = (v : number) => { if (!vertexSet.has( v )) { vertexSet.add( v ); vertices.push( v ); } };
        const used = new Set<string>();
        const edges : StepTopology["edges"] = [];
        // the directed edge -> (edge index, forward)
        const owner = new Map<string, [number, boolean]>();
        const walk = (a : number, first : { to : number, left : number, right : number }) => {
            const chain = [a];
            let cur = a, step = first;
            for (;;) {
                used.add( cur + "," + step.to ); used.add( step.to + "," + cur );
                chain.push( step.to );
                cur = step.to;
                if (isEnd( cur ) || cur == a) break;
                const next = (out.get( cur ) as Array<{ to : number, left : number, right : number }>).find( s => s.left == first.left && s.right == first.right && !used.has( cur + "," + s.to ) );
                if (next == null) break;
                step = next;
            }
            const e = edges.length;
            edges.push( { chain : chain, left : first.left, right : first.right } );
            addVertex( chain[0] ); addVertex( chain[chain.length - 1] );
            for (let k = 0; k + 1 < chain.length; k++) {
                owner.set( chain[k] + "," + chain[k + 1], [e, true] );
                owner.set( chain[k + 1] + "," + chain[k], [e, false] );
            }
        };
        // open chains from their ends first, then the closed ones that are left
        for (const [a, steps] of out) if (isEnd( a )) for (const s of steps) if (!used.has( a + "," + s.to )) walk( a, s );
        for (const [a, steps] of out) for (const s of steps) if (!used.has( a + "," + s.to )) walk( a, s );

        // loops: for each face, follow its oriented edges (face on the left) end to start
        const loops : StepTopology["loops"] = r.faces.map( () => [] );
        const startsAt = new Map<string, Array<[number, boolean]>>(); // face:vertex -> oriented edges leaving it
        edges.forEach( (e, k) => {
            const first = e.chain[0], last = e.chain[e.chain.length - 1];
            for (const [face, fwd, from] of [[e.left, true, first], [e.right, false, last]] as Array<[number, boolean, number]>) {
                const key = face + ":" + from;
                let l = startsAt.get( key ); if (l == null) startsAt.set( key, l = [] );
                l.push( [k, fwd] );
            }
        } );
        const taken = new Set<string>();
        edges.forEach( (e, k) => {
            for (const [face, fwd] of [[e.left, true], [e.right, false]] as Array<[number, boolean]>) {
                if (taken.has( k + ":" + fwd )) continue;
                const loop : Array<[number, boolean]> = [];
                let cur : [number, boolean] = [k, fwd];
                for (let guard = 0; guard <= edges.length; guard++) {
                    taken.add( cur[0] + ":" + cur[1] );
                    loop.push( cur );
                    const c = edges[cur[0]].chain;
                    const end = cur[1] ? c[c.length - 1] : c[0];
                    const nexts = (startsAt.get( face + ":" + end ) ?? []).filter( x => !taken.has( x[0] + ":" + x[1] ) );
                    if (nexts.length == 0) break;
                    cur = nexts[0];
                }
                loops[face].push( loop );
            }
        } );
        return { vertices : vertices, edges : edges, loops : loops };
    }

    // ---------- geometry ----------

    // The point of a surface nearest p: from the nearest of a grid of samples, by Newton's method.
    private static projector( s : NurbsSurfaceData ) : (p : Point) => { uv : UV, p : Point } {
        const d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
        const periodic : [boolean, boolean] = [Analyze.isRationalSurfaceClosed( s, true ), Analyze.isRationalSurfaceClosed( s, false )];
        const seeds : Array<{ uv : UV, p : Point }> = [];
        const g = 16;
        for (let i = 0; i <= g; i++) for (let j = 0; j <= g; j++) {
            const uv : UV = [d[0] + (d[1] - d[0]) * i / g, d[2] + (d[3] - d[2]) * j / g];
            seeds.push( { uv : uv, p : Eval.rationalSurfacePoint( s, uv[0], uv[1] ) } );
        }
        const span = [d[1] - d[0], d[3] - d[2]];
        const inDomain = (x : number, c : number) => {
            if (!periodic[c]) return Math.max( d[2 * c], Math.min( d[2 * c + 1], x ) );
            const t = (x - d[2 * c]) / span[c];
            return d[2 * c] + (t - Math.floor( t )) * span[c];
        };
        return (p : Point) => {
            let best = seeds[0], bd = Vec.distSquared( best.p, p );
            for (const x of seeds) { const dd = Vec.distSquared( x.p, p ); if (dd < bd) { best = x; bd = dd; } }
            // closer, on finer grids round the nearest sample (Newton alone can run off along a surface of revolution)
            let h = [span[0] / g, span[1] / g];
            for (let round = 0; round < 4; round++) {
                const c = best;
                for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
                    const uv : UV = [inDomain( c.uv[0] + i * h[0] / 2, 0 ), inDomain( c.uv[1] + j * h[1] / 2, 1 )];
                    const q = Eval.rationalSurfacePoint( s, uv[0], uv[1] ), dd = Vec.distSquared( q, p );
                    if (dd < bd) { best = { uv : uv, p : q }; bd = dd; }
                }
                h = [h[0] / 2.5, h[1] / 2.5];
            }
            const uv = SurfaceLoops.project( { surface : s, periodic : periodic }, p, best.uv );
            if (uv == null) return { uv : best.uv, p : best.p };
            const q = Eval.rationalSurfacePoint( s, uv[0], uv[1] );
            return Vec.distSquared( q, p ) <= bd ? { uv : uv, p : q } : { uv : best.uv, p : best.p };
        };
    }

    // A chain of points on the curve where two faces meet, made dense enough to follow it: between two points whose
    // chord strays from the faces by more than `tol` at its middle, a point is put on the faces (projected onto one,
    // then the other, a few times: alternating projections onto the two surfaces), and so on, down to 1/64 of the
    // first spacing.
    private static refine( pts : Array<Point>, onA : (p : Point) => Point, onB : (p : Point) => Point, tol : number ) : Array<Point> {
        const onBoth = (p : Point) => { let q = p; for (let k = 0; k < 4; k++) q = onB( onA( q ) ); return q; };
        const out : Array<Point> = [pts[0]];
        const split = (a : Point, b : Point, depth : number) => {
            const mid = Vec.mul( 0.5, Vec.add( a, b ) );
            const m = onBoth( mid );
            if (depth < 6 && Vec.dist( m, mid ) > tol) { split( a, m, depth + 1 ); split( m, b, depth + 1 ); }
            else out.push( b );
        };
        for (let k = 0; k + 1 < pts.length; k++) split( pts[k], pts[k + 1], 0 );
        return out;
    }

    // A cubic B-spline through a chain of points, within `tol` of the polyline (its ends exact).
    private static fitChain( pts : Array<Point>, tol : number ) : NurbsCurveData {
        if (pts.length <= 3) return Fit.curve( pts, Math.min( 3, pts.length - 1 ) );
        const u = Fit.chordLengthParams( pts );
        const at = (s : number) : Point => {
            let k = 0;
            while (k + 2 < u.length && u[k + 1] < s) k++;
            const du = u[k + 1] - u[k], f = du > 0 ? Math.max( 0, Math.min( 1, (s - u[k]) / du ) ) : 0;
            return Vec.add( Vec.mul( 1 - f, pts[k] ), Vec.mul( f, pts[k + 1] ) );
        };
        // start from a knot per few points, so the fit follows the chain's spacing
        const spans = Math.max( 1, Math.min( 64, Math.floor( pts.length / 4 ) ) );
        const knots = [0, 0, 0, 0];
        for (let k = 1; k < spans; k++) knots.push( u[Math.round( k * (pts.length - 1) / spans )] );
        knots.push( 1, 1, 1, 1 );
        return Fit.approximateCurve( at, 3, knots, tol, 8 ).curve;
    }

    // A seam edge's p-curve on one side of its face's cut: the line along the seam, at the domain's start (low) or
    // end, from w0 to w1 as the edge's curve runs from 0 to 1.
    private static seamCurve( F : SeamFace, cut : SeamCut, seam : { w0 : number, w1 : number }, low : boolean ) : NurbsCurveData {
        const c = low ? cut.c0 : cut.c0 + cut.per;
        const at = (w : number) => (cut.d == 0 ? [c, w] : [w, c]);
        return new NurbsCurveData( 1, [0, 0, 1, 1], [at( seam.w0 ), at( seam.w1 )].map( p => [p[0], p[1], 1] ) );
    }

    // An edge's p-curve on a face: the curve's points projected onto the surface, as a cubic B-spline in the same
    // parameter, within a small fraction of the tolerance once mapped onto the surface. Along a closed direction the
    // parameters are unwrapped, and on a face cut at its seam they are kept inside its domain.
    private static pcurve( c : NurbsCurveData, F : SeamFace, cut : SeamCut | null, tol : number ) : NurbsCurveData {
        const s = F.surface;
        const dom = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
        const per = [dom[1] - dom[0], dom[3] - dom[2]];
        const closed = [Analyze.isRationalSurfaceClosed( s, true ), Analyze.isRationalSurfaceClosed( s, false )];
        const k0 = c.knots[0], k1 = c.knots[c.knots.length - 1], N = 64;
        // where the surface collapses (a pole), one parameter says nothing: the neighbours' is used
        const scale = Math.max( per[0], per[1], 1e-300 );
        const degenerate = (uv : UV) => {
            const d = Eval.rationalSurfaceDerivatives( s, uv[0], uv[1], 1 );
            return [Vec.norm( d[1][0] ) < 1e-9 * scale * 1e3, Vec.norm( d[0][1] ) < 1e-9 * scale * 1e3];
        };
        const near = (q : UV, ref : UV) : UV => {
            const out : UV = [q[0], q[1]];
            for (let k = 0; k < 2; k++) if (closed[k]) out[k] += per[k] * Math.round( (ref[k] - out[k]) / per[k] );
            return out;
        };
        const ts : Array<number> = [], table : Array<UV> = [];
        for (let i = 0; i <= N; i++) {
            const t = k0 + (k1 - k0) * i / N;
            let q = F.project( Eval.rationalCurvePoint( c, t ) ).uv;
            if (i > 0) q = near( q, table[i - 1] );
            ts.push( t ); table.push( q );
        }
        // fill in the parameters a pole leaves open, from the nearest sample that has them
        const deg = table.map( degenerate );
        for (let k = 0; k < 2; k++) {
            const good = table.map( (_, i) => i ).filter( i => !deg[i][k] );
            if (good.length == 0 || good.length == table.length) continue;
            table.forEach( (q, i) => {
                if (!deg[i][k]) return;
                let best = good[0];
                for (const g of good) if (Math.abs( g - i ) < Math.abs( best - i )) best = g;
                q[k] = table[best][k];
            } );
        }
        // the whole curve inside the domain: on a cut face, inside its rectangle; otherwise its middle in the domain
        for (let k = 0; k < 2; k++) {
            if (!closed[k]) continue;
            const x = cut != null && cut.d == k ? table.slice( 1, N ).reduce( (a, q) => a + q[k], 0 ) / (N - 1) : table[N >> 1][k];
            const shift = per[k] * Math.floor( (x - dom[2 * k]) / per[k] );
            for (const q of table) q[k] -= shift;
        }
        let speed = 0;
        for (const q of table) {
            const d = Eval.rationalSurfaceDerivatives( s, q[0], q[1], 1 );
            speed = Math.max( speed, Vec.norm( d[1][0] ), Vec.norm( d[0][1] ) );
        }
        const at = (t : number) : Point => {
            const i = Math.max( 0, Math.min( N, Math.round( (t - k0) / (k1 - k0) * N ) ) );
            if (deg[i][0] || deg[i][1]) {
                // near a pole: between the table's samples
                const f = (t - k0) / (k1 - k0) * N, j = Math.min( N - 1, Math.floor( f ) ), g = f - j;
                return [table[j][0] * (1 - g) + table[j + 1][0] * g, table[j][1] * (1 - g) + table[j + 1][1] * g];
            }
            const q = near( F.project( Eval.rationalCurvePoint( c, t ) ).uv, table[i] );
            return [q[0], q[1]];
        };
        const interior = Array.from( new Set( c.knots.slice( c.degree + 1, c.knots.length - c.degree - 1 ) ) );
        const knots = [k0, k0, k0, k0, ...interior, k1, k1, k1, k1];
        const fit = Fit.approximateCurve( at, 3, knots, 0.05 * tol / Math.max( speed, 1e-300 ), 8 ).curve;
        // the ends exactly where the vertices project, and the curve inside the domain (by its control points: a fit
        // to points on a boundary strays past it by round-off)
        const cp = fit.controlPoints;
        for (let k = 0; k < 2; k++) if (!closed[k] || (cut != null && cut.d == k)) {
            for (const p of cp) p[k] = Math.max( dom[2 * k], Math.min( dom[2 * k + 1], p[k] ) );
        }
        cp[0] = [table[0][0], table[0][1], 1];
        cp[cp.length - 1] = [table[N][0], table[N][1], 1];
        return fit;
    }

    // Whether the surface's own normal (dS/du x dS/dv) points out of the solid: a vote of the face's triangles.
    private static sameSense( r : BooleanResult, fi : number ) : boolean {
        const m = r.mesh, f = r.faces[fi], s = f.surface;
        const d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
        const periodic : [boolean, boolean] = [Analyze.isRationalSurfaceClosed( s, true ), Analyze.isRationalSurfaceClosed( s, false )];
        const seeds : Array<{ uv : UV, p : Point }> = [];
        for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
            const uv : UV = [d[0] + (d[1] - d[0]) * i / 8, d[2] + (d[3] - d[2]) * j / 8];
            seeds.push( { uv : uv, p : Eval.rationalSurfacePoint( s, uv[0], uv[1] ) } );
        }
        let vote = 0, n = 0;
        for (let k = 0; k < m.triangles.length && n < 24; k++) {
            if (r.faceOf[k] != fi) continue;
            const t = m.triangles[k], a = m.vertices[t[0]], b = m.vertices[t[1]], c = m.vertices[t[2]];
            const nt = Vec.cross( Vec.sub( b, a ), Vec.sub( c, a ) );
            if (Vec.norm( nt ) < 1e-300) continue;
            const cen = Vec.mul( 1 / 3, Vec.add( a, Vec.add( b, c ) ) );
            const cuv = r.cornerUV != null ? r.cornerUV[k] : null;
            let uv : UV | null = cuv != null ? [(cuv[0][0] + cuv[1][0] + cuv[2][0]) / 3, (cuv[0][1] + cuv[1][1] + cuv[2][1]) / 3] : null;
            if (uv == null) {
                let best = seeds[0];
                for (const x of seeds) if (Vec.distSquared( x.p, cen ) < Vec.distSquared( best.p, cen )) best = x;
                uv = SurfaceLoops.project( { surface : s, periodic : periodic }, cen, best.uv );
            }
            if (uv == null) continue;
            const dd = Eval.rationalSurfaceDerivatives( s, uv[0], uv[1], 1 );
            const ns = Vec.cross( dd[1][0], dd[0][1] );
            if (Vec.norm( ns ) < 1e-300) continue;
            vote += Vec.dot( ns, nt ) > 0 ? 1 : -1; n++;
        }
        return n == 0 ? !f.reversed : vote >= 0;
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

    // A B-spline curve: in space, or (dim 2) in a surface's parameters, its homogeneous points then [u w, v w, w].
    private static curve( w : StepWriter, c : NurbsCurveData, dim : number = 3 ) : string {
        const [mult, ks] = Step.knots( c.knots );
        if (c.controlPoints.some( p => p.length != dim + 1 || Math.abs( p[dim] - 1 ) > 1e-12 )) throw new Error( "Step: rational and mixed-dimension curves are not written" );
        const pts = c.controlPoints.map( p => w.add( Step.point( p.slice( 0, dim ) as Point ) ) );
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
