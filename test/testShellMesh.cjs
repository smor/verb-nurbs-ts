var should = require('should');
var fs = require('fs'), path = require('path');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var verb = lib.default, Make = verb.eval.Make;
var BrepSolid = lib.BrepSolid, BrepBoolean = lib.BrepBoolean, ShellBuilder = lib.ShellBuilder, ShellMesher = lib.ShellMesher;
var Sweep = lib.Sweep, Vec = verb.core.Vec, Graph = lib.Graph;

// The export mesh (#72 section 1, #68 A1): an exact shell tessellated within a tolerance, apart from the Booleans' own mesh.

function area(m) {
	var s = 0;
	m.triangles.forEach(function(t){ s += Vec.norm(Vec.cross(Vec.sub(m.vertices[t[1]], m.vertices[t[0]]), Vec.sub(m.vertices[t[2]], m.vertices[t[0]]))) / 2; });
	return s;
}
// The mesh is a closed 2-manifold with the shell's genus, within the tolerance of the exact faces (plus the edges' own
// tolerances: a triangle on an edge is as far from the face as the edge is), and its volume is the exact one to within the deviation over the area.
function check(shell, tol, genus) {
	var m = ShellMesher.mesh(shell, tol), T = ShellMesher.tolerance(tol);
	var mf = m.mesh.checkClosedManifold();
	mf.closedManifold.should.be.true();
	mf.genus.should.equal(genus);
	m.faceOf.length.should.equal(m.mesh.triangles.length);
	m.faceOf.forEach(function(f){ f.should.be.within(0, shell.faces.length - 1); });
	// every face has triangles
	new Set(m.faceOf).size.should.equal(shell.faces.length);
	var slack = Math.max.apply(null, shell.edges.map(function(e){ return e.tolerance; }));
	m.deviation.should.be.below(T.chordal + slack + 1e-9);
	var V = ShellBuilder.volume(shell), A = area(m.mesh);
	Math.abs(m.mesh.signedVolume() - V).should.be.below(m.deviation * A);
	return m;
}
function line(a, b) { return Make.rationalBezierCurve([a, b]); }

describe("verb.solid.ShellMesher", function(){
	this.timeout(budget(120000));

	it('meshes a lone cylinder in tens of triangles, not thousands', function(){
		var cyl = BrepSolid.cappedTube(Sweep.pipe(line([0, 0, 0], [0, 0, 6]), 3.125).surface, [24, 96]);
		var r = BrepBoolean.evaluate([cyl], function(f){ return f[0]; });
		r.mesh.triangles.length.should.be.above(5000);
		var shell = ShellBuilder.fromResult(r);
		var at05 = check(shell, { chordal : 0.05 }, 0), at02 = check(shell, { chordal : 0.02 }, 0);
		// round the rim, the chord's sag r (1 - cos(pi / n)) within the tolerance needs n >= pi / acos(1 - tol / r):
		// 18 at 0.05 mm, 28 at 0.02 mm
		at05.mesh.triangles.length.should.be.within(68, 200);
		at02.mesh.triangles.length.should.be.within(108, 300);
		// the volume is biased low: the vertices lie on the faces, and the faces are convex
		at02.mesh.signedVolume().should.be.below(ShellBuilder.volume(shell));
		// the view preset bounds the normals' turn: 18 segments at least
		check(shell, 'view', 0).mesh.triangles.length.should.be.within(68, 200);
		// the same shell gives the same mesh, byte for byte
		JSON.stringify(ShellMesher.mesh(shell, 'print')).should.equal(JSON.stringify(ShellMesher.mesh(shell, 'print')));
	});

	it('meshes a rounded box and a box with setback corners closed, within the tolerance', function(){
		var b = BrepSolid.box([0, 0, 0], [40, 28, 20], 12);
		var E = lib.BrepEdges.all(b).map(function(e, k){ return { solid : 0, faces : e.faces, radius : [3, 4, 5][k % 3] }; });
		var round = ShellBuilder.fromResult(BrepBoolean.evaluate([b], function(f){ return f[0]; }, { edges : E.map(function(e){ return { solid : 0, faces : e.faces, radius : 4 }; }) }));
		var m = check(round, 'print', 0);
		// a ball corner (an eighth of a sphere, r 4, area 25.1): at most 200 triangles, about 120 at the sag bound
		var per = {};
		m.faceOf.forEach(function(f){ per[f] = (per[f] || 0) + 1; });
		round.faces.forEach(function(F, k){ if (F.name.indexOf('corner') >= 0) per[k].should.be.below(200); });
		// the flat parts of the six sides get no inner points: each is its boundary triangulated
		check(round, { chordal : 0.1 }, 0).mesh.triangles.length.should.be.below(m.mesh.triangles.length);
		check(ShellBuilder.fromResult(BrepBoolean.evaluate([b], function(f){ return f[0]; }, { edges : E, filletShape : 'curvature' })), 'print', 0);
	});

	it('gives Graph.evaluate an export mesh with a face name per triangle, for 507\'s parts', function(){
		var dir = path.join(__dirname, 'fixtures', '507');
		var doc = function(prefix){ return JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(function(f){ return f.indexOf(prefix + '-') == 0; })), 'utf8')); };
		// (A: windows cut from a disc whose polar parameters meet at its centre, where its seam and the windows' sides
		// start: a pole)
		[['A', 'wheel'], ['B', 'slotted'], ['C', 'tube-flange'], ['E', 'rim-spoke']].forEach(function(p){
			var g = new Graph();
			var r = g.evaluate(doc(p[0]), { output : p[1], mesh : 'print' });
			var X = r.export, mf = X.mesh.checkClosedManifold();
			mf.closedManifold.should.be.true();
			X.mesh.triangles.length.should.be.below(r.result.mesh.triangles.length);
			X.faceNames.length.should.equal(X.mesh.triangles.length);
			// the names are the result's: every face named, and nothing else
			var names = new Set(r.faceNames);
			X.faceNames.forEach(function(n){ names.has(n).should.be.true(); });
			new Set(X.faceNames).size.should.equal(names.size);
			X.deviation.should.be.below(0.02 + 1e-3);
			X.tolerance.chordal.should.equal(0.02);
			// another tolerance on the same result reuses its shell; the analysis mesh is the result's own
			var again = g.evaluate(doc(p[0]), { output : p[1], mesh : 'print' });
			again.export.should.equal(X);
			var A = g.evaluate(doc(p[0]), { output : p[1], mesh : 'analysis' }).export;
			A.mesh.should.equal(r.result.mesh);
			should(A.deviation).be.null();
		});
	});

	it('exports a lattice output\'s own mesh, which has no exact shell behind it', function(){
		var doc = { version : 1, output : 'l', features : {
			b : { type : 'box', min : [0, 0, 0], max : [20, 20, 10] },
			l : { type : 'lattice', of : 'b', pattern : 'gyroid', cell : 10, wall : 1.5, skin : 1.6, size : 1 },
		} };
		var r = new Graph().evaluate(doc, { mesh : 'print' });
		r.export.mesh.should.equal(r.lattice.mesh);
		r.export.faceNames.length.should.equal(r.lattice.mesh.triangles.length);
		r.export.faceNames.every(function(n){ return n == 'lattice'; }).should.be.true();
		should(r.export.deviation).be.null();
	});

	it('closes a face whose loop touches itself where a bar is tangent to a cup (#96)', function(){
		// 507's drive weight: the bar's ends are tangent to the cup's rim, so a sample of the rim falls on the bar's edge
		var nodes = { n1 : { type : 'primitive/cylinder', in : { radius : 16, height : 60 } },
			n2 : { type : 'primitive/box', in : { width : 32, depth : 3, height : 5 } },
			n3 : { type : 'transform/move', in : { of : '@n2', x : 0, y : 0, z : 60 } },
			n4 : { type : 'boolean/union', in : { a : '@n1', b : '@n3' } },
			n5 : { type : 'primitive/cylinder', in : { radius : 14.4, height : 60 } },
			n6 : { type : 'transform/move', in : { of : '@n5', x : 0, y : 0, z : 2 } },
			n7 : { type : 'boolean/difference', in : { from : '@n4', minus : '@n6' } },
			n8 : { type : 'primitive/cylinder', in : { radius : 1.2, height : 5 } },
			n9 : { type : 'transform/rotate', in : { of : '@n8', axis : 'x', degrees : -90 } },
			n10 : { type : 'transform/move', in : { of : '@n9', x : 0, y : -2.5, z : 0 } },
			n11 : { type : 'transform/move', in : { of : '@n10', x : 0, y : 0, z : 63 } },
			n12 : { type : 'boolean/difference', in : { from : '@n7', minus : '@n11' } } };
		var doc = { version : 2, meta : { name : 'drive weight' }, nodes : nodes, outputs : { s : '@n12', u : '@n4' } };
		var g = new Graph();
		[['u', 2], ['s', 0]].forEach(function(o){
			['print', 'view', { chordal : 0.05 }, { chordal : 0.005 }].forEach(function(m){
				var r = g.evaluate(doc, { output : o[0], mesh : m });
				var c = r.export.mesh.checkClosedManifold();
				c.closedManifold.should.be.true();
				c.eulerCharacteristic.should.equal(o[1]);
				// (the vertices lie on the faces: low by at most the chordal tolerance times the area)
				r.export.mesh.signedVolume().should.be.approximately(r.result.report.volume, r.export.tolerance.chordal * area(r.export.mesh) + 1e-3 * r.result.report.volume);
			});
		});
		// the bar's underside outside the rim is there on both sides, each a sliver between the rim and the bar's end
		var u = g.evaluate(doc, { output : 'u', mesh : 'print' }).export, xs = [];
		u.mesh.triangles.forEach(function(t, i){
			if (!/^n3\/n2\.-z/.test(u.faceNames[i])) return;
			xs.push(t.reduce(function(a, v){ return a + u.mesh.vertices[v][0] / 3; }, 0));
		});
		xs.some(function(x){ return x < -15.9; }).should.be.true();
		xs.some(function(x){ return x > 15.9; }).should.be.true();
	});

	it('refuses an unknown preset and a tolerance that is not positive', function(){
		(function(){ ShellMesher.tolerance('fine'); }).should.throw(/unknown preset/);
		(function(){ ShellMesher.tolerance({ chordal : 0 }); }).should.throw(/positive/);
	});
});
