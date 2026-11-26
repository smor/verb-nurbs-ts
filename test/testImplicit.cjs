var should = require('should');

var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Implicit = lib.Implicit, MeshBVH = lib.MeshBVH, BrepSolid = lib.BrepSolid, BrepBoolean = lib.BrepBoolean, Model = lib.Model;

var wasm;
before(async function(){
	var Module = (await import('manifold-3d')).default;
	wasm = await Module();
	wasm.setup();
});
function manifold(mesh) { return new wasm.Manifold(new wasm.Mesh(mesh.toManifoldMesh())); }

// a deterministic sequence in [0, 1)
function random(seed) { var s = seed; return function(){ s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

// a 40 x 28 x 20 box with every edge rounded (radius 4): a smooth closed mesh to fill
function roundedBox() {
	var b = BrepSolid.box([0, 0, 0], [40, 28, 20], 12);
	return BrepBoolean.evaluate([b], function(f){ return f[0]; }, { edges : lib.BrepEdges.all(b).map(function(e){ return { solid : 0, faces : e.faces, radius : 4 }; }) });
}

describe("verb.solid.Implicit", function(){

	it("meshes a field's zero set as a closed manifold, its vertices on the surface", function(){
		var m = Implicit.mesh(Implicit.ball([1, 2, 3], 5), [-5, -4, -3], [7, 8, 9], 0.5);
		var r = m.checkClosedManifold();
		r.closedManifold.should.be.true();
		r.genus.should.be.equal(0);
		m.components().should.be.equal(1);
		manifold(m).status().should.be.equal('NoError');
		// the roots are on the sphere; the volume is short of the ball's by the chords' cut (outward faces: positive)
		var worst = 0;
		m.vertices.forEach(function(p){ worst = Math.max(worst, Math.abs(Math.hypot(p[0] - 1, p[1] - 2, p[2] - 3) - 5)); });
		worst.should.be.below(1e-4);
		var V = 4 / 3 * Math.PI * 125;
		m.signedVolume().should.be.within(0.99 * V, V);
	});

	it("smooth and sharp CSG of fields: a smooth union fills the joint, a difference removes the volume", function(){
		var a = Implicit.box([0, 0, 0], [10, 10, 10]), b = Implicit.ball([10, 5, 5], 4);
		var sharp = Implicit.mesh(Implicit.union([a, b]), [-1, -1, -1], [15, 11, 11], 0.25);
		var smooth = Implicit.mesh(Implicit.union([a, b], 2), [-1, -1, -1], [15, 11, 11], 0.25);
		var cut = Implicit.mesh(Implicit.difference(a, b), [-1, -1, -1], [15, 11, 11], 0.25);
		[sharp, smooth, cut].forEach(function(m){ m.checkClosedManifold().closedManifold.should.be.true(); });
		// half the ball is in the box
		var ball = 4 / 3 * Math.PI * 64;
		sharp.signedVolume().should.be.approximately(1000 + ball / 2, 6);
		cut.signedVolume().should.be.approximately(1000 - ball / 2, 6);
		smooth.signedVolume().should.be.above(sharp.signedVolume() + 1);
	});

	it("strut lattices: one handle per independent loop of struts (genus E - V + 1 of the strut graph)", function(){
		this.timeout(budget(30000));
		// 2 x 2 x 2 cells of 10 in a 20 cube, the struts cut by the cube's faces. BCC: 27 corners and 8 centres joined
		// by 64 half diagonals; cubic: 27 nodes and 54 edges; octet: also the 36 face centres where the face diagonals
		// cross, 54 edges plus 144 half diagonals
		[['bcc', 64 - 35 + 1], ['cubic', 54 - 27 + 1], ['octet', 198 - 63 + 1]].forEach(function(x){
			var m = Implicit.mesh(Implicit.intersection([Implicit.box([0, 0, 0], [20, 20, 20]), Implicit.lattice(x[0], 10, 1.5)]), [-1, -1, -1], [21, 21, 21], 0.4);
			var r = m.checkClosedManifold();
			r.closedManifold.should.be.true();
			m.components().should.be.equal(1);
			r.genus.should.be.equal(x[1]);
		});
	});

	it("TPMS sheets are as thick as asked: measured across the sheet along its normal", function(){
		this.timeout(budget(30000));
		var w = 1.5;
		['gyroid', 'schwarz-p', 'diamond'].forEach(function(pat){
			var lat = Implicit.lattice(pat, 10, w);
			var m = Implicit.mesh(Implicit.intersection([Implicit.box([0, 0, 0], [20, 20, 20]), lat]), [-1, -1, -1], [21, 21, 21], 0.3);
			m.checkClosedManifold().closedManifold.should.be.true();
			var bvh = new MeshBVH(m), d = [];
			m.vertices.forEach(function(p, i){
				if (i % 7 || p.some(function(x){ return x < 4 || x > 16; })) return;
				// into the sheet, along the field's gradient, to the far side
				var h = 1e-4, g = [0, 1, 2].map(function(k){ var a = p.slice(), b = p.slice(); a[k] += h; b[k] -= h; return (lat.value(a) - lat.value(b)) / (2 * h); });
				var l = Math.hypot(g[0], g[1], g[2]); g = g.map(function(x){ return -x / l; });
				var t = bvh.raycast(p.map(function(x, k){ return x + 1e-4 * g[k]; }), g);
				if (isFinite(t)) d.push(t);
			});
			d.sort(function(a, b){ return a - b; });
			d.length.should.be.above(1000);
			// the median within 2%, and nine in ten no thinner than 3% under (the mesh's chords cut into the sheet)
			d[d.length >> 1].should.be.within(0.98 * w, 1.02 * w);
			d[Math.floor(0.1 * d.length)].should.be.above(0.97 * w);
		});
	});

	it("the signed distance to a closed mesh: its sign agrees with ray parity, its size with the nearest point", function(){
		var res = roundedBox();
		var s = Implicit.meshDistance(res.mesh, 3), bvh = new MeshBVH(res.mesh), rnd = random(7);
		for (var i = 0; i < 2000; i++) {
			var p = [rnd() * 48 - 4, rnd() * 36 - 4, rnd() * 28 - 4];
			var v = s.value(p);
			(v < 0).should.be.equal(bvh.contains(p));
			// the box's flat middles: the distance to the nearest plane
			if (p[0] > 6 && p[0] < 34 && p[1] > 6 && p[1] < 22 && (p[2] < 2 || p[2] > 18)) Math.abs(v).should.be.approximately(Math.min(3, Math.min(Math.abs(p[2]), Math.abs(p[2] - 20))), 1e-9);
		}
	});

	it("fills a solid with a gyroid inside a skin: one closed body, the skin solid, nothing outside", function(){
		this.timeout(budget(60000));
		var res = roundedBox(), skin = 1.6;
		var m = Implicit.infill(res.mesh, { pattern : 'gyroid', cell : 10, wall : 1.2, skin : skin, blend : 1, size : 0.6 });
		var r = m.checkClosedManifold();
		r.closedManifold.should.be.true();
		// one body, and the gyroid's two labyrinths sealed in by the skin: two voids
		var pieces = m.pieces();
		pieces.filter(function(p){ return p.volume > 0; }).length.should.be.equal(1);
		pieces.filter(function(p){ return p.volume < 0; }).length.should.be.equal(2);
		r.genus.should.be.above(20);
		manifold(m).status().should.be.equal('NoError');
		var v = m.signedVolume();
		v.should.be.within(0.3 * res.report.volume, 0.8 * res.report.volume);
		// points of the skin (well within it) are in the infill; points outside the solid are not
		var s = Implicit.meshDistance(res.mesh, 4), bvh = new MeshBVH(m), rnd = random(11), n = 0;
		for (var i = 0; i < 3000; i++) {
			var p = [rnd() * 44 - 2, rnd() * 32 - 2, rnd() * 24 - 2], d = s.value(p);
			if (d < -0.2 && d > -skin + 0.2) { bvh.contains(p).should.be.true(); n++; }
			if (d > 0.2) bvh.contains(p).should.be.false();
		}
		n.should.be.above(100);
	});

	it("opens the skin on chosen faces: the lattice runs out to them, and no void is sealed", function(){
		this.timeout(budget(60000));
		var res = roundedBox();
		// the top face's triangles
		var open = res.mesh.triangles.map(function(t){ return t.every(function(v){ return res.mesh.vertices[v][2] > 20 - 1e-9; }); });
		var m = Implicit.infill(res.mesh, { pattern : 'gyroid', cell : 10, wall : 1.2, skin : 1.6, blend : 1, size : 0.6, open : open });
		m.checkClosedManifold().closedManifold.should.be.true();
		var pieces = m.pieces();
		pieces.length.should.be.equal(1);
		pieces[0].volume.should.be.above(0);
		// on the open face the gyroid shows: the top is part solid, part hole
		var top = 0, area = 0;
		m.triangles.forEach(function(t){
			var a = m.vertices[t[0]], b = m.vertices[t[1]], c = m.vertices[t[2]];
			if (a[2] < 19.99 || b[2] < 19.99 || c[2] < 19.99 || a[0] < 6 || a[0] > 34 || a[1] < 6 || a[1] > 22) return;
			area += 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
		});
		area.should.be.within(0.1 * 28 * 16, 0.6 * 28 * 16);
		// a resin printer would trap resin in the sealed version, not in this one
		lib.Makeable.check(m, 'sla', 500).voids.should.be.equal(0);
	});
});

describe("verb.model.Model lattices", function(){

	function doc(lattice) {
		return { version : 1, parameters : { w : 1.5 }, features : {
			body : { type : 'box', min : [0, 0, 0], max : [40, 28, 20] },
			r : { type : 'round', of : 'body', rules : [{ edges : '*', radius : 4 }] },
			lat : Object.assign({ type : 'lattice', of : 'r', pattern : 'gyroid', cell : 10, wall : 'w', skin : 1.6, blend : 1, size : 0.7, open : ['body.+z'] }, lattice) },
			output : 'lat', machine : 'sla' };
	}

	it("a lattice output: the rounded solid filled, judged on its mesh, and rebuilt only when its own values change", function(){
		this.timeout(budget(90000));
		var model = new Model();
		var r = model.evaluate(doc({}));
		r.lattice.mesh.checkClosedManifold().closedManifold.should.be.true();
		r.lattice.fraction.should.be.within(0.3, 0.8);
		r.verdict.kind.should.be.equal('buildable');
		r.verdict.checks.map(function(c){ return c.name; }).should.eql(['closed', 'outward', 'resolution', 'one piece', 'drains', 'lattice wall', 'makeable']);
		r.lattice.bodies.should.be.equal(1);
		r.lattice.voids.should.be.equal(0);
		r.faceNames.length.should.be.above(6);
		// a thicker, graded wall keeps more; the rounded box is not built again
		var g = model.evaluate(doc({ grade : { axis : 'z', to : 2.4 } }));
		g.features.r.built.should.be.false();
		g.features.lat.built.should.be.true();
		g.lattice.wall.should.eql([1.5, 2.4]);
		g.lattice.volume.should.be.above(r.lattice.volume);
		// walls thinner than the machine holds: visual
		var thin = model.evaluate(doc({ wall : 0.3 }));
		thin.verdict.kind.should.be.equal('visual');
		thin.verdict.reasons.join(' ').should.match(/lattice's walls are 0.3/);
		thin.verdict.reasons.join(' ').should.match(/too coarse for walls of 0.3/);
		// a closed skin seals the gyroid's labyrinths in: fine on a filament printer, not on a resin one
		var sealed = model.evaluate(doc({ open : [] }));
		sealed.lattice.voids.should.be.equal(2);
		sealed.verdict.kind.should.be.equal('visual');
		sealed.verdict.reasons.join(' ').should.match(/2 sealed void\(s\).*trapped/);
		var d = doc({ open : [] }); d.machine = 'fdm';
		model.evaluate(d).verdict.checks.filter(function(c){ return c.name == 'drains'; })[0].passed.should.be.true();
	});

	it("refuses lattices it cannot build, with the reason", function(){
		var model = new Model();
		(function(){ model.evaluate(doc({ pattern : 'kelvin' })); }).should.throw(/unknown pattern "kelvin"/);
		(function(){ model.evaluate(doc({ wall : 12 })); }).should.throw(/0 < wall < cell/);
		(function(){ model.evaluate(doc({ grade : { axis : 'w', to : 2 } })); }).should.throw(/grades along x, y or z/);
		(function(){ model.evaluate(doc({ open : ['lid.*'] })); }).should.throw(/opens "lid.\*", which names no face/);
		var d = doc({});
		d.features.u = { type : 'union', of : ['lat'] };
		d.output = 'u';
		(function(){ model.evaluate(d); }).should.throw(/the lattice "lat" can only be the last feature/);
	});
});
