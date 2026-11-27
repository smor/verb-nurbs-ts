var should = require('should');

var lib = require('../dist/index.js');
var verb = lib.default;
var Make = verb.eval.Make, Eval = verb.eval.Eval, Vec = verb.core.Vec;
var SurfaceIntersect = lib.SurfaceIntersect, IntersectionCertificate = lib.IntersectionCertificate, Sweep = lib.Sweep;

function plane(z) {
	return Make.loftedSurface([Make.rationalBezierCurve([[-20,-20,z],[20,-20,z]]), Make.rationalBezierCurve([[-20,20,z],[20,20,z]])], 1);
}
// the plane y = 0 and a sphere of radius 10 centred at height 10 - eps
function planeAndSphere(eps) {
	return [{ surface : Make.fourPointSurface([-10,0,-10], [10,0,-10], [10,0,10], [-10,0,10]) },
	        { surface : Make.sphericalSurface([0, 10 - eps, 0], [0,0,1], [1,0,0], 10), periodic : [false, true] }];
}

describe("verb.solid.IntersectionCertificate", function(){

	it('proves a plane through a cylinder complete, and finds the branch when it is left out', function(){
		var A = { surface : plane(0) };
		var B = { surface : Sweep.pipe(Make.rationalBezierCurve([[0,0,-10],[0,0,10]]), 5).surface, periodic : [false, true] };
		var curves = SurfaceIntersect.surfaces(A, B);
		var r = IntersectionCertificate.check(A, B, curves);
		r.proven.should.be.true();
		r.unresolved.should.be.equal(0);
		r.missed.length.should.be.equal(0);
		(r.apart + r.noLoop).should.be.equal(r.pairs);

		var none = IntersectionCertificate.check(A, B, []);
		none.proven.should.be.false();
		none.missed.length.should.be.above(0);
		// every missed start lies on both surfaces, on the circle of radius 5 (the pipe is within 1e-4 of a true cylinder)
		none.missed.forEach(function(m){
			Math.abs(m.point[2]).should.be.below(1e-6);
			Math.abs(Math.hypot(m.point[0], m.point[1]) - 5).should.be.below(1e-4);
			Vec.dist(Eval.rationalSurfacePoint(A.surface, m.uvA[0], m.uvA[1]), m.point).should.be.below(1e-5);
			Vec.dist(Eval.rationalSurfacePoint(B.surface, m.uvB[0], m.uvB[1]), m.point).should.be.below(1e-5);
		});
	});

	it('proves a plane through a sphere complete, poles and knots included', function(){
		var s = planeAndSphere(7);
		var r = IntersectionCertificate.check(s[0], s[1], SurfaceIntersect.surfaces(s[0], s[1]));
		r.proven.should.be.true();
		IntersectionCertificate.check(s[0], s[1], []).missed.length.should.be.above(0);
	});

	it('does not prove a nearly tangent sphere, whose loop is smaller than any cell', function(){
		var s = planeAndSphere(1e-5);
		// the grid search alone misses the loop of radius 0.014; the certificate must not vouch for it
		var r = IntersectionCertificate.check(s[0], s[1], SurfaceIntersect.surfaces(s[0], s[1], { loops : false }));
		r.proven.should.be.false();
		r.unresolved.should.be.above(0);
	});

	it('proves surfaces apart when their boxes part', function(){
		var r = IntersectionCertificate.check({ surface : plane(0) }, { surface : plane(1) }, []);
		r.proven.should.be.true();
		r.apart.should.be.equal(r.pairs);
	});
});

describe("verb.model.Model: certified intersections", function(){

	function mug(certify) {
		return { version : 1, certify : certify, features : { cup : { type : "cylinder", from : [0, 0, 0], to : [0, 0, 40], radius : 15 },
			handle : { type : "pipe", through : [[8, 0, 30], [24, 0, 29], [27, 0, 19], [8, 0, 12]], radius : 3 },
			body : { type : "union", of : ["cup", "handle"] } }, output : "body" };
	}

	it('proves every pair of faces of a mug\'s union complete, the handle\'s pole-centred caps included, and notes it', function(){
		this.timeout(60000);
		var r = new lib.Model().evaluate(mug(true));
		var c = r.result.report.certificate;
		c.pairs.should.be.above(0);
		c.proven.should.be.equal(c.pairs);
		c.unproven.length.should.be.equal(0);
		r.verdict.notes.join(' ').should.containEql('proven complete');
		r.verdict.kind.should.be.equal('buildable');
	});

	// a gate: the reference models' Booleans stay proven complete
	it('proves the reference models\' intersections complete: a filleted boss, a rounded tray, slot rims', function(){
		this.timeout(120000);
		function line(a, b) { return Make.rationalBezierCurve([a, b]); }
		function model(features, output) { return new lib.Model().evaluate({ version : 1, certify : true, features : features, output : output }).result; }
		var block = { type : "box", min : [0, 0, 0], max : [40, 30, 20] };
		var results = {
			boss : lib.BrepBoolean.union([lib.BrepSolid.cappedTube(Sweep.pipe(line([0,0,-5], [0,0,5]), 30).surface, [8, 96]),
			                              lib.BrepSolid.cappedTube(Sweep.pipe(line([0,0,0], [0,0,30]), 8).surface, [24, 96])], { fillet : 4, certify : true }),
			tray : model({ box : block, tray : { type : "shell", of : "box", thickness : 2, open : ["box.+z"] },
			               r : { type : "round", of : "tray", rules : [{ edges : "*box.+z*", radius : 0 }, { edges : "box.*", radius : 4 }, { edges : "*", radius : 2 }] } }, "r"),
			slot : model({ block : block, slot : { type : "box", min : [15, -5, 12], max : [25, 35, 25] }, d : { type : "difference", from : "block", minus : ["slot"] },
			               r : { type : "round", of : "d", rules : [{ edges : "block.+z|slot.*", radius : 2 }] } }, "r"),
		};
		Object.keys(results).forEach(function(k){
			var c = results[k].report.certificate;
			c.pairs.should.be.above(0, k);
			c.unproven.should.be.eql([], k);
		});
	});

	it('leaves the certificate out unless asked', function(){
		this.timeout(60000);
		var r = new lib.Model().evaluate(mug(false));
		should(r.result.report.certificate).be.undefined();
		r.verdict.notes.join(' ').should.not.containEql('proven');
	});
});

describe("verb.eval.Make.surfaceIsocurve", function(){

	it('matches the surface at an existing knot of full multiplicity', function(){
		var s = Make.sphericalSurface([0,3,0], [0,0,1], [1,0,0], 10);
		[0, 0.25, 0.5, 0.7, 0.75, 1].forEach(function(u){
			var c = Make.surfaceIsocurve(s, u, false);
			for (var t = 0; t <= 1; t += 0.1) Vec.dist(Eval.rationalCurvePoint(c, t), Eval.rationalSurfacePoint(s, u, t)).should.be.below(1e-9);
		});
		[0, 0.5, 0.7, 1].forEach(function(v){
			var c = Make.surfaceIsocurve(s, v, true);
			for (var t = 0; t <= 1; t += 0.1) Vec.dist(Eval.rationalCurvePoint(c, t), Eval.rationalSurfacePoint(s, t, v)).should.be.below(1e-9);
		});
	});

	it('matches the surface within EPSILON of an existing knot, on either side of it, in u and in v', function(){
		// degree 2 with a double knot at 0.5 (one short of full multiplicity), in u and in v
		var K = [0, 0, 0, 0.5, 0.5, 1, 1, 1], cps = [];
		for (var i = 0; i < 5; i++) { cps.push([]); for (var j = 0; j < 5; j++) cps[i].push([i, j, (i - 2) * (i - 2) + j * j, 1]); }
		var s = new lib.NurbsSurfaceData(2, 2, K, K, cps);
		[0.5 - 1e-11, 0.5, 0.5 + 1e-11].forEach(function(a){
			var cu = Make.surfaceIsocurve(s, a, false), cv = Make.surfaceIsocurve(s, a, true);
			for (var t = 0; t <= 1; t += 0.1) {
				Vec.dist(Eval.rationalCurvePoint(cu, t), Eval.rationalSurfacePoint(s, a, t)).should.be.below(1e-9, 'u = ' + a);
				Vec.dist(Eval.rationalCurvePoint(cv, t), Eval.rationalSurfacePoint(s, t, a)).should.be.below(1e-9, 'v = ' + a);
			}
		});
	});
});
