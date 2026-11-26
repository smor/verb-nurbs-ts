var should = require('should');
var fs = require('fs');
var path = require('path');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var verb = lib.default, Vec = lib.Vec, Eval = verb.eval.Eval, Make = verb.eval.Make;
var BrepSolid = lib.BrepSolid, BrepBoolean = lib.BrepBoolean, ShellBuilder = lib.ShellBuilder, Sweep = lib.Sweep;

// The exact shell of a Boolean result (route A, step A2): vertices, edges with their curves, p-curves and own
// tolerances, faces bounded by loops of edges.

function line(a, b) { return Make.rationalBezierCurve([a, b]); }
function box(radii, shape) {
	var b = BrepSolid.box([0, 0, 0], [40, 28, 20], 12);
	var E = lib.BrepEdges.all(b).map(function(e, k){ return { solid : 0, faces : e.faces, radius : radii[k % radii.length] }; });
	return BrepBoolean.evaluate([b], function(f){ return f[0]; }, { filletShape : shape, edges : E });
}
var dir = path.join(__dirname, 'fixtures', '507');
function part(prefix, output) {
	var f = fs.readdirSync(dir).find(function(x){ return x.startsWith(prefix + '-'); });
	return new lib.Graph().evaluate(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), { output : output }).result;
}

// Checks a shell against its result, and returns the largest edge tolerance:
// * every edge is used once each way, by the faces on its sides;
// * Euler-Poincare: V - E + F - (L - F) = 2 (1 - genus), the genus the welded mesh has;
// * each edge's curve ends at its vertices, and lies within its tolerance of both faces (by projection, at
//   parameters its tolerance was not measured at), and the faces at its p-curves give the curve within it;
// * the tolerance is half the fitting tolerance, plus `gap` where a face is fitted (setback corners).
function valid(r, gap) {
	var S = ShellBuilder.fromResult(r), tol = S.tolerance;
	var uses = {};
	S.faces.forEach(function(F, fi){
		F.loops.forEach(function(l){
			l.edges.forEach(function(x){
				var e = S.edges[x[0]];
				(x[1] ? e.left : e.right).should.equal(fi);
				var k = x[0] + ':' + x[1]; uses[k] = (uses[k] || 0) + 1;
			});
		});
	});
	S.edges.forEach(function(e, k){ should.equal(uses[k + ':true'], 1); should.equal(uses[k + ':false'], 1); });
	var L = S.faces.reduce(function(a, F){ return a + F.loops.length; }, 0);
	(S.vertices.length - S.edges.length + S.faces.length - (L - S.faces.length)).should.equal(2 * (1 - r.report.manifold.genus));
	var worst = 0;
	S.edges.forEach(function(e){
		var a = e.curve.knots[0], b = e.curve.knots[e.curve.knots.length - 1];
		Vec.dist(Eval.rationalCurvePoint(e.curve, a), S.vertices[e.start]).should.be.below(1e-9);
		Vec.dist(Eval.rationalCurvePoint(e.curve, b), S.vertices[e.end]).should.be.below(1e-9);
		e.tolerance.should.be.below(0.5 * tol + gap);
		[e.left, e.right].forEach(function(fi, side){
			var F = S.faces[fi], project = ShellBuilder.projector(F.surface);
			for (var i = 0; i < 23; i++) {
				var t = a + (b - a) * (i + 0.37) / 23, p = Eval.rationalCurvePoint(e.curve, t), uv = Eval.rationalCurvePoint(e.pcurves[side], t);
				Vec.dist(project(p).p, p).should.be.below(e.tolerance + 1e-9);
				// (between the samples the tolerance was measured at, the p-curve may stray a little further)
				Vec.dist(Eval.rationalSurfacePoint(F.surface, uv[0], uv[1]), p).should.be.below(1.5 * e.tolerance + 1e-9);
			}
		});
		worst = Math.max(worst, e.tolerance);
	});
	return { shell : S, worst : worst };
}

describe("verb.solid.ShellBuilder", function(){
	this.timeout(budget(120000));

	it('makes a closed shell of a rounded box: ball corners, and setback corners whose fitted parts set their edges\' tolerances', function(){
		var ball = valid(box([4]), 0);
		ball.shell.faces.length.should.equal(26);
		ball.shell.edges.length.should.equal(48);
		// setback corners: six parts fitted to 1e-3 of the largest radius (5)
		valid(box([3, 4, 5], 'curvature'), 5e-3);
	});

	it('cuts faces on closed surfaces along their seams, with each seam edge\'s two p-curves on the seam\'s two sides', function(){
		var cyl = BrepSolid.cappedTube(Sweep.pipe(line([0, 0, 0], [0, 0, 40]), 15).surface, [24, 96]);
		var big = BrepSolid.cappedTube(Sweep.pipe(line([8, 0, 20], [20, 0, 20]), 4).surface, [24, 48]);
		var small = BrepSolid.cappedTube(Sweep.pipe(line([6, 0, 20], [22, 0, 20]), 1.5).surface, [24, 48]);
		var S = valid(BrepBoolean.evaluate([cyl, big, small], function(f){ return f[0] && !(f[1] && !f[2]); }), 0).shell;
		var seams = S.edges.filter(function(e){ return e.left == e.right; });
		seams.length.should.be.above(0);
		seams.forEach(function(e){
			var F = S.faces[e.left], s = F.surface, c = F.closed[0] ? 0 : 1, ks = c == 0 ? s.knotsU : s.knotsV, d = [ks[0], ks[ks.length - 1]];
			var u0 = Eval.rationalCurvePoint(e.pcurves[0], 0.5)[c], u1 = Eval.rationalCurvePoint(e.pcurves[1], 0.5)[c];
			[u0, u1].sort(function(x, y){ return x - y; }).should.eql(d);
			e.tolerance.should.be.below(1e-9 + 0.25 * S.tolerance);
		});
	});

	it('makes closed shells of the mug, plain and filleted (genus 1), and of 507 parts', function(){
		valid(lib.BooleanObjectsRecipe.mug({ divsU : 32, divsV : 128, fillet : 3 }).result, 0);
		// the slotted block's caps have spans of very different lengths: a projection seeded by a uniform grid put
		// its edges half a millimetre off them
		valid(part('B', 'slotted'), 0);
		valid(part('C', 'tube-flange'), 0);
		valid(part('E', 'rim-spoke'), 0);
	});
});
