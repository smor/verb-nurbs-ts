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

	it('refines only the direction that needs it: a B-spline profile swept with a varying scale keeps its own knots', function(){
		var lib = require('../dist/index.js');
		var profile = lib.BooleanObjectsRecipe.superellipse(10, 6, 2.6, 32);
		var s = Sweep.surface(helix(1), profile, { tolerance : 1e-3, scale : function(u){ return 1 + 0.25 * Math.sin(Math.PI * u); } });
		s.maxError.should.be.lessThan(1e-3);
		s.surface.knotsV.length.should.be.equal(profile.knots.length);
		s.surface.controlPoints[0].length.should.be.equal(profile.controlPoints.length);
	});

	it('closes a pipe smoothly: across its seam the surface is continuous in position and tangent', function(){
		var s = Sweep.pipe(helix(1), 3, { tolerance : 1e-3 }).surface;
		for (var u = 0; u <= 1; u += 0.1) {
			var d0 = Eval.rationalSurfaceDerivatives(s, u, 0, 1), d1 = Eval.rationalSurfaceDerivatives(s, u, 1, 1);
			Vec.dist(d0[0][0], d1[0][0]).should.be.lessThan(1e-9);
			Vec.dist(Vec.normalized(d0[0][1]), Vec.normalized(d1[0][1])).should.be.lessThan(1e-8);
		}
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

	it('measures how far a section reaches into the bends: past 1 the surface crosses itself, and the measure says so before meshing', function(){
		this.timeout(60000);
		var plain = lib.SweptObjectsRecipe.twistedRing({ wave : 12, waves : 4, noFold : false, divsU : 200, divsV : 32 });
		plain.sweep.fold.ratio.should.be.above(1);
		plain.mesh.selfIntersections().pairs.should.be.above(0);
		// the default ring stays well inside its bends, and is crossing-free
		var calm = lib.SweptObjectsRecipe.twistedRing({ divsU : 200, divsV : 32 });
		calm.sweep.fold.ratio.should.be.below(0.5);
		calm.mesh.selfIntersections().pairs.should.be.equal(0);
	});

	it('keeps a sweep from folding by narrowing the section only where a bend is too tight for it', function(){
		this.timeout(60000);
		[{ wave : 12, waves : 4 }, { wave : 12, waves : 8 }, { width : 14, radius : 15 }, { radius : 15, wave : 6, waves : 5, width : 8, height : 5 }].forEach(function(p){
			var o = lib.SweptObjectsRecipe.twistedRing(Object.assign({ divsU : 200, divsV : 32 }, p));
			o.sweep.fold.ratio.should.be.belowOrEqual(0.9 + 1e-6);
			o.sweep.narrowed.scale.should.be.below(1);
			o.report.manifold.closedManifold.should.be.true();
			o.mesh.selfIntersections().pairs.should.be.equal(0);
		});
		// a sweep that does not need it is left exactly as it was
		var a = lib.SweptObjectsRecipe.twistedRing({ divsU : 120, divsV : 24 }), b = lib.SweptObjectsRecipe.twistedRing({ divsU : 120, divsV : 24, noFold : false });
		a.sweep.narrowed.scale.should.be.equal(1);
		a.sweep.surface.controlPoints.should.eql(b.sweep.surface.controlPoints);
		// a ring that folds only a little in its wave troughs is narrowed only a little there
		var s = lib.SweptObjectsRecipe.twistedRing({ wave : 8, waves : 5, divsU : 120, divsV : 24 });
		s.sweep.narrowed.scale.should.be.within(0.5, 0.99);
	});

	it('keeps distant parts of a sweep clear of each other: strands of a knot, turns of a coil', function(){
		this.timeout(60000);
		// a coil whose pitch is less than the pipe's width: each turn runs into the next
		var pts = [];
		for (var i = 0; i <= 60; i++) { var t = 2 * Math.PI * 3 * i / 60; pts.push([20 * Math.cos(t), 20 * Math.sin(t), 2 * t]); }
		var coil = Fit.curve(pts, 3);
		var plain = Sweep.pipe(coil, 9, { tolerance : 0.01 });
		Shell.tube(plain.surface, false, { divsU : 240, divsV : 24 }).selfIntersections().pairs.should.be.above(0);
		var kept = Sweep.pipe(coil, 9, { tolerance : 0.01, noFold : true });
		kept.narrowed.scale.should.be.below(1);
		var m = Shell.tube(kept.surface, false, { divsU : 240, divsV : 24 });
		m.checkClosedManifold().closedManifold.should.be.true();
		m.selfIntersections().pairs.should.be.equal(0);
		// knots that used to cross where their strands meet
		[{ p : 4, q : 6, radius : 51, tubeRadius : 25, pipeRadius : 5.7, pipeSwell : 0.69 },
		 { p : 4, q : 4, radius : 45, tubeRadius : 13.5, pipeRadius : 3.6, pipeSwell : 0.55 },
		 { p : 3, q : 5, radius : 21, tubeRadius : 22.5, pipeRadius : 3.8, pipeSwell : 0.01 }].forEach(function(k){
			var o = lib.SweptObjectsRecipe.knotPipe(Object.assign({ divsU : 300, divsV : 20, tolerance : 0.05 }, k));
			o.report.manifold.closedManifold.should.be.true();
			o.mesh.selfIntersections().pairs.should.be.equal(0);
		});
	});

	it('draws a torus knot whose indices share a factor once, and keeps its tube off the axis', function(){
		var a = lib.SweptObjectsRecipe.knotPipe({ p : 4, q : 6, divsU : 120, divsV : 12, tolerance : 0.1 });
		var b = lib.SweptObjectsRecipe.knotPipe({ p : 2, q : 3, divsU : 120, divsV : 12, tolerance : 0.1 });
		a.rail.controlPoints.should.eql(b.rail.controlPoints);
		var c = lib.SweptObjectsRecipe.knotPipe({ radius : 20, tubeRadius : 30, divsU : 120, divsV : 12, tolerance : 0.1 });
		var nearest = Infinity;
		c.rail.controlPoints.forEach(function(p){ nearest = Math.min(nearest, Math.hypot(p[0] / p[3], p[1] / p[3])); });
		nearest.should.be.above(0.1 * 20);
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
