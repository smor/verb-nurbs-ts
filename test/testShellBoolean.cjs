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
// Closed with the genus given; its volume on the exact faces of its shell (not on the mesh, whose chords cut inside
// every curved face: 0.3% on these fillets).
function closed(res, genus) {
	res.report.manifold.closedManifold.should.be.true();
	res.report.manifold.genus.should.equal(genus);
	return ShellBuilder.volume(ShellBuilder.fromResult(res));
}
// The box [0,40]x[0,28]x[0,20] with every edge rounded to radius 4 (ball corners): the inner box grown by a ball
// (Steiner's formula), a'b'c' + 2r(a'b' + b'c' + c'a') + pi r^2 (a' + b' + c') + 4/3 pi r^3, with a' = 32, b' = 20, c' = 12.
var BOX = 32 * 20 * 12 + 8 * (32 * 20 + 20 * 12 + 12 * 32) + 16 * Math.PI * 64 + 4 / 3 * Math.PI * 64;
// The part of a vertical cylinder at (38, y0), radius 4 (y0 in [8, 20]), inside that box: there the box's height
// depends on x alone, 20 up to x = 36, then 12 + 2 sqrt(16 - (x - 36)^2) round the blend.
function notchCut() {
	var n = 200000, a = 34, h = 6 / n, v = 0;
	for (var i = 0; i < n; i++) {
		var x = a + (i + 0.5) * h;
		var chord = 2 * Math.sqrt(Math.max(0, 16 - (x - 38) * (x - 38)));
		v += chord * (x < 36 ? 20 : 12 + 2 * Math.sqrt(Math.max(0, 16 - (x - 36) * (x - 36)))) * h;
	}
	return v;
}
// The edges lie within 1e-3 of their faces, so volumes on the shells are good to about 1e-5.
var REL = 2e-5;

describe("verb.solid.BrepBoolean on shells", function(){
	this.timeout(budget(180000));

	it('rebuilds a rounded box\'s shell as a closed solid, and drills it through a face and through a fillet', function(){
		var A = rounded([0, 0, 0], [40, 28, 20], [4]);
		closed(BrepBoolean.evaluate([A.solid], function(f){ return f[0]; }), 0).should.be.approximately(BOX, REL * BOX);
		// through the top and bottom faces, inside their flat parts: a hole (genus 1)
		var hole = BOX - 25 * Math.PI * 20;
		closed(BrepBoolean.difference(A.solid, [rod(20, 14, 5)]), 1).should.be.approximately(hole, REL * hole);
		// through the rounded vertical edge's blend and the faces either side: a notch (genus 0)
		var notch = BOX - notchCut();
		closed(BrepBoolean.difference(A.solid, [rod(38, 14, 4)]), 0).should.be.approximately(notch, REL * notch);
	});

	it('unites and intersects two rounded boxes, the branches cut where they cross either shell\'s edges', function(){
		var A = rounded([0, 0, 0], [40, 28, 20], [4]), B = rounded([20, 10, 5], [60, 38, 25], [4]);
		var U = closed(BrepBoolean.union([A.solid, B.solid]), 0);
		var I = closed(BrepBoolean.intersection([A.solid, B.solid]), 0);
		// V(A u B) + V(A n B) = V(A) + V(B)
		(U + I).should.be.approximately(2 * BOX, REL * 2 * BOX);
		I.should.be.above(0.2 * BOX);
	});

	it('drills a box with setback corners, whose fitted parts meet their neighbours within 1e-3 of the radius', function(){
		var C = rounded([0, 0, 0], [40, 28, 20], [3, 4, 5], 'curvature');
		var whole = closed(BrepBoolean.evaluate([C.solid], function(f){ return f[0]; }), 0);
		// the corners' parts are fits within 1e-3 of the radius: their gaps count against the volume
		whole.should.be.approximately(ShellBuilder.volume(ShellBuilder.fromResult(C.result)), REL * whole);
		// through the corner's parts at (40, 28, *) and the faces and blends next to them
		var D = closed(BrepBoolean.difference(C.solid, [rod(36, 24, 3)]), 1);
		var I = closed(BrepBoolean.intersection([C.solid, rod(36, 24, 3)]), 0);
		(D + I).should.be.approximately(whole, REL * whole);
	});
});
