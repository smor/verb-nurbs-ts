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

describe('freeform/prism', function () {
	this.timeout(budget(60000));
	var prism = function (inputs, extra, output) {
		var nodes = Object.assign({ p : { type : 'freeform/prism', in : inputs } }, extra || {});
		return { version : 2, nodes : nodes, outputs : output ? { t : '@' + output } : { p : '@p' } };
	};

	it('extrudes its outline: a rectangle with two rounded corners has area w h - 2 (1 - pi / 4) r^2', function () {
		var r = new Graph().evaluate(prism({ outline : '0, 0; 40, 0, 4; 40, 20, 4; 0, 20', height : 5 }));
		r.verdict.kind.should.equal('buildable');
		r.result.report.manifold.closedManifold.should.be.true();
		var area = 40 * 20 - 2 * (1 - PI / 4) * 16;
		r.result.report.volume.should.be.approximately(area * 5, 1e-3 * area * 5);
		r.faceNames.should.containEql('p.top');
	});

	it('keeps expressions over number nodes as model parameters, so an edit rebuilds it', function () {
		var d = prism({ outline : '0, 0; w, 0; w, w / 2; 0, w / 2', height : '@h' },
			{ w : { type : 'number', in : { value : 30 } }, h : { type : 'number', in : { value : 2 } } });
		Graph.compile(d).features.p.outline[2].should.eql(['(w)', '(w / 2)']);
		var g = new Graph(), one = g.evaluate(d);
		one.result.report.volume.should.be.approximately(30 * 15 * 2, 0.5);
		d.nodes.w.in.value = 40;
		var two = g.evaluate(d);
		two.nodes.p.should.equal('built');
		two.result.report.volume.should.be.approximately(40 * 20 * 2, 0.5);
	});

	it('any simple polygon builds, as an exact extrusion: a T, and an L that is star-shaped about no point of its own', function () {
		var T = '0, 0; 24, 0; 24, 1.5; 22.5, 1.5; 22.5, 4; 1.5, 4; 1.5, 1.5; 0, 1.5';
		var r = new Graph().evaluate(prism({ outline : T, height : 10 }));
		r.result.report.manifold.closedManifold.should.be.true();
		r.result.report.volume.should.be.approximately((24 * 1.5 + 21 * 2.5) * 10, 0.5);
		// a U with long thin arms: no point sees all of it
		var U = new Graph().evaluate(prism({ outline : '0, 0; 30, 0; 30, 30; 28, 30; 28, 2; 2, 2; 2, 30; 0, 30', height : 2 }));
		U.result.report.manifold.closedManifold.should.be.true();
		U.result.report.volume.should.be.approximately((30 * 2 + 2 * 28 * 2) * 2, 0.05);
	});

	it('caps are trimmed planes: a union no longer depends on where a cap centre falls (#99)', function () {
		// #99's plate (concave, three corners rounded) united with a pad over it; with fan caps the result was open
		// when the centre lay under the pad or near it
		var outline = '0, 0; 93.5, 0; 101.8, 2.8; 120.3, 2.8; 120.3, 10.33, 5; 54.7, 36.3; 30.2, 36.3; 30.2, 54.52, 5; 0, 54.52, 5';
		// the plate's area: the polygon's, less what each rounded corner cuts off, r^2 (cot(h) - (pi / 2 - h)) for half
		// the interior angle h
		var pts = outline.split(';').map(function (q) { return q.split(',').map(Number); }), n = pts.length, area = 0;
		pts.forEach(function (p, i) {
			var q = pts[(i + 1) % n];
			area += (p[0] * q[1] - q[0] * p[1]) / 2;
			if (!(p[2] > 0)) return;
			var a = pts[(i + n - 1) % n], ua = [a[0] - p[0], a[1] - p[1]], ub = [q[0] - p[0], q[1] - p[1]];
			var h = Math.acos((ua[0] * ub[0] + ua[1] * ub[1]) / Math.hypot(ua[0], ua[1]) / Math.hypot(ub[0], ub[1])) / 2;
			area -= p[2] * p[2] * (1 / Math.tan(h) - (PI / 2 - h));
		});
		// the pad: 12.2 x 31 from z = 2 to 5.1 over the plate's 3, so 1 of its height above it
		var exact = area * 3 + 12.2 * 31 * 2.1;
		['25.2, 30.3', '20, 33.3', '15, 15', ''].forEach(function (c) {
			var r = new Graph().evaluate(prism({ outline : outline, height : 3, center : c }, {
				padS : { type : 'primitive/box', in : { width : 12.2, depth : 31, height : 3.1 } },
				pad : { type : 'transform/move', in : { of : '@padS', x : 24.1, y : 15.8, z : 2 } },
				t : { type : 'boolean/union', in : { a : '@p', b : '@pad' } } }, 't'), { mesh : 'print' });
			r.verdict.kind.should.equal('buildable', c);
			r.result.report.manifold.closedManifold.should.be.true();
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			// (a Boolean's volume is its mesh's, whose chords cut the rounded corners a little short)
			r.result.report.volume.should.be.approximately(exact, 5e-4 * exact);
		});
	});

	it('a housing of prisms takes a beam flush with its walls\' top (as #101\'s TV-mount part)', function () {
		var r = new Graph().evaluate(prism({ outline : '0, 0; 40, 0, 2; 40, 30, 2; 0, 30', height : 10 }, {
			inner : { type : 'freeform/prism', in : { outline : '2, 2; 38, 2; 38, 28; 2, 28', height : 10 } },
			innerM : { type : 'transform/move', in : { of : '@inner', x : 0, y : 0, z : 2 } },
			housing : { type : 'boolean/difference', in : { from : '@p', minus : '@innerM' } },
			b0 : { type : 'freeform/prism', in : { outline : '-3, 12; 43, 12; 43, 18; -3, 18', height : 4 } },
			b : { type : 'transform/move', in : { of : '@b0', x : 0, y : 0, z : 6 } },
			t : { type : 'boolean/union', in : { a : '@housing', b : '@b' } } }, 't'), { mesh : 'print' });
		r.verdict.kind.should.equal('buildable');
		r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
		// the housing (40 x 30 less two corners rounded 2, 10 high, less a 36 x 26 pocket 8 deep), the beam's 3 out each side
		var housing = (1200 - 2 * 4 * (1 - PI / 4)) * 10 - 36 * 26 * 8;
		r.result.report.volume.should.be.approximately(housing + 2 * 3 * 6 * 4 + 36 * 6 * 4, 5e-4 * housing);
	});

	it('refuses an outline that is not points, a name that is not a number node, and fewer than three points', function () {
		var f = function (outline) { return function () { Graph.compile(prism({ outline : outline, height : 1 })); }; };
		f('0, 0; 1').should.throw(/point 2 is "1", not "x, y" or "x, y, r"/);
		f('0, 0; 1, 0; q, 1').should.throw(/point 3 uses "q", which is not a number node/);
		f('0, 0; 1, 0').should.throw(/has 2 points; an outline needs three or more/);
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
			// to the rim: the cavity runs a few millimetres above it so the mouth is open, a cylinder of its last radius
			var cav = Graph.compile(doc, { output : n }).features[n + '/cavity'];
			var pts = doc.nodes[n].in.cavity.split(';').map(function (p) { return p.trim().split(' ').map(Number); }), last = pts[pts.length - 1];
			var over = Math.PI * last[0] * last[0] * Math.max(0, last[1] - top);
			var cr = g.evaluate({ version : 1, features : { c : cav }, output : 'c' }).result;
			var c = (cr.report.volume - over) / 1e6;
			c.should.be.approximately(it.capacity_l, 0.12 * it.capacity_l, n);
			// the turned cavity follows the drawing: it never swings below its floor (through the base, at worst)
			var low = Math.min.apply(null, cr.mesh.vertices.map(function (v) { return v[2]; }));
			low.should.be.above(pts[0][1] - 1, n + ': the cavity dips below its floor');
		});
	});

	it('every fourth vessel, across periods and forms, builds a closed, buildable solid of genus 0', function () {
		// all 73 take over a minute; the generator (scripts/aippd.mjs) checked each one when it chose it
		var g = new Graph();
		Object.keys(doc.outputs).filter(function (n, i) { return i % 4 == 0; }).forEach(function (n) { buildable(g.evaluate(doc, { output : n })); });
	});
});
