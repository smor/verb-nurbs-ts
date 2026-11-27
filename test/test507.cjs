var should = require('should');
var fs = require('fs');
var path = require('path');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph;

// Graph documents from the 507 project (Brown's 507 Mechanical Movements) that once failed: each output builds into a
// closed 2-manifold of the exact volume, to the meshes' accuracy. The documents are in test/fixtures/507; their
// meta.expect records how each volume is worked out.

var dir = path.join(__dirname, 'fixtures', '507');
var file = function (prefix) { return fs.readdirSync(dir).find(function (f) { return f.startsWith(prefix + '-'); }); };
var read = function (prefix) { return JSON.parse(fs.readFileSync(path.join(dir, file(prefix)), 'utf8')); };

var PI = Math.PI;
var win = (46 / 360) * PI * (29 * 29 - 9 * 9) * 6; // one window of the wheel, within the disc
var wheel = PI * 35 * 35 * 6 - 6 * win;
var pin = PI * 9 * 4.5;

function builds(prefix, output, volume, rel) {
	var r = new Graph().evaluate(read(prefix), { output : output });
	r.verdict.kind.should.equal('buildable', output + ': ' + (r.verdict.reasons || []).join('; '));
	r.result.report.manifold.closedManifold.should.be.true();
	if (volume != null) r.result.report.volume.should.be.approximately(volume, (rel || 5e-3) * volume);
	return r;
}

describe("507 regressions (test/fixtures/507)", function () {
	this.timeout(budget(120000));

	it('A: a pin on a face it only partly covers, over a window (#59)', function () {
		builds('A', 'wheel', wheel);
		builds('A', 'flywheel', wheel + pin);
		var r = builds('A', 'flywheel-overlap', null);
		r.result.report.volume.should.be.above(wheel + pin);
	});

	it('B: a rounded-rectangle prism with a pin and as a slot (#60)', function () {
		var block = 24 * 14 * 6 - 4 * (1 - PI / 4) * 2.1 * 2.1 * 6 + PI * 9 * 5.5;
		builds('B', 'block-pin', block);
		builds('B', 'pin-block', block);
		builds('B', 'slotted', 70 * 30.3 * 6 - 4 * (1 - PI / 4) * 9 * 6 - 66 * 14.3 * 6);
		builds('B', 'box-slotted', 7063.2);
	});

	it('C: a union is the same whichever operand comes first (#61)', function () {
		var v = PI * 49 * 6 + PI * 256 * 4;
		builds('C', 'tube-flange', v);
		builds('C', 'flange-tube', v);
	});

	it('D: windows cut one by one, and a union of disjoint windows (#62)', function () {
		builds('D', 'one-by-one-2', PI * 35 * 35 * 6 - 2 * win);
		builds('D', 'union-of-2', 2 * (46 / 360) * PI * (29 * 29 - 9 * 9) * 8);
	});

	it('D: windows cut one after another skip the pairs of faces that cannot meet on the result (#66)', function () {
		// pairs of faces from two different windows are skipped, unless their faces coincide (all the hubs lie on one
		// cylinder): the pairs intersected no longer grow with the square of the windows (61, 238, 531 before)
		var pairs = [2, 4, 6].map(function (n) {
			var r = builds('D', 'one-by-one-' + n, PI * 35 * 35 * 6 - n * win);
			return r.result.report.facePairs;
		});
		pairs.map(function (p) { return p.intersected + p.skipped; }).should.eql([61, 238, 531]);
		var step1 = pairs[1].intersected - pairs[0].intersected, step2 = pairs[2].intersected - pairs[1].intersected;
		step2.should.be.belowOrEqual(1.6 * step1);
		pairs[2].skipped.should.be.above(pairs[2].intersected);
	});

	it('F: unions of solids flush at a side as well as a plane: a T, an L, a rim on a disc (#94)', function () {
		// a side of one lies along a side of the other: found twice (from each face of the other that meets it), or
		// not at all (a rim on a disc of the same radius, each with its own grid); either way the result is closed
		var N = function (nodes) { return { version : 2, meta : { name : 'flush' }, nodes : nodes, outputs : { solid : '@out' } }; };
		var box = function (id, w, d, h, x, y) { var o = {}; o[id] = { type : 'primitive/box', in : { width : w, depth : d, height : h } };
			o[id + 'm'] = { type : 'transform/move', in : { of : '@' + id, x : x, y : y, z : 0 } }; return o; };
		var union = { out : { type : 'boolean/union', in : { a : '@am', b : '@bm' } } };
		var check = function (nodes, volume, rel) {
			var r = new Graph().evaluate(N(nodes), { mesh : 'print' });
			r.verdict.kind.should.equal('buildable', (r.verdict.reasons || []).join('; '));
			r.result.report.manifold.closedManifold.should.be.true();
			r.result.report.volume.should.be.approximately(volume, rel * volume);
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
		};
		check(Object.assign(box('a', 8, 20, 5, 0, 0), box('b', 18, 4, 5, 0, -8), union), 8 * 20 * 5 + 10 * 4 * 5, 1e-9);
		check(Object.assign(box('a', 29.65, 11.3, 12, -9.175, 17.65), box('b', 12, 23.3, 12, -18, 11.65), union),
			(29.65 * 11.3 + 12 * 23.3 - 12 * 11.3) * 12, 1e-9);
		// (the cylinders' chords: the disc's volume is within 1e-3 of the exact one)
		check({ c : { type : 'primitive/cylinder', in : { radius : 38, height : 6 } }, t : { type : 'primitive/tube', in : { outer : 38, inner : 35, height : 2 } },
			tm : { type : 'transform/move', in : { of : '@t', x : 0, y : 0, z : 6 } }, out : { type : 'boolean/union', in : { a : '@c', b : '@tm' } } },
			PI * 38 * 38 * 6 + PI * (38 * 38 - 35 * 35) * 2, 1e-3);
	});

	it('E: a union of solids sharing their top and bottom planes (#63)', function () {
		builds('E', 'rim-spoke', PI * (35 * 35 - 29 * 29) * 6 + (14 / 360) * PI * 29 * 29 * 6);
	});
	it('G: extrusions meeting on a cap plane or a side plane: stacked layers, a bar on a hub, a hub on an arm, aligned bores, a T plate (#104, #101)', function () {
		// a trimmed face's surface runs on past its outline: the region beside a layer is not on it, and a branch along
		// a layer's edge takes the edge's points
		var line = function (to) { return { type : 'line', to : to }; };
		var poly = function (pts) { return { kind : 'path', start : pts[0], segments : pts.slice(1).concat([pts[0]]).map(line) }; };
		var square = function (s, c, deg) {
			var a = deg * PI / 180;
			return poly([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) {
				return [c[0] + s / 2 * (q[0] * Math.cos(a) - q[1] * Math.sin(a)), c[1] + s / 2 * (q[0] * Math.sin(a) + q[1] * Math.cos(a))];
			}));
		};
		var ex = function (outer, height, z) { return { type : 'profile/extrude', in : { profile : { outer : outer }, height : height, z : z || 0 } }; };
		var op = function (type) { return { type : 'boolean/' + type, in : { a : '@a', b : '@b' } }; };
		var build = function (nodes) {
			var r = new Graph().evaluate({ version : 2, meta : { name : 'caps' }, nodes : nodes, outputs : { solid : '@u' } }, { output : 'solid', mesh : 'print' });
			r.verdict.kind.should.equal('buildable', (r.verdict.reasons || []).join('; '));
			r.result.report.manifold.closedManifold.should.be.true();
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			return r.result.report.volume;
		};
		// B1d: a square turned 30 degrees stacked on another
		build({ a : ex(square(20, [0, 0], 0), 6), b : ex(square(20, [5, 5], 30), 4, 6), u : op('union') }).should.be.approximately(400 * 6 + 400 * 4, 1e-9 * 4000);
		// B2: the two side by side, over the same heights: union and intersection make up both
		var cup = build({ a : ex(square(20, [0, 0], 0), 6), b : ex(square(20, [5, 5], 30), 6), u : op('union') });
		var cap = build({ a : ex(square(20, [0, 0], 0), 6), b : ex(square(20, [5, 5], 30), 6), u : op('intersection') });
		(cup + cap).should.be.approximately(2 * 400 * 6, 1e-9 * 4800);
		cap.should.be.above(0.5 * 400 * 6);
		// B1b: the turned square with a box over the same heights
		build({ a : ex(square(20, [5, 5], 30), 6), b : { type : 'primitive/box', in : { width : 20, depth : 20, height : 6 } }, u : op('intersection') })
			.should.be.approximately(cap, 1e-9 * cap);
		// D3: a bar, written as five segments, stacked on a hub whose rim crosses its edge (the cylinder's chords)
		var bar = poly([[-4, -5], [26, -5], [26, 5], [-4, 5], [-4, 0]]);
		build({ a : { type : 'primitive/cylinder', in : { radius : 5.5, height : 5.5 } }, b : ex(bar, 5, 5.5), u : op('union') })
			.should.be.approximately(PI * 5.5 * 5.5 * 5.5 + 30 * 10 * 5, 1e-3 * 2022);
		// A1: a hub of the arm's own radius standing on its round end: the hub's rim runs along the arm's edge, then on
		// across its top (the cylinders' chords)
		var arm = { kind : 'path', start : [0, -6], segments : [line([30, -6]), { type : 'arc', via : [36, 0], to : [30, 6] }, line([0, 6]), { type : 'arc', via : [-6, 0], to : [0, -6] }] };
		build({ a : ex(arm, 5), c : { type : 'primitive/cylinder', in : { radius : 6, height : 6 } }, b : { type : 'transform/move', in : { of : '@c', x : 0, y : 0, z : 5 } }, u : op('union') })
			.should.be.approximately((30 * 12 + PI * 36) * 5 + PI * 36 * 6, 1e-3 * 3044);
		// C1: a bored hub under a slotted arm whose hole lines up with the bore; the borer stands 1 above the hub, so its
		// end cap meets the arm's hole wall, a closed face cut at its seam, along a rim starting on that seam
		var bored = { type : 'boolean/difference', in : { from : '@h', minus : '@bm' } };
		var slot = { type : 'profile/extrude', in : { profile : { outer : { kind : 'path', start : [0, -5], segments : [line([30, -5]),
			{ type : 'arc', via : [35, 0], to : [30, 5] }, line([0, 5]), { type : 'arc', via : [-5, 0], to : [0, -5] }] },
			holes : [{ kind : 'circle', center : [0, 0], r : 2.5 }] }, height : 5, z : 5.5 } };
		build({ h : { type : 'primitive/cylinder', in : { radius : 5.5, height : 5.5 } }, bc : { type : 'primitive/cylinder', in : { radius : 2.5, height : 7.5 } },
			bm : { type : 'transform/move', in : { of : '@bc', x : 0, y : 0, z : -1 } }, a : bored, b : slot, u : op('union') })
			.should.be.approximately(PI * (5.5 * 5.5 - 2.5 * 2.5) * 5.5 + (30 * 10 + PI * 25 - PI * 6.25) * 5, 1e-3 * 2209);
		// #101: a T-shaped slide plate, two plates sharing their y = 0 and y = 23 side planes
		build({ a : ex(poly([[0, 0], [24, 0], [24, 23], [0, 23]]), 1.33), c : ex(poly([[0, 0], [21, 0], [21, 23], [0, 23]]), 2.17, 0.83),
			b : { type : 'transform/move', in : { of : '@c', x : 1.5, y : 0, z : 0 } }, u : op('union') })
			.should.be.approximately(24 * 23 * 1.33 + 21 * 23 * 2.17 - 21 * 23 * 0.5, 1e-9 * 1540);
	});
	it('H: an upright on a foot with rounded corners, sharing its bottom plane, its sides crossing the corner arcs or flush with the foot\'s (#123)', function () {
		var line = function (to) { return { type : 'line', to : to }; };
		var arc = function (via, to) { return { type : 'arc', via : via, to : to }; };
		// a base 16 x 18 x 4 with r 2 corners, x 0..16, y -9..9
		var k = 2 - Math.SQRT2, K = 14 + Math.SQRT2, j = 7 + Math.SQRT2;
		var rr = { kind : 'path', start : [2, -9], segments : [line([14, -9]), arc([K, -j], [16, -7]), line([16, 7]), arc([K, j], [14, 9]),
			line([2, 9]), arc([k, j], [0, 7]), line([0, -7]), arc([k, -j], [2, -9])] };
		var base = { type : 'profile/extrude', in : { profile : { outer : rr, holes : [] }, height : 4, z : 0 } };
		// the part of the upright's foot (x 0..6, y -8..8) outside the base: two slivers between y = 8 and an arc
		var sliver = 0, n = 2000, x1 = 2 - Math.sqrt(3);
		for (var i = 0; i < n; i++) { var x = (i + 0.5) * x1 / n; sliver += (1 - Math.sqrt(4 - (x - 2) * (x - 2))) * x1 / n; }
		var exact = 6 * 16 * 70 + 4 * (16 * 18 - 4 * (4 - PI)) - 4 * (96 - 2 * sliver);
		[0, -1].forEach(function (z) {
			var r = new Graph().evaluate({ version : 2, meta : { name : 'stand' }, nodes : { b0 : { type : 'primitive/box', in : { width : 6, depth : 16, height : 70 } },
				up : { type : 'transform/move', in : { of : '@b0', x : 3, y : 0, z : z } }, base : base, u : { type : 'boolean/union', in : { a : '@up', b : '@base' } } },
				outputs : { solid : '@u' } }, { output : 'solid', mesh : 'print' });
			r.verdict.kind.should.equal('buildable', (r.verdict.reasons || []).join('; '));
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			r.result.report.volume.should.be.approximately(exact, 1e-3 * exact);
		});
		// Y1: the upright made as 507 makes it, a rectangle extruded and turned up (x 0..6, y -h..h, z 0..70), flush with
		// the foot's x = 0 side, which turns into the corner arcs at y = -7 and 7: the upright's bottom edge is cut there
		var rect = function (h) { return { kind : 'path', start : [-h, 0], segments : [line([h, 0]), line([h, 70]), line([-h, 70]), line([-h, 0])] }; };
		[[9, 6 * 18 * 70 + 4 * (16 * 18 - 4 * (4 - PI)) - 4 * (108 - 2 * (4 - PI))], [8, exact]].forEach(function (c) {
			var r = new Graph().evaluate({ version : 2, meta : { name : 'stand' }, nodes : {
				e : { type : 'profile/extrude', in : { profile : { outer : rect(c[0]), holes : [] }, height : 6, z : 0 } },
				r1 : { type : 'transform/rotate', in : { of : '@e', axis : 'x', degrees : 90 } }, up : { type : 'transform/rotate', in : { of : '@r1', axis : 'z', degrees : 90 } },
				base : base, u : { type : 'boolean/union', in : { a : '@up', b : '@base' } } }, outputs : { solid : '@u' } }, { output : 'solid', mesh : 'print' });
			r.verdict.kind.should.equal('buildable', (r.verdict.reasons || []).join('; '));
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			r.result.report.volume.should.be.approximately(c[1], 1e-3 * c[1]);
		});
	});
	it('I: a boss over a plate\'s hole, and an arm with a hole halfway up a bored hub (#121)', function () {
		var line = function (to) { return { type : 'line', to : to }; };
		var circ = function (r, c) { return { kind : 'circle', center : c || [0, 0], r : r }; };
		var cyl = function (radius, height) { return { type : 'primitive/cylinder', in : { radius : radius, height : height } }; };
		var mv = function (of, z, x, y) { return { type : 'transform/move', in : { of : '@' + of, x : x || 0, y : y || 0, z : z } }; };
		var sq = { kind : 'path', start : [-20, -20], segments : [line([20, -20]), line([20, 20]), line([-20, 20]), line([-20, -20])] };
		var build = function (nodes) {
			var r = new Graph().evaluate({ version : 2, meta : { name : 'boss' }, nodes : nodes, outputs : { solid : '@u' } }, { output : 'solid', mesh : 'print' });
			r.verdict.kind.should.equal('buildable', (r.verdict.reasons || []).join('; '));
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			return r.result.report.volume;
		};
		var bore = PI * 2.625 * 2.625, plate = 1600 * 6 - bore * 6;
		var ex = function (outer, holes, height, z) { return { type : 'profile/extrude', in : { profile : { outer : outer, holes : holes }, height : height, z : z || 0 } }; };
		// H1: a plate with a hole and a bored boss on it, the bores lined up; H1c: the boss unbored, over the hole
		build({ p : ex(sq, [circ(2.625)], 6), c : cyl(7, 8), cm : mv('c', 6), h : cyl(2.625, 10), hm : mv('h', 5),
			boss : { type : 'boolean/difference', in : { from : '@cm', minus : '@hm' } }, u : { type : 'boolean/union', in : { a : '@p', b : '@boss' } } })
			.should.be.approximately(plate + 8 * (PI * 49 - bore), 1e-3 * 10528);
		build({ p : ex(sq, [circ(2.625, [10, 5])], 6), c : cyl(7, 8), boss : mv('c', 6, 10, 5), u : { type : 'boolean/union', in : { a : '@p', b : '@boss' } } })
			.should.be.approximately(plate + 8 * PI * 49, 1e-3 * 10702);
		// R3: an arm whose hole lies on a hub's bore, halfway up the hub: the hole's halves meet at the bore's seam; the
		// same volume as the arm flush with the hub's top
		var st = { kind : 'path', start : [0, -5], segments : [line([40, -5]), { type : 'arc', via : [45, 0], to : [40, 5] }, line([0, 5]), { type : 'arc', via : [-5, 0], to : [0, -5] }] };
		var arm = function (z) { return { c : cyl(6, 11), h : cyl(2.625, 13), hm : mv('h', -1), hub : { type : 'boolean/difference', in : { from : '@c', minus : '@hm' } },
			arm : ex(st, [circ(2.625)], 5, z), u : { type : 'boolean/union', in : { a : '@hub', b : '@arm' } } }; };
		var flush = build(arm(6));
		build(arm(5)).should.be.approximately(flush, 1e-4 * flush);
	});
	it('J: a pulley turned from a profile, on a bored hub, the bores lined up (#121)', function () {
		var line = function (to) { return { type : 'line', to : to }; };
		var cyl = function (radius, height) { return { type : 'primitive/cylinder', in : { radius : radius, height : height } }; };
		var mv = function (of, z) { return { type : 'transform/move', in : { of : '@' + of, x : 0, y : 0, z : z } }; };
		var pts = [[2.5, 0], [25.9, 0], [25.9, 11.25], [2.5, 11.25]];
		// the borer stands 1 into the pulley's bore: the bore's foot, the pulley's bottom on the hub's bore and the hub's
		// top on it are one circle, found three times
		var r = new Graph().evaluate({ version : 2, meta : { name : 'pulley' }, nodes : {
			p : { type : 'profile/revolve', in : { profile : { outer : { kind : 'path', start : pts[0], segments : pts.slice(1).concat([pts[0]]).map(line) } } } },
			c : cyl(7, 20), cm : mv('c', -20), h : cyl(2.5, 22), hm : mv('h', -21), hub : { type : 'boolean/difference', in : { from : '@cm', minus : '@hm' } },
			u : { type : 'boolean/union', in : { a : '@p', b : '@hub' } } }, outputs : { solid : '@u' } }, { output : 'solid', mesh : 'print' });
		r.verdict.kind.should.equal('buildable', (r.verdict.reasons || []).join('; '));
		r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
		var exact = PI * (25.9 * 25.9 - 2.5 * 2.5) * 11.25 + PI * (49 - 6.25) * 20;
		r.result.report.volume.should.be.approximately(exact, 3e-3 * exact);
		r.export.mesh.signedVolume().should.be.approximately(exact, 3e-3 * exact);
	});
	it('K: overlapping blind pockets of one depth, cut one after the other (#120)', function () {
		var square = function (s, c, deg) {
			var a = deg * PI / 180, p = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return [c[0] + s / 2 * (q[0] * Math.cos(a) - q[1] * Math.sin(a)), c[1] + s / 2 * (q[0] * Math.sin(a) + q[1] * Math.cos(a))]; });
			return { kind : 'path', start : p[0], segments : [1, 2, 3, 0].map(function (i) { return { type : 'line', to : p[i] }; }) };
		};
		var ex = function (outer, height, z) { return { type : 'profile/extrude', in : { profile : { outer : outer, holes : [] }, height : height, z : z || 0 } }; };
		// squares of side 4 turned by deg, their centres 2 dx apart along x: the overlap is a rectangle
		var pockets = function (deg, dx, n) {
			var nodes = { p : ex(square(40, [0, 0], 0), 6) }, prev = 'p';
			for (var i = 0; i < n; i++) {
				nodes['m' + i] = ex(square(4, [-dx + 2 * dx * i, 0], deg), 3.01, -0.01);
				nodes['d' + i] = { type : 'boolean/difference', in : { from : '@' + prev, minus : '@m' + i } };
				prev = 'd' + i;
			}
			var r = new Graph().evaluate({ version : 2, meta : { name : 'F1' }, nodes : nodes, outputs : { s : '@' + prev } }, { output : 's', mesh : 'print' });
			r.verdict.kind.should.equal('buildable', (r.verdict.reasons || []).join('; '));
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			var a = deg * PI / 180, ov = (4 - 2 * dx * Math.cos(a)) * (4 - 2 * dx * Math.sin(a));
			r.result.report.volume.should.be.approximately(40 * 40 * 6 - (16 * n - ov * (n - 1)) * 3, 1e-9 * 9600);
		};
		pockets(20, 1, 2); // F1
		pockets(0, 1, 2); // their sides in one plane
		pockets(0, 1.5, 4); // a row of four
		// a slot cut as squares turned along an arc, each overlapping the next ones: where a later pocket's floor meets
		// an earlier one's side, corners lie close together (runs of two points along an edge; a corner put into an
		// edge beside one of its samples; sides crossing at a shallow angle). The union's area by inclusion and
		// exclusion, the squares' overlaps clipped exactly (convex polygons)
		var clip = function (P, Q) { // P inside the convex, counter-clockwise Q
			Q.forEach(function (a, i) {
				var b = Q[(i + 1) % Q.length], side = function (p) { return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); }, out = [];
				P.forEach(function (p, j) {
					var q = P[(j + 1) % P.length], sp = side(p), sq = side(q);
					if (sp >= 0) out.push(p);
					if (sp * sq < 0) out.push([p[0] + (q[0] - p[0]) * sp / (sp - sq), p[1] + (q[1] - p[1]) * sp / (sp - sq)]);
				});
				P = out;
			});
			return P;
		};
		var area = function (P) { var s = 0; P.forEach(function (p, i) { var q = P[(i + 1) % P.length]; s += p[0] * q[1] - q[0] * p[1]; }); return Math.abs(s) / 2; };
		var arc = function (R, dt, n) {
			var ts = [], nodes = { p : ex(square(30, [0, 0], 0), 6) }, prev = 'p';
			for (var i = 0; i < n; i++) ts.push(-1.1 + i * dt);
			var sqs = ts.map(function (t) {
				var c = [R * Math.cos(t) - 4, R * Math.sin(t)];
				return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return [c[0] + 1.5 * (q[0] * Math.cos(t) - q[1] * Math.sin(t)), c[1] + 1.5 * (q[0] * Math.sin(t) + q[1] * Math.cos(t))]; });
			});
			var union = 0;
			for (var m = 1; m < (1 << n); m++) {
				var P = null, bits = 0;
				for (var k = 0; k < n; k++) if (m & (1 << k)) { bits++; P = P == null ? sqs[k] : (P.length > 2 ? clip(P, sqs[k]) : P); }
				union += (bits % 2 ? 1 : -1) * (P.length > 2 ? area(P) : 0);
			}
			ts.forEach(function (t, i) {
				nodes['m' + i] = ex(square(3, [R * Math.cos(t) - 4, R * Math.sin(t)], t * 180 / PI), 3.01, -0.01);
				nodes['d' + i] = { type : 'boolean/difference', in : { from : '@' + prev, minus : '@m' + i } };
				prev = 'd' + i;
			});
			var r = new Graph().evaluate({ version : 2, meta : { name : 'slot' }, nodes : nodes, outputs : { s : '@' + prev } }, { output : 's', mesh : 'print' });
			r.verdict.kind.should.equal('buildable', (r.verdict.reasons || []).join('; '));
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			r.result.report.volume.should.be.approximately(30 * 30 * 6 - union * 3, 1e-9 * 5400);
		};
		arc(9, 0.115, 3);
		arc(11, 0.09, 4);
		arc(12, 0.12, 8);
	});
});
