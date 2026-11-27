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
});
