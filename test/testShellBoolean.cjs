var should = require('should');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var verb = lib.default, Make = verb.eval.Make;
var BrepSolid = lib.BrepSolid, BrepBoolean = lib.BrepBoolean, ShellBuilder = lib.ShellBuilder, Sweep = lib.Sweep;

// Booleans that take shells (route A, step A3): a result's exact shell becomes an operand of trimmed faces, whose
// edges cut the branches of the next Boolean where they leave a face for its neighbour.

function line(a, b) { return Make.rationalBezierCurve([a, b]); }
function rounded(min, max, radii, shape) {
	var b = BrepSolid.box(min, max, 12);
	var E = lib.BrepEdges.all(b).map(function(e, k){ return { solid : 0, faces : e.faces, radius : radii[k % radii.length] }; });
	var r = BrepBoolean.evaluate([b], function(f){ return f[0]; }, { filletShape : shape, edges : E });
	return { result : r, solid : ShellBuilder.solid(ShellBuilder.fromResult(r), r.mesh) };
}
function rod(x, y, r) { return BrepSolid.cappedTube(Sweep.pipe(line([x, y, -5], [x, y, 25]), r).surface, [24, 96]); }
function closed(res, genus) {
	res.report.manifold.closedManifold.should.be.true();
	res.report.manifold.genus.should.equal(genus);
	return res.report.volume;
}
// The volume of the box [0,40]x[0,28]x[0,20] with every edge rounded to radius 4 (ball corners), less a vertical
// cylinder (x0, y0, r) through it: the box's height over (x, y) is 20 - 2 (4 - sqrt(16 - d^2)), d the distance into
// the rounded rim, integrated on a fine grid.
function exact(x0, y0, r) {
	var n = 1600, hx = 40 / n, hy = 28 / n, v = 0;
	for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
		var x = (i + 0.5) * hx, y = (j + 0.5) * hy;
		if (r > 0 && (x - x0) * (x - x0) + (y - y0) * (y - y0) < r * r) continue;
		var dx = Math.max(0, 4 - x, x - 36), dy = Math.max(0, 4 - y, y - 24), d = Math.sqrt(dx * dx + dy * dy);
		if (d >= 4) continue;
		v += (12 + 2 * Math.sqrt(16 - d * d)) * hx * hy;
	}
	return v;
}

describe("verb.solid.BrepBoolean on shells", function(){
	this.timeout(budget(180000));

	it('rebuilds a rounded box\'s shell as a closed solid, and drills it through a face and through a fillet', function(){
		var A = rounded([0, 0, 0], [40, 28, 20], [4]);
		var V = exact(0, 0, 0);
		closed(BrepBoolean.evaluate([A.solid], function(f){ return f[0]; }), 0).should.be.approximately(V, 0.005 * V);
		// through the top and bottom faces: a hole (genus 1)
		var hole = closed(BrepBoolean.difference(A.solid, [rod(20, 14, 5)]), 1), Vh = exact(20, 14, 5);
		hole.should.be.approximately(Vh, 0.005 * Vh);
		// through the rounded vertical edge's blend and the faces either side: a notch (genus 0)
		var notch = closed(BrepBoolean.difference(A.solid, [rod(38, 14, 4)]), 0), Vn = exact(38, 14, 4);
		notch.should.be.approximately(Vn, 0.005 * Vn);
	});

	it('unites and intersects two rounded boxes, the branches cut where they cross either shell\'s edges', function(){
		var A = rounded([0, 0, 0], [40, 28, 20], [4]), B = rounded([20, 10, 5], [60, 38, 25], [4]);
		var U = closed(BrepBoolean.union([A.solid, B.solid]), 0);
		var I = closed(BrepBoolean.intersection([A.solid, B.solid]), 0);
		// V(A u B) + V(A n B) = V(A) + V(B)
		var V = exact(0, 0, 0);
		(U + I).should.be.approximately(2 * V, 0.005 * 2 * V);
		I.should.be.above(0.1 * V);
	});

	it('drills a box with setback corners, whose fitted parts meet their neighbours within 1e-3 of the radius', function(){
		var C = rounded([0, 0, 0], [40, 28, 20], [3, 4, 5], 'curvature');
		var whole = closed(BrepBoolean.evaluate([C.solid], function(f){ return f[0]; }), 0);
		whole.should.be.approximately(C.result.report.volume, 0.005 * whole);
		// through the corner's parts at (40, 28, *) and the faces and blends next to them
		var D = closed(BrepBoolean.difference(C.solid, [rod(36, 24, 3)]), 1);
		var I = closed(BrepBoolean.intersection([C.solid, rod(36, 24, 3)]), 0);
		(D + I).should.be.approximately(whole, 0.003 * whole);
	});
});
