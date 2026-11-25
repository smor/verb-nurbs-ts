import { NurbsCurveData, NurbsSurfaceData, Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Divide } from "../eval/Divide.js";
import { Eval } from "../eval/Eval.js";
import { Fit } from "../eval/Fit.js";
import { Offset } from "../eval/Offset.js";
import { Shell } from "../solid/Shell.js";
import { ManifoldReport, TriMesh } from "../solid/TriMesh.js";

// One harmonic of a section outline: r(theta) gets a term amplitude * sin(frequency * theta + phase).
// Amplitude and phase are given at the base and at the rim and blend smoothly in between.
export interface VesselHarmonic {
    frequency : number;
    amplitude : [number, number];
    phase : [number, number];
}

export interface FreeformVesselParams {
    // overall height (default 160)
    height? : number;
    // mean radius at the base and at the rim (default [70, 80])
    radius? : [number, number];
    // radius changes linearly with height (a cone) instead of easing in and out (default false)
    linearRadius? : boolean;
    // extra bulge of the mean radius at mid height (default 1.5)
    belly? : number;
    // horizontal drift of the section centre between base and rim (default [4, -2])
    lean? : [number, number];
    // harmonics of the outline; together they make the irregular folds (default: an Aalto-like set)
    harmonics? : Array<VesselHarmonic>;
    // wall thickness, measured along the wall normal (default 3)
    wallThickness? : number;
    // thickness of the floor (default 4)
    baseThickness? : number;
    // number of horizontal section curves lofted into the wall (default 7)
    sections? : number;
    // control points per section curve (default 40)
    sectionControlPoints? : number;
    // tolerance of the wall offset (default 0.02)
    offsetTolerance? : number;
    // mesh resolution (default 64 x 256)
    divsU? : number;
    divsV? : number;
}

export interface FreeformVessel {
    sections : Array<NurbsCurveData>;
    outerWall : NurbsSurfaceData;
    innerWall : NurbsSurfaceData;
    mesh : TriMesh;
    report : {
        offsetMaxError : number;
        offsetRefinements : number;
        innerRingsSimple : boolean;
        manifold : ManifoldReport;
        volume : number;
        boundingBox : { min : Point, max : Point };
    };
}

// A free-form vessel in the spirit of Alvar Aalto's 1936 glass vases: an irregular, folded outline whose folds drift
// and change depth with height (so it is not a revolved or extruded shape), with walls of constant thickness and a
// flat floor. All dimensions are in millimetres.
//
// Construction:
// 1. each horizontal section is a closed, C2 periodic B-spline whose control points follow a polar outline
//    r(theta) = R(z) * (1 + sum of harmonics) around a centre that drifts with height
// 2. the sections are lofted into the outer wall with `Fit.loft`
// 3. the inner wall is `Offset.surface` of the outer wall, inward by the wall thickness
// 4. the inner wall is cut at the floor height with `Divide.surfaceSplit`
// 5. `Shell.openVessel` meshes both walls, the floors and the rim into one watertight solid

export class FreeformVesselRecipe {

    public static DEFAULT_HARMONICS : Array<VesselHarmonic> = [
        { frequency : 2, amplitude : [0.06, 0.09], phase : [0.3, 0.9] },
        { frequency : 3, amplitude : [0.08, 0.06], phase : [1.9, 2.5] },
        { frequency : 5, amplitude : [0.07, 0.10], phase : [0.0, 0.7] },
        { frequency : 7, amplitude : [0.035, 0.05], phase : [2.2, 3.0] },
        { frequency : 9, amplitude : [0.015, 0.025], phase : [0.8, 1.6] },
    ];

    // The section curves and the outer wall lofted through them. With `extend` > 0 the wall continues above the
    // rim by that fraction of the height, following the same outline (the rim then sits at u = 1 / (1 + extend)).
    public static outerWall( params? : FreeformVesselParams, extend : number = 0 ) : { sections : Array<NurbsCurveData>, outerWall : NurbsSurfaceData } {
        const p = params != null ? params : {};
        const H = p.height != null ? p.height : 160;
        const R = p.radius != null ? p.radius : [70, 80];
        const belly = p.belly != null ? p.belly : 1.5;
        const lean = p.lean != null ? p.lean : [4, -2];
        const harmonics = p.harmonics != null ? p.harmonics : FreeformVesselRecipe.DEFAULT_HARMONICS;
        const K = p.sections != null ? p.sections : 7;
        const M = p.sectionControlPoints != null ? p.sectionControlPoints : 40;

        // smooth blend 0..1 with zero slope at both ends
        const ease = (s : number) => s * s * (3 - 2 * s);
        const lerp = (a : number, b : number, s : number) => a + (b - a) * s;

        // with an extension, add sections above the rim (the outline keeps evolving as if the vessel were taller,
        // with the blends frozen at their rim values)
        const Kx = extend > 0 ? K + Math.max( 1, Math.ceil( extend * (K - 1) ) ) : K;
        const sMax = extend > 0 ? 1 + extend : 1;
        const sections : Array<NurbsCurveData> = [];
        for (let k = 0; k < Kx; k++) {
            const s = Kx == K ? k / (K - 1) : sMax * k / (Kx - 1);
            const sc = Math.min( s, 1 );
            const z = H * s;
            const e = ease( sc );
            const radius = lerp( R[0], R[1], p.linearRadius ? s : e ) + belly * Math.sin( Math.PI * sc );
            const cx = lean[0] * e, cy = lean[1] * Math.sin( Math.PI * sc );
            const cps : Array<Point> = [];
            for (let i = 0; i < M; i++) {
                const th = 2 * Math.PI * i / M;
                let f = 1.0;
                for (const h of harmonics) f += lerp( h.amplitude[0], h.amplitude[1], e ) * Math.sin( h.frequency * th + lerp( h.phase[0], h.phase[1], e ) );
                cps.push( [cx + radius * f * Math.cos( th ), cy + radius * f * Math.sin( th ), z] );
            }
            sections.push( Fit.periodicCurve( cps, 3 ) );
        }

        // u runs from base to top, v around the vessel; the loft parameters are the section heights so the wall is
        // evenly parameterised in height (z is exactly linear in u)
        const outerWall = Fit.loft( sections, 3, sections.map( (_, k) => k / (Kx - 1) ) );
        return { sections : sections, outerWall : outerWall };
    }

    // The wall offset inward by `thickness`, as `Offset.surface` returns it.
    public static innerOffset( outerWall : NurbsSurfaceData, thickness : number, tolerance : number ) {
        const mid = Eval.rationalSurfacePoint( outerWall, 0.5, 0.0 );
        const axisPt = Shell.centroid( Array.from( { length : 16 }, (_, j) => Eval.rationalSurfacePoint( outerWall, 0.5, j / 16 ) ) );
        const n = Offset.surfaceUnitNormal( outerWall, 0.5, 0.0 );
        const outwardSign = Vec.dot( n, Vec.sub( mid, axisPt ) ) > 0 ? 1 : -1;
        return Offset.surface( outerWall, -outwardSign * thickness, { tolerance : tolerance } );
    }

    // The parameter u at which the mean height of the wall's isocurve is z.
    public static uAtHeight( srf : NurbsSurfaceData, z : number ) : number {
        const meanZ = (u : number) => {
            let m = 0.0;
            for (let j = 0; j < 32; j++) m += Eval.rationalSurfacePoint( srf, u, j / 32 )[2] / 32;
            return m;
        };
        let lo = srf.knotsU[0], hi = srf.knotsU[srf.knotsU.length - 1];
        for (let it = 0; it < 60; it++) {
            const m = (lo + hi) / 2;
            if (meanZ( m ) < z) lo = m; else hi = m;
        }
        return (lo + hi) / 2;
    }

    public static build( params? : FreeformVesselParams ) : FreeformVessel {
        const p = params != null ? params : {};
        const t = p.wallThickness != null ? p.wallThickness : 3;
        const tb = p.baseThickness != null ? p.baseThickness : 4;
        const tol = p.offsetTolerance != null ? p.offsetTolerance : 0.02;
        const w = FreeformVesselRecipe.outerWall( p );
        const sections = w.sections, outerWall = w.outerWall;

        const off = FreeformVesselRecipe.innerOffset( outerWall, t, tol );
        // cut the inner wall where its mean height reaches the floor thickness
        const innerWall = Divide.surfaceSplit( off.result, FreeformVesselRecipe.uAtHeight( off.result, tb ), false )[1];

        const divsU = p.divsU != null ? p.divsU : 64;
        const divsV = p.divsV != null ? p.divsV : 256;
        const mesh = Shell.openVessel( outerWall, innerWall, { divsU : divsU, divsV : divsV } );

        // the offset must not fold over in the concave folds: check every inner ring for self-crossings
        const innerRings = Shell.sampleGrid( innerWall, 16, divsV, true );
        const simple = innerRings.every( r => Shell.ringIsSimpleXY( r ) );

        return {
            sections : sections,
            outerWall : outerWall,
            innerWall : innerWall,
            mesh : mesh,
            report : {
                offsetMaxError : off.maxError,
                offsetRefinements : off.iterations,
                innerRingsSimple : simple,
                manifold : mesh.checkClosedManifold(),
                volume : mesh.signedVolume(),
                boundingBox : mesh.boundingBox()
            }
        };
    }
}
