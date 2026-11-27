var should = require('should');
var lib = require('../dist/index.js');
var Graph = lib.Graph, Clearance = lib.Clearance;
var budget = require('./support/budget.cjs');

// Clearance and interference between posed solids, on their exact shells (#150, ask 1).

var PI = Math.PI;
var pair = { version : 2, meta : { name : 'pair' }, nodes : {
	a : { type : 'primitive/cylinder', in : { radius : 3, height : 5 } },
	b : { type : 'primitive/cylinder', in : { radius : 2, height : 5 } },
	k : { type : 'primitive/box', in : { width : 2, depth : 2, height : 2 } } }, outputs : { a : '@a', b : '@b', box : '@k' } };

describe("verb.solid.Clearance", function () {
	this.timeout(budget(120000));

	it('two parallel cylinders at a known gap: the gap, on their sides, the contact normal across', function () {
		var g = new Graph(), r = g.clearance(pair, 'a', 'b', { poseB : { translate : [6.5, 0, 0] } });
		r.overlap.should.be.false();
		r.distance.should.be.approximately(1.5, 1e-12);
		r.a.name.should.equal('tube'); r.b.name.should.equal('tube');
		r.normal[0].should.be.approximately(1, 1e-9);
		// the witnesses lie on the exact sides, and the normals there face each other along the contact normal
		Math.hypot(r.a.point[0], r.a.point[1]).should.be.approximately(3, 1e-12);
		Math.hypot(r.b.point[0] - 6.5, r.b.point[1]).should.be.approximately(2, 1e-12);
		r.a.normal[0].should.be.approximately(1, 1e-9); r.b.normal[0].should.be.approximately(-1, 1e-9);
		r.lower.should.be.belowOrEqual(r.distance);
		r.lower.should.be.above(1.4);
		should(r.interference).be.null();
	});

	it('cylinders turned and stacked, rim to rim, and a box\'s edge to a side: the exact gaps, witnesses on edges', function () {
		var g = new Graph();
		// b turned to lie along y, its side 1 above a's top
		var r = g.clearance(pair, 'a', 'b', { poseB : { rotate : { axis : [1, 0, 0], degrees : 90 }, translate : [0, 2.5, 8] } });
		r.distance.should.be.approximately(1, 1e-12);
		r.a.name.should.equal('end cap'); r.b.name.should.equal('tube');
		// b standing 1 out and 1 up from a's rim: the rims' nearest points, sqrt 2 apart
		r = g.clearance(pair, 'a', 'b', { poseB : { translate : [6, 0, 6] } });
		r.distance.should.be.approximately(Math.SQRT2, 1e-12);
		r.normal[0].should.be.approximately(Math.SQRT1_2, 1e-9); r.normal[2].should.be.approximately(Math.SQRT1_2, 1e-9);
		// a box's vertical edge towards the cylinder's axis
		r = g.clearance(pair, 'a', 'box', { poseB : { translate : [5, 5, 1] } });
		r.distance.should.be.approximately(4 * Math.SQRT2 - 3, 1e-12);
		r.a.name.should.equal('tube');
	});

	it('cylinders that overlap: the interference\'s exact volume, its box and its deepest point', function () {
		var g = new Graph(), r = g.clearance(pair, 'a', 'b', { poseB : { translate : [0, 0, 4] } });
		r.overlap.should.be.true();
		r.distance.should.equal(0);
		should(r.a).be.null();
		// the overlap is b's first millimetre: a disc of radius 2, 1 thick, at the shell's tolerance
		r.interference.volume.should.be.approximately(PI * 4, 3e-4 * PI * 4);
		[-2, -2, 4].forEach(function (x, k) { r.interference.box.min[k].should.be.approximately(x, 1e-6); });
		[2, 2, 5].forEach(function (x, k) { r.interference.box.max[k].should.be.approximately(x, 1e-6); });
		// the largest ball inside a disc 1 thick has radius 0.5, at mid-height, away from the rim
		r.interference.depth.should.be.approximately(0.5, 0.02);
		r.interference.deepest[2].should.be.approximately(4.5, 0.02);
		Math.hypot(r.interference.deepest[0], r.interference.deepest[1]).should.be.belowOrEqual(1.5 + 0.02);
		// side by side, 1 into each other: the lens of two discs, 5 high
		r = g.clearance(pair, 'a', 'b', { poseB : { translate : [4, 0, 0] } });
		var lens = function (R, r0, d) {
			var a = R * R * Math.acos((d * d + R * R - r0 * r0) / (2 * d * R)), b = r0 * r0 * Math.acos((d * d + r0 * r0 - R * R) / (2 * d * r0));
			return a + b - 0.5 * Math.sqrt((-d + R + r0) * (d + R - r0) * (d - R + r0) * (d + R + r0));
		};
		r.interference.volume.should.be.approximately(5 * lens(3, 2, 4), 1e-3 * 5 * lens(3, 2, 4));
		r.interference.depth.should.be.approximately(0.5, 0.02); // half the lens's width, 1
	});

	it('along a motion: a cylinder passing by another, the closest approach and when, with a bound', function () {
		var g = new Graph();
		// b at y 7 moves along x from -10 to 10 over [0, 1]: closest at t 0.5, 7 - 3 - 2 = 2 apart
		var r = g.closestApproach(pair, 'a', 'b', { motionB : { translate : { at : function (t) { return [-10 + 20 * t, 7, 0]; }, rate : 20 } }, from : 0, to : 1 });
		r.overlap.should.be.false();
		// the least distance lies between the bound and the least distance measured, within 1e-3
		r.distance.should.be.aboveOrEqual(2 - 1e-12); r.bound.should.be.belowOrEqual(2 + 1e-12);
		(r.distance - r.bound).should.be.belowOrEqual(1e-3);
		r.t.should.be.approximately(0.5, 1e-2);
		// the true distance never goes below the bound at the times sampled here
		for (var t = 0; t <= 1; t += 0.125) g.clearance(pair, 'a', 'b', { poseB : { translate : [-10 + 20 * t, 7, 0] } }).distance.should.be.aboveOrEqual(r.bound);
	});

	it('along a motion: an arm turning past a post, its corner nearest (11 - sqrt 101 apart)', function () {
		var g = new Graph();
		var doc = { version : 2, meta : { name : 'arm' }, nodes : {
			arm0 : { type : 'primitive/box', in : { width : 10, depth : 2, height : 2 } }, arm : { type : 'transform/move', in : { of : '@arm0', x : 5, y : 0, z : 0 } },
			post0 : { type : 'primitive/cylinder', in : { radius : 1, height : 2 } }, post : { type : 'transform/move', in : { of : '@post0', x : 0, y : 12, z : 0 } } },
			outputs : { arm : '@arm', post : '@post' } };
		var r = g.closestApproach(doc, 'arm', 'post', { motionA : { rotate : { axis : [0, 0, 1], degrees : function (t) { return 180 * t; }, rate : 180 } }, from : 0, to : 1 });
		var exact = 11 - Math.sqrt(101);
		r.distance.should.be.aboveOrEqual(exact - 1e-12); r.bound.should.be.belowOrEqual(exact + 1e-12);
		(r.distance - r.bound).should.be.belowOrEqual(1e-3);
		// a corner (10, ±1) points at the post's axis when turned by 90° ∓ atan(1/10): two minima, as near
		Math.abs(180 * r.t - 90).should.be.approximately(Math.atan(0.1) * 180 / PI, 1);
	});

	it('along a motion: a cylinder driven through another overlaps at some time', function () {
		var g = new Graph();
		var r = g.closestApproach(pair, 'a', 'b', { motionB : { translate : { at : function (t) { return [-10 + 20 * t, 0, 0]; }, rate : 20 } }, from : 0, to : 1 });
		r.overlap.should.be.true();
		r.distance.should.equal(0);
		Math.abs(-10 + 20 * r.t).should.be.below(5);
		(function () { g.closestApproach(pair, 'a', 'b', { from : 1, to : 0 }); }).should.throw(/before its start/);
	});

	it('refuses a name that is neither an output nor a node', function () {
		(function () { new Graph().clearance(pair, 'a', 'nothing'); }).should.throw(/neither an output nor a node/);
	});

	it('triangle distances: crossing, parallel, edge to edge', function () {
		var t = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
		Clearance.triTri(t, [[0.2, 0.2, -1], [0.2, 0.2, 1], [3, 3, 0]]).should.equal(0);
		Clearance.triTri(t, [[0, 0, 2], [1, 0, 2], [0, 1, 2]]).should.be.approximately(2, 1e-15);
		Clearance.triTri(t, [[2, -1, 1], [2, 1, 1], [3, 0, 5]]).should.be.approximately(Math.SQRT2, 1e-15);
	});
});
