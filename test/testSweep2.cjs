var should = require('should');
var lib = require('../dist/index.js');
var Graph = lib.Graph, ProfileSweep = lib.ProfileSweep;

// A planar section on two rails (#159, Sweep2): drawn with the first rail at u = 0 and the second at the rails'
// distance at the start, stretched along u to their distance, its v scaled the same or kept.

var PI = Math.PI;
var line = function (to) { return { type : 'line', to : to }; };
var dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
var cross = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
var sub = function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; };
var add = function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; };
var norm = function (a) { return Math.sqrt(dot(a, a)); };
var unit = function (a) { var n = norm(a); return [a[0] / n, a[1] / n, a[2] / n]; };

var rect = { outer : { kind : 'path', start : [0, -2], segments : [line([10, -2]), line([10, 2]), line([0, 2]), line([0, -2])] } };
var circle = { outer : { kind : 'circle', center : [5, 0], r : 5 } };
function sweep2(profile, r1, r2, more) {
	return Object.assign({ type : 'profile/sweep2', in : Object.assign({ profile : profile, x : r1[0], y : r1[1], z : r1[2], x2 : r2[0], y2 : r2[1], z2 : r2[2], samples : 16 }, more || {}) });
}
function one(node) { return { version : 2, nodes : { g : node }, outputs : { g : '@g' } }; }

describe('Sweep profile on two rails (#159)', function () {

	it('sweeps a rectangle along two parallel straight rails into a box: its volume and faces exact, buildable', function () {
		var res = new Graph().evaluate(one(sweep2(rect, ['0', '0', '30 * t'], ['10', '0', '30 * t'])), { mesh : 'print' });
		res.verdict.kind.should.equal('buildable');
		res.result.report.volume.should.be.approximately(10 * 4 * 30, 1e-9);
		res.export.mesh.checkClosedManifold().closedManifold.should.be.true();
		var bb = res.result.mesh.boundingBox();
		[[0, 10], [-2, 2], [0, 30]].forEach(function (r, d) { bb.min[d].should.be.approximately(r[0], 1e-9); bb.max[d].should.be.approximately(r[1], 1e-9); });
		// four planar sides and two caps, every vertex of each side on its plane
		var names = new Set(res.result.faces.map(function (f) { return res.faceNames[res.result.faces.indexOf(f)]; }));
		['g.outer.0', 'g.outer.1', 'g.outer.2', 'g.outer.3', 'g.start', 'g.end'].forEach(function (n) { names.has(n).should.be.true(); });
	});

	it('sweeps a circle along two diverging straight rails into a frustum, or with its height kept a truncated elliptic cone: volumes in closed form', function () {
		var r0 = 5, r1 = 10, h = 30;
		var frustum = new Graph().evaluate(one(sweep2(circle, ['-5 * t', '0', '30 * t'], ['10 + 5 * t', '0', '30 * t'])));
		frustum.verdict.kind.should.equal('buildable');
		(frustum.result.report.volume / (PI * h * (r0 * r0 + r0 * r1 + r1 * r1) / 3) - 1).should.be.within(-1e-6, 1e-6);
		// across the rails the radius grows from 5 to 10, square to them it stays 5: an ellipse whose one axis grows
		var kept = new Graph().evaluate(one(sweep2(circle, ['-5 * t', '0', '30 * t'], ['10 + 5 * t', '0', '30 * t'], { height : 'keep' })));
		kept.verdict.kind.should.equal('buildable');
		(kept.result.report.volume / (PI * r0 * h * (r0 + r1) / 2) - 1).should.be.within(-1e-6, 1e-6);
		var bb = kept.result.mesh.boundingBox();
		bb.min[1].should.be.approximately(-5, 1e-3); bb.max[1].should.be.approximately(5, 1e-3);
		bb.min[0].should.be.approximately(-5, 1e-3); bb.max[0].should.be.approximately(15, 1e-3);
	});

	it('gives its ends as the rails\' ends, the mean of their tangents, the line between them and the axis square to both, within 1e-6', function () {
		var r1 = ['60 * t', '0', '10 * sin(pi * t)'], r2 = ['60 * t', '10 - 6 * t', '10 * sin(pi * t)'];
		var res = new Graph().evaluate(one(sweep2(rect, r1, r2, { samples : 64 })));
		var p = res.parameters, get = function (end, k) { return [p['g_' + end + '_' + k[0]], p['g_' + end + '_' + k[1]], p['g_' + end + '_' + k[2]]]; };
		var P1 = function (t) { return [60 * t, 0, 10 * Math.sin(PI * t)]; }, P2 = function (t) { return [60 * t, 10 - 6 * t, 10 * Math.sin(PI * t)]; };
		var D1 = function (t) { return [60, 0, 10 * PI * Math.cos(PI * t)]; }, D2 = function (t) { return [60, -6, 10 * PI * Math.cos(PI * t)]; };
		var rails = { start : [], end : [] };
		for (var i = 0; i <= 64; i++) { rails.start.push(P1(i / 64)); rails.end.push(P2(i / 64)); }
		var ends = ProfileSweep.ends(rails.start, { rail2 : rails.end, startTangent : D1(0), endTangent : D1(1), startTangent2 : D2(0), endTangent2 : D2(1) });
		[['start', 0], ['end', 1]].forEach(function (e) {
			var t = e[1], T = unit(add(unit(D1(t)), unit(D2(t)))), u = unit(sub(P2(t), P1(t))), v = unit(cross(T, u));
			var want = { 'xyz' : P1(t), 'x2y2z2' : P2(t), 't' : T, 'u' : u, 'v' : v };
			norm(sub(get(e[0], ['x', 'y', 'z']), want.xyz)).should.be.below(1e-6);
			norm(sub(get(e[0], ['x2', 'y2', 'z2']), want.x2y2z2)).should.be.below(1e-6);
			['t', 'u', 'v'].forEach(function (a) { norm(sub(get(e[0], [a + 'x', a + 'y', a + 'z']), want[a])).should.be.below(1e-6); });
			// and the shell's own ends
			var end = ends[e[0]];
			norm(sub(end.point, want.xyz)).should.be.below(1e-9);
			norm(sub(end.tangent, T)).should.be.below(1e-9); norm(sub(end.u, u)).should.be.below(1e-9); norm(sub(end.v, v)).should.be.below(1e-9);
		});
		// the section's far side rides on the second rail: the end caps' corners at u = 10 are the second rail's ends
		var m = res.result.mesh, near = function (q) { return m.vertices.some(function (x) { return norm(sub(x, q)) < 1e-6; }); };
		var v0 = get('start', ['vx', 'vy', 'vz']), s1 = norm(sub(P2(1), P1(1))) / 10;
		near(add(P2(0), v0.map(function (x) { return 2 * x; }))).should.be.true();
		var v1 = get('end', ['vx', 'vy', 'vz']);
		near(add(P2(1), v1.map(function (x) { return 2 * s1 * x; }))).should.be.true();
	});

	it('is a closed, buildable operand of a difference, with a closed print mesh: a tapered slot through a plate', function () {
		// (the section drawn 10 wide, the rails' distance at the start, which grows to 14)
		var doc = { version : 2, nodes : {
			plate : { type : 'primitive/box', in : { width : 80, depth : 40, height : 6 } },
			slot : sweep2(rect, ['-50 + 100 * t', '-3', '0'], ['-50 + 100 * t', '7 + 4 * t', '0'], { height : 'keep' }),
			cut : { type : 'boolean/difference', in : { from : '@plate', minus : '@slot' } },
		}, outputs : { cut : '@cut' } };
		var res = new Graph().evaluate(doc, { mesh : 'print' });
		res.result.mesh.checkClosedManifold().closedManifold.should.be.true();
		res.export.mesh.checkClosedManifold().closedManifold.should.be.true();
		res.verdict.checks.filter(function (c) { return c.name == 'self-contact'; })[0].should.containDeep({ passed : true, proven : true });
		// a Boolean's intersections proven by its certificate: then buildable
		var model = Graph.compile(doc); model.certify = true;
		var v = new lib.Model().evaluate(model).verdict;
		v.kind.should.equal('buildable');
		// the slot's volume where it is in the plate: 80 long, 2 deep (z from 0 to 2), 10 to 14 wide over 100
		var w = function (x) { return 10 + 4 * (x + 50) / 100; };
		(res.result.report.volume).should.be.approximately(80 * 40 * 6 - 2 * 80 * (w(-40) + w(40)) / 2, 1e-6);
	});

	it('leaves a sweep whose sections turn unproven for self-contact, and refuses rails that do not match', function () {
		var res = new Graph().evaluate(one(sweep2(rect, ['20 * cos(pi * t)', '20 * sin(pi * t)', '0'], ['30 * cos(pi * t)', '30 * sin(pi * t)', '0'])));
		res.verdict.kind.should.equal('unproven');
		res.verdict.checks.filter(function (c) { return c.name == 'self-contact'; })[0].should.containDeep({ passed : true, proven : false });
		(function () { ProfileSweep.build(rect, [[0, 0, 0], [0, 0, 1], [0, 0, 2], [0, 0, 3]], { rail2 : [[1, 0, 0], [1, 0, 1], [1, 0, 2]] }); }).should.throw(/as many points as the first/);
		(function () { ProfileSweep.build(rect, [[0, 0, 0], [0, 0, 1], [0, 0, 2], [0, 0, 3]], { rail2 : [[0, 0, 0], [1, 0, 1], [1, 0, 2], [1, 0, 3]] }); }).should.throw(/start at one point/);
	});
});
