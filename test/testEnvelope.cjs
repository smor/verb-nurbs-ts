var should = require('should');
var lib = require('../dist/index.js');
var Graph = lib.Graph, Clearance = lib.Clearance, ShellBuilder = lib.ShellBuilder;
var budget = require('./support/budget.cjs');

// Swept envelopes (#150, ask 4): the room a solid takes moving along a path, as a solid.

var PI = Math.PI;

// points on the body's faces: its mesh triangles' centroids projected onto their faces
function samples(X) {
	var m = X.mesh, out = [], pr = {}, tris = m.mesh.triangles, step = Math.max(1, Math.floor(tris.length / 400));
	for (var i = 0; i < tris.length; i += step) {
		var t = tris[i], f = m.faceOf[i];
		pr[f] = pr[f] || ShellBuilder.projector(X.shell.faces[f].surface);
		var c = [0, 1, 2].map(function (k) { return (m.mesh.vertices[t[0]][k] + m.mesh.vertices[t[1]][k] + m.mesh.vertices[t[2]][k]) / 3; });
		out.push({ p : pr[f](c).p, face : X.shell.faces[f].name });
	}
	return out;
}
function toSegment(p, a, b) {
	var d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
	var t = Math.max(0, Math.min(1, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2])));
	return Math.hypot(w[0] - t * d[0], w[1] - t * d[1], w[2] - t * d[2]);
}
function doc(nodes, outputs) { return { version : 2, meta : { name : 'sweep' }, nodes : nodes, outputs : outputs }; }

describe("verb.solid sweeps (swept envelopes)", function () {
	this.timeout(budget(120000));

	it('a ball moving along a line sweeps a capsule: every point at the radius from the centre\'s path, the capsule\'s volume', function () {
		var g = new Graph(), r = 2;
		// the catalogue's ball stands on z = 0 (centre at z = r), moved to (1, 2, 3), then swept 20 along (1, 1, 1) / sqrt 3
		var k = 20 / Math.sqrt(3), D = doc({
			b : { type : 'primitive/sphere', in : { radius : r } }, m : { type : 'transform/move', in : { of : '@b', x : 1, y : 2, z : 3 } },
			s : { type : 'finish/sweep', in : { of : '@m', x : k + ' * t', y : k + ' * t', z : k + ' * t', samples : 2 } } }, { s : '@s' });
		var res = g.evaluate(D);
		res.verdict.kind.should.equal('buildable');
		var a = [1, 2, 3 + r], b = [1 + k, 2 + k, 3 + r + k];
		var names = {};
		samples(Clearance.body(g.shellOf(res))).forEach(function (q) { toSegment(q.p, a, b).should.be.approximately(r, 1e-9); names[q.face] = true; });
		Object.keys(names).sort().should.eql(['end cap', 'start cap', 'tube']);
		g.massProperties(res).volume.should.be.approximately(PI * r * r * 20 + 4 / 3 * PI * r * r * r, 2e-5 * 300);
	});

	it('a ball moving along a curve sweeps its canal surface, and the envelope cuts a groove', function () {
		var g = new Graph(), r = 2, R = 30;
		// half a circle of radius 30: half a torus and a ball's worth of ends
		var D = doc({
			b : { type : 'primitive/sphere', in : { radius : r } },
			s : { type : 'finish/sweep', in : { of : '@b', x : R + ' * cos(pi * t) - ' + R, y : R + ' * sin(pi * t)', z : '0', samples : 24 } },
			slab : { type : 'primitive/box', in : { width : 80, depth : 50, height : 4 } },
			slab2 : { type : 'transform/move', in : { of : '@slab', x : -R, y : 15, z : 2 } },
			cut : { type : 'boolean/difference', in : { from : '@slab2', minus : '@s' } } }, { s : '@s', cut : '@cut' });
		var res = g.evaluate(D, { output : 's' });
		var V = PI * r * r * PI * R + 4 / 3 * PI * r * r * r;
		g.massProperties(res).volume.should.be.approximately(V, 1e-4 * V);
		// the centre's path is (R cos - R, R sin, r): every point of the tube and the domes r from it
		samples(Clearance.body(g.shellOf(res))).forEach(function (q) {
			var p = q.p, rho = Math.hypot(p[0] + R, p[1]);
			var d = p[1] >= 0 ? Math.hypot(rho - R, p[2] - r) : Math.min(Math.hypot(p[0], p[1], p[2] - r), Math.hypot(p[0] + 2 * R, p[1], p[2] - r));
			d.should.be.approximately(r, 5e-4); // the path is the cubic through 24 samples of the circle
		});
		// a groove: the slab (z from 2 to 6) less the upper half of the tube and the domes above z = 2
		var cut = g.evaluate(D, { output : 'cut' });
		cut.verdict.kind.should.equal('buildable');
		var slab = 80 * 50 * 4;
		g.massProperties(cut).volume.should.be.approximately(slab - V / 2, 2e-4 * slab);
	});

	it('refuses what it cannot sweep yet', function () {
		var g = new Graph();
		(function () { g.evaluate(doc({ b : { type : 'primitive/box', in : { width : 2, depth : 2, height : 2 } }, s : { type : 'finish/sweep', in : { of : '@b' } } }, { s : '@s' })); }).should.throw(/only take a ball/);
	});
});
