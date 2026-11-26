var should = require('should');
var fs = require('fs');
var path = require('path');
var Ajv2020 = require('ajv/dist/2020').default;
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph;

// The document formats of docs/formats.md: the checked-in schemas, the fixtures, and the stability rules.

var root = path.join(__dirname, '..');
var read = function (p) { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); };
var fixtures = path.join('test', 'fixtures', 'formats');
var graphs = fs.readdirSync(path.join(root, fixtures)).filter(function (f) { return f.endsWith('.graph.json'); });

var ajv = new Ajv2020({ allErrors : true, strict : true, allowUnionTypes : true });
var graphSchema = read('schema/graph.v2.schema.json');
var modelSchema = read('schema/model.v1.schema.json');
var validGraph = ajv.compile(graphSchema);
var validModel = ajv.compile(modelSchema);

function ok(validate, doc) {
	var r = validate(doc);
	if (!r) throw new Error(ajv.errorsText(validate.errors));
	return r;
}
function crank() { return read(path.join(fixtures, 'crank.graph.json')); }

describe("Document formats (docs/formats.md)", function () {

	it('the checked-in graph schema is the one the registry makes', function () {
		// regenerate with `npm run build && npm run schema`, which may only add node types and ports (see the next test)
		JSON.parse(JSON.stringify(Graph.schema())).should.eql(graphSchema);
	});

	it('every released node type, port, kind and default is still there, unchanged', function () {
		// the stability rule: a released type or port is never removed, renamed, retyped, or given another default.
		// Such a change needs graph version 3 and an upgrade from 2.
		var now = Graph.schema().$defs;
		var released = graphSchema.$defs;
		Object.keys(released).forEach(function (k) {
			should.exist(now[k], 'node type ' + k + ' was removed');
			if (k == 'node') return;
			var was = released[k].properties.in.properties, is = now[k].properties.in.properties;
			Object.keys(was).forEach(function (p) {
				should.exist(is[p], k + '.' + p + ' was removed');
				var a = was[p], b = is[p];
				should(b.type).eql(a.type, k + '.' + p + ' changed kind');
				should(b.enum).eql(a.enum, k + '.' + p + ' changed its options');
				should(b.default).eql(a.default, k + '.' + p + ' changed its default');
			});
		});
	});

	graphs.forEach(function (file) {
		it('fixture ' + file + ': valid, and compiles to its checked-in model documents, which are valid', function () {
			var g = read(path.join(fixtures, file));
			var models = read(path.join(fixtures, file.replace('.graph.json', '.models.json')));
			ok(validGraph, g);
			Object.keys(models).should.eql(Object.keys(g.outputs));
			Object.keys(g.outputs).forEach(function (o) {
				var m = Graph.compile(g, { output : o });
				ok(validModel, m);
				// the compiled form is part of the format: a change here changes what a saved file builds
				JSON.parse(JSON.stringify(m)).should.eql(models[o]);
			});
		});
	});

	it('the graph schema and compile refuse the same malformed documents', function () {
		var bad = [
			function (g) { g.extra = 1; },                                            // a key the format does not have
			function (g) { g.nodes.disc.type = 'primitive/gear'; },                   // an unknown node type
			function (g) { g.nodes.disc.in.radius_ = 3; },                            // an unknown port
			function (g) { g.nodes['dash-id'] = { type : 'number' }; },               // a node id with "-"
			function (g) { g.outputs = {}; },                                         // no outputs
			function (g) { g.outputs['1st'] = '@flywheel'; },                         // an output name starting with a digit
			function (g) { g.outputs.flywheel = 'flywheel'; },                        // an output that is not a reference
			function (g) { g.version = 3; },
		];
		bad.forEach(function (edit, i) {
			var g = crank();
			edit(g);
			validGraph(g).should.equal(false, 'schema accepted bad document ' + i);
			(function () { Graph.compile(g); }).should.throw(/Graph:/, { message : 'compile accepted bad document ' + i });
		});
		// what only compile checks: references
		var g = crank();
		g.outputs.flywheel = '@crank';
		ok(validGraph, g);
		(function () { Graph.compile(g); }).should.throw(/output "flywheel".*not a reference to a solid node/);
	});

	it('several outputs: each builds its own part, to the analytic volume, and both are printable', function () {
		this.timeout(budget(60000));
		var graph = new Graph(), g = crank();
		var fly = graph.evaluate(g);
		fly.output.should.equal('flywheel');
		// disc less the bore, plus the pin standing 8 mm above the disc (it sinks 1 mm into it)
		var flyExact = Math.PI * (35 * 35 * 6 - 2.7 * 2.7 * 6 + 2.5 * 2.5 * 8);
		fly.result.report.volume.should.be.approximately(flyExact, flyExact * 0.005);
		var rod = graph.evaluate(g, { output : 'connecting-rod' });
		rod.output.should.equal('connecting-rod');
		// the bar (rod + 12) × 10 × 4, less two eyes of radius pinR + clearance
		var rodExact = 84 * 10 * 4 - 2 * Math.PI * 2.7 * 2.7 * 4;
		rod.result.report.volume.should.be.approximately(rodExact, rodExact * 0.005);
		// the graph names a machine, so the verdict checks each part against it
		[fly, rod].forEach(function (r) {
			r.verdict.kind.should.equal('buildable');
			should.exist(r.verdict.checks.find(function (c) { return c.name == 'makeable' && c.passed; }));
		});
		rod.nodes.flywheel.should.equal('unused');
		rod.nodes.connectingRod.should.equal('built');
		// one graph keeps both parts: going back to the flywheel builds nothing
		var back = graph.evaluate(g, { output : 'flywheel' });
		Object.keys(back.features).forEach(function (id) { back.features[id].built.should.equal(false, id); });
	});

	it('set: a caller gives number nodes their values, and only the parts that read them change', function () {
		this.timeout(budget(60000));
		var graph = new Graph(), g = crank();
		var rod = graph.evaluate(g, { output : 'connecting-rod', set : { rod : 90 } });
		// 18 mm longer
		var exact = 102 * 10 * 4 - 2 * Math.PI * 2.7 * 2.7 * 4;
		rod.result.report.volume.should.be.approximately(exact, exact * 0.005);
		rod.parameters.rod.should.equal(90);
		// the crank radius moves the pin, not the rod: setting it rebuilds nothing of the rod
		var again = graph.evaluate(g, { output : 'connecting-rod', set : { rod : 90, crank : 25 } });
		Object.keys(again.features).forEach(function (id) { again.features[id].built.should.equal(false, id); });
		// the document itself is left as it was
		g.nodes.rod.in.value.should.equal(72);
		(function () { Graph.compile(g, { set : { disc : 3 } }); }).should.throw(/cannot set "disc", which is not a number node/);
		(function () { Graph.compile(g, { set : { nothing : 3 } }); }).should.throw(/cannot set "nothing"/);
	});

	it('an output by reference previews any solid node, and an unknown output name is refused', function () {
		var g = crank();
		Graph.compile(g, { output : '@bar' }).output.should.equal('bar');
		(function () { Graph.compile(g, { output : 'crankshaft' }); }).should.throw(/no output "crankshaft" \(flywheel, connecting-rod\)/);
		(function () { Graph.compile(g, { output : '@crank' }); }).should.throw(/not a reference to a solid node/);
	});

	it('meta and view change nothing that is built', function () {
		var a = crank(), b = crank();
		b.meta = { name : 'renamed', author : 'someone' };
		b.view = { nodes : { disc : { x : 1, y : 2 } }, show : 'bar' };
		Graph.compile(b).should.eql(Graph.compile(a));
	});

	it('the model schema accepts the documents of every feature type', function () {
		var doc = {
			version : 1, parameters : { w : 20, h : 'w / 2' }, machine : 'fdm', certify : false,
			features : {
				b : { type : 'box', min : [0, 0, 0], max : ['w', 'w', 'h'], divs : 2 },
				c : { type : 'cylinder', from : [10, 10, -1], to : [10, 10, 11], radius : 3, divs : [8, 2] },
				p : { type : 'pipe', through : [[0, 0, 0], [0, 0, 10]], radius : 1 },
				r : { type : 'revolve', profile : [[0, 0], [5, 0], [5, 5], [0, 5]] },
				q : { type : 'primitive', shape : 'torus', values : { 'major radius' : 10 } },
				t : { type : 'transform', of : 'q', scale : 2, rotate : { axis : [0, 0, 1], degrees : 30, about : [0, 0, 0] }, translate : [1, 2, 3] },
				u : { type : 'union', of : ['b', 'c'] },
				i : { type : 'intersection', of : ['b', 'r'] },
				d : { type : 'difference', from : 'b', minus : ['c'] },
				f : { type : 'round', of : 'd', rules : [{ edges : 'b.*|c.*', radius : 1 }], shape : 'circular', corner : 'auto' },
				s : { type : 'shell', of : 'b', thickness : 1, open : ['b.+z'] },
				l : { type : 'lattice', of : 'b', pattern : 'gyroid', cell : 5, wall : 0.6, skin : 1, grade : { axis : 'z', to : 1 }, open : [] },
			},
			output : 'f',
		};
		ok(validModel, doc);
		var bad = JSON.parse(JSON.stringify(doc));
		bad.features.f.shape = 'oval';
		validModel(bad).should.equal(false);
		bad = JSON.parse(JSON.stringify(doc));
		bad.features['a.b'] = bad.features.b;
		validModel(bad).should.equal(false);
	});
});
