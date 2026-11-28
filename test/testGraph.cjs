var should = require('should');
var made = require('./support/made.cjs');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph, Model = lib.Model, Catalog = lib.Catalog;

// a box with a truncated cone taken out of it, its box edges rounded: the graph of docs/visual-programming.md
function sample() {
	return {
		version : 2,
		nodes : {
			h : { type : "number", in : { value : 24 }, label : "Height" },
			coneH : { type : "math/add", in : { a : "@h", b : 10 } },
			box : { type : "primitive/box", in : { width : 60, depth : 40, height : "@h" } },
			coneShape : { type : "primitive/cone", in : { radius : 13, height : "@coneH", top_radius : 6 } },
			cone : { type : "transform/move", in : { of : "@coneShape", z : -5 } },
			cut : { type : "boolean/difference", in : { from : "@box", minus : "@cone" } },
			round : { type : "finish/round", in : { of : "@cut", radius : 3, edges : "box.*|box.*" } },
		},
		outputs : { solid : "@round" },
		view : { nodes : { h : { x : 0, y : 0 } } },
	};
}

function zRange(mesh) {
	var lo = Infinity, hi = -Infinity;
	mesh.vertices.forEach(function(v){ lo = Math.min(lo, v[2]); hi = Math.max(hi, v[2]); });
	return [lo, hi];
}

// the frustum of the cone from z = -5 (radius 13) to z = h + 5 (radius 6), between z = 0 and z = h
function frustumInBox(h) {
	var r = function(z){ return 13 + (6 - 13) * (z + 5) / (h + 10); };
	var a = r(0), b = r(h);
	return Math.PI * h / 3 * (a * a + a * b + b * b);
}

describe("verb.model.Graph", function(){
	this.timeout(budget(120000));

	it('compiles into the model document a person would write, and builds the same solid bit for bit', function(){
		var m = Graph.compile(sample());
		m.parameters.should.be.eql({ h : 24, coneH : "(h) + (10)" });
		m.features.box.should.be.eql({ type : "box", min : [-30, -20, 0], max : [30, 20, "h"] });
		m.features.cone.should.be.eql({ type : "transform", of : "coneShape", translate : [0, 0, -5] });
		m.output.should.be.equal("round");
		var byGraph = new Graph().evaluate(sample()), byModel = new Model().evaluate(m);
		byGraph.faceNames.should.be.eql(byModel.faceNames);
		byGraph.result.mesh.vertices.should.be.eql(byModel.result.mesh.vertices);
		byGraph.result.mesh.triangles.should.be.eql(byModel.result.mesh.triangles);
	});

	it('takes the frustum out of the box exactly: the volume of the cut is the box less the frustum, to 0.5%', function(){
		var doc = sample();
		doc.outputs.solid = "@cut";
		var r = new Graph().evaluate(doc);
		made(r.verdict);
		var exact = 60 * 40 * 24 - frustumInBox(24);
		r.result.report.volume.should.be.approximately(exact, exact * 0.005);
		zRange(r.result.mesh)[0].should.be.approximately(0, 1e-9);
		zRange(r.result.mesh)[1].should.be.approximately(24, 1e-9);
	});

	it('rounds the twelve box edges and nothing else: the hole changes nothing at the edges, and the volume lost is the rolling ball\'s', function(){
		var g = new Graph();
		var cut = (function(){ var d = sample(); d.outputs.solid = "@cut"; return g.evaluate(d); })();
		var r = g.evaluate(sample());
		made(r.verdict);
		r.faceNames.filter(function(n){ return /^round\(box\./.test(n); }).length.should.be.equal(12);
		r.faceNames.filter(function(n){ return /^round\(.*cone/.test(n); }).length.should.be.equal(0);
		// the same box rounded with no hole loses the same volume: the cone is clear of every box edge
		var plain = new Graph().evaluate({ version : 2, nodes : { box : { type : "primitive/box", in : { width : 60, depth : 40, height : 24 } },
			round : { type : "finish/round", in : { of : "@box", radius : 3, edges : "box.*|box.*" } } }, outputs : { solid : "@round" } });
		var loss = cut.result.report.volume - r.result.report.volume, plainLoss = 60 * 40 * 24 - plain.result.report.volume;
		loss.should.be.approximately(plainLoss, plainLoss * 1e-6);
		// the exact loss is r²(1 − π/4) per length of straight edge and r³(1 − π/6) per corner; the volume is the
		// mesh's, whose chords cut inside the fillets, so it may only lose more, and by less than a tenth
		var rr = 3, exact = 4 * ((60 - 2 * rr) + (40 - 2 * rr) + (24 - 2 * rr)) * rr * rr * (1 - Math.PI / 4) + 8 * rr * rr * rr * (1 - Math.PI / 6);
		loss.should.be.within(exact, exact * 1.1);
	});

	it('rounds or chamfers the four edges around one face of a box, mitred where they meet, the third edge sharp (#93)', function(){
		var ring = function (shape, edges) {
			var r = new Graph().evaluate({ version : 2, nodes : { box : { type : "primitive/box", in : { width : 40, depth : 20, height : 30 } },
				r : { type : "finish/round", in : { of : "@box", radius : 1.5, edges : edges || "box.-y|*, *|box.-y", shape : shape } } }, outputs : { r : "@r" } }, { output : "r", mesh : "print" });
			made(r.verdict, (r.verdict.reasons || []).join("; "));
			r.result.report.manifold.closedManifold.should.be.true();
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			return 40 * 20 * 30 - r.result.report.volume;
		};
		// a mitred ring of chamfers: the section (r²/2) along each edge's length at the section's centroid, r/3 in from
		// each end; planar, so exact
		ring("chamfer").should.be.approximately(1.5 * 1.5 / 2 * (2 * (40 - 1) + 2 * (30 - 1)), 1e-9);
		// circular: the section r²(1 − π/4) at its centroid, r(10 − 3π)/(3(4 − π)) in from each end; the mesh's chords
		// cut inside the fillets, so it may only lose more, and by less than a tenth
		var rr = 1.5, c = rr * (10 - 3 * Math.PI) / (3 * (4 - Math.PI)), A = rr * rr * (1 - Math.PI / 4);
		var exact = A * (2 * (40 - 2 * c) + 2 * (30 - 2 * c));
		ring("circular").should.be.within(exact, exact * 1.1);
		// two of them: one mitre, and each runs out at its other end
		var two = A * (40 - c + 30 - c);
		ring("circular", "box.-y|box.+z, box.+x|box.-y").should.be.within(two, two * 1.1);
	});

	it('rebuilds only the nodes downstream of an edit, and nothing when nothing changed', function(){
		var g = new Graph(), doc = sample();
		var first = g.evaluate(doc);
		first.nodes.should.be.eql({ h : "parameter", coneH : "parameter", box : "built", coneShape : "built", cone : "built", cut : "built", round : "built" });
		doc.nodes.box.in.width = 80;
		g.evaluate(doc).nodes.should.be.eql({ h : "parameter", coneH : "parameter", box : "built", coneShape : "cached", cone : "cached", cut : "built", round : "built" });
		doc.view.nodes.h = { x : 300, y : 40 };
		doc.nodes.box.label = "Block";
		var again = g.evaluate(doc);
		Object.keys(again.nodes).filter(function(k){ return again.nodes[k] == "built"; }).should.be.eql([]);
		doc.nodes.h.in.value = 30;
		var taller = g.evaluate(doc);
		taller.nodes.box.should.be.equal("built");
		taller.nodes.coneShape.should.be.equal("built");
		zRange(taller.result.mesh)[1].should.be.approximately(30, 1e-9);
	});

	it('reads number nodes by wire, by "@id" or by name in an expression, through math nodes', function(){
		var doc = { version : 2, nodes : {
			h : { type : "number", in : { value : 7.5 } },
			twice : { type : "math/mul", in : { a : "@h.value", b : 2 } },
			half : { type : "expression", in : { expr : "twice / 4 + h" } },
			box : { type : "primitive/box", in : { width : "twice", depth : "@half", height : "max(h, 3) * 2" } },
		}, outputs : { solid : "@box" } };
		var r = new Graph().evaluate(doc);
		var v = r.result.mesh.vertices, ext = [0, 1, 2].map(function(i){
			return Math.max.apply(null, v.map(function(p){ return p[i]; })) - Math.min.apply(null, v.map(function(p){ return p[i]; }));
		});
		ext[0].should.be.approximately(15, 1e-9);
		ext[1].should.be.approximately(7.5 * 2 / 4 + 7.5, 1e-9);
		ext[2].should.be.approximately(15, 1e-9);
	});

	it('moves, rotates and scales exactly', function(){
		var doc = { version : 2, nodes : {
			b : { type : "primitive/box", in : { width : 10, depth : 20, height : 30 } },
			r : { type : "transform/rotate", in : { of : "@b", axis : "z", degrees : 90 } },
			s : { type : "transform/scale", in : { of : "@r", factor : 2 } },
			m : { type : "transform/move", in : { of : "@s", x : 5, y : -3, z : 1 } },
		}, outputs : { solid : "@m" } };
		var v = new Graph().evaluate(doc).result.mesh.vertices;
		[0, 1, 2].forEach(function(i, k){
			var lo = Math.min.apply(null, v.map(function(p){ return p[i]; })), hi = Math.max.apply(null, v.map(function(p){ return p[i]; }));
			lo.should.be.approximately([-15, -13, 1][k], 1e-9);
			hi.should.be.approximately([25, 7, 61][k], 1e-9);
		});
	});

	it('unites, intersects and shells: exact volumes of boxes', function(){
		var two = function(op, extra){
			var nodes = { a : { type : "primitive/box", in : { width : 20, depth : 20, height : 20 } },
				b0 : { type : "primitive/box", in : { width : 20, depth : 20, height : 20 } },
				b : { type : "transform/move", in : { of : "@b0", x : 10 } },
				op : { type : op, in : { a : "@a", b : "@b" } } };
			if (extra) nodes.out = extra;
			return new Graph().evaluate({ version : 2, nodes : nodes, outputs : { solid : extra ? "@out" : "@op" } }).result.report.volume;
		};
		two("boolean/union").should.be.approximately(30 * 20 * 20, 1e-6);
		two("boolean/intersection").should.be.approximately(10 * 20 * 20, 1e-6);
		var cup = new Graph().evaluate({ version : 2, nodes : { a : { type : "primitive/box", in : { width : 20, depth : 20, height : 20 } },
			cup : { type : "finish/shell", in : { of : "@a", thickness : 2, open : "a.+z" } } }, outputs : { solid : "@cup" } });
		made(cup.verdict);
		cup.result.report.volume.should.be.approximately(20 * 20 * 20 - 16 * 16 * 18, 1e-6);
	});

	it('refuses text and choices of the wrong kind', function(){
		var doc = function(n){ return { version : 2, nodes : { b : { type : "primitive/box" }, r : n }, outputs : { solid : "@r" } }; };
		(function(){ Graph.compile(doc({ type : "finish/round", in : { of : "@b", edges : 3 } })); }).should.throw(/"r.edges" must be text/);
		(function(){ Graph.compile(doc({ type : "finish/round", in : { of : "@b", edges : " , " } })); }).should.throw(/"r.edges" names no edges/);
		(function(){ Graph.compile(doc({ type : "transform/move", in : { of : "@b", x : true } })); }).should.throw(/"r.x" must be a number or an expression/);
		(function(){ Graph.compile(doc({ type : "expression", in : { expr : "q + 1" } })); }).should.throw(/"r.expr" uses "q"/);
		(function(){ Graph.compile({ version : 2, nodes : { b : { type : "primitive/box" } }, outputs : {} }); }).should.throw(/the document has no outputs/);
	});

	it('refuses a wrong document with a message that names the node and the port', function(){
		var bad = function(edit){ var d = sample(); edit(d); return function(){ Graph.compile(d); }; };
		bad(function(d){ d.nodes.box.in.height = "@cone"; }).should.throw(/"box.height" takes a number, but "cone.solid" is a solid/);
		bad(function(d){ d.nodes.cut.in.minus = "@h"; }).should.throw(/"cut.minus" takes a solid, but "h.value" is a number/);
		bad(function(d){ d.nodes.cut.in.minus = "@nothing"; }).should.throw(/refers to "nothing", which is not a node/);
		bad(function(d){ d.nodes.cut.in.minus = "@cone.volume"; }).should.throw(/"cone.volume", which is not an output/);
		bad(function(d){ delete d.nodes.cut.in.minus; }).should.throw(/"cut.minus" \(minus\) needs a solid/);
		bad(function(d){ d.nodes.box.in.colour = 1; }).should.throw(/node "box" \(primitive\/box\) has no input "colour"/);
		bad(function(d){ d.nodes.box.type = "primitive/teapot"; }).should.throw(/unknown type "primitive\/teapot"/);
		bad(function(d){ d.nodes.box.in.width = "w * 2"; }).should.throw(/"box.width" uses "w", which is not a number node/);
		bad(function(d){ d.nodes.pi = { type : "number", in : { value : 3 } }; }).should.throw(/"pi" is a function or constant/);
		bad(function(d){ d.nodes["2box"] = d.nodes.box; }).should.throw(/not a valid node id/);
		bad(function(d){ d.nodes.round.in.shape = "wavy"; }).should.throw(/"round.shape" must be one of circular, curvature, chamfer/);
		bad(function(d){ d.outputs.solid = "@h"; }).should.throw(/the output "solid" is "@h", not a reference to a solid node/);
		(function(){ new Graph().evaluate({ version : 3, nodes : {}, outputs : {} }); }).should.throw(/unknown document version 3/);
	});

	it('refuses a cycle between number nodes', function(){
		var doc = { version : 2, nodes : {
			a : { type : "math/add", in : { a : "@b", b : 1 } },
			b : { type : "math/add", in : { a : "@a", b : 1 } },
			box : { type : "primitive/box", in : { width : "@a" } },
		}, outputs : { solid : "@box" } };
		(function(){ new Graph().evaluate(doc); }).should.throw(/cycle|itself/);
	});

	it('evaluates version 1 model documents as they are', function(){
		var doc = { version : 1, parameters : { w : 30 }, features : {
			block : { type : "box", min : [0, 0, 0], max : ["w", 20, 10] },
			peg : { type : "cylinder", from : [15, 10, 5], to : [15, 10, 25], radius : 4 },
			body : { type : "union", of : ["block", "peg"] } }, output : "body" };
		var g = new Graph().evaluate(doc), m = new Model().evaluate(doc);
		g.faceNames.should.be.eql(m.faceNames);
		g.result.mesh.vertices.should.be.eql(m.result.mesh.vertices);
		g.nodes.should.be.eql({ block : "built", peg : "built", body : "built" });
		g.model.should.be.equal(doc);
	});

	it('has one primitive node per catalogued shape, with the catalogue\'s parameters as its ports', function(){
		var names = [];
		Catalog.ENTRIES.forEach(function(e){ if (names.indexOf(e.name) < 0) names.push(e.name); });
		var prims = Object.keys(Graph.REGISTRY).filter(function(k){ return k.indexOf("primitive/") == 0; });
		prims.length.should.be.equal(names.length);
		names.forEach(function(name){
			var e = Catalog.entry(name);
			var t = prims.map(function(k){ return Graph.REGISTRY[k]; }).filter(function(t){ return t.title.toLowerCase() == name.toLowerCase(); })[0];
			should.exist(t, name);
			Object.keys(t.inputs).map(function(k){ return t.inputs[k].label; }).should.be.eql(e.parameters.map(function(p){ return p.name; }));
		});
	});

	it('builds catalogue primitives from their default ports as closed solids of the catalogue\'s volume', function(){
		["primitive/sphere", "primitive/star-prism", "primitive/torus", "primitive/truncated-cube"].forEach(function(type){
			var r = new Graph().evaluate({ version : 2, nodes : { p : { type : type } }, outputs : { solid : "@p" } });
			r.verdict.checks.filter(function(c){ return c.name == "closed"; })[0].passed.should.be.true();
			var direct = lib.Primitives.volume(Catalog.build(Graph.REGISTRY[type].title.replace(/^./, function(c){ return c.toLowerCase(); })));
			r.result.report.volume.should.be.approximately(direct, Math.abs(direct) * 0.01);
		});
	});
});
