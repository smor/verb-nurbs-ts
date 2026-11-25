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

	it('fits one B-spline surface whose sides trace the patch', function(){
		var S = function(x, y){ return [x, y, 0.3 * (x * x - y * y)]; };
		var dS = function(x, y){ return [[1, 0, 0.6 * x], [0, 1, -0.6 * y]]; };
		var R = ribbonsOf(S, dS, 6, 128);
		var srf = Transfinite.surface(R, 1e-4);
		// the surface's corner (u, v) = (0, 0) maps onto the polygon's boundary, so onto the source surface
		var p = Eval.rationalSurfacePoint(srf, 0, 0.5);
		Math.abs(p[2] - S(p[0], p[1])[2]).should.be.below(1e-3);
	});
});
