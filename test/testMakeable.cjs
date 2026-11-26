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

	// a frustum: a square base `b` wide, a top `t` wide, `h` high
	function frustum(b, t, h) {
		var m = new lib.TriMesh(), o = (b - t) / 2;
		var v = [[0,0,0],[b,0,0],[b,b,0],[0,b,0],[o,o,h],[o+t,o,h],[o+t,o+t,h],[o,o+t,h]].map(function(p){ return m.addVertex(p); });
		[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]].forEach(function(q){ m.addQuad(v[q[0]], v[q[1]], v[q[2]], v[q[3]]); });
		return m;
	}

	it('finds the build direction that needs no supports, and says when every direction needs them', function(){
		// a T: a wide cap on a narrow stem. Cap up, its underside overhangs; built upside down, nothing does
		var BrepSolid = lib.BrepSolid, BrepBoolean = lib.BrepBoolean;
		var T = BrepBoolean.evaluate([BrepSolid.box([0, 0, 20], [40, 40, 26], 4), BrepSolid.box([15, 15, 0], [25, 25, 21], 4)], function(x){ return x[0] || x[1]; });
		T.report.manifold.closedManifold.should.be.true();
		var o = Makeable.orient(T.mesh, 45);
		o.up.should.eql([0, 0, -1]);
		o.overhang.should.be.equal(0);
		// with z up, the cap's underside (40 x 40 less the stem's 10 x 10) overhangs
		var f = Makeable.check(T.mesh, 'fdm');
		f.makeable.should.be.true();
		f.notes[0].should.match(/without supports with -z up/);
		// a ball overhangs whichever way up it is built: about a sixth of a sphere faces down past 45 degrees
		var ball = lib.Implicit.mesh(lib.Implicit.ball([0, 0, 0], 10), [-11, -11, -11], [11, 11, 11], 0.5);
		var b = Makeable.orient(ball, 45);
		b.overhang.should.be.within(0.13, 0.16);
		Makeable.check(ball, 'fdm').notes[0].should.match(/Needs supports: 1[45]\.\d% of the surface overhangs past 45/);
	});

	it('checks that a cast comes out of its mould: draft along the pull, and no undercuts', function(){
		// a frustum tapered by 5 degrees comes out; a box sticks (its sides have no draft)
		var h = 20, t = 30 - 2 * h * Math.tan(5 * Math.PI / 180);
		var good = Makeable.check(frustum(30, t, h), 'ceramic');
		good.release.pull.should.eql([0, 0, 1]);
		good.release.lowDraft.should.be.equal(0);
		good.release.undercut.should.be.equal(0);
		good.issues.join(' ').should.not.match(/draft|undercut/);
		var box30 = Makeable.check(box(30, 30, 30), 'ceramic');
		box30.release.lowDraft.should.be.approximately(4 / 6, 1e-9);
		box30.makeable.should.be.false();
		box30.issues.join(' ').should.match(/less than 1° of draft/);
		// a hole across a tapered block: undercut for the pull that the taper suits, without draft along the hole
		var I = lib.Implicit, k = Math.tan(5 * Math.PI / 180);
		var block = I.of(function(p){
			var side = Math.max(Math.abs(p[0] - 20), Math.abs(p[1] - 20)) - (20 - k * p[2]);
			return Math.max(side * Math.cos(5 * Math.PI / 180), -p[2], p[2] - 30);
		});
		var holed = I.mesh(I.difference(block, I.capsule([-10, 20, 15], [50, 20, 15], 5)), [-1, -1, -1], [41, 41, 31], 0.5);
		holed.checkClosedManifold().closedManifold.should.be.true();
		var r = Makeable.release(holed, 1);
		(r.lowDraft + r.undercut).should.be.above(0.05);
		var c = Makeable.check(holed, 'ceramic');
		c.makeable.should.be.false();
		c.issues.join(' ').should.match(/undercut|draft/);
	});

});
