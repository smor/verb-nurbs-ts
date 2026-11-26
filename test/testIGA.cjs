var should = require('should');

var lib = require('../dist/index.js');
var Make = lib.default.eval.Make, THB = lib.THB, IGA = lib.IGA;

// the quarter annulus 1 < r < 2, x, y > 0: exact, rational quadratic round, linear across
function annulus() {
	var arc = function(r){ return Make.arc([0,0,0], [1,0,0], [0,1,0], r, 0, Math.PI / 2); };
	return Make.loftedSurface([arc(1), arc(2)], 1);
}
function uniform(p, level, breaks) {
	var S = THB.space([p, p], breaks || [0, 1], breaks || [0, 1]);
	return THB.space([p, p], THB.breakpoints(S, level, 0), THB.breakpoints(S, level, 1));
}

// u = (r² - 1)(r² - 4) x y vanishes on the whole boundary; -Δu = x y (60 - 32 r²)
function u0(x, y) { var s = x * x + y * y; return (s - 1) * (s - 4) * x * y; }
function g0(x, y) { var s = x * x + y * y, g = (s - 1) * (s - 4), gp = 2 * s - 5; return [2 * x * x * y * gp + g * y, 2 * x * y * y * gp + g * x]; }
function f0(x, y) { return x * y * (60 - 32 * (x * x + y * y)); }

describe("verb.eval.IGA", function(){
	this.timeout(60000);

	[2, 3].forEach(function(p){
		it('degree ' + p + ': converges at the optimal rates on the quarter annulus, h^' + (p + 1) + ' in L2 and h^' + p + ' in H1', function(){
			var e = [3, 4].map(function(l){ return IGA.errors(IGA.poisson({ geometry : annulus(), space : uniform(p, l), source : f0 }), u0, g0); });
			Math.log2(e[0].l2 / e[1].l2).should.be.approximately(p + 1, 0.3);
			Math.log2(e[0].h1 / e[1].h1).should.be.approximately(p, 0.15);
		});
	});

	it('reproduces a linear solution exactly on a bilinear quadrilateral (the patch test), with its boundary values', function(){
		var quad = Make.fourPointSurface([0,0,0], [2,0.3,0], [2.4,1.9,0], [-0.2,1.5,0]);
		var exact = function(x, y){ return 1 + 2 * x - y; };
		var s = IGA.poisson({ geometry : quad, space : uniform(2, 2), source : function(){ return 0; }, boundary : exact });
		var e = IGA.errors(s, exact, function(){ return [2, -1]; });
		e.l2.should.be.below(1e-9);
		e.h1.should.be.below(1e-9);
	});

	it('estimates the error reliably: the residual estimate keeps a steady ratio to the H1 error as the mesh refines', function(){
		var ratios = [1, 2, 3].map(function(l){
			var s = IGA.poisson({ geometry : annulus(), space : uniform(2, l), source : f0 });
			var eta = Math.sqrt(IGA.estimate(s).reduce(function(a, x){ return a + x.eta * x.eta; }, 0));
			return eta / IGA.errors(s, u0, g0).h1;
		});
		ratios.forEach(function(r){ r.should.be.within(5, 30); });
		(Math.max.apply(null, ratios) / Math.min.apply(null, ratios)).should.be.below(1.5);
	});

	it('refines adaptively towards an internal layer, reaching the error of a uniform mesh with a fraction of its functions', function(){
		// u = atan(60 (r - 1.5)): a steep circular layer through the annulus, with its own boundary values
		var A = 60, c = 1.5;
		var u = function(x, y){ return Math.atan(A * (Math.hypot(x, y) - c)); };
		var d = function(r){ return A / (1 + A * A * (r - c) * (r - c)); };
		var grad = function(x, y){ var r = Math.hypot(x, y); return [d(r) * x / r, d(r) * y / r]; };
		var f = function(x, y){ var r = Math.hypot(x, y), t = 1 + A * A * (r - c) * (r - c); return 2 * A * A * A * (r - c) / (t * t) - d(r) / r; };
		var q = [0, 0.25, 0.5, 0.75, 1];
		var rounds = IGA.adaptive({ geometry : annulus(), space : THB.space([2, 2], q, q), source : f, boundary : u }, { steps : 10 });
		var last = rounds[rounds.length - 1].solution, eLast = IGA.errors(last, u, grad);
		// the estimate falls round after round, and the hierarchy is several levels deep along the layer only
		rounds[rounds.length - 1].estimate.should.be.below(rounds[0].estimate / 10);
		last.problem.space.omega.length.should.be.above(3);
		// uniform level 2 (324 functions) has about the same H1 error: the adaptive space has far fewer functions
		var U = IGA.poisson({ geometry : annulus(), space : uniform(2, 2, q), source : f, boundary : u });
		var eU = IGA.errors(U, u, grad);
		eLast.h1.should.be.below(eU.h1);
		(2 * last.basis.functions.length).should.be.below(U.basis.functions.length);
	});
});
