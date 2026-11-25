var should = require('should');

var lib = require('../dist/index.js');
var verb = lib.default;
var Make = verb.eval.Make, Eval = verb.eval.Eval, Vec = verb.core.Vec;
var BrepSolid = lib.BrepSolid, BrepBoolean = lib.BrepBoolean, SurfaceIntersect = lib.SurfaceIntersect, SurfaceLoops = lib.SurfaceLoops, Sweep = lib.Sweep;

// the plane y = 0 (x, z in [-10, 10]) and a sphere of radius R whose lowest point in y is at -eps: they meet in a
// circle of radius sqrt(2 R eps - eps^2) around the origin, far smaller than any search grid when eps is small
var R = 10;
function planeAndSphere(eps) {
	var plane = Make.fourPointSurface([-10,0,-10], [10,0,-10], [10,0,10], [-10,0,10]);
	var sphere = Make.sphericalSurface([0, R - eps, 0], [0,0,1], [1,0,0], R);
	return [{ surface : plane }, { surface : sphere, periodic : [false, true] }];
}

// a rod of radius 10 along x and a rod of radius 6 along y whose axes are 16 - eps apart: they overlap in a small lens
function grazingRods(eps) {
	function line(a, b) { return Make.rationalBezierCurve([a, b]); }
	return [BrepSolid.cappedTube(Sweep.pipe(line([-30,0,0],[30,0,0]), 10).surface, [24, 48]),
	        BrepSolid.cappedTube(Sweep.pipe(line([0,-30,16 - eps],[0,30,16 - eps]), 6).surface, [24, 48])];
}

describe("verb.solid.SurfaceLoops: intersection loops smaller than the search grid", function(){

	it('finds a loop of radius 0.014 that the grid search misses, exactly, on both surfaces', function(){
		var s = planeAndSphere(1e-5), A = s[0], B = s[1];
		SurfaceIntersect.surfaces(A, B, { loops : false }).length.should.be.equal(0);
		var curves = SurfaceIntersect.surfaces(A, B);
		curves.length.should.be.equal(1);
		var c = curves[0], r = Math.sqrt(2 * R * 1e-5 - 1e-10);
		c.closed.should.be.true();
		c.points.length.should.be.greaterThanOrEqual(24);
		for (var k = 0; k < c.points.length; k++) {
			var p = c.points[k];
			// the surfaces meet at a grazing angle (about r / R), so a 1e-9 error across them is ~1e-7 along the plane
			Math.hypot(p[0], p[2]).should.be.approximately(r, 1e-6);
			Math.abs(p[1]).should.be.lessThan(1e-8);
			Vec.dist(Eval.rationalSurfacePoint(A.surface, c.uvA[k][0], c.uvA[k][1]), p).should.be.lessThan(1e-8);
			Vec.dist(Eval.rationalSurfacePoint(B.surface, c.uvB[k][0], c.uvB[k][1]), p).should.be.lessThan(1e-8);
		}
	});

	it('reports a point where the surfaces touch without crossing (tangency), and no branch', function(){
		var s = planeAndSphere(0);
		var r = SurfaceIntersect.analyze(s[0], s[1]);
		r.curves.length.should.be.equal(0);
		r.touching.length.should.be.equal(1);
		Vec.norm(r.touching[0].pointA).should.be.lessThan(1e-6);
		r.touching[0].distance.should.be.lessThan(1e-9);
	});

	it('finds the closest points of two surfaces that do not meet, as a critical point of their distance', function(){
		var s = planeAndSphere(-1e-3);
		var r = SurfaceIntersect.analyze(s[0], s[1]);
		r.curves.length.should.be.equal(0);
		r.touching.length.should.be.equal(0);
		var cps = SurfaceLoops.criticalPoints(s[0], s[1]);
		cps.some(function(cp){ return Math.abs(cp.distance - 1e-3) < 1e-9 && Vec.norm(cp.pointA) < 1e-6; }).should.be.true();
	});

	it('a Boolean of two barely overlapping rods: without loop detection the overlap is lost, with it the result is one watertight solid', function(){
		var rods = grazingRods(1e-4);
		var blind = BrepBoolean.union(rods, { loops : false });
		blind.curves.length.should.be.equal(0);
		// two shells that overlap: topologically closed, but two components (Euler characteristic 4), and wrong
		blind.mesh.checkClosedManifold().eulerCharacteristic.should.be.equal(4);
		['union', 'intersection'].forEach(function(op){
			var r = BrepBoolean[op](rods);
			r.curves.length.should.be.equal(1);
			var rep = r.mesh.checkClosedManifold();
			rep.closedManifold.should.be.true();
			rep.genus.should.be.equal(0);
		});
	});

	it('inside/outside next to a seam is exact: a lens 0.01 thick, thinner than the tessellation, is kept', function(){
		var rods = grazingRods(0.01);
		var lens = BrepBoolean.intersection(rods);
		var rep = lens.mesh.checkClosedManifold();
		rep.closedManifold.should.be.true();
		rep.genus.should.be.equal(0);
		lens.mesh.signedVolume().should.be.greaterThan(0);
	});
});
