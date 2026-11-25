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

	it('base: block - slab - seat + arch, all four new edges filleted, a genus 1 solid', function(){
		var r = a.base.report;
		r.intersectionCurves.should.be.equal(4);
		r.fillets.should.be.equal(4);
		r.manifold.closedManifold.should.be.true();
		r.manifold.genus.should.be.equal(1);
		var m = manifold(a.base.mesh);
		m.status().should.be.equal('NoError');
		m.genus().should.be.equal(1);
	});

	it('bowl: a cone with a filleted handle, a genus 1 solid', function(){
		var r = a.bowl.result.report;
		r.fillets.should.be.equal(2);
		r.manifold.closedManifold.should.be.true();
		r.manifold.genus.should.be.equal(1);
		manifold(a.bowl.result.mesh).status().should.be.equal('NoError');
	});

	it('the bowl sits in its seat without touching, and the seat holds it (sinking it collides)', function(){
		var base = manifold(a.base.mesh), bowl = manifold(a.bowl.result.mesh).translate(a.bowlOffset);
		base.intersect(bowl).volume().should.be.below(1e-6);
		base.intersect(bowl.translate([0, 0, -1])).volume().should.be.above(100);
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
