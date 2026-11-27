var should = require('should');
var path = require('path');
var esbuild = require('esbuild');
var verb = require('../dist/index.js');
var Graph = verb.Graph;

// A document's own components (`components`, used as "#name"), and the editor's making and unpacking of them
// (editor/components.ts).

var C;
before(function () {
	var out = esbuild.buildSync({ entryPoints : [path.join(__dirname, '..', 'editor', 'components.ts')], bundle : true, format : 'cjs', platform : 'node', write : false, logLevel : 'error' });
	var m = { exports : {} };
	new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
	C = m.exports;
});

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function volume(doc, output) { return new Graph().evaluate(doc, output ? { output : output } : {}).result.report.volume; }

// a plate with a hole and a rounded top ring, its width a number node outside what becomes the component
function plate() {
	return { version : 2, nodes : {
		w : { type : 'number', in : { value : 40 }, label : 'Width' },
		a : { type : 'primitive/box', in : { width : 'w', depth : 30, height : 8 } },
		b : { type : 'primitive/cylinder', in : { radius : 6, height : 20 } },
		bm : { type : 'transform/move', in : { of : '@b', x : 20, y : 15, z : -5 } },
		d : { type : 'boolean/difference', in : { from : '@a', minus : '@bm' } },
		r : { type : 'finish/round', in : { of : '@d', radius : 1, edges : 'a.+z|*', shape : 'chamfer' } } },
		outputs : { plate : '@r' },
		view : { nodes : { w : { x : 0, y : 0 }, a : { x : 300, y : 0 }, b : { x : 300, y : 200 }, bm : { x : 600, y : 200 }, d : { x : 900, y : 0 }, r : { x : 1200, y : 0 } } } };
}

describe('graph documents: their own components', function () {

	it('builds an instance of "#name" from the document\'s components, as the nodes themselves', function () {
		var inline = plate();
		var lib = { version : 2, nodes : { w : { type : 'number', in : { value : 10 } }, a : inline.nodes.a, b : inline.nodes.b, bm : inline.nodes.bm, d : inline.nodes.d },
			outputs : { body : '@d' } };
		var doc = { version : 2, nodes : { w : inline.nodes.w, p : { type : 'component', use : '#Plate', in : { w : '@w' } },
			r : { type : 'finish/round', in : { of : '@p.body', radius : 1, edges : 'p/a.+z|*', shape : 'chamfer' } } },
			outputs : { plate : '@r' }, components : { Plate : lib } };
		volume(doc).should.be.approximately(volume(inline), 1e-6);
		// the instance's width is the outer number node's
		doc.nodes.w.in.value = 50;
		var wide = clone(inline); wide.nodes.w.in.value = 50;
		volume(doc).should.be.approximately(volume(wide), 1e-6);
	});

	it('refuses a "#name" the library does not have, and a component with a library of its own', function () {
		var box = { version : 2, nodes : { a : { type : 'primitive/box' } }, outputs : { a : '@a' } };
		(function () { Graph.compile({ version : 2, nodes : { p : { type : 'component', use : '#Nope' } }, outputs : { p : '@p.a' }, components : { Box : box } }); })
			.should.throw(/"#Nope", which is not in the document's components \(Box\)/);
		var nested = clone(box); nested.components = { Box : box };
		(function () { Graph.compile({ version : 2, nodes : { p : { type : 'component', use : '#N' } }, outputs : { p : '@p.a' }, components : { N : nested } }); })
			.should.throw(/has a library of its own/);
		// a component of the library may use another of it
		var outer = { version : 2, nodes : { q : { type : 'component', use : '#Box' } }, outputs : { q : '@q.a' } };
		volume({ version : 2, nodes : { p : { type : 'component', use : '#Outer' } }, outputs : { p : '@p.q' }, components : { Box : box, Outer : outer } })
			.should.be.approximately(40 * 30 * 20, 1e-6);
		(function () { Graph.compile({ version : 2, nodes : { p : { type : 'component', use : '#L' } }, outputs : { p : '@p.q' },
			components : { L : { version : 2, nodes : { q : { type : 'component', use : '#L' } }, outputs : { q : '@q.q' } } } }); }).should.throw(/uses itself/);
	});

	it('hashes the library: a changed component changes the document\'s hash, and a document without one keeps its hash', function () {
		var box = { version : 2, nodes : { a : { type : 'primitive/box' } }, outputs : { a : '@a' } };
		var doc = { version : 2, nodes : { p : { type : 'component', use : '#Box' } }, outputs : { p : '@p.a' }, components : { Box : box } };
		var h = Graph.hash(doc);
		var changed = clone(doc); changed.components.Box.nodes.a.in = { width : 41 };
		Graph.hash(changed).should.not.equal(h);
		var moved = clone(doc); moved.components.Box.view = { nodes : { a : { x : 5, y : 5 } } };
		Graph.hash(moved).should.equal(h);
		Graph.hash(box).should.equal(Graph.hash(clone(box)));
	});

	it('takes components in its schema', function () {
		var s = Graph.schema();
		s.properties.components.additionalProperties.should.eql({ $ref : '#' });
		JSON.stringify(require('../schema/graph.v2.schema.json')).should.equal(JSON.stringify(s));
	});
});

describe('editor components (editor/components.ts)', function () {

	it('makes a component of a selection: the same solid, the outer width wired in, the faces it rounds renamed', function () {
		var doc = plate(), before = volume(doc);
		var m = C.makeComponent(doc, ['a', 'b', 'bm', 'd'], 'Plate body', {});
		m.name.should.equal('Plate_body');
		m.instance.should.equal('plate_body');
		var g = m.graph; g.components = { Plate_body : m.component };
		Object.keys(g.nodes).sort().should.eql(['plate_body', 'r', 'w']);
		g.nodes.plate_body.should.eql({ type : 'component', use : '#Plate_body', in : { w : '@w' }, label : 'Plate body' });
		g.nodes.r.in.of.should.equal('@plate_body.d');
		g.nodes.r.in.edges.should.equal('plate_body/a.+z|*');
		Object.keys(m.component.nodes).sort().should.eql(['a', 'b', 'bm', 'd', 'w']);
		m.component.nodes.w.should.eql({ type : 'number', in : { value : 40 }, label : 'Width' });
		m.component.outputs.should.eql({ d : '@d' });
		m.component.meta.name.should.equal('Plate body');
		var r = new Graph().evaluate(g);
		r.result.report.volume.should.be.approximately(before, 1e-6);
		r.verdict.kind.should.equal('buildable');
		// the chamfer still cuts: the renamed pattern selects the same edges
		var sharp = plate(); sharp.outputs = { plate : '@d' }; delete sharp.nodes.r;
		before.should.be.below(volume(sharp) - 1);
	});

	it('unpacks an instance back into the same nodes', function () {
		var doc = plate();
		var m = C.makeComponent(doc, ['a', 'b', 'bm', 'd'], 'Plate body', {});
		var lib = { Plate_body : m.component };
		var g = m.graph; g.components = lib;
		var u = C.unpack(g, 'plate_body', lib);
		Object.keys(u.nodes).sort().should.eql(['a', 'b', 'bm', 'd', 'r', 'w']);
		u.nodes.r.in.should.eql(doc.nodes.r.in);
		u.nodes.a.in.should.eql(doc.nodes.a.in);
		// the component's own copy of w was set by the instance from the outer w: unpacked, it is named apart and wired
		volume(u).should.be.approximately(volume(doc), 1e-6);
	});

	it('names unpacked nodes apart from those already there, inside expressions and patterns too', function () {
		var doc = plate();
		var m = C.makeComponent(doc, ['a', 'b', 'bm', 'd'], 'Plate', {});
		var lib = { Plate : m.component };
		var g = m.graph; g.components = lib;
		// a second instance next to the first: unpacking it renames its nodes, which the first one's still hold
		g.nodes.p2 = { type : 'component', use : '#Plate', in : { w : 30 } };
		g.nodes.u = { type : 'boolean/union', in : { a : '@r', b : '@mv' } };
		g.nodes.mv = { type : 'transform/move', in : { of : '@p2.d', x : 0, y : 100, z : 0 } };
		g.outputs = { both : '@u' };
		var v = volume(g);
		var u = C.unpack(g, 'p2', lib);
		u.nodes.mv.in.of.should.equal('@d');
		u.nodes.a.in.width.should.equal('w2');
		u.nodes.w2.in.value.should.equal(30);
		volume(u).should.be.approximately(v, 1e-6);
	});

	it('keeps a selected number node outside when something outside uses it, and refuses a selection that takes a solid', function () {
		var doc = plate();
		doc.nodes.h = { type : 'number', in : { value : 8 } };
		doc.nodes.a.in.height = 'h';
		doc.nodes.r.in.radius = 'h / 8';
		var m = C.makeComponent(doc, ['h', 'a', 'b', 'bm', 'd'], 'Body', {});
		should.exist(m.graph.nodes.h);
		m.graph.nodes.body.in.should.eql({ w : '@w', h : '@h' });
		(function () { C.makeComponent(doc, ['d', 'r'], 'Top', {}); }).should.throw(/"d" takes the solid of "a", which is not selected/);
		(function () { C.makeComponent(doc, ['w'], 'Top', {}); }).should.throw(/at least one solid/);
	});

	it('gives a selection nothing outside uses its last solids as outputs, and counts instances', function () {
		var doc = plate();
		var m = C.makeComponent(doc, ['a', 'b', 'bm', 'd', 'r'], 'Plate', {});
		m.component.outputs.should.eql({ r : '@r' });
		m.graph.outputs.should.eql({ plate : '@plate.r' });
		var g = m.graph; g.components = { Plate : m.component };
		g.nodes.again = { type : 'component', use : '#Plate' };
		C.usage(g).should.eql({ Plate : 2 });
		volume(g).should.be.approximately(volume(doc), 1e-6);
	});
});
