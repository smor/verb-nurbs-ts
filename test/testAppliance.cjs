var should = require('should');
var lib = require('../dist/index.js');

var wasm;
before(async function(){
	var Module = (await import('manifold-3d')).default;
	wasm = await Module();
	wasm.setup();
});
function manifold(mesh) { return new wasm.Manifold(new wasm.Mesh(mesh.toManifoldMesh())); }

describe("verb.recipes.ApplianceRecipe", function(){
	this.timeout(120000);
	var a;
	before(function(){ a = lib.ApplianceRecipe.build({ fine : false }); });

	it('base: block - slab - seat - key pocket + arch, all five new edges filleted, a genus 1 solid', function(){
		var r = a.base.report;
		r.intersectionCurves.should.be.equal(5);
		r.fillets.should.be.equal(5);
		r.manifold.closedManifold.should.be.true();
		r.manifold.genus.should.be.equal(1);
		var m = manifold(a.base.mesh);
		m.status().should.be.equal('NoError');
		m.genus().should.be.equal(1);
	});

	it('bowl: a cone with a sculpted, filleted grip, a keyed foot and three filleted inner ribs, a genus 1 solid', function(){
		var r = a.bowl.result.report;
		r.fillets.should.be.equal(6);
		r.filletsFailed.should.be.equal(0);
		r.manifold.closedManifold.should.be.true();
		r.manifold.genus.should.be.equal(1);
		manifold(a.bowl.result.mesh).status().should.be.equal('NoError');
	});

	it('the grip is a variable section: 24 wide across the handle\'s plane at its ends, swelling to 1.2 times that halfway', function(){
		var s = a.bowl.handle.faces[0].surface, rail = a.bowl.handleRail;
		var c = lib.Eval.rationalCurvePoint(rail, 0.5), h = Math.hypot(c[0], c[1]), across = [c[1] / h, -c[0] / h];
		function width(u){
			var w = [];
			for (var v = 0; v < 1; v += 0.005) { var p = lib.Eval.rationalSurfacePoint(s, u, v); w.push(p[0] * across[0] + p[1] * across[1]); }
			return Math.max.apply(null, w) - Math.min.apply(null, w);
		}
		width(0).should.be.approximately(24, 0.3);
		width(1).should.be.approximately(24, 0.3);
		width(0.5).should.be.approximately(28.8, 0.3);
	});

	it('the bowl sits in its seat without touching, and the seat holds it (sinking it collides)', function(){
		var base = manifold(a.base.mesh), bowl = manifold(a.bowl.result.mesh).translate(a.bowlOffset);
		base.intersect(bowl).volume().should.be.below(1e-6);
		base.intersect(bowl.translate([0, 0, -1])).volume().should.be.above(100);
	});

	it('the coupling is keyed: the bowl turned by any third of a turn, or half a turn, collides with its seat', function(){
		var base = manifold(a.base.mesh), bowl = manifold(a.bowl.result.mesh);
		[60, 120, 180, 240].forEach(function(deg){
			base.intersect(bowl.rotate([0, 0, deg]).translate(a.bowlOffset)).volume().should.be.above(100);
		});
	});

	it('lid: plate + tapered plug - hollow - hole, both hole edges filleted; it rests on the rim, clear of the bowl and the base', function(){
		var r = a.lid.report;
		r.fillets.should.be.equal(2);
		r.manifold.closedManifold.should.be.true();
		r.manifold.genus.should.be.equal(1);
		var lid = manifold(a.lid.mesh).translate(a.bowlOffset), bowl = manifold(a.bowl.result.mesh).translate(a.bowlOffset);
		lid.status().should.be.equal('NoError');
		Math.abs(lid.intersect(bowl).volume()).should.be.below(1e-6);
		lid.intersect(manifold(a.base.mesh)).volume().should.be.below(1e-6);
		lid.translate([0, 0, -1]).intersect(bowl).volume().should.be.above(100);
		lid.translate([1, 0, 0]).intersect(bowl).volume().should.be.above(10);
	});

	it('measuring cup: teardrop flange + tapered body - cavity, two fillets; it plugs the lid\'s hole and rests on the lid', function(){
		var r = a.cup.report;
		r.fillets.should.be.equal(2);
		r.manifold.closedManifold.should.be.true();
		r.manifold.genus.should.be.equal(0);
		var cup = manifold(a.cup.mesh).translate(a.bowlOffset), lid = manifold(a.lid.mesh).translate(a.bowlOffset);
		cup.status().should.be.equal('NoError');
		Math.abs(cup.intersect(lid).volume()).should.be.below(1e-6);
		cup.intersect(manifold(a.bowl.result.mesh).translate(a.bowlOffset)).volume().should.be.below(1e-6);
		cup.translate([0, 0, -1]).intersect(lid).volume().should.be.above(100);
		cup.translate([1, 0, 0]).intersect(lid).volume().should.be.above(1);
	});
});

describe("verb.solid.BrepBoolean with surfaces of revolution", function(){
	this.timeout(60000);
	it('a perfectly round mug (both seams crossing a branch at one point) is watertight', function(){
		var m = lib.BooleanObjectsRecipe.mug({ height : 170, radius : [58, 76], linearRadius : true, belly : 0, lean : [0, 0], harmonics : [],
			divsU : 24, divsV : 96, offsetTolerance : 0.08 });
		m.result.report.manifold.closedManifold.should.be.true();
		m.result.report.manifold.genus.should.be.equal(1);
	});
});
