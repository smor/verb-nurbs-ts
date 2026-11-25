var should = require('should');

var lib = require('../dist/index.js');
var Transfinite = lib.Transfinite, Vec = lib.Vec, Eval = lib.default.eval.Eval;

// ribbons taken from a surface over the domain polygon itself: boundary samples, and the derivative along each side's
// inward normal
function ribbonsOf(S, dS, n, samples) {
	var P = Transfinite.polygon(n);
	return P.map(function(a, i){
		var b = P[(i + 1) % n];
		var nx = a[1] - b[1], ny = b[0] - a[0], l = Math.sqrt(nx * nx + ny * ny); nx /= l; ny /= l;
		var pts = [], cross = [];
		for (var k = 0; k <= samples; k++) {
			var t = k / samples, x = a[0] + t * (b[0] - a[0]), y = a[1] + t * (b[1] - a[1]);
			pts.push(S(x, y));
			var d = dS(x, y);
			cross.push(Vec.add(Vec.mul(nx, d[0]), Vec.mul(ny, d[1])));
		}
		return { points : pts, cross : cross };
	});
}

function normalAt(R, x, y, h) {
	var p = Transfinite.evaluate(R, [x, y]);
	var du = Vec.sub(Transfinite.evaluate(R, [x + h, y]), p), dv = Vec.sub(Transfinite.evaluate(R, [x, y + h]), p);
	return Vec.normalized(Vec.cross(du, dv));
}

describe("Transfinite n-sided patches", function(){

	it('keeps a flat patch flat, and interpolates its boundary', function(){
		[3, 4, 5, 6].forEach(function(n){
			var S = function(x, y){ return [2 * x + y, x - y, 0]; };
			var dS = function(){ return [[2, 1, 0], [1, -1, 0]]; };
			var R = ribbonsOf(S, dS, n, 64);
			var m = Transfinite.mesh(R, 8);
			m.points.forEach(function(p){ Math.abs(p[2]).should.be.below(1e-12); });
			// the boundary: the polygon's vertices and side midpoints map to the surface's
			var P = Transfinite.polygon(n);
			P.forEach(function(a, i){
				var b = P[(i + 1) % n], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
				Vec.dist(Transfinite.evaluate(R, mid), S(mid[0], mid[1])).should.be.below(1e-9);
			});
		});
	});

	it('meets its ribbons with tangent-plane (G1) continuity along every side', function(){
		var S = function(x, y){ return [x, y, 0.3 * (x * x - y * y) + 0.2 * x * y + 0.1 * x * x * x]; };
		var dS = function(x, y){ return [[1, 0, 0.6 * x + 0.2 * y + 0.3 * x * x], [0, 1, -0.6 * y + 0.2 * x]]; };
		[5, 6].forEach(function(n){
			var R = ribbonsOf(S, dS, n, 256);
			var P = Transfinite.polygon(n);
			P.forEach(function(a, i){
				var b = P[(i + 1) % n];
				var nx = a[1] - b[1], ny = b[0] - a[0], l = Math.sqrt(nx * nx + ny * ny); nx /= l; ny /= l;
				[0.25, 0.5, 0.75].forEach(function(t){
					var x = a[0] + t * (b[0] - a[0]) + 1e-4 * nx, y = a[1] + t * (b[1] - a[1]) + 1e-4 * ny;
					// (the boundary is parametrised by chord length, so compare with the source's normal where the patch is)
					var p = Transfinite.evaluate(R, [x, y]), d = dS(p[0], p[1]), want = Vec.normalized(Vec.cross(d[0], d[1]));
					Vec.dist(normalAt(R, x, y, 1e-6), want).should.be.below(2e-3);
				});
			});
			// and it is a smooth surface inside: near the source surface, which is no ribbon's
			var m = Transfinite.mesh(R, 10);
			var worst = 0;
			m.points.forEach(function(p){ worst = Math.max(worst, Math.abs(p[2] - S(p[0], p[1])[2])); });
			worst.should.be.below(0.05);
		});
	});

	it('with second cross derivatives, matches the normal curvature across every side as well (G2)', function(){
		var f = function(x, y){ return 0.3 * (x * x - y * y) + 0.2 * x * y + 0.1 * x * x * x; };
		var S = function(x, y){ return [x, y, f(x, y)]; };
		var dS = function(x, y){ return [[1, 0, 0.6 * x + 0.2 * y + 0.3 * x * x], [0, 1, -0.6 * y + 0.2 * x]]; };
		var hess = function(x){ return [[0.6 + 0.6 * x, 0.2], [0.2, -0.6]]; };
		// the second derivative of the patch along a side's inward normal, against the source's normal curvature there
		function worstCurvatureGap(n, g2) {
			var R = ribbonsOf(S, dS, n, 256), P = Transfinite.polygon(n), worst = 0, h = 1e-3;
			P.forEach(function(a, i){
				var b = P[(i + 1) % n];
				var nx = a[1] - b[1], ny = b[0] - a[0], l = Math.sqrt(nx * nx + ny * ny); nx /= l; ny /= l;
				if (g2) R[i].second = R[i].points.map(function(_, k){
					var t = k / (R[i].points.length - 1), H = hess(a[0] + t * (b[0] - a[0]));
					return [0, 0, nx * nx * H[0][0] + 2 * nx * ny * H[0][1] + ny * ny * H[1][1]];
				});
			});
			P.forEach(function(a, i){
				var b = P[(i + 1) % n];
				var nx = a[1] - b[1], ny = b[0] - a[0], l = Math.sqrt(nx * nx + ny * ny); nx /= l; ny /= l;
				[0.25, 0.5, 0.75].forEach(function(t){
					var x = a[0] + t * (b[0] - a[0]), y = a[1] + t * (b[1] - a[1]);
					var p = [0, 1, 2].map(function(k){ return Transfinite.evaluate(R, [x + k * h * nx, y + k * h * ny]); });
					var dd = Vec.mul(1 / (h * h), Vec.add(Vec.sub(p[0], Vec.mul(2, p[1])), p[2]));
					var d = dS(x, y), nrm = Vec.normalized(Vec.cross(d[0], d[1])), H = hess(x);
					var want = nrm[2] * (nx * nx * H[0][0] + 2 * nx * ny * H[0][1] + ny * ny * H[1][1]);
					worst = Math.max(worst, Math.abs(Vec.dot(nrm, dd) - want));
				});
			});
			return worst;
		}
		[5, 6].forEach(function(n){
			// normal curvatures here are about 0.6: G1 ribbons miss them by as much, G2 ribbons to about 1%
			worstCurvatureGap(n, false).should.be.above(0.3);
			worstCurvatureGap(n, true).should.be.below(0.02);
		});
	});

	it('fits n four-sided B-spline surfaces that meet along their shared sides and trace the patch', function(){
		var S = function(x, y){ return [x, y, 0.3 * (x * x - y * y) + 0.1 * x * x * x]; };
		var dS = function(x, y){ return [[1, 0, 0.6 * x + 0.3 * x * x], [0, 1, -0.6 * y]]; };
		var R = ribbonsOf(S, dS, 6, 128);
		var srf = Transfinite.surfaces(R, 1e-5);
		srf.length.should.be.equal(6);
		srf.forEach(function(s, i){
			var next = srf[(i + 1) % 6];
			for (var k = 0; k <= 8; k++) {
				var t = k / 8;
				// u = 1 (side i's split point to the centre) is the next surface's v = 1, from its side's split point
				Vec.dist(Eval.rationalSurfacePoint(s, 1, t), Eval.rationalSurfacePoint(next, t, 1)).should.be.below(1e-4);
				// and each one's patch matches the evaluated patch along v = 0 (the boundary)
				var p = Eval.rationalSurfacePoint(s, t, 0);
				Math.abs(p[2] - S(p[0], p[1])[2]).should.be.below(1e-3);
			}
		});
	});
});
