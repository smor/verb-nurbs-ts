var should = require('should');

var lib = require('../dist/index.js');
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
	this.timeout(60000);

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
});
