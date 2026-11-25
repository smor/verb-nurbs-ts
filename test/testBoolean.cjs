var should = require('should');

var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
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

describe("verb.solid.BrepBoolean fillets across a seam", function(){
	// a contact curve on the bore's tube ends a rounding error off its seam (v = 1e-15 instead of 0): that end must
	// still close the cut, or a sliver triangle bridges it and the tube merges with the fillet's strip and is dropped
	[2.5, 3, 4, 4.5].forEach(function(radius){
		it('keeps the bore of radius ' + radius + ' when its rims are rounded', function(){
			var box = BrepSolid.box([0,0,0],[40,28,20], 12);
			var bore = BrepSolid.cappedTube(Sweep.pipe(line([8,14,-5],[8,14,25]), radius).surface, [24, 96]);
			var r = BrepBoolean.difference(box, [bore], {fillet: 1});
			r.report.manifold.closedManifold.should.be.true();
			r.faces.map(function(f){ return f.name; }).filter(function(n){ return n == 'tube'; }).length.should.be.equal(1);
		});
	});
});

describe("verb.solid.BrepBoolean across face edges", function(){
	// the thin rod crosses the end of the thick one, so every intersection branch runs from the thick rod's wall
	// onto its end cap
	var a = BrepSolid.cappedTube(Sweep.pipe(line([-30,0,0],[30,0,0]), 10).surface, [24, 64]);
	var b = BrepSolid.cappedTube(Sweep.pipe(line([28,-30,1],[28,30,1]), 6).surface, [24, 64]);
	var ma = a.tessellate(), mb = b.tessellate();
	var cases = {
		union : [function(){ return BrepBoolean.union([a, b]); }, function(x, y){ return x.add(y); }],
		intersection : [function(){ return BrepBoolean.intersection([a, b]); }, function(x, y){ return x.intersect(y); }],
		difference : [function(){ return BrepBoolean.difference(a, [b]); }, function(x, y){ return x.subtract(y); }],
	};
	Object.keys(cases).forEach(function(name){
		it(name + ' is watertight when branches cross the edge between wall and cap', function(){
			var r = cases[name][0]();
			r.report.manifold.closedManifold.should.be.true();
			r.curves.filter(function(e){ return !e.curve.closed; }).length.should.be.equal(4);
			// branches that meet at the edge share their end point exactly
			var ends = [];
			r.curves.forEach(function(e){ ends.push(e.curve.points[0], e.curve.points[e.curve.points.length - 1]); });
			ends.forEach(function(p){ ends.filter(function(q){ return q === p; }).length.should.be.equal(2); });
			var m = manifold(r.mesh);
			m.status().should.be.equal('NoError');
			var ref = cases[name][1](manifold(ma), manifold(mb));
			m.volume().should.be.approximately(ref.volume(), ref.volume() * 2e-3);
		});
	});
});

describe("verb.recipes.BooleanObjectsRecipe", function(){
	this.timeout(budget(60000));

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

	it('rim notches: three faces meet at triple points, and the result is still watertight', function(){
		var o = lib.BooleanObjectsRecipe.pierced({ holes : 0, notches : 3, divsU : 48, divsV : 192 });
		o.result.report.manifold.closedManifold.should.be.true();
		o.result.report.manifold.genus.should.be.equal(0);
		var m = manifold(o.result.mesh);
		m.status().should.be.equal('NoError');
		var tess = [o.body, o.cavity].concat(o.tools).map(function(s){ return manifold(s.tessellate()); });
		var ref = tess.slice(1).reduce(function(x, y){ return x.subtract(y); }, tess[0]);
		m.volume().should.be.approximately(ref.volume(), ref.volume() * 1e-3);
	});

	it('rim notches at a coarse resolution: a triple point on a coarse branch still joins it (watertight)', function(){
		[0.5, 0.45].forEach(function(phase){
			var o = lib.BooleanObjectsRecipe.pierced({ holes : 0, notches : 3, notchPhase : phase, divsU : 24, divsV : 96, offsetTolerance : 0.08 });
			o.result.report.manifold.closedManifold.should.be.true();
			o.result.report.manifold.genus.should.be.equal(0);
		});
		var f = lib.BooleanObjectsRecipe.pierced({ notches : 9, fillet : 0.8, divsU : 24, divsV : 96, offsetTolerance : 0.08 });
		f.result.report.manifold.closedManifold.should.be.true();
		// 18 holes (two closed edges each) and 9 notches (four edges each, meeting at mitred corners)
		f.result.report.fillets.should.be.equal(72);
		f.result.report.filletsSkipped.should.be.equal(0);
	});

	it('rounds the edges of rim notches through their corners, mitred where two fillets meet a sharp edge', function(){
		var base = { holes : 0, rows : 0, notches : 3, divsU : 24, divsV : 96, offsetTolerance : 0.08 };
		var sharp = lib.BooleanObjectsRecipe.pierced(base).result;
		[0.5, 1, 1.2].forEach(function(r){
			var o = lib.BooleanObjectsRecipe.pierced(Object.assign({ fillet : r }, base));
			var rep = o.result.report;
			rep.manifold.closedManifold.should.be.true();
			rep.manifold.genus.should.be.equal(0);
			rep.fillets.should.be.equal(12);
			rep.filletsSkipped.should.be.equal(0);
			// rounding convex edges takes material away: about r^2 (1 - pi/4) per unit of edge length
			var lost = sharp.report.volume - rep.volume;
			lost.should.be.above(0);
			lost.should.be.below(12 * 30 * r * r * (1 - Math.PI / 4));
			var m = manifold(o.result.mesh);
			m.status().should.be.equal('NoError');
			// open blends are trimmed: no fillet face reaches beyond its notch
			o.result.fillets.forEach(function(f){ f.blend.closed.should.be.false(); });
		});
	});

	it('rounds the rim too: where three fillets of one radius meet, a ball corner (a spherical triangle) joins them', function(){
		var o = lib.BooleanObjectsRecipe.pierced({ holes : 0, rows : 0, notches : 3, fillet : 1, rimFillet : 1, divsU : 24, divsV : 96, offsetTolerance : 0.08 });
		var rep = o.result.report;
		rep.manifold.closedManifold.should.be.true();
		rep.manifold.genus.should.be.equal(0);
		// 12 notch edges and the rim's 3 runs between the notches; every notch has two inner corners
		rep.fillets.should.be.equal(15);
		rep.filletsFailed.should.be.equal(0);
		rep.filletsSkipped.should.be.equal(0);
		var corners = o.result.faces.map(function(f, i){ return f.name == 'fillet corner' ? i : -1; }).filter(function(i){ return i >= 0; });
		corners.length.should.be.equal(6);
		// each corner lies on its ball, which touches all three faces: every vertex at the radius from its centre
		o.result.corners.length.should.be.equal(6);
		o.result.corners.forEach(function(c){
			c.kind.should.be.equal('ball');
			c.radius.should.be.approximately(1, 1e-9);
			var n = 0;
			o.result.mesh.triangles.forEach(function(t, k){
				if (o.result.faceOf[k] != c.face) return;
				n++;
				t.forEach(function(v){ lib.Vec.dist(o.result.mesh.vertices[v], c.centre).should.be.approximately(1, 1e-6); });
			});
			n.should.be.above(3);
		});
		manifold(o.result.mesh).status().should.be.equal('NoError');
	});

	it('where three fillets of different radii meet, a setback vertex blend joins them smoothly', function(){
		[[1, 0.6], [0.5, 1]].forEach(function(r){
			var o = lib.BooleanObjectsRecipe.pierced({ holes : 0, rows : 0, notches : 3, fillet : r[0], rimFillet : r[1], divsU : 24, divsV : 96, offsetTolerance : 0.08 });
			var R = o.result, rep = R.report;
			rep.manifold.closedManifold.should.be.true();
			rep.manifold.genus.should.be.equal(0);
			rep.fillets.should.be.equal(15);
			rep.filletsSkipped.should.be.equal(0);
			R.corners.length.should.be.equal(6);
			R.corners.forEach(function(c){ c.kind.should.be.equal('setback'); c.radius.should.be.approximately(Math.max(r[0], r[1]), 1e-6); });
			// the corner patches meet the blends and the faces without a crease: the angle between the normals of
			// triangles across a patch's boundary is no more than across the blends' own triangles
			var V = R.mesh.vertices;
			var nrm = function(t){ return lib.Vec.normalized(lib.Vec.cross(lib.Vec.sub(V[t[1]], V[t[0]]), lib.Vec.sub(V[t[2]], V[t[0]]))); };
			var edges = new Map();
			R.mesh.triangles.forEach(function(t, k){ for (var i = 0; i < 3; i++) {
				var key = Math.min(t[i], t[(i + 1) % 3]) + ',' + Math.max(t[i], t[(i + 1) % 3]);
				if (!edges.has(key)) edges.set(key, []); edges.get(key).push(k); } });
			var name = function(k){ return R.faces[R.faceOf[k]].name; };
			var across = 0, blend = 0;
			edges.forEach(function(l){
				var a = name(l[0]), b = name(l[1]);
				var ang = Math.acos(Math.max(-1, Math.min(1, lib.Vec.dot(nrm(R.mesh.triangles[l[0]]), nrm(R.mesh.triangles[l[1]]))))) * 180 / Math.PI;
				if ((a == 'fillet corner') != (b == 'fillet corner')) across = Math.max(across, ang);
				if (a == 'fillet' && b == 'fillet') blend = Math.max(blend, ang);
			});
			across.should.be.below(Math.max(blend, 20));
			manifold(R.mesh).status().should.be.equal('NoError');
		});
	});

	it('curvature-continuous fillets go round the same corners, with curvature-continuous (setback) corners', function(){
		var o = lib.BooleanObjectsRecipe.pierced({ holes : 0, rows : 0, notches : 3, fillet : 1, rimFillet : 1, filletShape : 'curvature', divsU : 24, divsV : 96, offsetTolerance : 0.08 });
		var rep = o.result.report;
		rep.manifold.closedManifold.should.be.true();
		rep.manifold.genus.should.be.equal(0);
		rep.fillets.should.be.equal(15);
		rep.filletsSkipped.should.be.equal(0);
		o.result.corners.length.should.be.equal(6);
		o.result.corners.forEach(function(c){ c.kind.should.be.equal('setback'); });
		manifold(o.result.mesh).status().should.be.equal('NoError');
	});

	it('chamfers the same edges: straight sections, flat corners where equal chamfers meet, facets where unequal ones do', function(){
		var round = lib.BooleanObjectsRecipe.pierced({ holes : 0, rows : 0, notches : 3, fillet : 1, rimFillet : 1, divsU : 24, divsV : 96, offsetTolerance : 0.08 });
		var o = lib.BooleanObjectsRecipe.pierced({ holes : 0, rows : 0, notches : 3, fillet : 1, rimFillet : 1, filletShape : 'chamfer', divsU : 24, divsV : 96, offsetTolerance : 0.08 });
		var R = o.result;
		R.report.manifold.closedManifold.should.be.true();
		R.report.fillets.should.be.equal(15);
		R.report.filletsSkipped.should.be.equal(0);
		// the edges are convex: a chamfer cuts off more than a round of the same contacts
		R.report.volume.should.be.below(round.result.report.volume);
		R.corners.length.should.be.equal(6);
		R.corners.forEach(function(c){
			c.kind.should.be.equal('ball');
			// a flat triangle: every vertex on the plane of the first triangle
			var tri = R.mesh.triangles.filter(function(t, k){ return R.faceOf[k] == c.face; });
			var V = R.mesh.vertices, t0 = tri[0];
			var n = lib.Vec.normalized(lib.Vec.cross(lib.Vec.sub(V[t0[1]], V[t0[0]]), lib.Vec.sub(V[t0[2]], V[t0[0]])));
			tri.forEach(function(t){ t.forEach(function(v){ Math.abs(lib.Vec.dot(lib.Vec.sub(V[v], V[t0[0]]), n)).should.be.below(1e-6); }); });
		});
		manifold(R.mesh).status().should.be.equal('NoError');
		var u = lib.BooleanObjectsRecipe.pierced({ holes : 0, rows : 0, notches : 3, fillet : 1, rimFillet : 0.6, filletShape : 'chamfer', divsU : 24, divsV : 96, offsetTolerance : 0.08 });
		u.result.report.manifold.closedManifold.should.be.true();
		u.result.report.filletsSkipped.should.be.equal(0);
		u.result.corners.map(function(c){ return c.kind; }).should.be.eql(['setback', 'setback', 'setback', 'setback', 'setback', 'setback']);
		manifold(u.result.mesh).status().should.be.equal('NoError');
	});

	it('leaves a notch sharp when its fillets would swallow the rim (radius near half the wall)', function(){
		var o = lib.BooleanObjectsRecipe.pierced({ holes : 0, rows : 0, notches : 3, fillet : 1.5, divsU : 24, divsV : 96, offsetTolerance : 0.08 });
		o.result.report.manifold.closedManifold.should.be.true();
		o.result.report.filletsSkipped.should.be.equal(12);
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
