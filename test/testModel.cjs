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
		// pins standing on a plate print as they stand
		r.verdict.notes.should.eql(['Builds without supports with +z up.']);
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

describe("verb.model.Model shells", function(){
	this.timeout(budget(120000));

	var box = function(){ return { type : 'box', min : [0, 0, 0], max : [40, 30, 20] }; };
	var wall = function(r){ return r.walls[0].thinnest; };

	it('hollows a box open at the top into a tray whose walls are the thickness asked, the inside named after the shell', function(){
		var r = new Model().evaluate({ version : 1, features : { box : box(), tray : { type : 'shell', of : 'box', thickness : 2, open : ['box.+z'] } }, output : 'tray' });
		r.verdict.kind.should.be.equal('buildable');
		r.result.report.volume.should.be.approximately(40 * 30 * 20 - 36 * 26 * 18, 1e-6);
		wall(r).should.be.approximately(2, 1e-9);
		r.faceNames.should.containEql('tray~box.-z');
		r.faceNames.should.not.containEql('tray~box.+z');
		// closed: the inside is sealed in
		var c = new Model().evaluate({ version : 1, features : { box : box(), tray : { type : 'shell', of : 'box', thickness : 2 } }, output : 'tray' });
		c.result.report.volume.should.be.approximately(40 * 30 * 20 - 36 * 26 * 16, 1e-6);
		c.result.report.manifold.closedManifold.should.be.true();
	});

	it('carries the machine check behind its verdict: the tray\'s wall measured as the thickness asked', function(){
		var r = new Model().evaluate({ version : 1, features : { box : box(), tray : { type : 'shell', of : 'box', thickness : 2, open : ['box.+z'] } }, output : 'tray', machine : 'sla' });
		r.verdict.kind.should.be.equal('buildable');
		r.verdict.makeable.makeable.should.be.true();
		r.verdict.makeable.machine.name.should.be.equal(lib.Makeable.MACHINES.sla.name);
		r.verdict.makeable.wall.p01.should.be.approximately(2, 0.1);
		// no machine named, no machine check
		var n = new Model().evaluate({ version : 1, features : { box : box() }, output : 'box' });
		should(n.verdict.makeable).be.undefined();
	});

	it('offsets a Boolean: a bore through the tray keeps a wall around it', function(){
		var r = new Model().evaluate({ version : 1, features : {
			box : box(), bore : { type : 'cylinder', from : [10, 15, -5], to : [10, 15, 25], radius : 3 },
			holed : { type : 'difference', from : 'box', minus : ['bore'] },
			tray : { type : 'shell', of : 'holed', thickness : 2, open : ['box.+z'] } }, output : 'tray' });
		r.verdict.kind.should.be.equal('buildable');
		// (box - bore) - (inner box - bore grown by 2), within the box
		var expected = 24000 - Math.PI * 9 * 20 - (36 * 26 * 18 - Math.PI * 25 * 18);
		r.result.report.volume.should.be.approximately(expected, 2e-3 * expected);
		wall(r).should.be.approximately(2, 1e-3);
	});

	it('rounds a shell: outside radius = inside radius + thickness keeps the wall; a sharp inside under a round outside does not', function(){
		var doc = function(rules){ return { version : 1, features : { box : box(), hollow : { type : 'shell', of : 'box', thickness : 2 }, r : { type : 'round', of : 'hollow', rules : rules } }, output : 'r' }; };
		var both = new Model().evaluate(doc([{ edges : 'box.*', radius : 4 }, { edges : 'hollow~*', radius : 2 }]));
		both.verdict.kind.should.be.equal('buildable');
		both.result.report.fillets.should.be.equal(24);
		wall(both).should.be.above(2 * (1 - Model.WALL_TOLERANCE));
		// the inside of a rounded box, 36 x 26 x 16 rounded by 2, is taken from the outside, 40 x 30 x 20 rounded by 4
		var rounded = function(a, b, c, r){ a -= 2 * r; b -= 2 * r; c -= 2 * r; return a * b * c + 2 * r * (a * b + b * c + a * c) + Math.PI * r * r * (a + b + c) + 4 / 3 * Math.PI * r * r * r; };
		var expected = rounded(40, 30, 20, 4) - rounded(36, 26, 16, 2);
		both.result.report.volume.should.be.approximately(expected, 2e-2 * expected);
		var outside = new Model().evaluate(doc([{ edges : 'box.*', radius : 4 }]));
		outside.verdict.kind.should.be.equal('visual');
		// at a corner the wall is 4 - 2 sqrt 2 thick
		wall(outside).should.be.approximately(4 - 2 * Math.SQRT2, 0.05);
		outside.verdict.reasons.join(' ').should.match(/the shell "hollow" is .* thick at its thinnest \(2 asked\)/);
	});

	it('shells a mug with a curved handle, open at the rim, rounded inside and out', function(){
		var r = new Model().evaluate({ version : 1, features : {
			cup : { type : 'cylinder', from : [0, 0, 0], to : [0, 0, 40], radius : 15 },
			handle : { type : 'pipe', through : [[8, 0, 30], [24, 0, 29], [27, 0, 19], [8, 0, 12]], radius : 3 },
			body : { type : 'union', of : ['cup', 'handle'] },
			mug : { type : 'shell', of : 'body', thickness : 2, open : ['cup.end cap'] },
			rounded : { type : 'round', of : 'mug', rules : [
				{ edges : 'cup.end cap|*', radius : 0.8 }, { edges : 'cup.start cap|cup.tube', radius : 4 },
				{ edges : 'mug~cup.start cap|mug~cup.tube', radius : 2 }, { edges : 'cup.tube|handle.tube', radius : 2 }] } }, output : 'rounded' });
		r.verdict.kind.should.be.equal('buildable');
		r.result.report.fillets.should.be.equal(6);
		wall(r).should.be.above(2 * (1 - Model.WALL_TOLERANCE));
		// the handle is hollow and open to the cup: two handles' worth of genus
		r.result.report.manifold.genus.should.be.equal(2);
		// every face has a finite surface (a ring blend whose sections close on themselves once lofted to NaN), so the
		// mug exports
		r.result.faces.forEach(function(f){ f.surface.controlPoints.forEach(function(row){ row.forEach(function(p){ p.every(isFinite).should.be.true(); }); }); });
		lib.Step.write(r.result, { name : 'mug' }).should.match(/MANIFOLD_SOLID_BREP/);
	});

	it('goes through rigid and uniformly scaled transforms, and says what it cannot shell', function(){
		var r = new Model().evaluate({ version : 1, features : { box : box(),
			t : { type : 'transform', of : 'box', scale : 0.5, rotate : { axis : [0, 0, 1], degrees : 30 } },
			tray : { type : 'shell', of : 't', thickness : 1, open : ['t/box.+z'] } }, output : 'tray' });
		r.verdict.kind.should.be.equal('buildable');
		r.result.report.volume.should.be.approximately(20 * 15 * 10 - 18 * 13 * 9, 1e-6);
		var bad = function(features, output){ return function(){ new Model().evaluate({ version : 1, features : features, output : output }); }; };
		bad({ box : box(), s : { type : 'shell', of : 'box', thickness : 1, open : ['box.top'] } }, 's').should.throw(/opens "box.top", which names no face/);
		bad({ box : box(), s : { type : 'shell', of : 'box', thickness : 0 } }, 's').should.throw(/positive thickness/);
		bad({ box : box(), t : { type : 'transform', of : 'box', scale : [1, 2, 1] }, s : { type : 'shell', of : 't', thickness : 1 } }, 's').should.throw(/rigid or uniformly scaled/);
		bad({ v : { type : 'revolve', profile : [[5, 0], [5, 10]] }, s : { type : 'shell', of : 'v', thickness : 1 } }, 's').should.throw(/cannot yet offset the revolve/);
		bad({ box : box(), s : { type : 'shell', of : 'box', thickness : 1 }, s2 : { type : 'shell', of : 's', thickness : 1 } }, 's2').should.throw(/cannot be shelled again/);
	});
});

describe("verb.model.Model fillets that run out onto a face", function(){
	this.timeout(budget(120000));

	var block = function(){ return { type : 'box', min : [0, 0, 0], max : [40, 30, 20] }; };
	var slot = function(){ return { type : 'box', min : [15, -5, 12], max : [25, 35, 25] }; };
	var quarter = function(r){ return (4 - Math.PI) * r * r / 4; }; // the corner area a radius takes off a right angle
	var evaluate = function(features, rules){ features.r = { type : 'round', of : features.out, rules : rules }; var out = features.out; delete features.out; return new Model().evaluate({ version : 1, features : features, output : 'r' }); };

	it('rounds only the vertical edges of a box: each blend ends on the top and the bottom, cut by them', function(){
		var r = evaluate({ block : block(), out : 'block' }, [{ edges : '*z*', radius : 0 }, { edges : '*', radius : 4 }]);
		r.verdict.kind.should.be.equal('buildable');
		r.result.report.fillets.should.be.equal(4);
		r.result.report.volume.should.be.approximately(24000 - 4 * quarter(4) * 20, 1e-3 * 24000);
	});

	it('rounds a slot: rims cut off where they leave the block, the bottom filled in on the block\'s sides', function(){
		var f = function(){ return { block : block(), slot : slot(), d : { type : 'difference', from : 'block', minus : ['slot'] }, out : 'd' }; };
		var rims = evaluate(f(), [{ edges : 'block.+z|slot.*', radius : 2 }]);
		rims.verdict.kind.should.be.equal('buildable');
		// (the blends' chords take off a little more than the arcs: within a sixth of what the fillets take)
		rims.result.report.volume.should.be.approximately(21600 - 2 * quarter(2) * 30, 2 * quarter(2) * 30 / 6);
		var bottom = evaluate(f(), [{ edges : 'block.*|slot.-z', radius : 0 }, { edges : '*slot.-z*', radius : 2 }]);
		bottom.verdict.kind.should.be.equal('buildable');
		bottom.result.report.volume.should.be.approximately(21600 + 2 * quarter(2) * 30, 2 * quarter(2) * 30 / 6);
		// turned, the blends meet the sides at a slant
		var turned = f(); turned.t = { type : 'transform', of : 'slot', rotate : { axis : [0, 0, 1], degrees : 20, about : [20, 15, 0] } }; turned.d.minus = ['t'];
		var slant = evaluate(turned, [{ edges : 'block.+z|t/slot.*', radius : 2 }, { edges : 'block.*|t/slot.-z', radius : 0 }, { edges : '*t/slot.-z*', radius : 2 }]);
		slant.verdict.kind.should.be.equal('buildable');
		slant.result.report.fillets.should.be.equal(4);
	});

	it('rounds the vertical edges of a block with a slanted top, ending on the cut', function(){
		var r = evaluate({ block : block(), cutter : { type : 'box', min : [-10, -10, 16], max : [50, 40, 40] },
			tilt : { type : 'transform', of : 'cutter', rotate : { axis : [1, 0, 0], degrees : 15, about : [0, 0, 16] } },
			d : { type : 'difference', from : 'block', minus : ['tilt'] }, out : 'd' }, [{ edges : 'block.*x|block.*y', radius : 3 }, { edges : 'block.*y|block.*x', radius : 3 }]);
		r.verdict.kind.should.be.equal('buildable');
		r.result.report.fillets.should.be.equal(4);
	});

	it('rounds an open tray inside and out, the inside corners filled in up to the rim', function(){
		var r = new Model().evaluate({ version : 1, features : { box : block(), tray : { type : 'shell', of : 'box', thickness : 2, open : ['box.+z'] },
			r : { type : 'round', of : 'tray', rules : [{ edges : '*box.+z*', radius : 0 }, { edges : 'box.*', radius : 4 }, { edges : '*', radius : 2 }] } }, output : 'r' });
		r.verdict.kind.should.be.equal('buildable');
		r.result.report.fillets.should.be.equal(16);
		r.walls[0].thinnest.should.be.above(2 * (1 - Model.WALL_TOLERANCE));
	});

	it('leaves sharp, and says so, a blend that would need its face carried on past an edge', function(){
		// a step narrower than the block: the fillet at its foot runs off the step's side into the air
		var r = evaluate({ block : block(), step : { type : 'box', min : [0, 5, 20], max : [20, 25, 30] }, u : { type : 'union', of : ['block', 'step'] }, out : 'u' },
			[{ edges : 'block.+z|step.+x', radius : 3 }]);
		r.verdict.kind.should.be.equal('visual');
		r.result.report.filletsSkipped.should.be.equal(1);
		r.result.report.manifold.closedManifold.should.be.true();
	});
});
