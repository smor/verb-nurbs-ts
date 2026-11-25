var should = require('should');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');

function layer(v, name) { return v.layers.find(function(l){ return l.name == name; }); }
function fact(facts, name) { return facts.find(function(f){ return f[0] == name; })[1]; }

describe("verb.view.Inspect", function(){
	this.timeout(budget(60000));

	it('a circle: rational, its curvature comb a ring of teeth of one length, all pointing outward', function(){
		var v = lib.Inspect.curve(lib.Make.arc([0,0,0],[1,0,0],[0,1,0],10,0,2*Math.PI), 'circle', { samples : 64 });
		v.kind.should.be.equal('curve');
		fact(v.facts, 'Type').should.match(/^Rational/);
		fact(v.facts, 'Closed').should.be.equal('yes');
		fact(v.facts, 'Largest curvature').should.be.equal('0.1 (radius 10)');
		layer(v, 'Control points').positions.length.should.be.equal(27);
		layer(v, 'Control points').fields.weight.values.filter(function(w){ return Math.abs(w - Math.SQRT1_2) < 1e-12; }).length.should.be.equal(4);
		// every comb tooth points to the centre, and they all have the same length
		var c = layer(v, 'Curvature comb'), p = c.positions, len = [];
		for (var k = 0; k <= 64; k++) {
			var seg = k == 0 ? 0 : 2 * k - 1; // a tooth, then the line joining its tip to the previous one
			var a = c.indices[2 * seg], b = c.indices[2 * seg + 1];
			len.push(Math.hypot(p[3*a] - p[3*b], p[3*a+1] - p[3*b+1], p[3*a+2] - p[3*b+2]));
			Math.hypot(p[3*b], p[3*b+1]).should.be.above(10);
		}
		(Math.max.apply(null, len) - Math.min.apply(null, len)).should.be.below(1e-9);
	});

	it('a sphere: Gaussian curvature 1/r² and mean curvature ±1/r everywhere, two poles found', function(){
		var v = lib.Inspect.surface(lib.Make.sphericalSurface([0,0,0],[0,0,1],[1,0,0],10), 'sphere', { samples : 24 });
		var f = layer(v, 'Surface').fields;
		f['Gaussian curvature'].values.forEach(function(k){ k.should.be.approximately(0.01, 1e-9); });
		f['mean curvature'].values.forEach(function(h){ Math.abs(h).should.be.approximately(0.1, 1e-9); });
		layer(v, 'Poles').positions.length.should.be.equal(6);
		layer(v, 'Control net').indices.length.should.be.above(0);
	});

	it('a saddle: negative Gaussian curvature', function(){
		var cps = [];
		for (var i = 0; i < 3; i++) { cps.push([]); for (var j = 0; j < 3; j++) { var x = (i-1)*50, y = (j-1)*50; cps[i].push([x, y, (x*x - y*y)/50, 1]); } }
		var v = lib.Inspect.surface(new lib.NurbsSurfaceData(2, 2, [0,0,0,1,1,1], [0,0,0,1,1,1], cps), 'saddle', { samples : 8 });
		layer(v, 'Surface').fields['Gaussian curvature'].values.forEach(function(k){ k.should.be.below(0); });
	});

	it('a B-rep: one item per trimmed face, each triangle tagged with its face, trims, natural edges, seams and fillet rails', function(){
		var m = lib.BooleanObjectsRecipe.mug({ fillet : 2, divsU : 24, divsV : 96, offsetTolerance : 0.08 });
		var r = m.result;
		r.faceOf.length.should.be.equal(r.mesh.triangles.length);
		var v = lib.Inspect.brep(r, 'mug');
		v.items.length.should.be.equal(r.faces.length);
		v.items.filter(function(it){ return it.type == 'Fillet face'; }).length.should.be.equal(2);
		['Trim edges', 'Natural edges', 'Seams', 'Fillets'].forEach(function(n){ layer(v, n).indices.length.should.be.above(0); });
		var faces = layer(v, 'Faces');
		faces.pick.length.should.be.equal(faces.indices.length / 3);
		faces.pick.forEach(function(i){ i.should.be.within(0, v.items.length - 1); });
		v.items[0].overlay.map(function(l){ return l.name; }).should.containEql('Control net');
		// the wall's top and bottom circles are natural edges; its seam is drawn once
		var wall = v.items.find(function(it){ return it.label == 'wall'; });
		fact(wall.facts, 'Edge length').should.match(/natural/);
	});

	it('a plain solid is shown as the Boolean of itself: a capped tube has a seam and no trims', function(){
		var rail = lib.Make.rationalInterpCurve([[0,0,0],[30,10,40],[0,40,80]], 2);
		var v = lib.Inspect.brep(lib.BrepSolid.cappedTube(lib.Sweep.pipe(rail, 8).surface, [24, 32]));
		v.items.length.should.be.equal(3);
		layer(v, 'Seams').indices.length.should.be.above(0);
		layer(v, 'Trim edges').indices.length.should.be.equal(0);
		fact(v.facts, 'Watertight').should.be.equal('yes');
	});

	it('a mesh: open edges where triangles are missing, a non-manifold edge where two cubes share one, and wall thickness', function(){
		function cube(o, s, m) {
			var v = [];
			for (var k = 0; k < 8; k++) v.push(m.addVertex([o[0] + s * (k & 1), o[1] + s * ((k >> 1) & 1), o[2] + s * ((k >> 2) & 1)]));
			[[0,2,3,1],[4,5,7,6],[0,1,5,4],[2,6,7,3],[0,4,6,2],[1,3,7,5]].forEach(function(f){ m.addQuad(v[f[0]], v[f[1]], v[f[2]], v[f[3]]); });
		}
		var m = new lib.TriMesh(); cube([0,0,0], 10, m);
		var v = lib.Inspect.mesh(m, 'cube');
		fact(v.facts, 'Watertight').should.be.equal('yes');
		// every vertex is a corner: its normal runs along the cube's diagonal
		layer(v, 'Mesh').fields.thickness.values.forEach(function(t){ t.should.be.approximately(10 * Math.sqrt(3), 1e-6); });

		m.triangles.pop();
		v = lib.Inspect.mesh(m, 'open', { thickness : false });
		fact(v.facts, 'Open edges').should.be.equal('3');

		var two = new lib.TriMesh(); cube([0,0,0], 10, two); cube([10,10,0], 10, two);
		var first = new Map();
		var map = two.vertices.map(function(p, i){ var k = p.join(','); if (!first.has(k)) first.set(k, i); return first.get(k); });
		two.triangles = two.triangles.map(function(t){ return t.map(function(i){ return map[i]; }); });
		two.compact();
		v = lib.Inspect.mesh(two, 'two', { thickness : false });
		fact(v.facts, 'Non-manifold edges').should.be.equal('1');
	});
	it('a B-rep carries exact surface normals at every triangle corner, and its curvature: a capped pipe', function(){
		// a capped pipe of radius 8 along a straight rail: on the tube, normals point away from the axis and the
		// mean curvature is 1/(2 r) (outward-bulging positive); on the flat caps it is 0
		var rail = lib.Make.rationalBezierCurve([[0,0,0],[0,0,60]]);
		var v = lib.Inspect.brep(lib.BrepSolid.cappedTube(lib.Sweep.pipe(rail, 8).surface, [24, 32]));
		var f = layer(v, 'Faces');
		f.normals.length.should.be.equal(f.positions.length);
		var mean = f.fields['mean curvature'].values, tube = 0;
		for (var k = 0; k < f.indices.length; k++) {
			var i = f.indices[k], p = f.positions.slice(3 * i, 3 * i + 3), n = f.normals.slice(3 * i, 3 * i + 3);
			Math.hypot(n[0], n[1], n[2]).should.be.approximately(1, 1e-9);
			var item = v.items[f.pick[Math.floor(k / 3)]];
			if (item.label == 'tube' && p[2] > 1 && p[2] < 59) {
				var r = Math.hypot(p[0], p[1]);
				(n[0] * p[0] / r + n[1] * p[1] / r).should.be.approximately(1, 1e-6);
				// the pipe is a B-spline within 1e-3 of the exact one, so its curvature is close, not exact
				mean[i].should.be.approximately(1 / 16, 1e-3);
				tube++;
			}
		}
		tube.should.be.above(100);
	});
});
