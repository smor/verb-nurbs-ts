var should = require('should');
var lib = require('../dist/index.js');
var Graph = lib.Graph, MassPropertiesOf = lib.MassPropertiesOf;

// Mass properties integrated on the exact shell (#150, ask 2): textbook values for a box and a cylinder, a tensor that
// turns with the solid, and sets of solids of different densities.

var PI = Math.PI;
var evaluate = function (g, nodes) { return g.evaluate({ version : 2, meta : { name : 'mass' }, nodes : nodes, outputs : { s : '@s' } }, { output : 's' }); };
var box = function (w, d, h) { return { type : 'primitive/box', in : { width : w, depth : d, height : h } }; };
var near = function (a, b, rel) { a.should.be.approximately(b, rel * Math.max(1, Math.abs(b))); };

describe("verb.solid.MassPropertiesOf", function () {
	this.timeout(60000);

	it('a box: its mass, centre of mass and textbook inertia (m (b² + c²) / 12), exactly', function () {
		var g = new Graph(), m = g.massProperties(evaluate(g, { s : box(2, 4, 6) }), 2);
		near(m.volume, 48, 1e-12);
		near(m.mass, 96, 1e-12);
		[0, 0, 3].forEach(function (c, k) { near(m.centroid[k], c, 1e-12); });
		near(m.inertia[0][0], 96 * (16 + 36) / 12, 1e-12);
		near(m.inertia[1][1], 96 * (4 + 36) / 12, 1e-12);
		near(m.inertia[2][2], 96 * (4 + 16) / 12, 1e-12);
		[[0, 1], [0, 2], [1, 2]].forEach(function (p) { m.inertia[p[0]][p[1]].should.be.approximately(0, 1e-9); });
		m.principal.should.have.length(3);
		near(m.principal[0], 160, 1e-12); near(m.principal[2], 416, 1e-12);
		Math.abs(m.axes[0][2]).should.be.approximately(1, 1e-12); // the smallest moment about z, the long side
	});

	it('a cylinder: m r² / 2 about its axis and m (3 r² + h²) / 12 across, to the shell\'s edge tolerance', function () {
		// the shell's edges are fitted to half its tolerance and the integrals follow the fitted p-curves, so they are
		// as exact as the shell: about 1e-4 at the graph's default tolerance (0.01), 1e-6 once the edges are fitted to 1e-5
		var g = new Graph(), r = 3, h = 5, res = evaluate(g, { s : { type : 'primitive/cylinder', in : { radius : r, height : h } } });
		var V = PI * r * r * h;
		[[g.massProperties(res), 3e-4], [MassPropertiesOf.shell(lib.ShellBuilder.fromResult(res.result, { tolerance : 1e-5 })), 1e-6]].forEach(function (x) {
			var m = x[0], rel = x[1];
			near(m.volume, V, rel);
			near(m.centroid[2], h / 2, rel);
			near(m.inertia[2][2], V * r * r / 2, rel);
			near(m.inertia[0][0], V * (3 * r * r + h * h) / 12, rel);
			near(m.inertia[1][1], V * (3 * r * r + h * h) / 12, rel);
			Math.abs(m.axes[2][2]).should.be.approximately(1, 1e-3); // the largest moment about the axis
		});
	});

	it('a box turned about z and moved: the tensor turns with it (R I Rᵀ), and the centre of mass moves', function () {
		var g = new Graph(), a = 30 * PI / 180, c = Math.cos(a), s = Math.sin(a);
		var m = g.massProperties(evaluate(g, { b : box(2, 4, 6), t : { type : 'transform/rotate', in : { of : '@b', axis : 'z', degrees : 30 } },
			s : { type : 'transform/move', in : { of : '@t', x : 5, y : -1, z : 2 } } }));
		var I0 = [48 * (16 + 36) / 12, 48 * (4 + 36) / 12, 48 * (4 + 16) / 12];
		// R diag(I0) Rᵀ for a turn about z
		near(m.inertia[0][0], c * c * I0[0] + s * s * I0[1], 1e-10);
		near(m.inertia[1][1], s * s * I0[0] + c * c * I0[1], 1e-10);
		near(m.inertia[0][1], c * s * (I0[0] - I0[1]), 1e-10);
		near(m.inertia[2][2], I0[2], 1e-10);
		[5, -1, 5].forEach(function (x, k) { near(m.centroid[k], x, 1e-10); });
	});

	it('a set of solids, each of its own density: masses add, and the tensors meet at the common centre', function () {
		var g = new Graph();
		var left = g.massProperties(evaluate(g, { b : box(2, 4, 6), s : { type : 'transform/move', in : { of : '@b', x : -1, y : 0, z : 0 } } }), 1.25);
		var right = g.massProperties(evaluate(g, { b : box(2, 4, 6), s : { type : 'transform/move', in : { of : '@b', x : 1, y : 0, z : 0 } } }), 1.25);
		var whole = g.massProperties(evaluate(g, { s : box(4, 4, 6) }), 1.25);
		var both = MassPropertiesOf.combine([left, right]);
		near(both.mass, whole.mass, 1e-12);
		near(both.volume, whole.volume, 1e-12);
		for (var i = 0; i < 3; i++) { near(both.centroid[i], whole.centroid[i], 1e-12); for (var j = 0; j < 3; j++) near(both.inertia[i][j], whole.inertia[i][j], 1e-10); }
		// two densities: a PLA half and a steel half (1.24 and 7.85 g/cm³, in g/mm³): the centre of mass by the lever rule
		var pla = g.massProperties(evaluate(g, { b : box(2, 4, 6), s : { type : 'transform/move', in : { of : '@b', x : -1, y : 0, z : 0 } } }), 1.24e-3);
		var steel = g.massProperties(evaluate(g, { b : box(2, 4, 6), s : { type : 'transform/move', in : { of : '@b', x : 1, y : 0, z : 0 } } }), 7.85e-3);
		var mix = MassPropertiesOf.combine([pla, steel]);
		near(mix.mass, 48 * (1.24e-3 + 7.85e-3), 1e-12);
		near(mix.centroid[0], (-1 * 1.24e-3 + 1 * 7.85e-3) / (1.24e-3 + 7.85e-3), 1e-12);
		// about z through the common centre: each half's own inertia plus its mass times its offset²
		var mz = function (rho, x) { return 48 * rho * (4 + 16) / 12 + 48 * rho * Math.pow(x - mix.centroid[0], 2); };
		near(mix.inertia[2][2], mz(1.24e-3, -1) + mz(7.85e-3, 1), 1e-10);
	});

	it('a Boolean result: a bored disc, its moment about the axis m (R² + r²) / 2', function () {
		var g = new Graph(), R = 25, r0 = 2.5, h = 6;
		var res = evaluate(g, { d : { type : 'primitive/cylinder', in : { radius : R, height : h } }, b : { type : 'primitive/cylinder', in : { radius : r0, height : h + 2 } },
			bm : { type : 'transform/move', in : { of : '@b', x : 0, y : 0, z : -1 } }, s : { type : 'boolean/difference', in : { from : '@d', minus : '@bm' } } });
		var m = g.massProperties(res), V = PI * (R * R - r0 * r0) * h;
		near(m.volume, V, 3e-4);
		near(m.inertia[2][2], V * (R * R + r0 * r0) / 2, 3e-4);
		near(m.centroid[2], h / 2, 3e-4);
	});

	it('refuses a set with no parts', function () {
		(function () { MassPropertiesOf.combine([]); }).should.throw(/no parts/);
	});
});
