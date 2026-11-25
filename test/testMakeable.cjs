var should = require('should');

var lib = require('../dist/index.js');
var Makeable = lib.Makeable, MeshBVH = lib.MeshBVH, Shell = lib.Shell, SweptObjectsRecipe = lib.SweptObjectsRecipe, FreeformVesselRecipe = lib.FreeformVesselRecipe;
var Sweep = lib.Sweep, Make = lib.default.eval.Make;

function box(w, d, h) {
	var m = new lib.TriMesh();
	var v = [[0,0,0],[w,0,0],[w,d,0],[0,d,0],[0,0,h],[w,0,h],[w,d,h],[0,d,h]].map(function(p){ return m.addVertex(p); });
	[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]].forEach(function(q){ m.addQuad(v[q[0]], v[q[1]], v[q[2]], v[q[3]]); });
	return m;
}

describe("verb.solid.MeshBVH", function(){
	it('finds the nearest hit and counts crossings like the brute-force test', function(){
		var pipe = Shell.tube(Sweep.pipe(Make.rationalBezierCurve([[0,0,0],[40,0,0]]), 5).surface, false, { divsU : 20, divsV : 32 });
		var bvh = new MeshBVH(pipe);
		bvh.raycast([20.3, 0.2, 20], [0, 0, -1]).should.be.approximately(15, 0.05);
		bvh.raycast([20.3, 0, 0.2], [0, 1, 0]).should.be.approximately(5, 0.05);
		bvh.raycast([20, 0, 20], [0, 0, 1]).should.be.equal(Infinity);
		for (var k = 0; k < 50; k++) {
			var p = [Math.random() * 50 - 5, Math.random() * 14 - 7, Math.random() * 14 - 7];
			bvh.contains(p).should.be.equal(pipe.containsPoint(p));
		}
	});
});

describe("verb.solid.Makeable", function(){
	it('measures the wall of a 2 mm plate', function(){
		var r = Makeable.check(box(40, 30, 2), 'fdm');
		r.makeable.should.be.true();
		r.wall.median.should.be.approximately(2, 1e-6);
		r.size.should.eql([40, 30, 2]);
	});

	it('flags walls thinner than the machine holds, and parts too big for it', function(){
		var r = Makeable.check(box(40, 30, 0.4), 'fdm');
		r.makeable.should.be.false();
		r.wall.p01.should.be.approximately(0.4, 1e-6);
		r.issues.length.should.be.equal(1);
		r.thinSpots.length.should.be.greaterThan(0);
		var big = Makeable.check(box(400, 30, 5), 'fdm');
		big.fits.should.be.false();
		big.makeable.should.be.false();
	});

	it('rejects open sheets and inside-out meshes', function(){
		var sheet = SweptObjectsRecipe.ribbonKnot({ thickness : 0, divsU : 200 });
		sheet.report.manifold.closedManifold.should.be.false();
		Makeable.check(sheet.mesh).makeable.should.be.false();
		var b = box(10, 10, 10); b.flip();
		Makeable.check(b).issues[0].should.match(/inward/);
	});

	it('passes the ribbon knot with thickness, and fails it for ceramics', function(){
		var o = SweptObjectsRecipe.ribbonKnot({ thickness : 1.6, divsU : 300, divsV : 32 });
		o.report.manifold.genus.should.be.equal(1);
		var fdm = Makeable.check(o.mesh, 'fdm');
		fdm.makeable.should.be.true();
		fdm.wall.median.should.be.approximately(1.6, 0.1);
		Makeable.check(o.mesh, 'ceramic').makeable.should.be.false();
	});

	it('measures the vessel wall at its thickness', function(){
		var v = FreeformVesselRecipe.build({ wallThickness : 2.5, divsU : 32, divsV : 128 });
		Makeable.check(v.mesh, 'sla').wall.median.should.be.approximately(2.5, 0.1);
	});
});
