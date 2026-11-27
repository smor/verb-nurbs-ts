var should = require('should');
var verb = require('../dist/index.js');
var Graph = verb.Graph, Model = verb.Model;

// Switches: a part included or not, holes cut or not (the model's `choose`, the graph's `logic/switch`).

// a plate, a peg standing on it, and a hole through it; `peg` and `hole` switch them
function plate(peg, hole) {
	return { version : 2, nodes : {
		peg_on : { type : 'number', in : { value : peg } },
		hole_on : { type : 'number', in : { value : hole } },
		p : { type : 'primitive/box', in : { width : 40, depth : 30, height : 5 } },
		c : { type : 'primitive/cylinder', in : { radius : 4, height : 10 } },
		cm : { type : 'transform/move', in : { of : '@c', x : -10, y : 0, z : 4 } },
		h : { type : 'primitive/cylinder', in : { radius : 3, height : 20 } },
		hm : { type : 'transform/move', in : { of : '@h', x : 10, y : 0, z : -5 } },
		sp : { type : 'logic/switch', in : { on : 'peg_on', on_solid : '@cm' } },
		sh : { type : 'logic/switch', in : { on : 'hole_on', on_solid : '@hm' } },
		u : { type : 'boolean/union', in : { a : '@p', b : '@sp' } },
		d : { type : 'boolean/difference', in : { from : '@u', minus : '@sh' } } },
		outputs : { plate : '@d' } };
}
function volume(doc, options) { return new Graph().evaluate(doc, options || {}).result.report.volume; }

describe('switches: a part included or not (Model.choose, logic/switch)', function () {

	it('includes the peg and cuts the hole as their numbers are on or off', function () {
		var base = volume(plate(0, 0));
		base.should.be.approximately(40 * 30 * 5, 1e-6);
		var peg = volume(plate(1, 0)) - base, hole = base - volume(plate(0, 1));
		peg.should.be.above(100);
		hole.should.be.above(100);
		volume(plate(1, 1)).should.be.approximately(base + peg - hole, 1e-6);
	});

	it('takes an expression and the other side, and reports what it chose', function () {
		var doc = plate(1, 0);
		doc.nodes.big = { type : 'primitive/cylinder', in : { radius : 6, height : 10 } };
		doc.nodes.bm = { type : 'transform/move', in : { of : '@big', x : -10, y : 0, z : 4 } };
		doc.nodes.sp.in = { on : 'peg_on * 2', on_solid : '@cm', off_solid : '@bm' };
		var g = new Graph();
		var small = g.evaluate(doc), v1 = small.result.report.volume;
		small.nodes.sp.should.equal('on');
		small.nodes.sh.should.equal('off');
		small.chosen.should.eql({ sp : true, sh : false });
		doc.nodes.peg_on.in.value = 0;
		var big = g.evaluate(doc);
		big.nodes.sp.should.equal('off');
		big.result.report.volume.should.be.above(v1);
	});

	it('makes nothing of what is made from nothing alone, and refuses an output switched off', function () {
		var doc = plate(0, 0);
		doc.nodes.moved = { type : 'transform/move', in : { of : '@sp', x : 1 } };
		doc.outputs = { peg : '@moved' };
		(function () { new Graph().evaluate(doc); }).should.throw(/the output .* is switched off/);
		doc.nodes.peg_on.in.value = 1;
		volume(doc).should.be.approximately(Math.PI * 16 * 10, 1);
		// an intersection with nothing is nothing; a difference from nothing too
		var m = { version : 1, parameters : { on : 0 }, output : 'i', features : {
			a : { type : 'box', min : [0, 0, 0], max : [1, 1, 1] }, s : { type : 'choose', when : 'on', then : 'a' },
			i : { type : 'intersection', of : ['a', 's'] } } };
		(function () { new Model().evaluate(m); }).should.throw(/switched off/);
		m.output = 'd'; m.features.d = { type : 'difference', from : 's', minus : ['a'] };
		(function () { new Model().evaluate(m); }).should.throw(/switched off/);
	});

	it('leaves a document without switches as it is, and builds a switched part from the cache when it comes back', function () {
		var m = { version : 1, output : 'a', features : { a : { type : 'box', min : [0, 0, 0], max : [1, 1, 1] } } };
		Model.choose(m, {}).should.equal(m);
		var g = new Graph(), doc = plate(1, 1);
		g.evaluate(doc);
		doc.nodes.peg_on.in.value = 0; g.evaluate(doc);
		doc.nodes.peg_on.in.value = 1;
		var again = g.evaluate(doc);
		again.nodes.d.should.equal('cached');
	});

	it('builds the wall bracket sample (editor/samples) with every option on or off', function () {
		var d = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'editor', 'samples', 'wall-bracket.graph.json'), 'utf8'));
		var g = new Graph(), vols = {};
		[[1, 1, 0, 1], [0, 0, 0, 0], [1, 1, 1, 1], [0, 1, 1, 0]].forEach(function (o) {
			d.nodes.lip_on.in.value = o[0]; d.nodes.base_holes_on.in.value = o[1]; d.nodes.wall_holes_on.in.value = o[2]; d.nodes.notch_on.in.value = o[3];
			var r = g.evaluate(d);
			r.verdict.kind.should.equal('buildable', o.join(''));
			vols[o.join('')] = r.result.report.volume;
		});
		// the same holes in the base and in the wall, both through 4 mm: the same volume each
		(vols['1101'] - vols['1111']).should.be.approximately(2 * Math.PI * 2.2 * 2.2 * 4, 2);
		vols['0000'].should.be.below(vols['1101'] + 1);
	});

	it('switches inside a component as each instance sets it', function () {
		var inner = plate(1, 1);
		var doc = { version : 2, nodes : {
			a : { type : 'component', use : '#Plate', in : { peg_on : 0 } },
			b : { type : 'component', use : '#Plate' },
			bm : { type : 'transform/move', in : { of : '@b.plate', x : 0, y : 50, z : 0 } },
			u : { type : 'boolean/union', in : { a : '@a.plate', b : '@bm' } } },
			outputs : { both : '@u' }, components : { Plate : inner } };
		volume(doc).should.be.approximately(volume(plate(0, 1)) + volume(plate(1, 1)), 1e-6);
	});
});
