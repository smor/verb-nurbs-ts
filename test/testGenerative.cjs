var should = require('should');

var lib = require('../dist/index.js');
var verb = lib.default;
var Fit = lib.Fit, Offset = lib.Offset, TriMesh = lib.TriMesh, Shell = lib.Shell;
var Eval = verb.eval.Eval;

function sampleCurve(curve, n, f) {
	var a = curve.knots[0], b = curve.knots[curve.knots.length - 1];
	for (var i = 0; i <= n; i++) f(Eval.rationalCurvePoint(curve, a + (b - a) * i / n));
}

function sampleSurface(srf, n, f) {
	for (var i = 0; i <= n; i++) for (var j = 0; j <= n; j++) {
		var u = srf.knotsU[0] + (srf.knotsU[srf.knotsU.length - 1] - srf.knotsU[0]) * i / n;
		var v = srf.knotsV[0] + (srf.knotsV[srf.knotsV.length - 1] - srf.knotsV[0]) * j / n;
		f(Eval.rationalSurfacePoint(srf, u, v));
	}
}

describe("verb.eval.Fit.periodicCurve", function(){
	it('is closed and C2 at the seam', function(){
		var cps = [];
		for (var i = 0; i < 9; i++) cps.push([Math.cos(i), Math.sin(2 * i), 0.1 * i % 0.3]);
		var c = Fit.periodicCurve(cps, 3);
		lib.Check.isValidNurbsCurveData(c);
		var d0 = Eval.rationalCurveDerivatives(c, 0, 2), d1 = Eval.rationalCurveDerivatives(c, 1, 2);
		for (var k = 0; k < 3; k++) for (var j = 0; j < 3; j++) d0[k][j].should.be.approximately(d1[k][j], 1e-8);
	});
});

describe("verb.eval.Fit.curveWithKnots", function(){
	it('interpolates the points at the given parameters', function(){
		var pts = [[0,0,0],[1,2,0],[2,-1,1],[4,0,0],[5,3,2]];
		var params = [0, 0.2, 0.5, 0.7, 1];
		var c = Fit.curve(pts, 3, params);
		for (var i = 0; i < pts.length; i++) {
			var p = Eval.rationalCurvePoint(c, params[i]);
			for (var k = 0; k < 3; k++) p[k].should.be.approximately(pts[i][k], 1e-9);
		}
	});
});

describe("verb.eval.Fit.loft", function(){
	it('interpolates every section curve', function(){
		var secs = [0, 1, 2, 3].map(function(k){
			var cps = [];
			for (var i = 0; i < 12; i++) { var t = 2 * Math.PI * i / 12; cps.push([(2 + k * 0.3) * Math.cos(t), (2 + Math.sin(k)) * Math.sin(t), k]); }
			return Fit.periodicCurve(cps, 3);
		});
		var params = [0, 0.3, 0.7, 1];
		var srf = Fit.loft(secs, 3, params);
		lib.Check.isValidNurbsSurfaceData(srf);
		for (var k = 0; k < secs.length; k++) for (var j = 0; j <= 10; j++) {
			var a = Eval.rationalSurfacePoint(srf, params[k], j / 10), b = Eval.rationalCurvePoint(secs[k], j / 10);
			verb.core.Vec.dist(a, b).should.be.lessThan(1e-9);
		}
	});
});

describe("verb.eval.Offset.curve", function(){
	it('offsets a circle (a rational curve) outward to within tolerance', function(){
		var circle = new verb.geom.Circle([0,0,0], [1,0,0], [0,1,0], 5).asNurbs();
		var r = Offset.curve(circle, 1.5, [0,0,1], { tolerance : 1e-5 });
		r.maxError.should.be.lessThan(1e-5);
		sampleCurve(r.result, 500, function(p){ Math.hypot(p[0], p[1]).should.be.approximately(6.5, 2e-5); });
	});

	it('offsets inward with a negative distance', function(){
		var circle = new verb.geom.Circle([0,0,0], [1,0,0], [0,1,0], 5).asNurbs();
		var r = Offset.curve(circle, -2, [0,0,1], { tolerance : 1e-5 });
		sampleCurve(r.result, 500, function(p){ Math.hypot(p[0], p[1]).should.be.approximately(3, 2e-5); });
	});

	it('offsets a free-form closed curve and stays at the offset distance', function(){
		var cps = [];
		for (var i = 0; i < 16; i++) { var t = 2 * Math.PI * i / 16; var r = 10 * (1 + 0.15 * Math.sin(3 * t)); cps.push([r * Math.cos(t), r * Math.sin(t), 0]); }
		var c = Fit.periodicCurve(cps, 3);
		var off = Offset.curve(c, 0.8, [0,0,1], { tolerance : 1e-4 }).result;
		sampleCurve(off, 200, function(p){
			var q = lib.Analyze.rationalCurveClosestPoint(c, p);
			verb.core.Vec.dist(p, q).should.be.approximately(0.8, 2e-4);
		});
	});

	it('offsets a polyline exactly with miter joins', function(){
		var square = verb.eval.Make.polyline([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,0]]);
		var off = Offset.curve(square, -0.25).result;
		var pts = Eval.dehomogenize1d(off.controlPoints);
		var expected = [[0.25,0.25,0],[0.75,0.25,0],[0.75,0.75,0],[0.25,0.75,0],[0.25,0.25,0]];
		for (var i = 0; i < 5; i++) for (var k = 0; k < 3; k++) pts[i][k].should.be.approximately(expected[i][k], 1e-12);
	});

	it('is available on NurbsCurve', function(){
		var c = new verb.geom.Circle([0,0,0], [1,0,0], [0,1,0], 2).offset(1);
		c.point(0.3).should.have.length(3);
		Math.hypot(c.point(0.3)[0], c.point(0.3)[1]).should.be.approximately(3, 1e-4);
	});
});

describe("verb.eval.Offset.surface", function(){
	it('offsets a sphere, including its poles, to within tolerance', function(){
		var sphere = new verb.geom.SphericalSurface([0,0,0], 3).asNurbs();
		var r = Offset.surface(sphere, 0.5, { tolerance : 1e-3 });
		r.maxError.should.be.lessThan(1e-3);
		sampleSurface(r.result, 40, function(p){ Math.hypot(p[0], p[1], p[2]).should.be.approximately(3.5, 1e-3); });
	});

	it('offsets a cylinder along its normal', function(){
		var cyl = new verb.geom.CylindricalSurface([0,0,1], [1,0,0], [0,0,0], 5, 2).asNurbs();
		var n = Offset.surfaceUnitNormal(cyl, 0.5, 0.5), p = Eval.rationalSurfacePoint(cyl, 0.5, 0.5);
		var outward = verb.core.Vec.dot(n, [p[0], p[1], 0]) > 0 ? 1 : -1;
		var r = Offset.surface(cyl, -0.4 * outward, { tolerance : 1e-4 });
		sampleSurface(r.result, 40, function(p){ Math.hypot(p[0], p[1]).should.be.approximately(1.6, 1e-4); });
	});

	it('is available on NurbsSurface', function(){
		var s = new verb.geom.SphericalSurface([0,0,0], 1).offset(0.25, { tolerance : 1e-3 });
		var p = s.point(0.4, 0.3);
		Math.hypot(p[0], p[1], p[2]).should.be.approximately(1.25, 1e-3);
	});
});

describe("verb.solid.TriMesh.checkClosedManifold", function(){
	function cube() {
		var m = new TriMesh();
		[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]].forEach(function(p){ m.addVertex(p); });
		[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]].forEach(function(q){ m.addQuad(q[0], q[1], q[2], q[3]); });
		return m;
	}

	it('accepts a closed cube with genus 0 and unit volume', function(){
		var m = cube();
		var r = m.checkClosedManifold();
		r.closedManifold.should.be.true();
		r.genus.should.be.equal(0);
		m.signedVolume().should.be.approximately(1, 1e-12);
	});

	it('reports holes and flipped triangles', function(){
		var m = cube();
		m.triangles.pop();
		m.checkClosedManifold().boundaryEdges.should.be.equal(3);
		var m2 = cube();
		var t = m2.triangles[0]; m2.triangles[0] = [t[0], t[2], t[1]];
		m2.checkClosedManifold().badEdges.should.be.greaterThan(0);
	});
});

describe("verb.recipes.FreeformVesselRecipe", function(){
	var vessel;
	before(function(){ vessel = lib.FreeformVesselRecipe.build({ divsU : 32, divsV : 128 }); });

	it('builds a closed, oriented, genus 0 solid', function(){
		var r = vessel.report;
		r.manifold.closedManifold.should.be.true();
		r.manifold.genus.should.be.equal(0);
		r.innerRingsSimple.should.be.true();
		r.volume.should.be.greaterThan(0);
		r.offsetMaxError.should.be.lessThan(0.02);
	});

	it('is accepted by manifold-3d', async function(){
		var Module = (await import('manifold-3d')).default;
		var wasm = await Module();
		wasm.setup();
		var m = new wasm.Manifold(new wasm.Mesh(vessel.mesh.toManifoldMesh()));
		m.status().should.be.equal('NoError');
		m.genus().should.be.equal(0);
		m.volume().should.be.approximately(vessel.report.volume, vessel.report.volume * 1e-4);
		// a boolean works on it: cut the vessel in half and keep a positive volume
		var half = m.subtract(wasm.Manifold.cube([400, 400, 400], true).translate([200, 0, 0]));
		half.volume().should.be.greaterThan(0);
		half.volume().should.be.lessThan(m.volume());
		half.delete(); m.delete();
	});
});
