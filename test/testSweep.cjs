var should = require('should');

var lib = require('../dist/index.js');
var verb = lib.default;
var Fit = lib.Fit, Sweep = lib.Sweep, Shell = lib.Shell, RMF = lib.RotationMinimizingFrames;
var Eval = verb.eval.Eval, Vec = verb.core.Vec;

function helix(turns) {
	var pts = [];
	for (var i = 0; i <= 40; i++) { var t = 2 * Math.PI * turns * i / 40; pts.push([10 * Math.cos(t), 10 * Math.sin(t), 4 * t]); }
	return Fit.curve(pts, 3);
}

function trefoil() {
	var cps = [];
	for (var i = 0; i < 48; i++) { var t = 2 * Math.PI * i / 48; cps.push([Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t), -Math.sin(3 * t)]); }
	return Fit.periodicCurve(cps, 3);
}

describe("verb.eval.RotationMinimizingFrames", function(){
	it('keeps the plane normal on a planar curve', function(){
		var circle = new verb.geom.Circle([0,0,0], [1,0,0], [0,1,0], 5).asNurbs();
		var f = new RMF(circle, { initialNormal : [0,0,1] });
		f.closed.should.be.true();
		f.closureAngle.should.be.approximately(0, 1e-9);
		f.frames(50).forEach(function(fr){ fr.normal[2].should.be.approximately(1, 1e-9); });
	});

	it('gives orthonormal frames', function(){
		var f = new RMF(helix(2));
		f.frames(30).forEach(function(fr){
			Vec.norm(fr.tangent).should.be.approximately(1, 1e-9);
			Vec.norm(fr.normal).should.be.approximately(1, 1e-9);
			Vec.dot(fr.tangent, fr.normal).should.be.approximately(0, 1e-9);
			Vec.dot(Vec.cross(fr.tangent, fr.normal), fr.binormal).should.be.approximately(1, 1e-9);
		});
	});

	it('does not rotate around the tangent (normal derivative has no binormal part)', function(){
		var f = new RMF(helix(2));
		for (var i = 1; i < 20; i++) {
			var u = i / 20, du = 1e-5;
			var a = f.frameAt(u), b = f.frameAt(u + du);
			var dn = Vec.mul(1 / du, Vec.sub(b.normal, a.normal));
			var dx = Vec.norm(Vec.mul(1 / du, Vec.sub(b.point, a.point)));
			(Vec.dot(dn, a.binormal) / dx).should.be.approximately(0, 1e-4);
		}
	});

	it('closes up on a closed space curve', function(){
		var f = new RMF(trefoil());
		f.closed.should.be.true();
		Math.abs(f.closureAngle).should.be.greaterThan(0.01);
		var a = f.frameAt(0), b = f.frameAt(1);
		Vec.dist(a.normal, b.normal).should.be.lessThan(1e-9);
	});
});

describe("verb.eval.Sweep", function(){
	it('sweeps a circle along a line into a cylinder', function(){
		var line = verb.eval.Make.polyline([[0,0,0],[0,0,10]]);
		var s = Sweep.pipe(line, 2, { tolerance : 1e-4 });
		s.closedU.should.be.false();
		s.closedV.should.be.true();
		for (var i = 0; i <= 10; i++) for (var j = 0; j <= 20; j++) {
			var p = Eval.rationalSurfacePoint(s.surface, i / 10, j / 20);
			Math.hypot(p[0], p[1]).should.be.approximately(2, 1e-4);
		}
	});

	it('keeps a pipe at its radius from a helix', function(){
		var rail = helix(1.5);
		var s = Sweep.pipe(rail, 1.5, { tolerance : 1e-3 });
		s.maxError.should.be.lessThan(1e-3);
		for (var i = 1; i < 10; i++) for (var j = 0; j < 12; j++) {
			var p = Eval.rationalSurfacePoint(s.surface, i / 10, j / 12);
			var q = verb.eval.Analyze.rationalCurveClosestPoint(rail, p);
			Vec.dist(p, q).should.be.approximately(1.5, 2e-3);
		}
	});

	it('scales and twists the profile', function(){
		var line = verb.eval.Make.polyline([[0,0,0],[10,0,0]]);
		var bar = verb.eval.Make.polyline([[-1,0,0],[1,0,0]]);
		var s = Sweep.surface(line, bar, { twist : [0, Math.PI / 2], scale : [1, 3], initialNormal : [0,0,1], tolerance : 1e-6 });
		// at the start the profile's x axis is the frame normal (+Z); at the end it has turned 90 degrees and grown 3x
		var a = Eval.rationalSurfacePoint(s.surface, 0, 1), b = Eval.rationalSurfacePoint(s.surface, 1, 1);
		Vec.dist(a, [0, 0, 1]).should.be.lessThan(1e-6);
		Vec.dist(b, [10, -3, 0]).should.be.lessThan(1e-4);
	});

	it('meshes an open pipe into a capped, genus 0 solid', function(){
		var s = Sweep.pipe(helix(1), 2, { tolerance : 1e-2 });
		var m = Shell.tube(s.surface, s.closedU, { divsU : 80, divsV : 24 });
		var r = m.checkClosedManifold();
		r.closedManifold.should.be.true();
		r.genus.should.be.equal(0);
		m.signedVolume().should.be.greaterThan(0);
	});
});

describe("verb.recipes.SweptObjectsRecipe", function(){
	var wasm;
	before(async function(){
		var Module = (await import('manifold-3d')).default;
		wasm = await Module();
		wasm.setup();
	});

	['knotPipe', 'twistedRing'].forEach(function(name){
		it(name + ' is a genus 1 solid accepted by manifold-3d', function(){
			var o = lib.SweptObjectsRecipe[name]({ divsU : 160, divsV : 24 });
			o.report.manifold.closedManifold.should.be.true();
			o.report.manifold.genus.should.be.equal(1);
			var m = new wasm.Manifold(new wasm.Mesh(o.mesh.toManifoldMesh()));
			m.status().should.be.equal('NoError');
			m.genus().should.be.equal(1);
			m.volume().should.be.approximately(o.report.volume, o.report.volume * 1e-4);
			m.delete();
		});
	});
});
