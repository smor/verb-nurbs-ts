var should = require('should');

var lib = require('../dist/index.js');
var verb = lib.default;
var Fair = lib.Fair, Fit = lib.Fit, Eval = verb.eval.Eval, Modify = verb.eval.Modify, NurbsCurveData = verb.core.NurbsCurveData;

function random(seed) { var s = seed; return function(){ s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

// one period of a sine, 5 high and 31.4 long, through 41 points with noise of 0.15 (peak to peak)
function noisySine() {
	var rnd = random(5), pts = [];
	for (var i = 0; i <= 40; i++) { var x = i / 40 * 2 * Math.PI; pts.push([x * 5, 5 * Math.sin(x) + 0.15 * (rnd() - 0.5), 0]); }
	return Fit.curve(pts, 3);
}

// a dome 8 high over a 30 x 30 square, through a 16 x 16 grid with noise of 0.6 inside
function noisyDome() {
	var rnd = random(5), n = 16, grid = [];
	for (var i = 0; i < n; i++) {
		var row = [];
		for (var j = 0; j < n; j++) {
			var u = i / (n - 1), v = j / (n - 1), inner = i > 0 && j > 0 && i < n - 1 && j < n - 1;
			row.push([u * 30, v * 30, 8 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v) + (inner ? 0.6 * (rnd() - 0.5) : 0)]);
		}
		grid.push(row);
	}
	var params = grid.map(function(_, i){ return i / (n - 1); }), knots = Fit.knotsByAveraging(params, 3);
	return Fit.surfaceWithKnots(grid, params, params, 3, 3, knots, knots);
}

function domeRms(S) {
	var e = 0, n = 0;
	for (var i = 0; i <= 40; i++) for (var j = 0; j <= 40; j++) {
		var p = Eval.rationalSurfacePoint(S, i / 40, j / 40);
		e += Math.pow(p[2] - 8 * Math.sin(Math.PI * p[0] / 30) * Math.sin(Math.PI * p[1] / 30), 2); n++;
	}
	return Math.sqrt(e / n);
}

describe("verb.eval.Fair", function(){

	it("integrates the energies exactly: (u, u^2, u^3) has 16 of bending and 36 of jerk, however its knots are split", function(){
		var bezier = new NurbsCurveData(3, [0, 0, 0, 0, 1, 1, 1, 1], [[0, 0, 0, 1], [1 / 3, 0, 0, 1], [2 / 3, 1 / 3, 0, 1], [1, 1, 1, 1]]);
		var split = Modify.curveKnotRefine(bezier, [0.2, 0.5, 0.5, 0.7]);
		[bezier, split].forEach(function(c){
			Fair.curveEnergy(c, 2).should.be.approximately(16, 1e-9);
			Fair.curveEnergy(c, 3).should.be.approximately(36, 1e-9);
			Fair.curveEnergy(c, 1).should.be.approximately(1 + 4 / 3 + 9 / 5, 1e-9);
		});
	});

	it("fairs a noisy curve: far fewer curvature extrema, its ends kept to G1 or G2, closer to the curve the noise hid", function(){
		var c = noisySine();
		Fair.curvatureExtrema(c).should.be.above(40);
		var g1 = Fair.curve(c, { smoothness : 1000, keep : 1 });
		// a sine's curvature has three extrema inside a period; the faired curve is within two of that
		Fair.curvatureExtrema(g1).should.be.belowOrEqual(5);
		var err = 0;
		for (var i = 0; i <= 200; i++) { var p = Eval.rationalCurvePoint(g1, i / 200); err = Math.max(err, Math.abs(p[1] - 5 * Math.sin(p[0] / 5))); }
		err.should.be.below(0.25);
		// the ends: same points and tangents (G1); with keep 2, the same curvature too (G2)
		var g2 = Fair.curve(c, { smoothness : 1000, keep : 2 });
		[0, 1].forEach(function(u){
			var a = Eval.rationalCurveDerivatives(c, u, 2), b = Eval.rationalCurveDerivatives(g1, u, 2), d = Eval.rationalCurveDerivatives(g2, u, 2);
			verb.core.Vec.dist(a[0], b[0]).should.be.below(1e-12);
			verb.core.Vec.dist(a[1], b[1]).should.be.below(1e-9);
			verb.core.Vec.dist(a[2], d[2]).should.be.below(1e-9);
		});
	});

	it("smoothness 0 changes nothing, and more smoothness always lowers the energy", function(){
		var c = noisySine();
		Fair.curve(c, { smoothness : 0 }).controlPoints.should.eql(c.controlPoints);
		var last = Fair.curveEnergy(c);
		[0.1, 1, 10, 100].forEach(function(l){
			var e = Fair.curveEnergy(Fair.curve(c, { smoothness : l }));
			e.should.be.below(last);
			last = e;
		});
		// bending energy, if asked for
		Fair.curveEnergy(Fair.curve(c, { smoothness : 10, order : 2 }), 2).should.be.below(Fair.curveEnergy(c, 2));
	});

	it("fairs a noisy surface by the thin plate: the energy falls, the boundary and its cross tangents stay, the noise goes", function(){
		var s = noisyDome(), e0 = Fair.surfaceEnergy(s);
		var f = Fair.surface(s, { smoothness : 1 });
		Fair.surfaceEnergy(f).should.be.below(0.7 * e0);
		Fair.surfaceEnergy(Fair.surface(s, { smoothness : 10 })).should.be.below(Fair.surfaceEnergy(f));
		// two rows along every side are kept (G1)
		var n = s.controlPoints.length;
		s.controlPoints.forEach(function(row, i){ row.forEach(function(p, j){
			if (i <= 1 || j <= 1 || i >= n - 2 || j >= n - 2) f.controlPoints[i][j].should.eql(p);
		}); });
		// nearer the dome the noise was added to
		domeRms(f).should.be.below(0.85 * domeRms(s));
		// a free side moves with the rest
		var open = Fair.surface(s, { smoothness : 10, sides : [true, true, true, false] });
		open.controlPoints[8][n - 1].should.not.eql(s.controlPoints[8][n - 1]);
		open.controlPoints[0][8].should.eql(s.controlPoints[0][8]);
	});

	it("refuses what it cannot fair", function(){
		var rational = new NurbsCurveData(2, [0, 0, 0, 1, 1, 1], [[1, 0, 0, 1], [0.7, 0.7, 0, 0.7], [0, 1, 0, 1]]);
		(function(){ Fair.curve(rational, { smoothness : 1 }); }).should.throw(/non-rational/);
		(function(){ Fair.curve(noisySine(), { smoothness : 1, order : 4 }); }).should.throw(/order 4/);
		(function(){ Fair.curve(noisySine(), { smoothness : -1 }); }).should.throw(/smoothness/);
	});
});
