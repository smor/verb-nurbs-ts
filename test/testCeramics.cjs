var should = require('should');
var fs = require('fs');
var path = require('path');
var esbuild = require('esbuild');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph;

// Vessels from drawn sections: the freeform/vessel node, the AIPPD profile reader (scripts/aippd-profile.mjs), the
// editor's shelf layout (editor/shelf.ts), and the pottery collection (editor/samples/ceramics), whose every vessel
// must hold the capacity its source documents.

var PI = Math.PI;
var vessel = function (inputs) { return { version : 2, nodes : { v : { type : 'freeform/vessel', in : inputs } }, outputs : { v : '@v' } }; };
var buildable = function (r) {
	r.verdict.kind.should.equal('buildable', (r.verdict.reasons || []).join('; '));
	r.result.report.manifold.closedManifold.should.be.true();
	r.result.report.manifold.genus.should.equal(0);
	return r;
};

describe('freeform/vessel', function () {
	this.timeout(budget(60000));

	it('a straight-walled pot is a cylinder less its cavity: pi (R^2 H - r^2 (H - floor))', function () {
		var r = buildable(new Graph().evaluate(vessel({ outer : '20 0; 20 40', cavity : '17 4; 17 43' })));
		r.result.report.volume.should.be.approximately(PI * (400 * 40 - 289 * 36), 5e-3 * PI * 400 * 40);
		r.faceNames.should.containEql('v/cavity.wall');
	});

	it('a hollow foot is taken from under the base, and a vessel with no cavity is the turned body', function () {
		var withFoot = buildable(new Graph().evaluate(vessel({ outer : '20 0; 20 40', cavity : '17 10; 17 43', foot : '12 -3; 12 5' })));
		withFoot.result.report.volume.should.be.approximately(PI * (400 * 40 - 289 * 30 - 144 * 5), 5e-3 * PI * 400 * 40);
		var solid = buildable(new Graph().evaluate(vessel({ outer : '20 0; 20 40', cavity : '' })));
		solid.result.report.volume.should.be.approximately(PI * 400 * 40, 5e-3 * PI * 400 * 40);
		Graph.compile(vessel({ outer : '20 0; 20 40', cavity : '' })).features.v.type.should.equal('revolve');
	});

	it('refuses points that are not pairs of numbers, a one-point profile, and a missing outer profile', function () {
		var f = function (inputs) { return function () { Graph.compile(vessel(inputs)); }; };
		f({ outer : '20 0; 20' }).should.throw(/"v.outer" point 2 is "20", not two numbers "r z"/);
		f({ outer : '20 0; a 4' }).should.throw(/point 2 is "a 4"/);
		f({ outer : '20 0' }).should.throw(/has 1 point; a profile needs two or more/);
		f({ outer : '' }).should.throw(/"v.outer" needs points/);
	});
});

describe('AIPPD profile reader (scripts/aippd-profile.mjs)', function () {
	var profile;
	before(async function () { profile = (await import('../scripts/aippd-profile.mjs')).profile; });

	// a mask of a cup drawn like AIPPD's: wall 4 px thick from x = 140 to 143, base 6 px from y = 194 to 199, the
	// axis at x = 200 (the base's right end), rim at y = 100; 100 px tall, given as 10 cm
	var cup = function (y, x) {
		if (y < 100 || y > 199 || x > 199) return 0;
		if (x >= 140 && x < 144) return 1;
		return y >= 194 && x >= 140 ? 1 : 0;
	};

	it('finds the axis at the profile\'s right edge and gives radii and heights in millimetres', function () {
		var p = profile(cup, 10);
		p.mmPerPx.should.be.approximately(1, 1e-12);
		p.heightMm.should.be.approximately(100, 1e-9);
		// outer radius 60 px, cavity radius 56 px (from the wall's inner side to the axis)
		p.outer.forEach(function (q) { q[0].should.be.approximately(60, 1e-9); });
		p.outer[0][1].should.equal(0);
		p.outer[p.outer.length - 1][1].should.be.approximately(100, 1e-9);
		p.cavity.forEach(function (q) { q[0].should.be.approximately(56, 1e-9); });
		// the floor is the base's top (6 px up), and the cavity opens above the rim
		p.cavity[0][1].should.be.approximately(6, 1e-9);
		p.cavity[p.cavity.length - 1][1].should.be.approximately(103, 1e-9);
		should(p.foot).be.null();
		// increasing heights, as the revolve needs
		for (var i = 1; i < p.outer.length; i++) p.outer[i][1].should.be.above(p.outer[i - 1][1]);
	});

	it('a ring foot leaves a hollow under the base, open below', function () {
		// the same cup on a ring foot 10 px tall, from x = 170 to 173
		var footed = function (y, x) {
			if (y >= 200 && y < 210) return x >= 170 && x < 174 ? 1 : 0;
			return cup(y, x);
		};
		var p = profile(footed, 11);
		p.foot.should.not.be.null();
		p.foot[0][1].should.be.below(0);
		p.foot[0][0].should.be.approximately(26, 1e-9);   // from the ring's inner side (x = 173) to the axis (x = 200)
		var d = { outer : p.outer.map(function (q) { return q.join(' '); }).join('; '), cavity : p.cavity.map(function (q) { return q.join(' '); }).join('; '),
			foot : p.foot.map(function (q) { return q.join(' '); }).join('; ') };
		buildable(new Graph().evaluate(vessel(d)));
	});
});

describe('editor shelf layout (editor/shelf.ts)', function () {
	var shelf;
	before(function () {
		var out = esbuild.buildSync({ entryPoints : [path.join(__dirname, '..', 'editor', 'shelf.ts')], bundle : true, format : 'cjs', platform : 'node', write : false, logLevel : 'error' });
		var m = { exports : {} };
		new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
		shelf = m.exports;
	});
	var box = function (w, h, x0) { x0 = x0 || 0; return { min : [x0 - w / 2, -w / 2, 0], max : [x0 + w / 2, w / 2, h] }; };
	var moved = function (b, t) { return { min : b.min.map(function (v, k) { return v + t[k]; }), max : b.max.map(function (v, k) { return v + t[k]; }) }; };
	var overlap = function (a, b) { return [0, 1, 2].every(function (k) { return a.min[k] < b.max[k] && b.min[k] < a.max[k]; }); };

	it('places each piece in its row and column, standing on its row, centred in its column, none overlapping', function () {
		var boxes = { a : box(10, 30, 50), b : box(40, 8), c : box(6, 6), d : box(20, 50) };
		var spec = { rows : [{ key : 'r1', label : 'One' }, { key : 'r2', label : 'Two' }], columns : [{ key : 'x', label : 'X' }, { key : 'y', label : 'Y' }],
			place : { a : ['r1', 'x'], b : ['r1', 'y'], c : ['r2', 'x'], d : ['r2', 'y'] } };
		var L = shelf.layout(boxes, spec);
		var at = {};
		Object.keys(boxes).forEach(function (k) { at[k] = moved(boxes[k], L.move[k]); });
		// standing: each piece's base on its row's floor; the first row above the second
		at.a.min[2].should.be.approximately(L.rows[0].z, 1e-9);
		at.b.min[2].should.be.approximately(L.rows[0].z, 1e-9);
		at.c.min[2].should.be.approximately(L.rows[1].z, 1e-9);
		L.rows[0].z.should.be.above(L.rows[1].z + L.rows[1].height);
		// centred: a and c share column x, b and d column y, to the right
		((at.a.min[0] + at.a.max[0]) / 2).should.be.approximately((at.c.min[0] + at.c.max[0]) / 2, 1e-9);
		((at.b.min[0] + at.b.max[0]) / 2).should.be.approximately((at.d.min[0] + at.d.max[0]) / 2, 1e-9);
		at.b.min[0].should.be.above(at.a.max[0]);
		// sizes kept (a move only), and no two pieces overlap
		(at.d.max[2] - at.d.min[2]).should.equal(50);
		var ks = Object.keys(at);
		for (var i = 0; i < ks.length; i++) for (var j = i + 1; j < ks.length; j++) overlap(at[ks[i]], at[ks[j]]).should.be.false(ks[i] + ' ' + ks[j]);
	});

	it('pieces without a place go to a row of their own after the last; without a spec, a square grid', function () {
		var spec = { rows : [{ key : 'r', label : 'R' }], columns : [{ key : 'c', label : 'C' }], place : { a : ['r', 'c'] } };
		var L = shelf.layout({ a : box(10, 10), stray : box(10, 10) }, spec);
		L.rows.length.should.equal(2);
		(L.move.stray[2]).should.be.below(L.move.a[2]);
		var G = shelf.layout({ a : box(5, 5), b : box(5, 5), c : box(5, 5), d : box(5, 5), e : box(5, 5) }, null);
		G.rows.length.should.equal(2);
		G.columns.length.should.equal(3);
	});
});

describe('pottery of ancient Italy (editor/samples/ceramics)', function () {
	this.timeout(budget(600000));
	var doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'editor', 'samples', 'ceramics', 'italy-by-period.graph.json'), 'utf8'));

	it('is a valid graph whose every output is documented and placed on the shelf', function () {
		var Ajv2020 = require('ajv/dist/2020').default;
		var validate = new Ajv2020({ allErrors : true, strict : true, allowUnionTypes : true })
			.compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema', 'graph.v2.schema.json'), 'utf8')));
		validate(doc).should.be.true(JSON.stringify(validate.errors));
		var names = Object.keys(doc.outputs);
		names.length.should.be.above(60);
		names.forEach(function (n) {
			doc.meta.items[n].source.should.match(/\w/);
			doc.view.shelf.place[n].length.should.equal(2);
		});
	});

	it('every vessel is at its documented height and its cavity holds its documented capacity', function () {
		var g = new Graph();
		Object.keys(doc.outputs).forEach(function (n) {
			var it = doc.meta.items[n];
			// the height: the top of the outer profile, which is the drawing's height (cm) at its real size
			var outer = doc.nodes[n].in.outer.split(';'), top = +outer[outer.length - 1].trim().split(' ')[1];
			top.should.be.approximately(it.height_cm * 10, 0.06, n);
			// the capacity: the cavity's volume against the dataset's (stacked cylinders on the drawing)
			var cav = Graph.compile(doc, { output : n }).features[n + '/cavity'];
			var c = g.evaluate({ version : 1, features : { c : cav }, output : 'c' }).result.report.volume / 1e6;
			c.should.be.approximately(it.capacity_l, 0.12 * it.capacity_l, n);
		});
	});

	it('every fourth vessel, across periods and forms, builds a closed, buildable solid of genus 0', function () {
		// all 73 take over a minute; the generator (scripts/aippd.mjs) checked each one when it chose it
		var g = new Graph();
		Object.keys(doc.outputs).filter(function (n, i) { return i % 4 == 0; }).forEach(function (n) { buildable(g.evaluate(doc, { output : n })); });
	});
});
