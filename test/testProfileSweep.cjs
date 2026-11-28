var should = require('should');
var made = require('./support/made.cjs');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph, ProfileSweep = lib.ProfileSweep, ShellBuilder = lib.ShellBuilder, Extrusion = lib.Extrusion;

// A planar section swept along a rail (#134): exact faces, the volume in closed form, the frame at the rail's ends as
// graph outputs, and 507's barrel-cam groove (~167's drum) against the hull-of-cones build it replaces.

var PI = Math.PI;
var line = function (to) { return { type : 'line', to : to }; };
var circle = function (cx, cy, r) { return { kind : 'circle', center : [cx, cy], r : r }; };
var dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
var cross = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
var sub = function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; };
var norm = function (a) { return Math.sqrt(dot(a, a)); };
var unit = function (a) { var n = norm(a); return [a[0] / n, a[1] / n, a[2] / n]; };

// every edge of a shell on both its faces, through its p-curves
function worstEdge(shell) {
	var worst = 0;
	shell.edges.forEach(function (e) {
		[e.left, e.right].forEach(function (f, k) { worst = Math.max(worst, ShellBuilder.deviation(e.curve, shell.faces[f].surface, e.pcurves[k])); });
	});
	return worst;
}

// ~167's groove cutter, in the section's (u, v) plane with v radial: a 45° cone with a flat tip of radius 2 at
// r = 16 - 3.5, grown by a normal clearance of 0.3, its floor 0.6 below the tip and running out to r = 17. Its axial
// section is this trapezoid, about the rail on the drum's surface (v = r - 16).
var GROW = 0.3 * Math.SQRT2, FLOOR = 2 + GROW - 0.6, TOP = 2 + GROW + 4.5;
var cutter = { outer : { kind : 'path', start : [-FLOOR, -4.1], segments : [line([FLOOR, -4.1]), line([TOP, 1]), line([-TOP, 1]), line([-FLOOR, -4.1])] } };
// the same cone, as a solid of revolution about its axis, for placing at a groove's end: running out a little further
// than the groove's section (to v = 2), so that its top does not graze the swept top along the end (docs/formats.md, Sweeps)
var cone = { outer : { kind : 'path', start : [0, -4.1], segments : [line([FLOOR, -4.1]), line([TOP + 1, 2]), line([0, 2]), line([0, -4.1])] } };

// 167's heart cam: 27 mm out over half a turn and back over the other, each stroke's ends blended by constant
// acceleration over `blend` degrees; as an expression of u (0 to 1 a turn), and as a function
function heartExpr(blend, u) {
	var b = '(' + blend + ' * pi / 180)', a = '(27 / (' + b + ' * (pi - ' + b + ')))', phi = '(pi - abs(2 * pi * ' + u + ' - pi))';
	var q = '(clamp(' + phi + ', pi - ' + b + ', pi) - (pi - ' + b + '))';
	return '(' + a + ' / 2 * clamp(' + phi + ', 0, ' + b + ')^2 + ' + a + ' * ' + b + ' * (clamp(' + phi + ', ' + b + ', pi - ' + b + ') - ' + b + ') + ' + a + ' * ' + b + ' * ' + q + ' - ' + a + ' / 2 * ' + q + '^2)';
}
function heart(blend, u) {
	var b = blend * PI / 180, a = 27 / (b * (PI - b)), phi = PI - Math.abs(2 * PI * u - PI);
	var clamp = function (x, lo, hi) { return Math.min(hi, Math.max(lo, x)); };
	var q = clamp(phi, PI - b, PI) - (PI - b);
	return a / 2 * Math.pow(clamp(phi, 0, b), 2) + a * b * (clamp(phi, b, PI - b) - b) + a * b * q - a / 2 * q * q;
}

// The distance from each vertex and triangle centre of mesh A to mesh B (its triangles, exactly), the largest: on a
// grid of cells `h` wide holding B's triangles, searched `reach` cells round (enough for distances below h reach).
function farthest(A, B, h, reach) {
	var cells = new Map(), key = function (i, j, k) { return i + ',' + j + ',' + k; };
	B.triangles.forEach(function (t, ti) {
		var p = t.map(function (v) { return B.vertices[v]; });
		var lo = [0, 1, 2].map(function (d) { return Math.floor(Math.min(p[0][d], p[1][d], p[2][d]) / h); });
		var hi = [0, 1, 2].map(function (d) { return Math.floor(Math.max(p[0][d], p[1][d], p[2][d]) / h); });
		for (var i = lo[0]; i <= hi[0]; i++) for (var j = lo[1]; j <= hi[1]; j++) for (var k = lo[2]; k <= hi[2]; k++) {
			var c = key(i, j, k); if (!cells.has(c)) cells.set(c, []); cells.get(c).push(ti);
		}
	});
	// the distance from p to triangle abc (Ericson, Real-Time Collision Detection, 2005, 5.1.5)
	var toTri = function (p, a, b, c) {
		var ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
		if (d1 <= 0 && d2 <= 0) return norm(ap);
		var bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
		if (d3 >= 0 && d4 <= d3) return norm(bp);
		var vc = d1 * d4 - d3 * d2;
		if (vc <= 0 && d1 >= 0 && d3 <= 0) { var v = d1 / (d1 - d3); return norm(sub(p, [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]])); }
		var cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
		if (d6 >= 0 && d5 <= d6) return norm(cp);
		var vb = d5 * d2 - d1 * d6;
		if (vb <= 0 && d2 >= 0 && d6 <= 0) { var w = d2 / (d2 - d6); return norm(sub(p, [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]])); }
		var va = d3 * d6 - d5 * d4;
		if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { var x = (d4 - d3) / ((d4 - d3) + (d5 - d6)); var bc = sub(c, b); return norm(sub(p, [b[0] + x * bc[0], b[1] + x * bc[1], b[2] + x * bc[2]])); }
		var n = unit(cross(ab, ac)); return Math.abs(dot(ap, n));
	};
	var pts = A.vertices.slice();
	A.triangles.forEach(function (t) { var a = A.vertices[t[0]], b = A.vertices[t[1]], c = A.vertices[t[2]]; pts.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]); });
	var worst = 0;
	pts.forEach(function (p) {
		var best = Infinity, i0 = Math.floor(p[0] / h), j0 = Math.floor(p[1] / h), k0 = Math.floor(p[2] / h), seen = new Set();
		for (var i = -reach; i <= reach; i++) for (var j = -reach; j <= reach; j++) for (var k = -reach; k <= reach; k++) {
			var list = cells.get(key(i0 + i, j0 + j, k0 + k)); if (!list) continue;
			list.forEach(function (ti) { if (seen.has(ti)) return; seen.add(ti); var t = B.triangles[ti];
				best = Math.min(best, toTri(p, B.vertices[t[0]], B.vertices[t[1]], B.vertices[t[2]])); });
		}
		worst = Math.max(worst, best);
	});
	return worst;
}

var wasm;
before(async function () {
	var Module = (await import('manifold-3d')).default;
	wasm = await Module();
	wasm.setup();
});
// a manifold-3d mesh as { vertices, triangles }
function plain(m) {
	var g = m.getMesh(), n = g.numProp, v = [], t = [];
	for (var i = 0; i < g.vertProperties.length; i += n) v.push([g.vertProperties[i], g.vertProperties[i + 1], g.vertProperties[i + 2]]);
	for (var j = 0; j < g.triVerts.length; j += 3) t.push([g.triVerts[j], g.triVerts[j + 1], g.triVerts[j + 2]]);
	return { vertices : v, triangles : t };
}
// 507's build of a groove (packages/elements/src/drum.ts): the cutter cone, its axis radial from z, at stations along
// the rail; the convex hulls of each two neighbours, united
// the cutter cone at a point of a rail on the drum, its axis radial from z, as points of its two end circles, running
// out to v = top
function conePoints(p, top) {
	var axis = unit([p[0], p[1], 0]), e1 = unit(cross(axis, [0, 0, 1])), e2 = cross(axis, e1), out = [];
	[[FLOOR, -4.1], [FLOOR + top + 4.1, top]].forEach(function (rv) {
		for (var k = 0; k < 64; k++) { var a = 2 * PI * k / 64;
			out.push([0, 1, 2].map(function (d) { return p[d] + rv[1] * axis[d] + rv[0] * (Math.cos(a) * e1[d] + Math.sin(a) * e2[d]); })); }
	});
	return out;
}
// 507's build of a groove (packages/elements/src/drum.ts): the cutter at stations along the rail, the convex hulls
// of each two neighbours united
function hullOfCones(rail, closed) {
	var cones = rail.map(function (p) { return conePoints(p, 1); }), hulls = [];
	for (var i = 0; i + (closed ? 0 : 1) < cones.length; i++) hulls.push(wasm.Manifold.hull(cones[i].concat(cones[(i + 1) % cones.length])));
	return wasm.Manifold.union(hulls);
}
// The signed distance from p to the exact union of the cutter cones along a rail on the drum (negative inside), the
// cone at each of `stations` (dense: their spacing well below the distances measured), those within `window`
// stations of p's angle: a cone's distance is that of its axial section, the trapezoid, in the (radius, axis) plane.
function coneUnion(stations, window, near) {
	var K = stations.length, poly = [[0, -4.1], [FLOOR, -4.1], [TOP, 1], [0, 1]];
	var seg = function (px, py, a, b) { var dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
		return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy); };
	var trap = function (r, a) { var d = Infinity; for (var i = 0; i < 4; i++) d = Math.min(d, seg(r, a, poly[i], poly[(i + 1) % 4]));
		return a >= -4.1 && a <= 1 && r <= FLOOR + a + 4.1 ? -d : d; };
	return function (p) {
		var k0 = near != null ? near(p) : Math.round(((Math.atan2(p[1], p[0]) / (2 * PI)) % 1 + 1) % 1 * K), best = Infinity;
		for (var dk = -window; dk <= window; dk++) {
			if (near != null && (k0 + dk < 0 || k0 + dk >= K)) continue;
			var c = stations[((k0 + dk) % K + K) % K], axis = unit([c[0], c[1], 0]), d = sub(p, c), a = dot(d, axis);
			best = Math.min(best, trap(norm(sub(d, axis.map(function (x) { return x * a; }))), a));
		}
		return best;
	};
}

describe("Profile sweep (#134)", function () {
	this.timeout(budget(120000));

	it('sweeps a circle round a circle into the torus, its volume 2 pi^2 R r^2 in closed form and on its faces', function () {
		var R = 20, r = 3, N = 96;
		var rail = Array.from({ length : N }, function (_, i) { var a = 2 * PI * i / N; return [R * Math.cos(a), R * Math.sin(a), 0]; });
		var exact = 2 * PI * PI * R * r * r;
		['radial', 'up', 'rmf'].forEach(function (frame) {
			var s = ProfileSweep.shell({ outer : circle(0, 0, r) }, rail, { closed : true, frame : frame });
			// a ring cut into halves, each section piece too (a circle is two halves): 4 faces, no caps
			s.shell.faces.length.should.equal(4);
			worstEdge(s.shell).should.be.below(1e-9);
			// the closed form is the shell's own volume (to rounding), and the spline through 96 points is the circle
			// to about 1e-7
			(Math.abs(s.shell.volume / ShellBuilder.volume(s.shell) - 1)).should.be.below(1e-9);
			(Math.abs(s.shell.volume / exact - 1)).should.be.below(1e-6);
			s.mesh.checkClosedManifold().closedManifold.should.be.true();
		});
	});

	it('sweeps a profile straight up as its extrusion', function () {
		var profile = { outer : { kind : 'path', start : [0, 0], segments : [line([30, 0]), { type : 'arc', via : [38, 10], to : [30, 20] }, line([0, 20]), line([0, 0])] },
			holes : [circle(12, 10, 4)] };
		var rail = Array.from({ length : 9 }, function (_, i) { return [0, 0, 10 * i / 8]; });
		// v held along y, so that u = v x t = x: the section's plane is the profile's own
		var s = ProfileSweep.shell(profile, rail, { frame : 'up', up : [0, 1, 0] });
		var e = Extrusion.shell(profile, 10);
		(Math.abs(s.shell.volume / e.shell.volume - 1)).should.be.below(1e-12);
		s.shell.faces.map(function (f) { return f.name; }).sort().should.eql(e.shell.faces.map(function (f) { return f.name; }).sort().map(function (n) { return n == 'bottom' ? 'start' : n == 'top' ? 'end' : n; }).sort());
		// every vertex of the extrusion is one of the sweep's
		e.shell.vertices.forEach(function (p) {
			Math.min.apply(null, s.shell.vertices.map(function (q) { return norm(sub(p, q)); })).should.be.below(1e-12);
		});
		worstEdge(s.shell).should.be.below(1e-9);
	});

	it('gives the ends of a helix, their tangents and frames, in closed form, as graph outputs too', function () {
		var R = 16, rise = 20, turns = 0.75, w = 2 * PI * turns;
		var P = function (t) { return [R * Math.cos(w * t), R * Math.sin(w * t), rise * t]; };
		var T = function (t) { return unit([-R * w * Math.sin(w * t), R * w * Math.cos(w * t), rise]); };
		var doc = { version : 2, nodes : {
			r : { type : 'number', in : { value : R } },
			g : { type : 'profile/sweep', in : { profile : cutter, x : 'r * cos(' + w + ' * t)', y : 'r * sin(' + w + ' * t)', z : rise + ' * t', samples : 96 } },
		}, outputs : { g : '@g' } };
		var res = new Graph().evaluate(doc);
		var p = res.parameters;
		['start', 'end'].forEach(function (end, k) {
			var t = k, at = function (q) { return [p['g_' + end + '_' + q + 'x'], p['g_' + end + '_' + q + 'y'], p['g_' + end + '_' + q + 'z']]; };
			var pt = [p['g_' + end + '_x'], p['g_' + end + '_y'], p['g_' + end + '_z']];
			norm(sub(pt, P(t))).should.be.below(1e-12);
			norm(sub(at('t'), T(t))).should.be.below(1e-9);
			// radial: v points away from the z axis, normal to the tangent; u = v x t
			var radial = unit([pt[0], pt[1], 0]), v = unit(sub(radial, T(t).map(function (x) { return x * dot(radial, T(t)); })));
			norm(sub(at('v'), v)).should.be.below(1e-9);
			norm(sub(at('u'), cross(v, T(t)))).should.be.below(1e-9);
		});
		// the sweep's own end caps lie in the planes those outputs give
		var shell = res.result.faces;
		var cap = res.faceNames.indexOf('g.end');
		cap.should.be.aboveOrEqual(0);
		var n = [p.g_end_tx, p.g_end_ty, p.g_end_tz], o = [p.g_end_x, p.g_end_y, p.g_end_z];
		res.result.mesh.triangles.forEach(function (t, i) {
			if (res.result.faceOf[i] != cap) return;
			t.forEach(function (v) { Math.abs(dot(sub(res.result.mesh.vertices[v], o), n)).should.be.below(1e-9); });
		});
		should.exist(shell);
	});

	it('places a cone at both ends of a groove along a helix, cut into a drum: on the cones\' union within 0.05 mm', function () {
		// (starting off the blank's seams, which a cone's axis there would meet)
		var R = 16, rise = 20, turns = 0.75, w = 2 * PI * turns, th0 = 0.35;
		var place = function (end) {
			return { type : 'transform/place', in : { of : '@upright_' + end, x : '@g.' + end + '_x', y : '@g.' + end + '_y', z : '@g.' + end + '_z',
				ux : '@g.' + end + '_ux', uy : '@g.' + end + '_uy', uz : '@g.' + end + '_uz', vx : '@g.' + end + '_vx', vy : '@g.' + end + '_vy', vz : '@g.' + end + '_vz' } };
		};
		var doc = { version : 2, nodes : {
			g : { type : 'profile/sweep', in : { profile : cutter, x : R + ' * cos(' + th0 + ' + ' + w + ' * t)', y : R + ' * sin(' + th0 + ' + ' + w + ' * t)', z : rise + ' * t', samples : 128 } },
			// the cone about z, turned so that its axis is y: placed, y is the frame's v, radial; its seam (along x) turned
			// first to point away from the groove, out of the end section's plane (docs/formats.md, Sweeps)
			c : { type : 'profile/revolve', in : { profile : cone } },
			turned_start : { type : 'transform/rotate', in : { of : '@c', axis : 'z', degrees : 90 } },
			turned_end : { type : 'transform/rotate', in : { of : '@c', axis : 'z', degrees : -90 } },
			upright_start : { type : 'transform/rotate', in : { of : '@turned_start', axis : 'x', degrees : -90 } },
			upright_end : { type : 'transform/rotate', in : { of : '@turned_end', axis : 'x', degrees : -90 } },
			a : place('start'), b : place('end'),
			ga : { type : 'boolean/union', in : { a : '@g', b : '@a' } },
			groove : { type : 'boolean/union', in : { a : '@ga', b : '@b' } },
			blank : { type : 'profile/extrude', in : { profile : { outer : circle(0, 0, 16) }, height : 40, z : -10 } },
			drum : { type : 'boolean/difference', in : { from : '@blank', minus : '@groove' } },
		}, outputs : { drum : '@drum' } };
		var res = new Graph().evaluate(doc, { mesh : 'print' });
		made(res.verdict);
		var mine = res.export.mesh;
		mine.checkClosedManifold().closedManifold.should.be.true();
		// 507's build, with the same cones at the ends; in the drum, where the groove is (the cones turning with the
		// drum reach further than the section past r = 17, outside it)
		var stations = Array.from({ length : 181 }, function (_, i) { var t = i / 180; return [R * Math.cos(th0 + w * t), R * Math.sin(th0 + w * t), rise * t]; });
		var cut = wasm.Manifold.union([hullOfCones(stations, false), wasm.Manifold.hull(conePoints(stations[0], 2)), wasm.Manifold.hull(conePoints(stations[180], 2))]);
		var drum = wasm.Manifold.cylinder(40, 16, 16, 256).translate([0, 0, -10]).subtract(cut);
		(Math.abs(mine.signedVolume() / drum.volume() - 1)).should.be.below(0.005);
		var dense = Array.from({ length : 5401 }, function (_, i) { var t = i / 5400; return [R * Math.cos(th0 + w * t), R * Math.sin(th0 + w * t), rise * t]; });
		var sd = coneUnion(dense, 400, function (p) {
			var th = ((Math.atan2(p[1], p[0]) - th0) % (2 * PI) + 2 * PI) % (2 * PI);
			if (th > w + 0.5 * (2 * PI - w)) th -= 2 * PI;
			return Math.max(0, Math.min(5400, Math.round(th / w * 5400)));
		}), worst = 0;
		mine.vertices.forEach(function (p) {
			if (Math.hypot(p[0], p[1]) > 16 - 1e-3 || p[2] < -10 + 1e-6 || p[2] > 30 - 1e-6) return;
			worst = Math.max(worst, Math.abs(sd(p)));
		});
		worst.should.be.below(0.05);
	});

	it("cuts 167's groove into its drum: closed, genus 1, on the cones' union within 0.05 mm, the hull-of-cones build's volume and box", function () {
		// (with 15° blends: 167's own 10° fold the section over, below)
		var blend = 15, N = 256;
		var doc = { version : 2, nodes : {
			blank : { type : 'profile/extrude', in : { profile : { outer : circle(0, 0, 16), holes : [circle(0, 0, 2.5)] }, height : 95 } },
			groove : { type : 'profile/sweep', in : { profile : cutter, x : '16 * cos(2 * pi * t)', y : '16 * sin(2 * pi * t)', z : '34 + ' + heartExpr(blend, 't'),
				rail : 'closed', frame : 'radial', axis : 'z', samples : N } },
			drum : { type : 'boolean/difference', in : { from : '@blank', minus : '@groove' } },
		}, outputs : { drum : '@drum' } };
		var res = new Graph().evaluate(doc, { mesh : 'print' });
		made(res.verdict);
		res.verdict.defects.should.eql([]);
		res.verdict.checks.filter(function (c) { return c.name == 'fold'; })[0].should.containDeep({ passed : true });
		res.result.report.manifold.genus.should.equal(1);
		var mine = res.export.mesh;
		mine.checkClosedManifold().closedManifold.should.be.true();
		var stations = Array.from({ length : 240 }, function (_, i) { var u = i / 240; return [16 * Math.cos(2 * PI * u), 16 * Math.sin(2 * PI * u), 34 + heart(blend, u)]; });
		var drum = wasm.Manifold.cylinder(95, 16, 16, 256).subtract(wasm.Manifold.cylinder(95, 2.5, 2.5, 64)).subtract(hullOfCones(stations, true));
		(Math.abs(mine.signedVolume() / drum.volume() - 1)).should.be.below(0.005);
		var bb = mine.boundingBox(), rb = drum.boundingBox();
		[0, 1, 2].forEach(function (d) { Math.abs(bb.min[d] - rb.min[d]).should.be.below(0.05); Math.abs(bb.max[d] - rb.max[d]).should.be.below(0.05); });
		// against the exact union of the cutter cones: the groove's surface is on its boundary within 0.05 mm (the
		// hull build is itself up to about 0.025 mm off it, on the inside of the reversals, so the two builds are up to
		// 0.075 apart there)
		var dense = Array.from({ length : 14400 }, function (_, i) { var u = i / 14400; return [16 * Math.cos(2 * PI * u), 16 * Math.sin(2 * PI * u), 34 + heart(blend, u)]; });
		var sd = coneUnion(dense, 600), worst = 0;
		mine.vertices.forEach(function (p) {
			var r = Math.hypot(p[0], p[1]);
			if (r > 16 - 1e-3 || r < 3 || p[2] < 1e-6 || p[2] > 95 - 1e-6) return;
			worst = Math.max(worst, Math.abs(sd(p)));
		});
		worst.should.be.below(0.05);
	});

	it("builds 167's 10° blends, where the section folds over, and says where: proven, a model's verdict visual", function () {
		var rail = function (blend) { return Array.from({ length : 256 }, function (_, i) { var u = i / 256; return [16 * Math.cos(2 * PI * u), 16 * Math.sin(2 * PI * u), 34 + heart(blend, u)]; }); };
		var b = ProfileSweep.build(cutter, rail(10), { closed : true, frame : 'radial' });
		// one fold at each reversal (the bottom one over the ring's seam), each proven: the section reaches further
		// towards the bend's centre than the bend's radius
		b.folds.length.should.equal(2);
		b.folds.forEach(function (f) { f.proven.should.be.true(); f.radius.should.be.approximately(4.69, 0.01); f.reach.should.be.above(f.radius); });
		[[16, 0, 34], [-16, 0, 61]].forEach(function (p, k) { norm(sub(b.folds[k].at, p)).should.be.below(0.01); });
		b.solid.faces.length.should.be.above(0);
		// 13° still folds, 14° is proven free of folds
		ProfileSweep.build(cutter, rail(13), { closed : true, frame : 'radial' }).folds.length.should.equal(2);
		ProfileSweep.build(cutter, rail(14), { closed : true, frame : 'radial' }).folds.length.should.equal(0);
		// as a graph's output: closed and outward (a folded shell can be), and visual for the fold, with the defects
		var doc = { version : 2, nodes : {
			groove : { type : 'profile/sweep', in : { profile : cutter, x : '16 * cos(2 * pi * t)', y : '16 * sin(2 * pi * t)', z : '34 + ' + heartExpr(10, 't'),
				rail : 'closed', frame : 'radial', axis : 'z', samples : 256 } },
			moved : { type : 'transform/move', in : { of : '@groove', z : 10 } },
		}, outputs : { moved : '@moved' } };
		var v = new Graph().evaluate(doc).verdict;
		v.kind.should.equal('visual');
		var byName = {}; v.checks.forEach(function (c) { byName[c.name] = c; });
		byName.closed.passed.should.be.true(); byName.outward.passed.should.be.true(); byName.fold.passed.should.be.false();
		byName.fold.detail.should.match(/the sweep "groove" folds over near \(16, 0, 44\): its rail bends with a radius of 4\.69/);
		v.defects.length.should.equal(2);
		v.defects[0].should.containDeep({ kind : 'fold', feature : 'groove', proven : true });
		// moved with the sweep
		norm(sub(v.defects[0].at, [16, 0, 44])).should.be.below(0.01);
	});

	it('refuses the end frame of a rotation-minimizing sweep, and a node named like an output', function () {
		var sweep = { type : 'profile/sweep', in : { profile : cutter, frame : 'rotation-minimizing' } };
		var base = { version : 2, nodes : { g : sweep, m : { type : 'transform/move', in : { of : '@g', x : '@g.end_ux' } } }, outputs : { m : '@m' } };
		(function () { Graph.compile(base); }).should.throw(/rotation-minimizing sweep does not give/);
		// the start's frame it does give, and its ends' points and tangents
		Graph.compile({ version : 2, nodes : { g : sweep, m : { type : 'transform/move', in : { of : '@g', x : 'g_start_ux + g_end_tx' } } }, outputs : { m : '@m' } }).parameters.should.have.property('g_start_ux');
		(function () { Graph.compile({ version : 2, nodes : { g : { type : 'profile/sweep' }, g_end_x : { type : 'number' } }, outputs : { g : '@g' } }); }).should.throw(/the name of "g"'s output end_x/);
	});

	it('places a solid in a frame: x along u, y along v, z along u x v', function () {
		var doc = { version : 2, nodes : {
			b : { type : 'primitive/box', in : { width : 2, depth : 4, height : 6 } },
			p : { type : 'transform/place', in : { of : '@b', x : 10, y : 20, z : 30, ux : 0, uy : 0, uz : 3, vx : 1, vy : 1, vz : 0 } },
		}, outputs : { p : '@p' } };
		var res = new Graph().evaluate(doc);
		var bb = res.result.mesh.boundingBox();
		// u = z, v = (x + y) / sqrt 2, u x v = (-x + y) / sqrt 2: the box's x (2 wide) along z, its y (4) along v
		(bb.max[2] - bb.min[2]).should.be.approximately(2, 1e-9);
		(bb.min[2] + bb.max[2]).should.be.approximately(60, 1e-9);
		(Math.abs(res.result.report.volume - 48)).should.be.below(1e-6);
	});
});
