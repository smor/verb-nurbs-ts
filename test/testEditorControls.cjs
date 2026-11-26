var should = require('should');
var path = require('path');
var esbuild = require('esbuild');

// The arithmetic of the editor's number controls (editor/controls/math.ts): ranges at the value's scale, stepping with
// modifiers, snapping without floating-point drift, display at the step's precision.

var M;
before(function () {
	var out = esbuild.buildSync({ entryPoints : [path.join(__dirname, '..', 'editor', 'controls', 'math.ts')], bundle : true, format : 'cjs', platform : 'node', write : false, logLevel : 'error' });
	var m = { exports : {} };
	new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
	M = m.exports;
});

describe('editor number controls: arithmetic (editor/controls/math.ts)', function () {

	it('rounds to 1, 2 or 5 times a power of ten, up and down', function () {
		[[0.6, 1], [1, 1], [1.2, 2], [3, 5], [7, 10], [0.017, 0.02], [336, 500]].forEach(function (c) { M.niceCeil(c[0]).should.be.approximately(c[1], 1e-12); });
		[[0.6, 0.5], [1, 1], [1.9, 1], [3, 2], [7, 5], [0.017, 0.01], [336, 200]].forEach(function (c) { M.niceFloor(c[0]).should.be.approximately(c[1], 1e-12); });
	});

	it('gives a range at the value\'s scale: a 3 mm wall slides 0..10 by 0.1, never to 200', function () {
		M.defaults(3).should.eql({ min : 0, max : 10, step : 0.1 });
		M.defaults(0.17).should.eql({ min : 0, max : 1, step : 0.01 });
		M.defaults(112).should.eql({ min : 0, max : 500, step : 5 });
		M.defaults(3, true).should.eql({ min : 0, max : 10, step : 1 });
		M.defaults(-4).should.eql({ min : -20, max : 0, step : 0.2 });
		M.defaults(0).should.eql({ min : 0, max : 10, step : 0.1 });
		// every value sits inside its range with room to grow: between a third and a half of the way up
		[0.05, 0.17, 1.5, 3, 7.2, 24, 112, 950].forEach(function (v) {
			var r = M.defaults(v);
			(v / r.max).should.be.within(0.1, 0.34);
			((r.max - r.min) / r.step).should.be.within(50, 100);
		});
	});

	it('keeps given bounds, tames a catalogue range far wider than the value, and keeps whole steps whole', function () {
		M.resolve(3, { min : 1.2, max : 6, step : 0.1 }).should.eql({ min : 1.2, max : 6, step : 0.1 });
		M.resolve(3, { min : 1.2, max : 6 }).step.should.equal(0.02);
		M.resolve(20, { min : 0.01, max : 1000, step : 0.5 }, false, true).should.eql({ min : 0.01, max : 100, step : 0.5 });
		M.resolve(20, { min : 0.01, max : 1000, step : 0.5 }).should.eql({ min : 0.01, max : 1000, step : 0.5 });
		M.resolve(3, {}, true).step.should.equal(1);
	});

	it('steps to the step\'s grid with the plain step, by ten with Shift, by a tenth with Alt, and never drifts', function () {
		M.stepped(3, 1, 0.1).should.equal(3.1);
		M.stepped(3.04, 1, 0.1).should.equal(3.1);
		M.stepped(3.04, -1, 0.1).should.equal(3);
		M.stepped(3, 1, 0.1, { shift : true }).should.equal(4);
		M.stepped(3, 1, 0.1, { alt : true }).should.equal(3.01);
		M.stepped(0.17, 1, 0.005).should.equal(0.175);
		// thirty 0.1 steps from 0 land on 3 exactly, not 2.9999999999999996
		var v = 0;
		for (var i = 0; i < 30; i++) v = M.stepped(v, 1, 0.1);
		v.should.equal(3);
		M.snap(0.30000000000000004, 0.1).should.equal(0.3);
	});

	it('scrubs one step per 4 px, holds values in range, and shows them at the step\'s precision', function () {
		M.scrubbed(3, 40, 0.1).should.equal(4);
		M.scrubbed(3, -6, 0.1).should.equal(2.9);
		M.scrubbed(3, 40, 0.1, { alt : true }).should.equal(3.1);
		M.clamp(31, { min : 1.2, max : 6 }).should.equal(6);
		M.format(3, 0.1).should.equal('3');
		M.format(3.1, 0.1).should.equal('3.1');
		M.format(0.17, 0.005).should.equal('0.17');
		M.format(1 / 3, 0.01).should.equal('0.333333');
		M.decimals(0.005).should.equal(3);
		M.decimals(1e-7).should.equal(7);
	});
});
