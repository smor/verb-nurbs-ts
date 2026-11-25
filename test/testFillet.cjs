var should = require('should');

var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var verb = lib.default;
var Sweep = lib.Sweep, Make = verb.eval.Make, Eval = verb.eval.Eval, Vec = verb.core.Vec;
var BrepSolid = lib.BrepSolid, BrepBoolean = lib.BrepBoolean, Fillet = lib.Fillet;

function line(a, b) { return Make.rationalBezierCurve([a, b]); }

var wasm;
before(async function(){
	var Module = (await import('manifold-3d')).default;
	wasm = await Module();
	wasm.setup();
});
function manifold(mesh) { return new wasm.Manifold(new wasm.Mesh(mesh.toManifoldMesh())); }

// a disc of radius 30 and thickness 10 and a rod of radius 5 through it, slightly off the axis
function discAndRod(around) {
	var disc = BrepSolid.cappedTube(Sweep.pipe(line([0,0,-5],[0,0,5]), 30).surface, [8, 96]);
	var rod = BrepSolid.cappedTube(Sweep.pipe(line([0.3,0.2,-20],[0.3,0.2,20]), 5).surface, [16, around]);
	return [disc, rod];
}

// Pappus: a fillet of radius r on a right-angled circular edge of radius R sweeps the region between the corner and
// the quarter circle, of area (1 - pi/4) r^2, whose centroid lies 0.22337 r from both faces
function pappus(R, r) { return 2 * Math.PI * (R + 0.22337 * r) * (1 - Math.PI / 4) * r * r; }

describe("verb.solid.Fillet", function(){
	this.timeout(budget(60000));

	it('arc is an exact circular arc from one point to the other', function(){
		var c = [1, 2, 3], p = [4, 2, 3], q = [1, 2, 6];
		var arc = Fillet.arc(p, c, q);
		for (var t = 0; t <= 1; t += 0.125) Vec.dist(Eval.rationalCurvePoint(arc, t), c).should.be.approximately(3, 1e-12);
		Vec.dist(Eval.rationalCurvePoint(arc, 0), p).should.be.below(1e-12);
		Vec.dist(Eval.rationalCurvePoint(arc, 1), q).should.be.below(1e-12);
	});

	it('rounds the edges of a hole: watertight, and removes the volume Pappus predicts', function(){
		var s = discAndRod(128);
		var sharp = BrepBoolean.difference(s[0], [s[1]]);
		var round = BrepBoolean.difference(s[0], [s[1]], { fillet : 2 });
		round.report.fillets.should.be.equal(2);
		round.report.manifold.closedManifold.should.be.true();
		round.report.manifold.genus.should.be.equal(1);
		var m = manifold(round.mesh);
		m.status().should.be.equal('NoError');
		m.genus().should.be.equal(1);
		var exact = 2 * pappus(5, 2);
		(sharp.report.volume - round.report.volume).should.be.approximately(exact, exact * 0.015);
	});

	it('fills the concave edges where a rod meets a disc, adding the same volume', function(){
		var s = discAndRod(128);
		var sharp = BrepBoolean.union(s);
		var round = BrepBoolean.union(s, { fillet : 2 });
		round.report.fillets.should.be.equal(2);
		round.report.manifold.closedManifold.should.be.true();
		round.report.manifold.genus.should.be.equal(0);
		manifold(round.mesh).status().should.be.equal('NoError');
		var exact = 2 * pappus(5, 2);
		(round.report.volume - sharp.report.volume).should.be.approximately(exact, exact * 0.015);
	});

	it('a variable radius: the ball grows and shrinks along the edge, and the volume follows the integral of r^2', function(){
		var s = discAndRod(128);
		var rad = function(t){ return 2 + Math.sin(2 * Math.PI * t); }; // from 1 to 3 and back
		var sharp = BrepBoolean.union(s);
		var round = BrepBoolean.union(s, { fillet : function(){ return rad; } });
		round.report.fillets.should.be.equal(2);
		round.report.manifold.closedManifold.should.be.true();
		manifold(round.mesh).status().should.be.equal('NoError');
		round.fillets.forEach(function(f){
			var rs = f.blend.sections.map(function(x){ return Vec.dist(x.centre, x.pa); });
			f.blend.sections.forEach(function(x, k){ Vec.dist(x.centre, x.pb).should.be.approximately(rs[k], 1e-8); });
			Math.min.apply(null, rs).should.be.approximately(1, 0.02);
			Math.max.apply(null, rs).should.be.approximately(3, 0.02);
		});
		// Pappus with the radius varying round the edge
		var exact = 0, n = 2000;
		for (var i = 0; i < n; i++) { var r = rad((i + 0.5) / n); exact += 2 * Math.PI * (5 + 0.22337 * r) * (1 - Math.PI / 4) * r * r / n; }
		(round.report.volume - sharp.report.volume).should.be.approximately(2 * exact, 2 * exact * 0.03);
	});

	it('a curvature-continuous section matches each face\'s position, tangent and normal curvature at its ends (G2)', function(){
		// a sphere of radius 10 standing on the plane z = -6: a ball of radius 2 in the concave corner between them
		var sphere = verb.eval.Make.sphericalSurface([0,0,0], [0,0,1], [1,0,0], 10);
		var plane = new verb.core.NurbsSurfaceData(1, 1, [0,0,1,1], [0,0,1,1], [[[-20,-20,-6,1],[-20,20,-6,1]],[[20,-20,-6,1],[20,20,-6,1]]]);
		var A = { face : BrepSolid.face(sphere, [false, true], [8, 8]), sign : 1, keptInsideOther : false };
		var B = { face : BrepSolid.face(plane, [false, false], [2, 2]), sign : 1, keptInsideOther : false };
		var centre = [Math.sqrt(144 - 16), 0, -4];
		var ua = verb.eval.Analyze.rationalSurfaceClosestParam(sphere, Vec.mul(10 / 12, centre)), pa = Eval.rationalSurfacePoint(sphere, ua[0], ua[1]);
		var ub = [(centre[0] + 20) / 40, 0.5], pb = Eval.rationalSurfacePoint(plane, ub[0], ub[1]);
		var c = Fillet.g2(A, ua, pa, B, ub, pb);
		should.exist(c);
		[[0, sphere, ua, pa], [1, plane, ub, pb]].forEach(function(e){
			var d = Eval.rationalCurveDerivatives(c, e[0], 2);
			Vec.dist(d[0], e[3]).should.be.below(1e-12);
			var sd = Eval.rationalSurfaceDerivatives(e[1], e[2][0], e[2][1], 2);
			var n = Vec.normalized(Vec.cross(sd[1][0], sd[0][1]));
			Math.abs(Vec.dot(Vec.normalized(d[1]), n)).should.be.below(1e-9); // tangent to the face
			// normal curvature of the curve against the face's, along the curve's tangent
			var t = Vec.normalized(d[1]), kc = Vec.dot(d[2], n) / Vec.dot(d[1], d[1]);
			var st = [Vec.dot(t, sd[1][0]), Vec.dot(t, sd[0][1])];
			var E = Vec.dot(sd[1][0], sd[1][0]), F = Vec.dot(sd[1][0], sd[0][1]), G = Vec.dot(sd[0][1], sd[0][1]), det = E * G - F * F;
			var du = (G * st[0] - F * st[1]) / det, dv = (E * st[1] - F * st[0]) / det;
			var I = du * du * E + 2 * du * dv * F + dv * dv * G;
			var II = du * du * Vec.dot(sd[2][0], n) + 2 * du * dv * Vec.dot(sd[1][1], n) + dv * dv * Vec.dot(sd[0][2], n);
			kc.should.be.approximately(II / I, 1e-6);
		});
	});

	it('curvature-continuous fillets keep a Boolean watertight, and fill a little less than circular ones', function(){
		var s = discAndRod(128);
		var sharp = BrepBoolean.union(s), circ = BrepBoolean.union(s, { fillet : 2 });
		var g2 = BrepBoolean.union(s, { fillet : 2, filletShape : 'curvature' });
		g2.report.fillets.should.be.equal(2);
		g2.report.manifold.closedManifold.should.be.true();
		manifold(g2.mesh).status().should.be.equal('NoError');
		var added = g2.report.volume - sharp.report.volume, addedCirc = circ.report.volume - sharp.report.volume;
		added.should.be.above(0.3 * addedCirc);
		added.should.be.below(addedCirc);
	});

	it('the ball touches both faces: each section centre is at the radius from both contacts, along their normals', function(){
		var s = discAndRod(64);
		var round = BrepBoolean.union(s, { fillet : 2 });
		round.fillets.length.should.be.equal(2);
		round.fillets.forEach(function(f){
			var e = round.curves[f.curve];
			var fa = s[e.solids[0]].faces[e.faces[0]], fb = s[e.solids[1]].faces[e.faces[1]];
			f.blend.side.should.be.equal(1); // concave: the ball rolls in the air
			f.blend.sections.forEach(function(x){
				// sections snapped onto a seam too: swept pipes are fitted periodically, smooth across their seams
				var tol = 1e-8;
				Vec.dist(x.centre, x.pa).should.be.approximately(2, tol);
				Vec.dist(x.centre, x.pb).should.be.approximately(2, tol);
				[[fa, x.a, x.pa], [fb, x.b, x.pb]].forEach(function(t){
					var d = Eval.rationalSurfaceDerivatives(t[0].surface, t[1][0], t[1][1], 1);
					var n = Vec.normalized(Vec.cross(d[1][0], d[0][1]));
					Math.abs(Vec.dot(n, Vec.normalized(Vec.sub(x.centre, t[2])))).should.be.approximately(1, tol);
				});
			});
		});
	});

	it('leaves an edge sharp, and the solid watertight, when the ball does not fit', function(){
		var a = BrepSolid.cappedTube(Sweep.pipe(line([-30,0,0],[30,0,0]), 10).surface, [24, 48]);
		var b = BrepSolid.cappedTube(Sweep.pipe(line([0,-30,1],[0,30,1]), 6).surface, [24, 48]);
		var r = BrepBoolean.difference(a, [b], { fillet : 2 });
		r.report.filletsFailed.should.be.equal(2);
		r.report.fillets.should.be.equal(0);
		r.report.manifold.closedManifold.should.be.true();
	});

	it('mug: the handle joint is filleted, the result still a genus 1 solid', function(){
		var sharp = lib.BooleanObjectsRecipe.mug({ divsU : 32, divsV : 128 });
		var o = lib.BooleanObjectsRecipe.mug({ divsU : 32, divsV : 128, fillet : 3 });
		o.result.report.fillets.should.be.equal(2);
		o.result.report.manifold.closedManifold.should.be.true();
		o.result.report.manifold.genus.should.be.equal(1);
		var m = manifold(o.result.mesh);
		m.status().should.be.equal('NoError');
		m.genus().should.be.equal(1);
		o.result.report.volume.should.be.above(sharp.result.report.volume);
	});

	it('pierced vessel: both edges of every hole are rounded', function(){
		var o = lib.BooleanObjectsRecipe.pierced({ holes : 5, rows : 1, divsU : 32, divsV : 128, fillet : 1 });
		o.result.report.fillets.should.be.equal(10);
		o.result.report.manifold.closedManifold.should.be.true();
		o.result.report.manifold.genus.should.be.equal(5);
		var m = manifold(o.result.mesh);
		m.status().should.be.equal('NoError');
		m.genus().should.be.equal(5);
	});
	it('ribs that grow out of a wall: filleted when the ball fits round their ends, left sharp (and watertight) when it does not', function(){
		var base = { height : 170, radius : [58, 76], linearRadius : true, belly : 0, lean : [0, 0], harmonics : [], wallThickness : 2.5, baseThickness : 4,
			divsU : 24, divsV : 96, offsetTolerance : 0.08, ribs : 3 };
		var ok = lib.BooleanObjectsRecipe.mug(Object.assign({ ribFillet : 1.5 }, base)).result.report;
		ok.manifold.closedManifold.should.be.true();
		ok.fillets.should.be.equal(3);
		var big = lib.BooleanObjectsRecipe.mug(Object.assign({ ribFillet : 2.5 }, base)).result.report;
		big.manifold.closedManifold.should.be.true();
		big.fillets.should.be.equal(0);
		big.filletsFailed.should.be.equal(3);
	});

	it("rounds a solid's own edges, with no boolean: the disc's rims become tori", function(){
		var disc = discAndRod(16)[0];
		var edges = lib.BrepEdges.all(disc);
		edges.length.should.be.equal(2);
		edges.forEach(function(e){ e.curve.closed.should.be.true(); });
		var r = 2;
		var res = BrepBoolean.evaluate([disc], function(f){ return f[0]; }, { edges : [{ solid : 0, faces : [0, 1], radius : r }, { solid : 0, faces : [0, 2], radius : r }] });
		res.report.fillets.should.be.equal(2);
		res.report.manifold.closedManifold.should.be.true();
		res.report.manifold.genus.should.be.equal(0);
		manifold(res.mesh).status().should.be.equal('NoError');
		// every vertex of the blends lies on its torus: r from the circle of radius 30 - r, r inside each cap
		res.mesh.triangles.forEach(function(t, k){
			if (res.faces[res.faceOf[k]].name != 'fillet') return;
			t.forEach(function(v){
				var p = res.mesh.vertices[v], rho = Math.hypot(p[0], p[1]), zc = p[2] > 0 ? 5 - r : r - 5;
				Math.hypot(rho - (30 - r), p[2] - zc).should.be.approximately(r, 1e-3);
			});
		});
		// Pappus, on a convex edge: the corner's centroid lies 0.22337 r inside the rim (the blend's chords cut a
		// little more, by up to 10% here with four chords a quarter turn)
		var sharp = BrepBoolean.evaluate([disc], function(f){ return f[0]; }, {});
		var removed = sharp.report.volume - res.report.volume, exact = 2 * 2 * Math.PI * (30 - 0.22337 * r) * (1 - Math.PI / 4) * r * r;
		removed.should.be.above(exact * 0.99);
		removed.should.be.below(exact * 1.1);
	});

	it("rounds own edges and new edges together: a disc and a rod, every edge rounded, in each section shape", function(){
		['circular', 'curvature', 'chamfer'].forEach(function(shape){
			var s = discAndRod(64);
			var res = BrepBoolean.union(s, { fillet : 2, filletShape : shape, edges : [
				{ solid : 0, faces : [0, 1], radius : 3 }, { solid : 0, faces : [0, 2], radius : 3 },
				{ solid : 1, faces : [0, 1], radius : 2 }, { solid : 1, faces : [0, 2], radius : 2 }] });
			res.report.fillets.should.be.equal(6);
			res.report.filletsFailed.should.be.equal(0);
			res.report.manifold.closedManifold.should.be.true();
			manifold(res.mesh).status().should.be.equal('NoError');
		});
	});

	it("rounds every edge of a box: open own edges meeting at ball corners, the volume of a Minkowski sum", function(){
		var b = BrepSolid.box([0, 0, 0], [20, 14, 10], 12);
		var E = lib.BrepEdges.all(b);
		E.length.should.be.equal(12);
		var r = 2;
		var res = BrepBoolean.evaluate([b], function(f){ return f[0]; }, { edges : E.map(function(e){ return { solid : 0, faces : e.faces, radius : r }; }) });
		res.report.fillets.should.be.equal(12);
		res.report.filletsSkipped.should.be.equal(0);
		res.corners.map(function(c){ return c.kind; }).should.be.eql(['ball', 'ball', 'ball', 'ball', 'ball', 'ball', 'ball', 'ball']);
		res.report.manifold.closedManifold.should.be.true();
		manifold(res.mesh).status().should.be.equal('NoError');
		// the inner box (16 x 10 x 6) swept by a ball of radius 2
		var a = 16, bb = 10, c = 6;
		var exact = a * bb * c + r * 2 * (a * bb + bb * c + c * a) + Math.PI * r * r * (a + bb + c) + 4 / 3 * Math.PI * r * r * r;
		res.report.volume.should.be.approximately(exact, exact * 0.01);
		res.report.volume.should.be.below(exact);
	});

	it("rounds a box's edges with three radii: setback corners where they differ, in every section shape", function(){
		var b = BrepSolid.box([0, 0, 0], [20, 14, 10], 12);
		var E = lib.BrepEdges.all(b);
		['circular', 'chamfer'].forEach(function(shape){
			var res = BrepBoolean.evaluate([b], function(f){ return f[0]; }, { filletShape : shape, edges : E.map(function(e, k){ return { solid : 0, faces : e.faces, radius : [1, 2, 3][k % 3] }; }) });
			res.report.fillets.should.be.equal(12);
			res.report.filletsSkipped.should.be.equal(0);
			res.corners.length.should.be.equal(8);
			res.corners.filter(function(c){ return c.kind == 'setback'; }).length.should.be.above(5);
			res.report.manifold.closedManifold.should.be.true();
			manifold(res.mesh).status().should.be.equal('NoError');
		});
	});

	it("gives curvature-continuous fillets curvature-continuous setback corners (G2): no jump in curvature across any side", function(){
		var b = BrepSolid.box([0, 0, 0], [20, 14, 10], 12);
		var E = lib.BrepEdges.all(b);
		var Transfinite = lib.Transfinite;
		// the normal curvature of a corner patch across its sides, times the corner's radius, at the worst of three
		// points per side. Every face and every blend of a box meets the corner with zero curvature across the joint
		// (planes, and blends along straight edges), so G2 means zero here.
		function worstAcross(c) {
			var R = c.ribbons, n = R.length, P = Transfinite.polygon(n), h = 1e-3, worst = 0;
			P.forEach(function(a, i){
				var q = P[(i + 1) % n];
				var nx = a[1] - q[1], ny = q[0] - a[0], l = Math.sqrt(nx * nx + ny * ny); nx /= l; ny /= l;
				[0.3, 0.5, 0.7].forEach(function(t){
					var x = a[0] + t * (q[0] - a[0]), y = a[1] + t * (q[1] - a[1]);
					var p = [0, 1, 2].map(function(k){ return Transfinite.evaluate(R, [x + k * h * nx, y + k * h * ny]); });
					var d1 = Vec.mul(1 / h, Vec.sub(p[1], p[0]));
					var d2 = Vec.mul(1 / (h * h), Vec.add(Vec.sub(p[0], Vec.mul(2, p[1])), p[2]));
					var along = Vec.sub(Transfinite.evaluate(R, [x + 1e-3 * (q[0] - a[0]), y + 1e-3 * (q[1] - a[1])]), p[0]);
					var nrm = Vec.normalized(Vec.cross(along, d1));
					worst = Math.max(worst, Math.abs(Vec.dot(nrm, d2)) / Vec.dot(d1, d1) * c.radius);
				});
			});
			return worst;
		}
		var res = BrepBoolean.evaluate([b], function(f){ return f[0]; }, { filletShape : 'curvature', edges : E.map(function(e, k){ return { solid : 0, faces : e.faces, radius : [1, 2, 3][k % 3] }; }) });
		res.report.fillets.should.be.equal(12);
		res.report.filletsSkipped.should.be.equal(0);
		res.report.manifold.closedManifold.should.be.true();
		manifold(res.mesh).status().should.be.equal('NoError');
		var setbacks = res.corners.filter(function(c){ return c.kind == 'setback'; });
		setbacks.length.should.be.above(5);
		// the same corner built G1 (without second derivatives) jumps by 2.3 to 4 / r; this one by under 0.1 / r
		setbacks.forEach(function(c){ worstAcross(c).should.be.below(0.1); });
	});

	it("rounds the edges around a boss on a box: concave mitres at a sharp boss, and mixed corners when the boss is rounded too", function(){
		var A = BrepSolid.box([0, 0, 0], [30, 20, 8], 12), B = BrepSolid.box([8, 5, 4], [20, 15, 16], 12);
		// only the new (concave) edges: they meet in pairs at the boss's sharp vertical edges, along mitres
		var base = BrepBoolean.union([A, B], { fillet : 1.5 });
		base.report.fillets.should.be.equal(4);
		base.report.filletsSkipped.should.be.equal(0);
		base.report.manifold.closedManifold.should.be.true();
		// every edge: the boss's vertical edges are split where the base's edges end on them, and their upper parts
		// (convex) meet the base's fillets (concave) at four mixed setback corners
		var edges = lib.BrepEdges.all(A).map(function(e){ return { solid : 0, faces : e.faces, radius : 1.5 }; })
			.concat(lib.BrepEdges.all(B).map(function(e){ return { solid : 1, faces : e.faces, radius : 1.5 }; }));
		var all = BrepBoolean.union([A, B], { fillet : 1.5, edges : edges });
		all.report.fillets.should.be.equal(24);
		all.report.filletsSkipped.should.be.equal(0);
		all.corners.filter(function(c){ return c.kind == 'setback'; }).length.should.be.equal(4);
		all.corners.filter(function(c){ return c.kind == 'ball'; }).length.should.be.equal(12);
		all.report.manifold.closedManifold.should.be.true();
		all.report.manifold.genus.should.be.equal(0);
		manifold(all.mesh).status().should.be.equal('NoError');
		// rounding takes material off the convex edges and adds it in the concave ones: less than the sharp union
		all.report.volume.should.be.below(BrepBoolean.union([A, B]).report.volume);
	});
});
