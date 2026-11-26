var should = require('should');
var fs = require('fs');
var path = require('path');
var Ajv2020 = require('ajv/dist/2020').default;
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph;

// The freeform nodes (freeform/revolve, freeform/pipe) and their function ports: expressions of t, 0 to 1, sampled
// into the model's revolve profile and pipe rail. And the editor's freeform samples (editor/samples), which must build.

var PI = Math.PI;
var doc = function (nodes, out) { return { version : 2, nodes : nodes, outputs : { solid : '@' + out } }; };
var build = function (d, options) {
	var r = new Graph().evaluate(d, options);
	r.verdict.kind.should.equal('buildable', (r.verdict.reasons || []).join('; '));
	r.result.report.manifold.closedManifold.should.be.true();
	return r;
};

describe('freeform nodes', function () {
	this.timeout(budget(60000));

	it('a revolve whose radius is linear in t is the frustum: volume pi h (R^2 + R r + r^2) / 3', function () {
		var r = build(doc({ f : { type : 'freeform/revolve', in : { radius : '15 - 6 * t', height : 40, samples : 6 } } }, 'f'));
		var R = 15, q = 9, h = 40;
		r.result.report.volume.should.be.approximately(PI * h * (R * R + R * q + q * q) / 3, 5e-3 * PI * h * R * R);
		r.result.report.manifold.genus.should.equal(0);
	});

	it('a revolve follows its radius function between samples: a bulb within 1% of the integral of pi r(z)^2', function () {
		var f = function (t) { return 18 + 7 * Math.sin(PI * (1.4 * t + 0.1)) - 6 * t; };
		var r = build(doc({ f : { type : 'freeform/revolve', in : { height : 90 } } }, 'f'));  // the default radius and 14 samples
		var n = 2000, v = 0;
		for (var i = 0; i < n; i++) { var t = (i + 0.5) / n; v += PI * f(t) * f(t) * 90 / n; }
		r.result.report.volume.should.be.approximately(v, 0.01 * v);
	});

	it('a pipe along a straight line is a cylinder, and along a helix has volume pi r^2 times the arc length', function () {
		var line = build(doc({ p : { type : 'freeform/pipe', in : { x : '0', y : '0', z : '50 * t', radius : 4, samples : 5 } } }, 'p'));
		line.result.report.volume.should.be.approximately(PI * 16 * 50, 5e-3 * PI * 16 * 50);
		// the default: radius 25, one and a half turns, rising 70; the curve's curvature radius stays above the tube's
		var helix = build(doc({ p : { type : 'freeform/pipe' } }, 'p'));
		var L = Math.sqrt(Math.pow(2 * PI * 25 * 1.5, 2) + 70 * 70);
		helix.result.report.volume.should.be.approximately(PI * 9 * L, 0.01 * PI * 9 * L);
	});

	it('function ports keep the number nodes they name, so the model stays parametric and an edit rebuilds only what follows', function () {
		var d = doc({
			h : { type : 'number', in : { value : 30 } },
			a : { type : 'number', in : { value : 10 } },
			f : { type : 'freeform/revolve', in : { radius : 'a + 2 * sin(pi * t)', height : '@h', samples : 5 } },
			p : { type : 'freeform/pipe', in : { x : '0', y : '0', z : 'h * t', radius : 2 } },
		}, 'f');
		var model = Graph.compile(d);
		model.features.f.profile.length.should.equal(5);
		model.features.f.profile[2][0].should.equal('(a + 2 * sin(pi * (0.5)))');
		model.features.f.profile[4][1].should.equal('(h) * 1');
		model.features.p.through.length.should.equal(24);
		var g = new Graph(), one = g.evaluate(d);
		d.nodes.a.in.value = 12;
		var two = g.evaluate(d);
		two.nodes.f.should.equal('built');
		two.result.report.volume.should.be.above(one.result.report.volume * 1.3);
		// a variable hides a number node of the same id
		var hidden = doc({ t : { type : 'number', in : { value : 100 } },
			f : { type : 'freeform/revolve', in : { radius : '10 + 0 * t', height : 20, samples : 3 } } }, 'f');
		build(hidden).result.report.volume.should.be.approximately(PI * 100 * 20, 5e-3 * PI * 100 * 20);
	});

	it('refuses an unknown name in a function, and samples that are not a whole number written as one', function () {
		var f = function (inputs) { return function () { Graph.compile(doc({ f : { type : 'freeform/revolve', in : inputs } }, 'f')); }; };
		f({ radius : '10 + s' }).should.throw(/"f.radius" uses "s", which is neither t nor a number node/);
		f({ samples : 2.5 }).should.throw(/"f.samples" must be a whole number from 2 to 64/);
		f({ samples : 65 }).should.throw(/"f.samples" must be a whole number/);
		f({ samples : 'h' }).should.throw(/written as a number/);
		f({ radius : '' }).should.throw(/must be an expression of t/);
	});
});

describe('editor freeform samples (editor/samples)', function () {
	this.timeout(budget(120000));
	var dir = path.join(__dirname, '..', 'editor', 'samples');
	var ajv = new Ajv2020({ allErrors : true, strict : true, allowUnionTypes : true });
	var validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema', 'graph.v2.schema.json'), 'utf8')));
	// the genus of each: the vase's two handles, the column's three free vines
	var genus = { 'art-nouveau-vase' : 2, 'vine-column' : 3, 'fern-sprout' : 0, 'tulip-lamp' : 0 };

	Object.keys(genus).forEach(function (name) {
		it(name + ' is a valid graph that builds a closed 2-manifold of genus ' + genus[name], function () {
			var d = JSON.parse(fs.readFileSync(path.join(dir, name + '.graph.json'), 'utf8'));
			validate(d).should.be.true(JSON.stringify(validate.errors));
			var r = build(d);
			r.result.report.manifold.genus.should.equal(genus[name]);
		});
	});

	it('the vase is hollow: its volume is its body less a cavity that follows it, plus the handles', function () {
		var d = JSON.parse(fs.readFileSync(path.join(dir, 'art-nouveau-vase.graph.json'), 'utf8'));
		var g = new Graph();
		var body = g.evaluate(d, { output : '@body' }).result.report.volume;
		var cavity = g.evaluate(d, { output : '@cavity' }).result.report.volume;
		var handles = g.evaluate(d, { output : '@handles' }).result.report.volume;
		var vessel = g.evaluate(d, { output : '@vessel' }).result.report.volume;
		var vase = g.evaluate(d).result.report.volume;
		// the cavity reaches above the rim, so the vessel is the body less the cavity's part below the rim
		vessel.should.be.below(body - cavity * 0.95);
		vessel.should.be.above(0.1 * body);
		// the handles reach into the wall, so the union adds less than their whole volume
		vase.should.be.above(vessel);
		vase.should.be.below(vessel + handles);
	});
});
