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
});
