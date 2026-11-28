var should = require('should');
var made = require('./support/made.cjs');
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

// 507's 31/worm outline (#117): ten teeth, its points, its 60 cubics, and its area
function wormProfile() {
	// ten teeth, six cubics each (a root, a flank, two across the tip, a flank, a root), corners where the flanks
	// meet the root and the tip, as 507's 31/worm
	var Rr = 4.6, Rt = 6, pitch = 2 * PI / 10, segs = [], pts = [];
	var at = function (r, a) { return { p : [r * Math.cos(a), r * Math.sin(a)], t : [-Math.sin(a), Math.cos(a)] }; };
	for (var k = 0; k < 10; k++) [[Rr, 0, 1], [Rr, 0.2, 0], [Rt, 0.35, 1], [Rt, 0.5, 1], [Rt, 0.65, 0], [Rr, 0.8, 1]].forEach(function (x) {
		var q = at(x[0], (k + x[1]) * pitch); q.round = x[2]; pts.push(q);
	});
	// each cubic leaves a round point along the circle and a corner along the chord
	pts.forEach(function (a, i) {
		var b = pts[(i + 1) % pts.length], d = [b.p[0] - a.p[0], b.p[1] - a.p[1]], l = Math.hypot(d[0], d[1]), u = [d[0] / l, d[1] / l];
		var round = a.round && b.round || (a.p[0] * a.p[0] + a.p[1] * a.p[1] == b.p[0] * b.p[0] + b.p[1] * b.p[1]);
		var t0 = round ? a.t : u, t1 = round ? b.t : u;
		segs.push({ type : 'cubic', c1 : [a.p[0] + l / 3 * t0[0], a.p[1] + l / 3 * t0[1]], c2 : [b.p[0] - l / 3 * t1[0], b.p[1] - l / 3 * t1[1]], to : b.p });
	});
	segs[segs.length - 1].to = pts[0].p;
	// its area, exactly (Green's theorem on each cubic: x y' - y x' is of degree 5, three Gauss points)
	var area = 0, gx = [-Math.sqrt(0.6), 0, Math.sqrt(0.6)], gw = [5 / 9, 8 / 9, 5 / 9], from = pts[0].p;
	segs.forEach(function (s) {
		var c = [from, s.c1, s.c2, s.to];
		for (var i = 0; i < 3; i++) {
			var t = 0.5 + 0.5 * gx[i], m = 1 - t, b = [m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t], db = [-3 * m * m, 3 * m * m - 6 * m * t, 6 * m * t - 3 * t * t, 3 * t * t];
			var x = 0, y = 0, dx = 0, dy = 0;
			for (var j = 0; j < 4; j++) { x += b[j] * c[j][0]; y += b[j] * c[j][1]; dx += db[j] * c[j][0]; dy += db[j] * c[j][1]; }
			area += 0.5 * gw[i] * 0.5 * (x * dy - y * dx);
		}
		from = s.to;
	});
	return { pts : pts, segs : segs, area : area };
}

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
		made(r.verdict);
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
		made(r.verdict);
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
		made(r.verdict);
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
			made(r.verdict, r.verdict.reasons.join('; '));
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			r.result.report.volume.should.be.approximately(c[1], 3e-3 * c[1]);
			r.export.mesh.signedVolume().should.be.approximately(c[1], 3e-3 * c[1]);
			Array.from(new Set(r.export.faceNames)).sort().should.eql(c[2]);
		});
		// the frustum's report within 0.1 %: its side's grid is as fine as its base needs
		evaluate(cases[1][0]).result.report.volume.should.be.approximately(cases[1][1], 1e-3 * cases[1][1]);
	});

	it('gives a twisted thin bar its exact volume, in closed form, and the shell the same on its faces (#117)', function () {
		var bar = rect(-10, -1, 10, 1);
		// 507's sentinel: rect(20, 2) twisted 360 degrees over 10 has a volume within 0.01 % of 400 (it was 402.14)
		[[360, 1, 400], [60, 1, 400], [60, 0.7, 10 * 40 * (1 + 0.7 + 0.49) / 3], [0, 0.7, 10 * 40 * (1 + 0.7 + 0.49) / 3]].forEach(function (c) {
			var r = evaluate({ x : { type : 'profile/extrude', in : { profile : { outer : bar, holes : [] }, height : 10, twist : c[0], scaleTop : c[1] } } }, { mesh : 'print' });
			made(r.verdict);
			r.result.report.volume.should.be.approximately(c[2], 1e-6 * c[2]);
			// (the export is the shell's own mesh: its vertices on the faces, its volume short of them by about the
			// chordal tolerance times the area)
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			r.export.mesh.signedVolume().should.be.approximately(c[2], 0.02 * 2 * (20 * 10 + 40));
		});
		// the closed form is the volume of the shell as built, to rounding: an arc, a hole, a twist and a taper
		var profile = { outer : { kind : 'path', start : P(0, 0), segments : [line(P(30, 0)), arc(P(38, 10), P(30, 20)), line(P(0, 20)), line(P(0, 0))] },
			holes : [circle(12, 10, 4)] };
		[{ twist : 400, scaleTop : 1.3 }, { twist : -90 }, { scaleTop : 0.6 }].forEach(function (o) {
			var sh = Extrusion.shell(profile, 7, 1, o).shell;
			sh.volume.should.be.approximately(ShellBuilder.volume(sh), 1e-10 * sh.volume);
		});
	});

	it('builds a worm of a 60-cubic tooth outline turned 1375 degrees, with its print mesh, in seconds (#117)', function () {
		var w = wormProfile(), pts = w.pts, segs = w.segs, area = w.area;
		var t = Date.now();
		var r = evaluate({ x : { type : 'profile/extrude', in : { profile : { outer : { kind : 'path', start : pts[0].p, segments : segs }, holes : [] }, height : 24, twist : 1375 } } }, { mesh : 'print' });
		var took = Date.now() - t;
		made(r.verdict);
		r.result.report.volume.should.be.approximately(area * 24, 1e-6 * area * 24);
		r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
		r.export.mesh.signedVolume().should.be.approximately(area * 24, 3e-3 * area * 24);
		// (31 s on 507's machine before; about 4 s here)
		took.should.be.below(budget(15000));
	});

	it('bores the worm through its axis fast: the twisted faces are apart from the bore, and their edges stay exact (#146)', function () {
		var w = wormProfile(), outer = { kind : 'path', start : w.pts[0].p, segments : w.segs };
		var t = Date.now();
		var r = evaluate({ e : { type : 'profile/extrude', in : { profile : { outer : outer, holes : [] }, height : 24, twist : 1375 } },
			c : { type : 'primitive/cylinder', in : { radius : 2.5, height : 26 } }, m : { type : 'transform/move', in : { of : '@c', x : 0, y : 0, z : -1 } },
			x : { type : 'boolean/difference', in : { from : '@e', minus : '@m' } } }, { mesh : 'print' });
		var took = Date.now() - t;
		made(r.verdict);
		var V = (w.area - PI * 2.5 * 2.5) * 24;
		r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
		r.export.mesh.signedVolume().should.be.approximately(V, 3e-3 * V);
		// (13 s, 82 s with the print mesh, before: the bore was tested against every twisted face, and each edge
		// between two of them projected back onto both; about 7 s here)
		took.should.be.below(budget(25000));
		// the edges between the twisted faces are theirs, exact: the sides' isocurves, with straight p-curves
		var shell = ShellBuilder.fromResult(r.result), sides = shell.edges.filter(function (e) { return /outer/.test(shell.faces[e.left].name) && /outer/.test(shell.faces[e.right].name); });
		sides.length.should.equal(60);
		sides.forEach(function (e) { e.pcurves[0].degree.should.equal(1); e.pcurves[1].degree.should.equal(1); e.tolerance.should.be.below(1e-9); });
	});

	it('tells surfaces apart by the boxes of their knot spans (#146)', function () {
		var w = wormProfile();
		var shell = Extrusion.shell({ outer : { kind : 'path', start : w.pts[0].p, segments : w.segs } }, 24, 0, { twist : 1375 }).shell;
		var side = shell.faces.filter(function (f) { return /outer/.test(f.name); })[0].surface;
		var bore = lib.Make.cylindricalSurface([0, 0, 1], [1, 0, 0], [0, 0, -1], 26, 2.5);
		lib.SurfaceIntersect.apart(side, bore).should.be.true();
		lib.SurfaceIntersect.apart(side, lib.Make.cylindricalSurface([0, 0, 1], [1, 0, 0], [0, 0, -1], 26, 5)).should.be.false();
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
