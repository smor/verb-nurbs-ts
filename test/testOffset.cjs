var should = require('should');
var lib = require('../dist/index.js');
var Graph = lib.Graph, Clearance = lib.Clearance, ShellBuilder = lib.ShellBuilder, ProfileOffset = lib.ProfileOffset;
var budget = require('./support/budget.cjs');

// Offsets of solids (#150, ask 3): the offset's faces sit at the offset distance from the solid's, on the exact shells.

var PI = Math.PI;
var sq = { kind : 'path', start : [-3, -3], segments : [{ type : 'line', to : [3, -3] }, { type : 'line', to : [3, 3] }, { type : 'line', to : [-3, 3] }, { type : 'line', to : [-3, -3] }] };

// points on each face of a body: its mesh triangles' centroids projected onto the face's surface (about 300 of them)
function samples(X) {
	var m = X.mesh, out = [], pr = {}, tris = m.mesh.triangles, step = Math.max(1, Math.floor(tris.length / 300));
	for (var i = 0; i < tris.length; i += step) {
		var t = tris[i], f = m.faceOf[i];
		pr[f] = pr[f] || ShellBuilder.projector(X.shell.faces[f].surface);
		var c = [0, 1, 2].map(function (k) { return (m.mesh.vertices[t[0]][k] + m.mesh.vertices[t[1]][k] + m.mesh.vertices[t[2]][k]) / 3; });
		out.push(pr[f](c).p);
	}
	return out;
}
function range(from, to) {
	var r = [Infinity, -Infinity];
	samples(from).forEach(function (p) { var x = Clearance.distanceTo(to, p); r = [Math.min(r[0], x), Math.max(r[1], x)]; });
	return r;
}
// the solid "s" and its offset by d: the distances from the solid's faces to the offset's, and back
function offset(nodes, d) {
	var g = new Graph(), doc = { version : 2, meta : { name : 'offset' }, nodes : Object.assign({}, nodes, { off : { type : 'finish/offset', in : { of : '@s', distance : d } } }), outputs : { s : '@s', o : '@off' } };
	var rs = g.evaluate(doc, { output : 's' }), ro = g.evaluate(doc, { output : 'o' });
	var A = Clearance.body(g.shellOf(rs)), B = Clearance.body(g.shellOf(ro));
	return { g : g, ro : ro, out : range(A, B), back : range(B, A) };
}

describe("verb.solid.ProfileOffset and the offset feature", function () {
	this.timeout(budget(120000));

	it('a box grown and shrunk: every face at the distance both ways, and the grown volume Steiner\'s', function () {
		var r = offset({ s : { type : 'primitive/box', in : { width : 4, depth : 6, height : 8 } } }, 0.5);
		r.ro.verdict.kind.should.equal('buildable');
		r.out.concat(r.back).forEach(function (x) { x.should.be.approximately(0.5, 1e-8); });
		// the box swept by a ball: V + d S + pi d^2 (w + h + l) + 4/3 pi d^3
		var d = 0.5, V = 4 * 6 * 8 + d * 2 * (24 + 32 + 48) + PI * d * d * 18 + 4 / 3 * PI * d * d * d;
		r.g.massProperties(r.ro).volume.should.be.approximately(V, 2e-3 * V);
		r = offset({ s : { type : 'primitive/box', in : { width : 4, depth : 6, height : 8 } } }, -0.5);
		r.back.forEach(function (x) { x.should.be.approximately(0.5, 1e-8); });
		r.g.massProperties(r.ro).volume.should.be.approximately(3 * 5 * 7, 1e-9);
	});

	it('a cylinder grown and shrunk: at the distance, within the round\'s fit', function () {
		var r = offset({ s : { type : 'primitive/cylinder', in : { radius : 3, height : 5 } } }, 0.25);
		r.out.forEach(function (x) { x.should.be.approximately(0.25, 1e-8); });
		r.back.forEach(function (x) { x.should.be.approximately(0.25, 2e-4); });
		r = offset({ s : { type : 'primitive/cylinder', in : { radius : 3, height : 5 } } }, -0.25);
		r.out.concat(r.back).forEach(function (x) { x.should.be.approximately(0.25, 1e-8); });
	});

	it('a twisted bar grown and shrunk: its screw sides at the distance, within the fit of the section', function () {
		var bar = { s : { type : 'profile/extrude', in : { profile : { outer : sq }, height : 20, z : 0, twist : 90 } } };
		// grown: every point of the bar at the distance from the offset; the offset's points no nearer, and at the
		// distance but for its caps' rims, which stay sharp
		var r = offset(bar, 0.25);
		r.ro.verdict.kind.should.equal('buildable');
		r.out.forEach(function (x) { x.should.be.approximately(0.25, 2e-4); });
		r.back[0].should.be.aboveOrEqual(0.25 - 2e-4);
		// shrunk: every point of the offset at the distance from the bar, the bar's no nearer
		r = offset(bar, -0.25);
		r.back.forEach(function (x) { x.should.be.approximately(0.25, 2e-4); });
		r.out[0].should.be.aboveOrEqual(0.25 - 2e-4);
	});

	it('profile offsets: a square grown gains quarter circles, a circle round the twist\'s axis stays a circle', function () {
		var p = ProfileOffset.region({ outer : sq }, 1);
		p.outer.segments.filter(function (s) { return s.type == 'arc'; }).length.should.equal(4);
		ProfileOffset.region({ outer : sq }, -1).outer.start.should.eql([-2, -2]);
		var c = ProfileOffset.region({ outer : { kind : 'circle', center : [0, 0], r : 2 } }, 0.5, 1e-4, 0.1);
		c.outer.r.should.equal(2.5);
		should(ProfileOffset.region({ outer : { kind : 'circle', center : [0, 0], r : 2 } }, -3)).be.null();
		var t = ProfileOffset.rotated({ outer : sq }, PI / 2).outer.start;
		t[0].should.be.approximately(3, 1e-15); t[1].should.be.approximately(-3, 1e-15);
		(function () { ProfileOffset.region({ outer : sq }, -3.5); }).should.throw();
	});

	it('refuses what it cannot offset exactly yet: a tapered extrusion', function () {
		var g = new Graph(), doc = { version : 2, meta : { name : 'offset' }, nodes : {
			s : { type : 'profile/extrude', in : { profile : { outer : sq }, height : 10, z : 0, scaleTop : 0.5 } },
			off : { type : 'finish/offset', in : { of : '@s', distance : 0.25 } } }, outputs : { o : '@off' } };
		(function () { g.evaluate(doc); }).should.throw(/tapered/);
	});
});
