var should = require('should');

var lib = require('../dist/index.js');
var Eval = lib.default.eval.Eval, THB = lib.THB;

var quarters = [0, 0.25, 0.5, 0.75, 1];

// three levels of refinement towards a corner, the last one round a point: Ω_1 ⊇ Ω_2 ⊇ Ω_3, irregular shapes
function cornered(p) {
	var S = THB.space([p, p], quarters, quarters);
	S = THB.refineWhere(S, 0, function(u0, u1, v0, v1){ return u0 < 0.5 && v0 < 0.5; });
	S = THB.refineWhere(S, 1, function(u0, u1, v0, v1){ return u0 < 0.25 && v0 < 0.375 && v1 > 0.1; });
	return THB.refineWhere(S, 2, function(u0, u1, v0, v1){ return Math.hypot(u0 - 0.1, v0 - 0.2) < 0.08; });
}

// a deterministic stream of parameter points
function points(n) {
	var out = [], a = 0.5, b = 0.25;
	for (var k = 0; k < n; k++) { a = (a + 0.6180339887) % 1; b = (b + 0.7548776662) % 1; out.push([a, b]); }
	return out;
}

function grid(n, f) {
	var out = [];
	for (var i = 0; i <= n; i++) for (var j = 0; j <= n; j++) out.push({ uv : [i / n, j / n], point : f(i / n, j / n) });
	return out;
}

describe("verb.eval.THB", function(){

	[2, 3].forEach(function(p){
		it('degree ' + p + ': truncated functions are non-negative and sum to one everywhere', function(){
			var B = THB.basis(cornered(p));
			B.space.omega.length.should.be.equal(4);
			points(1500).forEach(function(uv){
				var v = THB.evaluate(B, uv), s = 0;
				v.forEach(function(x){ x[1].should.be.above(-1e-14); s += x[1]; });
				Math.abs(s - 1).should.be.below(1e-12);
			});
		});

		it('degree ' + p + ': functions are linearly independent (their finest coefficients have a positive definite Gram matrix)', function(){
			var B = THB.basis(cornered(p)), n = B.functions.length;
			var G = B.functions.map(function(fi){ return B.functions.map(function(fj){
				var s = 0; fi.coefficients.forEach(function(x, k){ var y = fj.coefficients.get(k); if (y) s += x * y; }); return s; }); });
			// Cholesky: every pivot positive
			for (var k = 0; k < n; k++) {
				for (var m = 0; m < k; m++) G[k][k] -= G[k][m] * G[k][m];
				G[k][k].should.be.above(1e-6);
				G[k][k] = Math.sqrt(G[k][k]);
				for (var i = k + 1; i < n; i++) { for (var m2 = 0; m2 < k; m2++) G[i][k] -= G[i][m2] * G[k][m2]; G[i][k] /= G[k][k]; }
			}
		});
	});

	it('adds finer functions only where their support fits in the refined region', function(){
		function one(u, v) { return THB.basis(THB.refineWhere(THB.space([3, 3], quarters, quarters), 0, function(u0, u1, v0, v1){ return u0 == u && v0 == v; })); }
		// an inner cell: no level-1 cubic fits in it, so the space is level 0's
		var B = one(0.25, 0.25);
		B.functions.length.should.be.equal(49);
		B.functions.every(function(f){ return f.level == 0; }).should.be.true();
		// a corner cell: the open knots shrink the supports there; 4 level-1 cubics fit, and replace the corner's one
		var C = one(0, 0);
		C.functions.filter(function(f){ return f.level == 1; }).length.should.be.equal(4);
		C.functions.length.should.be.equal(52);
	});

	it('spans nested spaces: a surface refined elsewhere keeps its shape exactly', function(){
		var B = THB.basis(cornered(3));
		var P = THB.fit(B, grid(40, function(u, v){ return [u, v, Math.sin(3 * u) * Math.cos(2 * v)]; }));
		var S2 = THB.refineWhere(B.space, 0, function(u0, u1, v0, v1){ return u0 > 0.6 && v0 > 0.6; });
		var B2 = THB.basis(S2);
		B2.functions.length.should.be.above(B.functions.length);
		var a = THB.surface(B, P), b = THB.surface(B2, THB.transfer(B, P, B2));
		points(300).forEach(function(uv){
			var x = Eval.rationalSurfacePoint(a, uv[0], uv[1]), y = Eval.rationalSurfacePoint(b, uv[0], uv[1]);
			Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]).should.be.below(1e-9);
		});
	});

	it('converts exactly to a B-spline surface of the finest level', function(){
		var B = THB.basis(cornered(3));
		var P = B.functions.map(function(f, k){ return [Math.sin(k), Math.cos(3 * k), k % 7]; });
		var S = THB.surface(B, P);
		S.knotsU.length.should.be.equal(B.count[0] + 4);
		points(300).forEach(function(uv){
			var x = [0, 0, 0];
			THB.evaluate(B, uv).forEach(function(e){ for (var d = 0; d < 3; d++) x[d] += e[1] * P[e[0]][d]; });
			var y = Eval.rationalSurfacePoint(S, uv[0], uv[1]);
			Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]).should.be.below(1e-12);
		});
	});

	it('refuses to refine a cell outside its level\'s domain', function(){
		var S = THB.refineWhere(THB.space([2, 2], quarters, quarters), 0, function(u0){ return u0 < 0.25; });
		(function(){ THB.refine(S, 1, [[7, 7]]); }).should.throw(/domain/);
	});

	it('fits a sharp ridge within tolerance with far fewer functions than uniform refinement', function(){
		this.timeout(60000);
		function f(u, v) { return [0.1 * Math.tanh((u - 0.35 - 0.15 * Math.sin(2 * Math.PI * v)) / 0.03) + 0.05 * u * v]; }
		var samples = grid(100, f);
		var R = THB.adaptiveFit(THB.space([3, 3], quarters, quarters), samples, { tolerance : 2e-3, maxLevel : 4 });
		R.error.should.be.below(2e-3);
		R.space.omega.length.should.be.above(2);
		// the same tolerance by uniform refinement: the coarsest uniform level that reaches it
		var uniform = 0;
		for (var l = 1; l <= 4; l++) {
			var U = THB.space([3, 3], THB.breakpoints(R.space, l, 0), THB.breakpoints(R.space, l, 1)), B = THB.basis(U);
			var S = THB.surface(B, THB.fit(B, samples)), e = 0;
			samples.forEach(function(s){ e = Math.max(e, Math.abs(Eval.rationalSurfacePoint(S, s.uv[0], s.uv[1])[0] - s.point[0])); });
			if (e < 2e-3) { uniform = B.functions.length; break; }
		}
		uniform.should.be.above(0);
		(R.basis.functions.length * 2).should.be.below(uniform);
	});
});
