var should = require('should');
var verb = require('../dist/index.js');
var Graph = verb.Graph, Model = verb.Model;

// Looks (look/material, look/band, look/motif): what a solid is made of and how it is painted. They change nothing
// that is built; the result says which faces each one covers.

// a glazed pot, a band painted over the glaze, and a hole whose cutter is a bare metal rod
function pot() {
	return { version : 2, nodes : {
		c : { type : 'primitive/cylinder', in : { radius : 20, height : 40 } },
		m : { type : 'look/material', in : { of : '@c', color : '#15110e', roughness : 0.35, clearcoat : 0.4 } },
		b : { type : 'look/band', in : { of : '@m', color : '#b5653a', from : 0.4, to : 0.5 } },
		h : { type : 'primitive/cylinder', in : { radius : 5, height : 60 } },
		hm : { type : 'transform/move', in : { of : '@h', z : -10 } },
		hl : { type : 'look/material', in : { of : '@hm', color : '#c0c0c0', metalness : 1 } },
		d : { type : 'boolean/difference', in : { from : '@b', minus : '@hl' } } },
		outputs : { pot : '@d' } };
}
function bare() {
	var d = pot();
	d.nodes.d.in = { from : '@c', minus : '@hm' };
	['m', 'b', 'hl'].forEach(function (k) { delete d.nodes[k]; });
	return d;
}

describe('looks: materials and paint (look/*)', function () {

	it('change nothing that is built: the same model, the same solid', function () {
		Graph.compile(pot()).should.eql(Graph.compile(bare()));
		var g = new Graph();
		var a = g.evaluate(bare()), b = g.evaluate(pot());
		b.result.report.volume.should.equal(a.result.report.volume);
		// from the cache: a look is not a feature
		b.nodes.d.should.equal('cached');
		should.not.exist(a.looks);
	});

	it('cover the faces that come from their solid, innermost first, a band after the material it is painted over', function () {
		var r = new Graph().evaluate(pot());
		r.looks.map(function (l) { return l.id; }).should.eql(['m', 'b', 'hl']);
		var names = function (l) { return l.faces.map(function (i) { return r.faceNames[i]; }).sort(); };
		names(r.looks[0]).should.eql(['c.end cap', 'c.start cap', 'c.tube']);
		names(r.looks[1]).should.eql(names(r.looks[0]));
		names(r.looks[2]).should.eql(['hm/h.tube']);
		r.looks[0].values.should.eql({ color : '#15110e', roughness : 0.35, metalness : 0, clearcoat : 0.4, grain : 0.3 });
		r.looks[1].kind.should.equal('band');
	});

	it('take expressions, and pass their solid on to an output and to what is made from them', function () {
		var d = pot();
		d.nodes.t = { type : 'number', in : { value : 0.2 } };
		d.nodes.b.in.from = 't';
		d.nodes.b.in.to = 't * 2';
		d.outputs = { banded : '@b' };
		var r = new Graph().evaluate(d);
		r.result.report.volume.should.be.approximately(Math.PI * 400 * 40, 0.002 * Math.PI * 400 * 40);
		r.looks.find(function (l) { return l.id == 'b'; }).values.should.containEql({ from : 0.2, to : 0.4 });
		// the rod's look does not reach this output
		r.looks.map(function (l) { return l.id; }).should.eql(['m', 'b']);
	});

	it("follow a component's instances, named under them", function () {
		var doc = { version : 2, nodes : { p : { type : 'component', use : '#Pot' }, q : { type : 'component', use : '#Pot' },
			qm : { type : 'transform/move', in : { of : '@q.pot', x : 100 } }, u : { type : 'boolean/union', in : { a : '@p.pot', b : '@qm' } } },
			outputs : { both : '@u' }, components : { Pot : pot() } };
		var r = new Graph().evaluate(doc);
		r.looks.map(function (l) { return l.id; }).sort().should.eql(['p/b', 'p/hl', 'p/m', 'q/b', 'q/hl', 'q/m']);
		var pm = r.looks.find(function (l) { return l.id == 'p/m'; }), qm = r.looks.find(function (l) { return l.id == 'q/m'; });
		pm.faces.length.should.equal(3);
		qm.faces.length.should.equal(3);
		pm.faces.should.not.containDeep(qm.faces);
	});

	it('refuses a colour that is not "#rrggbb", and a look given no solid', function () {
		var d = pot(); d.nodes.m.in.color = 'brown';
		(function () { Graph.compile(d); }).should.throw(/"m.color" must be a colour "#rrggbb"/);
		d = pot(); delete d.nodes.m.in.of;
		(function () { Graph.compile(d); }).should.throw(/needs a solid|given no solid/);
	});
});
