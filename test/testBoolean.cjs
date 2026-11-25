var should = require('should');

var lib = require('../dist/index.js');
var verb = lib.default;
var Sweep = lib.Sweep, Make = verb.eval.Make, Eval = verb.eval.Eval, Vec = verb.core.Vec;
var BrepSolid = lib.BrepSolid, BrepBoolean = lib.BrepBoolean, SurfaceIntersect = lib.SurfaceIntersect;

function line(a, b) { return Make.rationalBezierCurve([a, b]); }

// a cylinder of radius 10 along x and one of radius 6 along y, 1 above it, so they cross without tangency
function crossingRods(around) {
	var a = BrepSolid.cappedTube(Sweep.pipe(line([-30,0,0],[30,0,0]), 10).surface, [24, around]);
	var b = BrepSolid.cappedTube(Sweep.pipe(line([0,-30,1],[0,30,1]), 6).surface, [24, around]);
	return [a, b];
}

// volume common to both rods, by numerical integration: over the disc x^2 + (z-1)^2 < 36, the chord 2 sqrt(100 - z^2)
function exactCommonVolume() {
	var n = 1500, s = 0, h = 12 / n;
	for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
		var x = -6 + (i + 0.5) * h, z = -5 + (j + 0.5) * h;
		if (x * x + (z - 1) * (z - 1) < 36) s += 2 * Math.sqrt(100 - z * z);
	}
	return s * h * h;
}

var wasm;
before(async function(){
	var Module = (await import('manifold-3d')).default;
	wasm = await Module();
	wasm.setup();
});
function manifold(mesh) { return new wasm.Manifold(new wasm.Mesh(mesh.toManifoldMesh())); }

describe("verb.solid.SurfaceIntersect", function(){
	it('finds the two loops where a thin rod crosses a thick one, on both surfaces, across seams', function(){
		var rods = crossingRods(48);
		var fa = rods[0].faces[0], fb = rods[1].faces[0];
		var curves = SurfaceIntersect.surfaces(BrepSolid.domainOf(fa), BrepSolid.domainOf(fb), { divsA : [24, 48], divsB : [24, 48], step : 0.5 });
		curves.length.should.be.equal(2);
		curves.forEach(function(c){
			c.closed.should.be.true();
			c.points.length.should.be.greaterThan(40);
			for (var k = 0; k < c.points.length; k++) {
				Vec.dist(Eval.rationalSurfacePoint(fa.surface, c.uvA[k][0], c.uvA[k][1]), c.points[k]).should.be.lessThan(1e-8);
				Vec.dist(Eval.rationalSurfacePoint(fb.surface, c.uvB[k][0], c.uvB[k][1]), c.points[k]).should.be.lessThan(1e-8);
				// on the thin rod (radius 6, axis along y at z = 1)
				var p = c.points[k];
				Math.sqrt(p[0] * p[0] + (p[2] - 1) * (p[2] - 1)).should.be.approximately(6, 1e-2);
			}
			// each loop goes round the thin rod, so it crosses that rod's seam exactly once
			c.seamB.filter(function(m){ return m != 0; }).length.should.be.equal(1);
		});
	});

	it('splits a loop that crosses a seam into a piece from one side of the domain to the other', function(){
		var rods = crossingRods(48);
		var fa = rods[0].faces[0], fb = rods[1].faces[0];
		var c = SurfaceIntersect.surfaces(BrepSolid.domainOf(fa), BrepSolid.domainOf(fb), { step : 0.5 })[0];
		var pieces = BrepBoolean.facePieces(fb, c.uvB, c.seamB, c.points);
		pieces.length.should.be.equal(1);
		var p = pieces[0];
		p.closed.should.be.false();
		var v = p.uv.map(function(x){ return x[1]; });
		[v[0], v[v.length - 1]].sort().should.be.eql([0, 1]);
		Vec.dist(p.points[0], p.points[p.points.length - 1]).should.be.lessThan(1e-12);
	});
});

describe("verb.solid.BrepSolid", function(){
	it('orients the faces of a capped tube outward and tessellates it watertight', function(){
		var rod = crossingRods(48)[0];
		var m = rod.tessellate();
		m.checkClosedManifold().closedManifold.should.be.true();
		m.signedVolume().should.be.approximately(Math.PI * 100 * 60, Math.PI * 100 * 60 * 0.01);
	});
});

describe("verb.solid.BrepBoolean", function(){
	var rods = crossingRods(96);
	var exact = exactCommonVolume();
	var meshes = rods.map(function(r){ return r.tessellate(); });
	var cases = {
		union : [function(){ return BrepBoolean.union(rods); }, function(a, b){ return a.add(b); }, 0],
		intersection : [function(){ return BrepBoolean.intersection(rods); }, function(a, b){ return a.intersect(b); }, 0],
		difference : [function(){ return BrepBoolean.difference(rods[0], [rods[1]]); }, function(a, b){ return a.subtract(b); }, 1],
	};
	Object.keys(cases).forEach(function(name){
		it(name + ' of two rods is watertight and agrees with manifold-3d', function(){
			var r = cases[name][0]();
			r.report.manifold.closedManifold.should.be.true();
			r.report.manifold.genus.should.be.equal(cases[name][2]);
			r.report.intersectionCurves.should.be.equal(2);
			r.report.maxCurveError.should.be.lessThan(1e-8);
			var m = manifold(r.mesh);
			m.status().should.be.equal('NoError');
			var ref = cases[name][1](manifold(meshes[0]), manifold(meshes[1]));
			m.volume().should.be.approximately(ref.volume(), ref.volume() * 2e-3);
			m.genus().should.be.equal(ref.genus());
		});
	});

	it('intersection of two rods matches the exact common volume', function(){
		var r = BrepBoolean.intersection(rods);
		r.report.volume.should.be.approximately(exact, exact * 3e-3);
	});

	it('inclusion-exclusion holds: |A| + |B| = |A u B| + |A n B|', function(){
		var u = BrepBoolean.union(rods).report.volume, i = BrepBoolean.intersection(rods).report.volume;
		(meshes[0].signedVolume() + meshes[1].signedVolume()).should.be.approximately(u + i, (u + i) * 1e-3);
	});

	it('returns trimmed faces with trim loops in their parameter domains', function(){
		var r = BrepBoolean.difference(rods[0], [rods[1]]);
		// the thick rod's wall keeps one region with two holes; the thin rod keeps the band through the hole
		var wall = r.faces.filter(function(f){ return f.solid == 0 && f.name == 'tube'; });
		wall.length.should.be.equal(1);
		wall[0].loops.length.should.be.greaterThan(2);
		var band = r.faces.filter(function(f){ return f.solid == 1; });
		band.length.should.be.equal(1);
		// it now bounds the hole, so it faces the other way
		band[0].reversed.should.not.equal(rods[1].faces[0].reversed);
		band[0].loops.forEach(function(l){ l.forEach(function(uv){
			uv[0].should.be.within(0, 1); uv[1].should.be.within(0, 1);
		}); });
	});

	it('evaluates any expression: (A - B) u (A n B) is A', function(){
		var r = BrepBoolean.evaluate(rods, function(f){ return (f[0] && !f[1]) || (f[0] && f[1]); });
		r.report.manifold.closedManifold.should.be.true();
		r.report.intersectionCurves.should.be.equal(2);
		r.report.volume.should.be.approximately(meshes[0].signedVolume(), 1e-4 * meshes[0].signedVolume());
	});
});

describe("verb.recipes.BooleanObjectsRecipe", function(){
	this.timeout(60000);

	it('mug: (body + handle) - cavity is a genus 1 solid accepted by manifold-3d', function(){
		var o = lib.BooleanObjectsRecipe.mug({ divsU : 32, divsV : 128 });
		o.result.report.manifold.closedManifold.should.be.true();
		o.result.report.manifold.genus.should.be.equal(1);
		o.result.report.intersectionCurves.should.be.equal(5);
		var m = manifold(o.result.mesh);
		m.status().should.be.equal('NoError');
		m.genus().should.be.equal(1);
		var ref = manifold(o.body.tessellate()).add(manifold(o.handle.tessellate())).subtract(manifold(o.cavity.tessellate()));
		m.volume().should.be.approximately(ref.volume(), ref.volume() * 1e-3);
	});

	it('pierced vessel has one handle-like hole per tool', function(){
		var o = lib.BooleanObjectsRecipe.pierced({ holes : 5, rows : 1, divsU : 32, divsV : 128 });
		o.result.report.manifold.closedManifold.should.be.true();
		o.result.report.manifold.genus.should.be.equal(5);
		var m = manifold(o.result.mesh);
		m.status().should.be.equal('NoError');
		m.genus().should.be.equal(5);
	});
});
