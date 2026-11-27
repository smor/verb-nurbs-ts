var should = require('should');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph, Extrusion = lib.Extrusion, ShellBuilder = lib.ShellBuilder;

// Exact extrusions of 507's profile JSON (#85): every face exact, the shell's volume on the exact faces, and the
// graph node building closed solids that Booleans take.

var PI = Math.PI;
var P = function (x, y) { return [x, y]; };
var line = function (to) { return { type : 'line', to : to }; };
var arc = function (via, to) { return { type : 'arc', via : via, to : to }; };
var rect = function (x0, y0, x1, y1) {
	return { kind : 'path', start : P(x0, y0), segments : [line(P(x1, y0)), line(P(x1, y1)), line(P(x0, y1)), line(P(x0, y0))] };
};
var circle = function (cx, cy, r) { return { kind : 'circle', center : P(cx, cy), r : r }; };
// a circular segment of chord c and sagitta s
var segment = function (c, s) { var R = (c * c / 4 + s * s) / (2 * s), th = 2 * Math.asin(c / (2 * R)); return R * R / 2 * (th - Math.sin(th)); };

function evaluate(nodes, options) {
	var doc = { version : 2, meta : { name : 'extrude' }, nodes : nodes, outputs : { s : '@x' } };
	return new Graph().evaluate(doc, Object.assign({ output : 's' }, options || {}));
}

describe("Extrusion of profiles (#85)", function () {
	this.timeout(budget(60000));

	it('gives the exact volume of lines, an arc and a hole, on the exact faces', function () {
		var profile = { outer : { kind : 'path', start : P(0, 0), segments : [line(P(30, 0)), arc(P(38, 10), P(30, 20)), line(P(0, 20)), line(P(0, 0))] },
			holes : [circle(12, 10, 4)] };
		var exact = (600 + segment(20, 8) - PI * 16) * 6;
		var s = Extrusion.shell(profile, 6, 2);
		ShellBuilder.volume(s.shell).should.be.approximately(exact, 1e-9 * exact);
		// the mesh for inside tests is closed, its volume within its chords of the exact one
		s.mesh.checkClosedManifold().closedManifold.should.be.true();
		s.mesh.signedVolume().should.be.approximately(exact, 2e-3 * exact);
		// (the hole's side is two exact halves, named as one face: #122)
		var faces = Extrusion.solid(profile, 6, 2).faces;
		faces.map(function (f) { return f.name; }).should.eql(['bottom', 'top', 'outer.0', 'outer.1', 'outer.2', 'outer.3', 'hole0.0', 'hole0.0']);
		faces.map(function (f) { return f.half === true; }).should.eql([false, false, false, false, false, false, true, true]);
	});

	it('takes paths either way round, and a cubic Bézier exactly', function () {
		// a quarter "circle" as a cubic, closed by two lines; its area by Green's theorem on the cubic is exact
		var k = 0.5522847498, R = 10;
		var cubic = { type : 'cubic', c1 : P(R, R * k), c2 : P(R * k, R), to : P(0, R) };
		var ccw = { kind : 'path', start : P(0, 0), segments : [line(P(R, 0)), cubic, line(P(0, 0))] };
		var cw = { kind : 'path', start : P(0, 0), segments : [line(P(0, R)), { type : 'cubic', c1 : P(R * k, R), c2 : P(R, R * k), to : P(R, 0) }, line(P(0, 0))] };
		// area under a cubic Bézier from (R,0) to (0,R): (3/20) of the control-point shoelace terms
		var b = [[R, 0], [R, R * k], [R * k, R], [0, R]];
		var A = 0;
		var w = [[0, 6, 3, 1], [-6, 0, 3, 3], [-3, -3, 0, 6], [-1, -3, -6, 0]];
		for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) A += w[i][j] * b[i][0] * b[j][1] / 20;
		var v1 = ShellBuilder.volume(Extrusion.shell({ outer : ccw }, 3).shell), v2 = ShellBuilder.volume(Extrusion.shell({ outer : cw }, 3).shell);
		v1.should.be.approximately(3 * A, 1e-9 * 3 * A);
		v2.should.be.approximately(v1, 1e-9 * v1);
	});

	it('builds the graph node: closed, buildable, its volume, its export mesh named per face', function () {
		var r = evaluate({ x : { type : 'profile/extrude' } }, { mesh : 'print' });
		var exact = (600 + segment(20, 8) - PI * 16) * 6;
		r.verdict.kind.should.equal('buildable');
		r.result.report.manifold.closedManifold.should.be.true();
		r.result.report.volume.should.be.approximately(exact, 1e-3 * exact);
		r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
		r.export.mesh.signedVolume().should.be.approximately(exact, 1e-3 * exact);
		var names = {};
		r.export.faceNames.forEach(function (n) { names[n] = true; });
		Object.keys(names).sort().should.eql(['x.bottom', 'x.hole0.0', 'x.outer.0', 'x.outer.1', 'x.outer.2', 'x.outer.3', 'x.top']);
	});

	it('is an operand of Booleans: a gear of 160 segments, bored', function () {
		var N = 40, Ro = 30, Ri = 27, segs = [], start = null;
		var at = function (r, a) { return [r * Math.cos(a), r * Math.sin(a)]; };
		for (var i = 0; i < N; i++) {
			var a0 = 2 * PI * i / N, a1 = a0 + PI / N * 0.8, a2 = a0 + PI / N, a3 = a0 + 2 * PI / N;
			if (i == 0) start = at(Ri, a0);
			segs.push(line(at(Ro, a0 + 0.02)), arc(at(Ro, (a0 + 0.02 + a1) / 2), at(Ro, a1)), line(at(Ri, a2)), arc(at(Ri, (a2 + a3) / 2), i == N - 1 ? start : at(Ri, a3)));
		}
		var profile = { outer : { kind : 'path', start : start, segments : segs } };
		var gear = ShellBuilder.volume(Extrusion.shell(profile, 6).shell);
		var t = Date.now();
		var r = evaluate({
			g : { type : 'profile/extrude', in : { profile : profile, height : 6 } },
			c : { type : 'primitive/cylinder', in : { radius : 5, height : 20 } },
			m : { type : 'transform/move', in : { of : '@c', x : 0, y : 0, z : -5 } },
			x : { type : 'boolean/difference', in : { from : '@g', minus : '@m' } } });
		r.verdict.kind.should.equal('buildable');
		r.result.report.manifold.closedManifold.should.be.true();
		r.result.report.volume.should.be.approximately(gear - PI * 25 * 6, 2e-3 * gear);
		(Date.now() - t).should.be.below(budget(10000));
	});

	it('twists and tapers the top (#86): helical sides of the exact volume, conical ones towards the apex', function () {
		var sq = rect(-5, -5, 5, 5);
		// a twist keeps every section the profile turned: the volume is the area times the height (Cavalieri)
		var v = ShellBuilder.volume(Extrusion.shell({ outer : sq }, 20, 0, { twist : 90 }).shell);
		v.should.be.approximately(2000, 1e-6 * 2000);
		// a taper is a frustum: h (A0 + sqrt(A0 A1) + A1) / 3, exactly, and with a twist as well (to the helix's fit)
		var frustum = 20 * (100 + 50 + 25) / 3;
		ShellBuilder.volume(Extrusion.shell({ outer : sq }, 20, 0, { scaleTop : 0.5 }).shell).should.be.approximately(frustum, 1e-9 * frustum);
		ShellBuilder.volume(Extrusion.shell({ outer : sq }, 20, 0, { scaleTop : 0.5, twist : 45 }).shell).should.be.approximately(frustum, 1e-6 * frustum);
		// the top's corner is the bottom's, turned and scaled
		var s = Extrusion.solid({ outer : sq }, 20, 0, { twist : 90, scaleTop : 0.5 });
		s.faces.map(function (f) { return f.name; }).should.eql(['bottom', 'top', 'outer.0', 'outer.1', 'outer.2', 'outer.3']);
		(function () { Extrusion.shell({ outer : sq }, 20, 0, { scaleTop : 0 }); }).should.throw(/scale is a positive/);
	});

	it('builds a worm through the graph: a tooth profile turned three times up its length, closed, in seconds rather than minutes', function () {
		// a rounded tooth on a core, as 507's worms: twist = 360 x length / lead
		var profile = { outer : { kind : 'path', start : P(-4, -9), segments : [line(P(4, -9)), line(P(4, 6)), arc(P(0, 10), P(-4, 6)), line(P(-4, -9))] } };
		var t = Date.now();
		var r = evaluate({ x : { type : 'profile/extrude', in : { profile : profile, height : 30, twist : 1080 } } }, { mesh : 'print' });
		r.verdict.kind.should.equal('buildable');
		r.result.report.manifold.closedManifold.should.be.true();
		r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
		var area = 8 * 15 + PI * 16 / 2;
		r.export.mesh.signedVolume().should.be.approximately(area * 30, 3e-3 * area * 30);
		(Date.now() - t).should.be.below(budget(20000));
		var names = {};
		r.export.faceNames.forEach(function (n) { names[n] = true; });
		Object.keys(names).sort().should.eql(['x.bottom', 'x.outer.0', 'x.outer.1', 'x.outer.2', 'x.outer.3', 'x.top']);
	});

	it('cuts with a circle and tapers a circle to a small top: closed, of the exact volumes, named as one face (#122)', function () {
		var ex = function (outer, height, z, more) { return { type : 'profile/extrude', in : Object.assign({ profile : { outer : outer, holes : [] }, height : height, z : z || 0 }, more || {}) }; };
		var stadium = { kind : 'path', start : P(0, -2.5), segments : [line(P(64, -2.5)), arc(P(66.5, 0), P(64, 2.5)), line(P(0, 2.5)), arc(P(-2.5, 0), P(0, -2.5))] };
		var cases = [
			// a hole through a bar 5 wide, its wall 0.1 thick at the sides
			[{ a : ex(stadium, 5), b : ex(circle(32, 0, 2.4), 7, -1), x : { type : 'boolean/difference', in : { from : '@a', minus : '@b' } } },
			 (64 * 5 + PI * 2.5 * 2.5 - PI * 2.4 * 2.4) * 5, ['a.bottom', 'a.outer.0', 'a.outer.1', 'a.outer.2', 'a.outer.3', 'a.top', 'b.outer.0']],
			// a frustum r 7 to r 2
			[{ x : ex(circle(0, 0, 7), 5, 0, { scaleTop : 2 / 7 }) }, PI * 5 / 3 * (49 + 14 + 4), ['x.bottom', 'x.outer.0', 'x.top']]];
		cases.forEach(function (c) {
			var r = evaluate(c[0], { mesh : 'print' });
			r.verdict.kind.should.equal('buildable', r.verdict.reasons.join('; '));
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			r.result.report.volume.should.be.approximately(c[1], 3e-3 * c[1]);
			r.export.mesh.signedVolume().should.be.approximately(c[1], 3e-3 * c[1]);
			Array.from(new Set(r.export.faceNames)).sort().should.eql(c[2]);
		});
		// the frustum's report within 0.1 %: its side's grid is as fine as its base needs
		evaluate(cases[1][0]).result.report.volume.should.be.approximately(cases[1][1], 1e-3 * cases[1][1]);
	});

	it('refuses an open path, an arc on a line, and a profile that is not one', function () {
		var bad = function (profile, re) {
			(function () { evaluate({ x : { type : 'profile/extrude', in : { profile : profile } } }); }).should.throw(re);
		};
		bad({ outer : { kind : 'path', start : P(0, 0), segments : [line(P(10, 0)), line(P(10, 10)), line(P(0, 9))] } }, /ends at the start/);
		bad({ outer : { kind : 'path', start : P(0, 0), segments : [arc(P(5, 0), P(10, 0)), line(P(10, 10)), line(P(0, 0))] } }, /on a line/);
		bad({ outer : 'square' }, /path or a circle/);
		bad('square', /profile \{ outer, holes \}/);
	});
});
