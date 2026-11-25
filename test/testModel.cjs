var should = require('should');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Model = lib.Model, Expr = lib.Expr;

describe("verb.model.Expr", function(){
	it('evaluates arithmetic with the usual precedence, right-associative powers and unary minus below them', function(){
		Expr.evaluate('1 + 2 * 3', {}).should.be.equal(7);
		Expr.evaluate('(1 + 2) * 3', {}).should.be.equal(9);
		Expr.evaluate('2 ^ 3 ^ 2', {}).should.be.equal(512);
		Expr.evaluate('-2 ^ 2', {}).should.be.equal(-4);
		Expr.evaluate('7 % 4 - +1', {}).should.be.equal(2);
		Expr.evaluate('1.5e2 / .5', {}).should.be.equal(300);
	});

	it('knows parameters, constants and functions', function(){
		Expr.evaluate('w / 2 + wall', { w : 40, wall : 2 }).should.be.equal(22);
		Expr.evaluate('max(a, b, 3) + min(a, b)', { a : 1, b : 2 }).should.be.equal(4);
		Expr.evaluate('sqrt(3^2 + 4^2)', {}).should.be.equal(5);
		Expr.evaluate('deg(pi)', {}).should.be.equal(180);
		Expr.evaluate('sin(rad(90))', {}).should.be.approximately(1, 1e-15);
		Expr.evaluate('clamp(5, 0, 2) + lerp(10, 20, 0.5)', {}).should.be.equal(17);
	});

	it('names the parameters an expression uses, not its functions or constants', function(){
		Expr.names('max(w, d) / 2 + pi * w - e').should.be.eql(['w', 'd']);
	});

	it('says what is wrong, and never returns a non-finite number', function(){
		(function(){ Expr.evaluate('w + 1', {}); }).should.throw(/unknown name "w"/);
		(function(){ Expr.evaluate('1 / (2 - 2)', {}); }).should.throw(/division by zero/);
		(function(){ Expr.evaluate('sqrt(-1)', {}); }).should.throw(/not a finite number/);
		(function(){ Expr.evaluate('foo(1)', {}); }).should.throw(/unknown function "foo"/);
		(function(){ Expr.evaluate('min()', {}); }).should.throw(/takes 1 or more/);
		(function(){ Expr.evaluate('atan2(1)', {}); }).should.throw(/takes 2 argument/);
		(function(){ Expr.evaluate('(1 + 2', {}); }).should.throw(/expected "\)"/);
		(function(){ Expr.evaluate('1 2', {}); }).should.throw(/unexpected "2"/);
		(function(){ Expr.evaluate('1 + $', {}); }).should.throw(/unexpected character/);
		(function(){ Expr.evaluate('1 +', {}); }).should.throw(/unexpected end/);
		(function(){ Expr.evaluate(')', {}); }).should.throw(/unexpected "\)"/);
	});
});

// a block with a peg on top and a bore through it, the peg's foot and the bore's rim rounded
function bracket() {
	return {
		version : 1,
		parameters : { w : 40, d : 28, h : 20, r : 'min(w, d) / 6', hole : 4, bx : 'w / 5', foot : 2, rim : 1 },
		features : {
			block : { type : 'box', min : [0, 0, 0], max : ['w', 'd', 'h'] },
			peg : { type : 'cylinder', from : ['w / 2', 'd / 2', 'h - 5'], to : ['w / 2', 'd / 2', 'h + 12'], radius : 'r' },
			bore : { type : 'cylinder', from : ['bx', 'd / 2', -5], to : ['bx', 'd / 2', 'h + 5'], radius : 'hole' },
			solid : { type : 'union', of : ['block', 'peg'] },
			body : { type : 'difference', from : 'solid', minus : ['bore'] },
			rounded : { type : 'round', of : 'body', rules : [{ edges : 'block.+z|peg.tube', radius : 'foot' }, { edges : 'block.+z|bore.tube', radius : 'rim' }] },
		},
		output : 'rounded',
	};
}

function edit(doc, f) { var d = JSON.parse(JSON.stringify(doc)); f(d); return d; }

describe("verb.model.Model", function(){
	this.timeout(budget(120000));

	it('resolves parameters in dependency order, and refuses cycles and unknown names', function(){
		Model.parameters({ a : 'b * 2', b : 'c + 1', c : 3 }).should.be.eql({ a : 8, b : 4, c : 3 });
		(function(){ Model.parameters({ a : 'b', b : 'a' }); }).should.throw(/depends on itself/);
		(function(){ Model.parameters({ a : 'zz + 1' }); }).should.throw(/not a parameter/);
	});

	it('regenerates a document into a buildable solid whose faces have persistent names', function(){
		var r = new Model().evaluate(bracket());
		r.verdict.kind.should.be.equal('buildable');
		r.verdict.checks.map(function(c){ return c.name; }).should.be.eql(['closed', 'outward', 'fillets']);
		r.faceNames.slice().sort().should.be.eql(['block.+x', 'block.+y', 'block.+z', 'block.-x', 'block.-y', 'block.-z', 'bore.tube', 'peg.end cap', 'peg.tube',
			'round(block.+z|bore.tube)', 'round(block.+z|peg.tube)']);
		r.result.report.fillets.should.be.equal(2);
		r.faceIndex['peg.tube'].should.be.equal(r.faceNames.indexOf('peg.tube'));
	});

	it('is deterministic: the same document gives the same mesh, bit for bit, in a fresh model', function(){
		var a = new Model().evaluate(bracket()), b = new Model().evaluate(bracket());
		JSON.stringify(a.result.mesh.vertices).should.be.equal(JSON.stringify(b.result.mesh.vertices));
		JSON.stringify(a.result.mesh.triangles).should.be.equal(JSON.stringify(b.result.mesh.triangles));
		a.faceNames.should.be.eql(b.faceNames);
		Object.keys(a.features).forEach(function(id){ a.features[id].hash.should.be.equal(b.features[id].hash); });
	});

	it('rebuilds only what an edit changes, and keeps the names: rules still select the same edges', function(){
		var m = new Model(), doc = bracket();
		var first = m.evaluate(doc);
		Object.keys(first.features).forEach(function(id){ first.features[id].built.should.be.true(); });
		var again = m.evaluate(doc);
		Object.keys(again.features).forEach(function(id){ again.features[id].built.should.be.false(); });
		again.result.should.be.equal(first.result);
		// the bore moved: the bore and what uses it rebuild; the block, the peg and their union come from the cache
		var moved = m.evaluate(edit(doc, function(d){ d.parameters.bx = 7; }));
		var built = Object.keys(moved.features).filter(function(id){ return moved.features[id].built; }).sort();
		built.should.be.eql(['body', 'bore', 'rounded']);
		moved.faceNames.slice().sort().should.be.eql(first.faceNames.slice().sort());
		moved.verdict.kind.should.be.equal('buildable');
		// only the rim's radius: only the round rebuilds
		var rim = m.evaluate(edit(doc, function(d){ d.parameters.rim = 0.8; }));
		Object.keys(rim.features).filter(function(id){ return rim.features[id].built; }).should.be.eql(['rounded']);
		rim.verdict.kind.should.be.equal('buildable');
		// a wider block moves everything, and the names still hold
		var wider = m.evaluate(edit(doc, function(d){ d.parameters.w = 50; }));
		wider.faceNames.slice().sort().should.be.eql(first.faceNames.slice().sort());
		wider.result.report.fillets.should.be.equal(2);
	});

	it('places copies with transforms, named by their path, and checks against a machine', function(){
		var doc = {
			version : 1,
			parameters : { n : 3, gap : 12 },
			features : {
				plate : { type : 'box', min : [-30, -10, 0], max : [30, 10, 4] },
				pin : { type : 'cylinder', from : [0, 0, 2], to : [0, 0, 14], radius : 3 },
				left : { type : 'transform', of : 'pin', translate : ['-gap', 0, 0] },
				right : { type : 'transform', of : 'pin', rotate : { axis : [0, 0, 1], degrees : 180 }, translate : ['gap', 0, 0] },
				all : { type : 'union', of : ['plate', 'left', 'pin', 'right'] },
			},
			output : 'all',
			machine : 'fdm',
		};
		var r = new Model().evaluate(doc);
		r.verdict.kind.should.be.equal('buildable');
		r.verdict.checks.map(function(c){ return c.name; }).should.containEql('makeable');
		['left/pin.tube', 'pin.tube', 'right/pin.tube', 'left/pin.end cap'].forEach(function(n){ r.faceNames.should.containEql(n); });
		r.result.report.volume.should.be.approximately(60 * 20 * 4 + 3 * Math.PI * 9 * 10, 30);
		// the same leaf twice in one Boolean is ambiguous
		(function(){ new Model().evaluate(edit(doc, function(d){ d.features.all.of = ['plate', 'pin', 'pin']; })); }).should.throw(/used twice/);
	});

	it('scales, mirrors and rotates about a point, keeping the faces outward', function(){
		var doc = {
			version : 1,
			features : {
				b : { type : 'box', min : [0, 0, 0], max : [10, 10, 10], divs : 4 },
				t : { type : 'transform', of : 'b', scale : [2, -1, 0.5], rotate : { axis : [0, 0, 1], degrees : 90, about : [5, 5, 0] } },
			},
			output : 't',
		};
		var r = new Model().evaluate(doc);
		r.verdict.kind.should.be.equal('buildable');
		r.result.report.volume.should.be.approximately(1000, 1e-6);
	});

	it('revolves a profile into a solid of revolution and sweeps a pipe along points', function(){
		var r = new Model().evaluate({ version : 1, parameters : { R : 10, H : 30 }, features : {
			c : { type : 'revolve', profile : [['R', 0], ['R', 'H / 2'], ['R', 'H']] },
		}, output : 'c' });
		r.verdict.kind.should.be.equal('buildable');
		r.faceNames.slice().sort().should.be.eql(['c.bottom', 'c.top', 'c.wall']);
		r.result.report.volume.should.be.approximately(Math.PI * 100 * 30, Math.PI * 100 * 30 * 0.01);
		var p = new Model().evaluate({ version : 1, features : {
			p : { type : 'pipe', through : [[0, 0, 0], [20, 10, 10], [40, 0, 20]], radius : 3 },
		}, output : 'p' });
		p.verdict.kind.should.be.equal('buildable');
		p.faceNames.slice().sort().should.be.eql(['p.end cap', 'p.start cap', 'p.tube']);
	});

	it('calls a model visual, with the reason, when a fillet interferes and takes a face with it', function(){
		// the bore's rim comes within a third of a millimetre of the peg: the peg's fillet runs into the bore
		var r = new Model().evaluate(edit(bracket(), function(d){ d.parameters.hole = 5; d.parameters.bx = 'w / 4'; d.features.rounded.rules.pop(); }));
		r.verdict.kind.should.be.equal('visual');
		r.verdict.reasons.should.containEql('the surface has open or non-manifold edges');
	});

	it('refuses malformed documents with a plain message', function(){
		var bad = function(f){ return function(){ new Model().evaluate(edit(bracket(), f)); }; };
		bad(function(d){ d.version = 2; }).should.throw(/unknown document version/);
		bad(function(d){ d.output = 'nope'; }).should.throw(/is not a feature/);
		bad(function(d){ d.features.solid.of = ['block', 'ghost']; }).should.throw(/unknown feature "ghost"/);
		bad(function(d){ d.features.solid.of = ['block', 'body']; }).should.throw(/depends on itself/);
		bad(function(d){ d.features.block.max = [1, 2]; }).should.throw(/must be a point/);
		bad(function(d){ d.features.block.max = [0, 1, 1]; }).should.throw(/max must exceed its min/);
		bad(function(d){ d.features.peg.radius = '-r'; }).should.throw(/radius must be positive/);
		bad(function(d){ d.features.solid.of = []; }).should.throw(/no operands/);
		bad(function(d){ d.features.other = { type : 'union', of : ['rounded', 'block'] }; d.output = 'other'; }).should.throw(/can only be the last feature/);
		bad(function(d){ d.features.block = { type : 'sphere' }; }).should.throw(/unknown feature type/);
		bad(function(d){ d.features.block.min = [0, 0, {}]; }).should.throw(/must be a number or an expression/);
	});

	it('hashes canonical JSON: key order and -0 do not matter, values do', function(){
		Model.canonical({ b : 1, a : [-0, 'x'] }).should.be.equal(Model.canonical({ a : [0, 'x'], b : 1 }));
		Model.hash(Model.canonical({ a : 1 })).should.not.be.equal(Model.hash(Model.canonical({ a : 2 })));
		Model.hash('').should.match(/^[0-9a-f]{16}$/);
		Model.pattern('a.*|b.tube').test('a.+z|b.tube').should.be.true();
		Model.pattern('a.*|b.tube').test('a.+z|b.tubes').should.be.false();
		Model.edgeName('b', 'a').should.be.equal('a|b');
	});
});
