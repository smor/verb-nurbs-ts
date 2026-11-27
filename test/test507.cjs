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
});
