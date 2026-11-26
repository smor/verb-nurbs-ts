var should = require('should');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var N = lib.Nodes, P = lib.Primitives, Make = lib.Make, Eval = lib.Eval, BrepBoolean = lib.BrepBoolean, Step = lib.Step;
var NurbsCurveData = lib.NurbsCurveData;
var PI = Math.PI;

function closed(s, genus) {
	var r = s.tessellate().checkClosedManifold();
	r.closedManifold.should.be.true();
	r.genus.should.be.equal(genus === undefined ? 0 : genus);
}
function near(x, v, tol) { Math.abs(x - v).should.be.below(tol * Math.abs(v), x + ' against ' + v); }
function circle(r, z, c) { c = c || [0, 0]; return Make.arc([c[0], c[1], z], [1, 0, 0], [0, 1, 0], r, 0, 2 * PI); }
function line(a, b) { return new NurbsCurveData(1, [0, 0, 1, 1], [a.concat([1]), b.concat([1])]); }
function polygon(pts) {
	var n = pts.length, knots = [0, 0];
	for (var i = 1; i < n; i++) knots.push(i / n);
	knots.push(1, 1);
	return new NurbsCurveData(1, knots, pts.concat([pts[0]]).map(function(p){ return p.concat([1]); }));
}
// the largest distance of a grid of surface points from a predicate's zero set
function worst(s, f) {
	var e = 0, u0 = s.knotsU[0], u1 = s.knotsU[s.knotsU.length - 1], v0 = s.knotsV[0], v1 = s.knotsV[s.knotsV.length - 1];
	for (var i = 0; i <= 12; i++) for (var j = 0; j <= 12; j++)
		e = Math.max(e, Math.abs(f(Eval.rationalSurfacePoint(s, u0 + (u1 - u0) * i / 12, v0 + (v1 - v0) * j / 12))));
	return e;
}

describe('Nodes (the surface and solid builders of Grasshopper)', function () {
	this.timeout(budget(120000));

	describe('Plane Surface and 4Point Surface', function () {
		it('a plane surface spans its x and y domains in its plane', function(){
			var s = N.plane([1, 2, 3], [0, 1, 0], [1, 1, 0], [-5, 5], 4);
			Eval.rationalSurfacePoint(s, 0, 0).should.be.eql([1, -3, 3]);
			Eval.rationalSurfacePoint(s, 1, 1).should.be.eql([5, 7, 3]);
			worst(s, function(p){ return p[2] - 3; }).should.be.below(1e-12);
		});
		it('refuses a plane with parallel axes or an empty domain', function(){
			(function(){ N.plane([0, 0, 0], [1, 0, 0], [2, 0, 0], 1, 1); }).should.throw(/y axis/);
			(function(){ N.plane([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1], 1); }).should.throw(/increasing/);
		});
		it('four corners make a bilinear patch, three a triangle', function(){
			var q = N.fourPoint([0, 0, 0], [10, 0, 0], [10, 10, 5], [0, 10, 0]);
			// a hyperbolic paraboloid: z = 5 x y / 100
			worst(q, function(p){ return p[2] - 5 * p[0] * p[1] / 100; }).should.be.below(1e-12);
			var t = N.fourPoint([0, 0, 0], [10, 0, 0], [0, 10, 0]);
			worst(t, function(p){ return p[2] + Math.max(0, p[0] + p[1] - 10); }).should.be.below(1e-12);
			(function(){ N.fourPoint([0, 0, 0], [0, 0, 0], [1, 1, 0]); }).should.throw(/distinct/);
		});
	});

	describe('Boundary Surfaces', function () {
		it('fills each closed planar curve with a planar face', function(){
			var star = [];
			for (var i = 0; i < 10; i++) star.push([Math.cos(i * PI / 5) * (i % 2 ? 4 : 10), Math.sin(i * PI / 5) * (i % 2 ? 4 : 10), 2]);
			var ss = N.boundary([circle(5, 0, [20, 0]), polygon(star)]);
			ss.length.should.be.equal(2);
			worst(ss[0], function(p){ return p[2]; }).should.be.below(1e-12);
			worst(ss[0], function(p){ return Math.max(0, Math.hypot(p[0] - 20, p[1]) - 5); }).should.be.below(1e-12);
			worst(ss[1], function(p){ return p[2] - 2; }).should.be.below(1e-12);
		});
		it('refuses holes, open and non-planar curves, and regions not star-shaped', function(){
			(function(){ N.boundary([circle(10, 0), circle(5, 0)]); }).should.throw(/holes/);
			(function(){ N.boundary([line([0, 0, 0], [1, 0, 0])]); }).should.throw(/closed/);
			(function(){ N.boundary([polygon([[0, 0, 0], [10, 0, 0], [10, 10, 3], [0, 10, 0]])]); }).should.throw(/planar/);
			// a C shape: its centroid is outside it
			(function(){ N.boundary([polygon([[0, 0, 0], [10, 0, 0], [10, 2, 0], [2, 2, 0], [2, 8, 0], [10, 8, 0], [10, 10, 0], [0, 10, 0]])]); }).should.throw(/star-shaped/);
		});
	});

	describe('Loft', function () {
		var sections = [circle(10, 0), circle(5, 10), circle(10, 20)];
		it('a normal loft passes through every section; a loose one through the ends only', function(){
			var s = N.loft(sections);
			// the middle section is at v = 1/2 (chord-length parameters, equal spacing)
			for (var i = 0; i < 8; i++) {
				var p = Eval.rationalSurfacePoint(s, i / 8, 0.5);
				near(Math.hypot(p[0], p[1]), 5, 1e-9);
				near(p[2], 10, 1e-9);
			}
			var l = N.loft(sections, { type : 'loose' });
			var m = Eval.rationalSurfacePoint(l, 0.3, 0.5);
			Math.hypot(m[0], m[1]).should.be.above(5.5);
			near(Math.hypot.apply(null, Eval.rationalSurfacePoint(l, 0.3, 1).slice(0, 2)), 10, 1e-9);
		});
		it('a straight loft is ruled: between two circles it is a cone frustum, exactly', function(){
			var s = N.loftSolid([circle(10, 0), circle(4, 12)], { type : 'straight' });
			closed(s);
			near(P.volume(s), PI * 12 / 3 * (100 + 40 + 16), 1e-9);
		});
		it('caps closed planar sections into a solid that rounds, subtracts and writes to STEP', function(){
			var s = N.loftSolid(sections);
			closed(s);
			var E = P.creases(s).map(function(e){ return { solid : 0, faces : e.faces, radius : 1 }; });
			E.length.should.be.equal(2);
			var r = BrepBoolean.evaluate([s], function(f){ return f[0]; }, { edges : E });
			r.report.fillets.should.be.equal(2);
			r.report.manifold.closedManifold.should.be.true();
			Step.write(r, { tolerance : 0.01 }).should.match(/MANIFOLD_SOLID_BREP/);
			var h = BrepBoolean.evaluate([s, P.cylinder(3, 40)], function(f){ return f[0] && !f[1]; });
			h.report.manifold.closedManifold.should.be.true();
			h.report.manifold.genus.should.be.equal(1);
		});
		it('refuses one section, an unknown type, and open sections for a solid', function(){
			(function(){ N.loft([circle(1, 0)]); }).should.throw(/two sections/);
			(function(){ N.loft(sections, { type : 'developable' }); }).should.throw(/normal, loose or straight/);
			(function(){ N.loftSolid([line([0, 0, 0], [1, 0, 0]), line([0, 0, 1], [1, 0, 1])]); }).should.throw(/closed/);
		});
	});

	describe('Sweep1 and Sweep2', function () {
		var square = polygon([[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]]);
		it('a section drawn at the start of the rail is carried along it', function(){
			// a square in the plane x = 0, swept along x
			var sq = polygon([[0, -5, -5], [0, 5, -5], [0, 5, 5], [0, -5, 5]]);
			var s = N.sweep1(line([0, 0, 0], [30, 0, 0]), sq);
			worst(s, function(p){ return Math.max(Math.abs(p[1]), Math.abs(p[2])) - 5; }).should.be.below(1e-3);
			var solid = N.sweep1Solid(line([0, 0, 0], [30, 0, 0]), sq);
			closed(solid);
			near(P.volume(solid), 3000, 1e-4);
		});
		it('a section swept round a closed rail makes a ring', function(){
			var s = N.sweep1Solid(circle(30, 0), polygon([[25, 0, -2], [35, 0, -2], [35, 0, 2], [25, 0, 2]]));
			closed(s, 1);
			// Pappus: the section's area times the path of its centroid
			near(P.volume(s), 40 * 2 * PI * 30, 1e-3);
		});
		it('a two-rail sweep keeps its section between the rails, scaled to their distance', function(){
			var arc = Make.arc([10, 0, 0], [-1, 0, 0], [0, 0, 1], 10, 0, PI);
			var s = N.sweep2(line([0, 0, 0], [0, 40, 0]), line([20, 0, 0], [20, 40, 0]), [arc]);
			worst(s, function(p){ return Math.hypot(p[0] - 10, p[2]) - 10; }).should.be.below(1e-9);
			// rails that spread from 20 to 30 apart, the second given the other way round
			var w = N.sweep2(line([0, 0, 0], [0, 40, 0]), line([30, 40, 0], [20, 0, 0]), [arc]);
			var end = Eval.rationalSurfacePoint(w, 0.5, 1);
			near(end[0], 15, 1e-9); near(end[2], 15, 1e-9);
		});
		it('a two-rail sweep blends between its sections', function(){
			var r1 = line([0, 0, 0], [0, 40, 0]), r2 = line([20, 0, 0], [20, 40, 0]);
			var low = Make.arc([10, 0, 0], [-1, 0, 0], [0, 0, 1], 10, 0, PI);
			var flat = line([0, 40, 0], [20, 40, 0]);
			var s = N.sweep2(r1, r2, [flat, low], { stations : 9 });
			// the arc at the start, a straight section at the end, half-height half way
			near(Eval.rationalSurfacePoint(s, 0.5, 0)[2], 10, 1e-9);
			Math.abs(Eval.rationalSurfacePoint(s, 0.5, 1)[2]).should.be.below(1e-9);
			near(Eval.rationalSurfacePoint(s, 0.5, 0.5)[2], 5, 1e-6);
			(function(){ N.sweep2(r1, r2, [line([5, 5, 5], [6, 6, 6])]); }).should.throw(/starts on one rail/);
			(function(){ N.sweep2(r1, r2, []); }).should.throw(/a section/);
		});
	});

	describe('Pipe', function () {
		var rail = line([0, 0, 0], [0, 0, 30]);
		var bend = Make.arc([0, 0, 0], [1, 0, 0], [0, 0, 1], 30, 0, PI / 2);
		it('an open pipe is a tube round its curve', function(){
			var s = N.pipe(bend, 5);
			worst(s, function(p){ return Math.hypot(Math.hypot(p[0], p[2]) - 30, p[1]) - 5; }).should.be.below(1e-3);
		});
		it('flat caps close it: a cylinder, a quarter torus', function(){
			var c = N.pipeSolid(rail, 5);
			closed(c);
			near(P.volume(c), PI * 25 * 30, 1e-4);
			var q = N.pipeSolid(bend, 5);
			closed(q);
			near(P.volume(q), PI * 25 * 30 * PI / 2, 1e-4);
		});
		it('round caps are half-spheres that meet the tube exactly', function(){
			var c = N.pipeSolid(rail, 5, 'round');
			closed(c);
			near(P.volume(c), PI * 25 * 30 + 4 / 3 * PI * 125, 1e-4);
			// the dome is the sphere wherever its ring is the circle
			worst(c.faces[1].surface, function(p){ return Math.hypot(p[0], p[1], p[2]) - 5; }).should.be.below(1e-2);
			worst(c.faces[2].surface, function(p){ return Math.hypot(p[0], p[1], p[2] - 30) - 5; }).should.be.below(1e-2);
			var b = N.pipeSolid(bend, 5, 'round');
			closed(b);
			P.creases(b).length.should.be.equal(0);
			Step.write(BrepBoolean.evaluate([b], function(f){ return f[0]; }), { tolerance : 0.01 }).should.match(/MANIFOLD_SOLID_BREP/);
		});
		it('a pipe round a closed curve is a torus', function(){
			var t = N.pipeSolid(circle(30, 0), 5);
			closed(t, 1);
			near(P.volume(t), 2 * PI * PI * 30 * 25, 1e-4);
		});
		it('a tapered pipe takes its end radii', function(){
			var c = N.pipeSolid(rail, [5, 2], 'round');
			closed(c);
			// a cone frustum and two half-spheres
			near(P.volume(c), PI * 30 / 3 * (25 + 10 + 4) + 2 / 3 * PI * (125 + 8), 1e-2);
		});
		it('refuses a radius that is not positive and unknown caps', function(){
			(function(){ N.pipe(rail, 0); }).should.throw(/positive/);
			(function(){ N.pipeSolid(rail, 1, 'pointed'); }).should.throw(/flat or round/);
		});
	});
});
