var should = require('should');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph, Lathe = lib.Lathe;

// Profiles drawn in the (r, z) half-plane and turned about z (#87): the solids closed, of the volumes Pappus gives,
// their faces named after the segments, and the graph node building them.

var PI = Math.PI;
var line = function (to) { return { type : 'line', to : to }; };
var arc = function (via, to) { return { type : 'arc', via : via, to : to }; };
var path = function (start, segs) { return { outer : { kind : 'path', start : start, segments : segs } }; };
// the volume of a polygon turned about the y axis (Pappus: 2 pi times its first moment about the axis)
var turned = function (pts) {
	var m = 0;
	for (var i = 0; i < pts.length; i++) {
		var a = pts[i], b = pts[(i + 1) % pts.length], c = a[0] * b[1] - b[0] * a[1];
		m += c * (a[0] + b[0]) / 6;
	}
	return Math.abs(2 * PI * m);
};
function evaluate(nodes, options) {
	var doc = { version : 2, meta : { name : 'lathe' }, nodes : nodes, outputs : { s : '@x' } };
	return new Graph().evaluate(doc, Object.assign({ output : 's' }, options || {}));
}
// built, closed, and the print mesh within its chords of the exact volume
function check(profile, exact) {
	var r = evaluate({ x : { type : 'profile/revolve', in : { profile : profile } } }, { mesh : 'print' });
	r.verdict.kind.should.equal('buildable');
	r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
	// an inscribed mesh within `chordal` of the surface loses at most chordal x its area
	var M = r.export.mesh, area = 0;
	M.triangles.forEach(function (t) {
		var a = M.vertices[t[0]], b = M.vertices[t[1]], c = M.vertices[t[2]];
		var u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
		area += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
	});
	M.signedVolume().should.be.approximately(exact, Math.max(2e-3 * exact, r.export.tolerance.chordal * area));
	r.result.report.volume.should.be.approximately(exact, 5e-3 * exact);
	return r;
}

describe("Revolved profiles (#87)", function () {
	this.timeout(budget(60000));

	it('turns lines into a cylinder, cones and annuli: a V-pulley with its bore, of the exact volume', function () {
		var pts = [[3, 0], [20, 0], [20, 2], [16, 6], [20, 10], [20, 12], [3, 12]];
		var r = check(path(pts[0], pts.slice(1).concat([pts[0]]).map(line)), turned(pts));
		var names = {};
		r.export.faceNames.forEach(function (n) { names[n] = true; });
		Object.keys(names).sort().should.eql(['x.outer.0', 'x.outer.1', 'x.outer.2', 'x.outer.3', 'x.outer.4', 'x.outer.5', 'x.outer.6']);
		r.export.mesh.checkClosedManifold().genus.should.equal(1);
	});

	it('turns arcs into tori and spheres: a concave pulley, a sphere drawn on the axis, a torus from a circle', function () {
		// the groove: a half circle of radius 4 centred at (20, 6), through (16, 6): Pappus on the half disc it cuts away
		var seg = PI * 16 / 2, cx = 20 - 4 * 4 / (3 * PI);
		var pts = [[3, 0], [20, 0], [20, 2], [20, 10], [20, 12], [3, 12]];
		check(path([3, 0], [line([20, 0]), line([20, 2]), arc([16, 6], [20, 10]), line([20, 12]), line([3, 12]), line([3, 0])]), turned(pts) - 2 * PI * cx * seg);
		// a sphere: a half circle from the axis to the axis, closed along it (the axis segment makes no face)
		var s = check(path([0, -10], [arc([10, 0], [0, 10]), line([0, -10])]), 4 / 3 * PI * 1000);
		s.export.mesh.checkClosedManifold().genus.should.equal(0);
		var t = check({ outer : { kind : 'circle', center : [20, 0], r : 5 } }, 2 * PI * 20 * PI * 25);
		t.export.mesh.checkClosedManifold().genus.should.equal(1);
		Lathe.solid({ outer : { kind : 'circle', center : [20, 0], r : 5 } }).faces.map(function (f) { return f.name; }).should.eql(['outer.0']);
	});

	it('is an operand of Booleans: a pulley with a belt groove cut by a torus', function () {
		var pts = [[3, 0], [20, 0], [20, 12], [3, 12]];
		var r = evaluate({
			p : { type : 'profile/revolve', in : { profile : path(pts[0], pts.slice(1).concat([pts[0]]).map(line)) } },
			g : { type : 'profile/revolve', in : { profile : { outer : { kind : 'circle', center : [20, 6], r : 2 } } } },
			x : { type : 'boolean/difference', in : { from : '@p', minus : '@g' } } });
		r.verdict.kind.should.equal('buildable');
		r.result.report.manifold.closedManifold.should.be.true();
		// half the torus lies in the pulley, less the sliver its polygon misses
		r.result.report.volume.should.be.approximately(turned(pts) - PI * 4 * 2 * PI * (20 - 8 / (3 * PI)) / 2, 5e-3 * turned(pts));
	});

	it('a belt groove cut through a pulley\'s side: the export mesh closed, of the exact volume (#116)', function () {
		// the torus's band in the pulley goes round the axis: its face is cut along the seam it goes round
		var groove = { type : 'profile/revolve', in : { profile : { outer : { kind : 'circle', center : [35, 3.5], r : 1.8 } } } };
		// the part of the groove's circle inside r = 35.9 (all but the segment 0.9 beyond its centre), by Pappus
		var R = 1.8, th = 2 * Math.acos(0.9 / R), seg = R * R / 2 * (th - Math.sin(th)), xs = 35 + 4 * R * Math.pow(Math.sin(th / 2), 3) / (3 * (th - Math.sin(th)));
		var cut = 2 * PI * (PI * R * R * 35 - seg * xs);
		var pts = [[2.5, 0], [35.9, 0], [35.9, 7], [2.5, 7]];
		[[{ type : 'primitive/cylinder', in : { radius : 35.9, height : 7 } }, PI * 35.9 * 35.9 * 7],
		 [{ type : 'profile/revolve', in : { profile : path(pts[0], pts.slice(1).concat([pts[0]]).map(line)) } }, turned(pts)]].forEach(function (c) {
			var r = new Graph().evaluate({ version : 2, meta : { name : 'groove' }, nodes : { p : c[0], g : groove, x : { type : 'boolean/difference', in : { from : '@p', minus : '@g' } } },
				outputs : { s : '@x' } }, { output : 's', mesh : 'print' });
			r.verdict.kind.should.equal('buildable', r.verdict.reasons.join('; '));
			r.export.mesh.checkClosedManifold().closedManifold.should.be.true();
			// the verdict judges the export mesh too
			r.verdict.checks.filter(function (k) { return k.name == 'export mesh' && k.passed; }).length.should.equal(1);
			r.export.mesh.signedVolume().should.be.approximately(c[1] - cut, 1e-3 * c[1]);
			r.export.mesh.signedVolume().should.be.approximately(r.result.report.volume, 5e-3 * c[1]);
		});
	});
	it('refuses a path across the axis, two runs along it, a part turn and holes', function () {
		var bad = function (profile, re, degrees) {
			(function () { evaluate({ x : { type : 'profile/revolve', in : { profile : profile, degrees : degrees == null ? 360 : degrees } } }); }).should.throw(re);
		};
		bad(path([-2, 0], [line([10, 0]), line([10, 5]), line([-2, 5]), line([-2, 0])]), /crosses the axis/);
		bad(path([0, 0], [line([5, 0]), line([0, 2]), line([0, 4]), line([5, 6]), line([0, 6]), line([0, 0])]), /more than once/);
		bad(path([0, 0], [line([5, 0]), line([5, 5]), line([0, 5]), line([0, 0])]), /full turn/, 180);
		bad({ outer : { kind : 'circle', center : [20, 0], r : 5 }, holes : [{ kind : 'circle', center : [20, 0], r : 2 }] }, /no holes/);
	});
});
