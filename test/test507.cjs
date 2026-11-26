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

	it('E: a union of solids sharing their top and bottom planes (#63)', function () {
		builds('E', 'rim-spoke', PI * (35 * 35 - 29 * 29) * 6 + (14 / 360) * PI * 29 * 29 * 6);
	});
});
