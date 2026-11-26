var should = require('should');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var P = lib.Primitives, Pr = lib.Profiles, H = lib.Polyhedra, BrepEdges = lib.BrepEdges, BrepBoolean = lib.BrepBoolean, Step = lib.Step;
var PI = Math.PI;

// a closed 2-manifold of the given genus, built without welding anything the faces do not share exactly
function closed(s, genus) {
	var r = s.tessellate().checkClosedManifold();
	r.closedManifold.should.be.true();
	r.genus.should.be.equal(genus === undefined ? 0 : genus);
}

// the exact volume (divergence theorem on the NURBS faces) against a formula
function volume(s, v, tol) {
	var x = P.volume(s);
	Math.abs(x - v).should.be.below((tol || 1e-9) * Math.abs(v), 'volume ' + x + ' against ' + v);
}

describe('Primitives', function () {
	this.timeout(budget(120000));

	describe('volumes match their formulas, exactly', function () {
		var hexArea = 3 * Math.sqrt(3) / 2 * 100;
		var cases = [
			['box', function(){ return P.box(40, 30, 20); }, 24000],
			['wedge with a ridge', function(){ return P.wedge(10, 10, 10, 5, 5); }, 500],
			['wedge with a smaller top', function(){ return P.wedge(20, 20, 10, 5, 15); }, 10 / 6 * (400 + 4 * 15 * 20 + 200)],
			['parallelepiped', function(){ return P.parallelepiped([10, 0, 0], [3, 8, 0], [1, 2, 5]); }, 400],
			['hexagonal prism', function(){ return P.regularPrism(6, 10, 20); }, hexArea * 20],
			['twisted hexagonal prism (Simpson: the section area is quadratic)', function(){ return P.regularPrism(6, 10, 20, { twist : 0.5 }); },
				20 * hexArea * (2 + 4 * Math.pow(Math.cos(0.25), 2)) / 6],
			['oblique prism', function(){ return P.regularPrism(6, 10, 20, { shear : [7, -3] }); }, hexArea * 20],
			['square pyramid', function(){ return P.regularPyramid(4, 10, 30); }, 200 * 30 / 3],
			['oblique pyramid', function(){ return P.regularPyramid(4, 10, 30, [8, 3]); }, 200 * 30 / 3],
			['pentagonal frustum', function(){ return P.frustum(Pr.regular(5, 10), 12, 0.5); },
				12 * (5 / 2 * 100 * Math.sin(2 * PI / 5)) * (1 + 0.5 + 0.25) / 3],
			['star prism', function(){ return P.prism(Pr.star(5, 20, 8), 10); }, 5 * 20 * 8 * Math.sin(PI / 5) * 10],
			['heart prism', function(){ return P.prism(Pr.heart(40), 8); }, (function(){ var L = 40 / (Math.SQRT1_2 + 1); return (L * L + PI * L * L / 4) * 8; })()],
			['rounded rectangle prism', function(){ return P.prism(Pr.roundedRectangle(40, 20, 5), 10); }, (800 - (4 - PI) * 25) * 10],
			['stadium prism', function(){ return P.prism(Pr.stadium(30, 5), 4); }, (300 + PI * 25) * 4],
			['I section', function(){ return P.prism(Pr.iSection(20, 30, 3, 2), 50); }, (2 * 20 * 3 + 2 * 24) * 50],
			['channel section', function(){ return P.prism(Pr.channelSection(20, 15, 2), 30); }, (20 * 15 - 16 * 13) * 30],
			['T section', function(){ return P.prism(Pr.teeSection(20, 15, 3, 4), 10); }, (60 + 48) * 10],
			['angle section', function(){ return P.prism(Pr.angleSection(20, 15, 3), 10); }, (60 + 36) * 10],
			['cross', function(){ return P.prism(Pr.cross(30, 10), 5); }, (300 + 200) * 5],
			['elliptic cylinder', function(){ return P.prism(Pr.ellipse(10, 5), 10); }, PI * 50 * 10],
			['Reuleaux triangle prism', function(){ return P.prism(Pr.reuleaux(3, 20), 5); }, (PI - Math.sqrt(3)) / 2 * 400 * 5],
			['pie slice of 270 degrees', function(){ return P.prism(Pr.sector(10, 1.5 * PI), 5); }, 0.5 * 100 * 1.5 * PI * 5],
			['extrusion along a slanted direction', function(){ return P.extrude(Pr.regular(3, 10), [5, 0, 20]); }, 3 * Math.sqrt(3) / 4 * 100 * 20],
			['cylinder', function(){ return P.cylinder(10, 20); }, PI * 100 * 20],
			['cone', function(){ return P.cone(10, 30); }, PI * 100 * 30 / 3],
			['cone frustum', function(){ return P.cone(10, 30, 5); }, PI * 30 / 3 * (100 + 50 + 25)],
			['sphere', function(){ return P.sphere(10); }, 4 / 3 * PI * 1000],
			['hemisphere', function(){ return P.hemisphere(10); }, 2 / 3 * PI * 1000],
			['spherical cap', function(){ return P.sphericalCap(10, 4); }, PI * 16 * (30 - 4) / 3],
			['spherical zone', function(){ return P.sphericalZone(10, -3, 6); }, PI * (100 * 9 - (216 + 27) / 3)],
			['spherical sector', function(){ return P.sphericalSector(10, 0.6); }, 2 / 3 * PI * 1000 * (1 - Math.cos(0.6))],
			['spheroid', function(){ return P.spheroid(10, 30); }, 4 / 3 * PI * 100 * 15],
			['ellipsoid', function(){ return P.ellipsoid(10, 6, 4); }, 4 / 3 * PI * 240],
			['capsule', function(){ return P.capsule(5, 20); }, PI * 25 * 20 + 4 / 3 * PI * 125],
			['paraboloid', function(){ return P.paraboloid(10, 20); }, PI * 100 * 20 / 2],
			['lens', function(){ return P.lens(20, 30, 30); }, (function(){
				var cap = function(r, a){ var h = r - Math.sqrt(r * r - a * a); return PI * h * h * (3 * r - h) / 3; };
				return cap(20, 15) + cap(30, 15); })()],
			['torus', function(){ return P.torus(20, 5); }, 2 * PI * PI * 20 * 25],
			['torus of elliptic section', function(){ return P.torus(20, 5, 3); }, 2 * PI * 20 * PI * 15],
			['tube', function(){ return P.tube(10, 8, 20); }, PI * 36 * 20],
			['conical tube', function(){ return P.conicalTube(10, 8, 6, 3, 12); }, PI * 12 / 3 * ((100 + 60 + 36) - (64 + 24 + 9))],
			['two-ellipsoid egg', function(){ return P.egg(10, 15, 10); }, 2 / 3 * PI * 100 * 25],
			['tangent ogive (Pappus on the circular segment)', function(){ return P.ogive(10, 30); }, (function(){
				// the volume of revolution of the region under the arc: integrate pi y(x)^2 along the axis numerically
				var R = 10, L = 30, rho = (R * R + L * L) / (2 * R), n = 20000, v = 0;
				for (var i = 0; i < n; i++) { var z = (i + 0.5) / n * L, y = Math.sqrt(rho * rho - z * z) + R - rho; v += PI * y * y * L / n; }
				return v; })(), 1e-7],
			['antiprism', function(){ return P.antiprism(4, 10); }, null],
			['bipyramid', function(){ return P.bipyramid(5, 10, 12, 6); }, 5 / 2 * 100 * Math.sin(2 * PI / 5) * 18 / 3],
		];
		cases.forEach(function(c){
			it(c[0], function(){
				var s = c[1]();
				closed(s, /torus|tube/.test(c[0]) ? 1 : 0);
				if (c[2] != null) volume(s, c[2], c[3]);
				else P.volume(s).should.be.above(0);
			});
		});
	});

	describe('polyhedra', function () {
		// the known counts of vertices, edges and faces
		var counts = {
			tetrahedron : [4, 6, 4], cube : [8, 12, 6], octahedron : [6, 12, 8], dodecahedron : [20, 30, 12], icosahedron : [12, 30, 20],
			truncatedTetrahedron : [12, 18, 8], cuboctahedron : [12, 24, 14], truncatedCube : [24, 36, 14], truncatedOctahedron : [24, 36, 14],
			rhombicuboctahedron : [24, 48, 26], truncatedCuboctahedron : [48, 72, 26], snubCube : [24, 60, 38], icosidodecahedron : [30, 60, 32],
			truncatedDodecahedron : [60, 90, 32], truncatedIcosahedron : [60, 90, 32], rhombicosidodecahedron : [60, 120, 62],
			truncatedIcosidodecahedron : [120, 180, 62],
		};
		Object.keys(counts).forEach(function(name){
			it(name + ': its counts, one edge length, every vertex on the circumsphere', function(){
				var p = H.named(name), e = H.edges(p);
				[p.vertices.length, e.length, p.faces.length].should.eql(counts[name]);
				var lens = e.map(function(x){ return lib.Vec.dist(p.vertices[x[0]], p.vertices[x[1]]); });
				(Math.max.apply(null, lens) - Math.min.apply(null, lens)).should.be.below(1e-9);
				p.vertices.forEach(function(v){ Math.abs(lib.Vec.norm(v) - 1).should.be.below(1e-9); });
			});
		});
		it('the Platonic solids as B-reps: closed, with the exact volume for their edge', function(){
			var R = 10;
			var a = { tetrahedron : R * Math.sqrt(8 / 3), cube : 2 * R / Math.sqrt(3), octahedron : R * Math.SQRT2, dodecahedron : 4 * R / (Math.sqrt(3) * (1 + Math.sqrt(5))),
				icosahedron : 4 * R / Math.sqrt(10 + 2 * Math.sqrt(5)) };
			var f = { tetrahedron : function(x){ return x * x * x / (6 * Math.SQRT2); }, cube : function(x){ return x * x * x; }, octahedron : function(x){ return Math.SQRT2 / 3 * x * x * x; },
				dodecahedron : function(x){ return (15 + 7 * Math.sqrt(5)) / 4 * x * x * x; }, icosahedron : function(x){ return 5 * (3 + Math.sqrt(5)) / 12 * x * x * x; } };
			H.PLATONIC.forEach(function(n){ var s = P.platonic(n, R); closed(s); volume(s, f[n](a[n]), 1e-9); });
		});
		it('the dual of the cuboctahedron is the rhombic dodecahedron: 12 planar rhombi, 14 vertices', function(){
			var d = H.dual(H.cuboctahedron());
			d.faces.length.should.be.equal(12); d.vertices.length.should.be.equal(14);
			d.faces.forEach(function(f){
				f.length.should.be.equal(4);
				var l = f.map(function(i, k){ return lib.Vec.dist(d.vertices[i], d.vertices[f[(k + 1) % 4]]); });
				(Math.max.apply(null, l) - Math.min.apply(null, l)).should.be.below(1e-9);
			});
			closed(P.polyhedron(d));
		});
		it('the trapezohedron of a d10 has 10 kites and 12 vertices', function(){
			var t = H.trapezohedron(5);
			t.faces.length.should.be.equal(10); t.vertices.length.should.be.equal(12);
			closed(P.polyhedron(t));
		});
		it('truncation and rectification of a cube give the truncated cube and the cuboctahedron', function(){
			var t = H.truncate(H.cube(), 1 / (2 + Math.SQRT2));
			[t.vertices.length, t.faces.length].should.eql([24, 14]);
			var e = H.edges(t).map(function(x){ return lib.Vec.dist(t.vertices[x[0]], t.vertices[x[1]]); });
			(Math.max.apply(null, e) - Math.min.apply(null, e)).should.be.below(1e-9);
			var a = H.ambo(H.cube());
			[a.vertices.length, a.faces.length].should.eql([12, 14]);
		});
		it('kis puts a pyramid on every face', function(){
			var k = H.kis(H.cube(), 0.2);
			[k.vertices.length, k.faces.length].should.eql([14, 24]);
			closed(P.polyhedron(k));
		});
	});

	describe('profiles', function () {
		it('keep their corners: one side face per smooth piece', function(){
			Pr.regular(6, 10).pieces().length.should.be.equal(6);
			Pr.roundedRectangle(40, 20, 5).pieces().length.should.be.equal(1);
			Pr.circle(5).pieces().length.should.be.equal(1);
			Pr.heart(40).pieces().length.should.be.equal(2);
			Pr.star(5, 20, 8).pieces().length.should.be.equal(10);
			Pr.rounded([[0, 0], [20, 0], [20, 10], [0, 10]], [0, 3, 3, 0]).pieces().length.should.be.equal(2);
		});
		it('have the exact areas of their shapes', function(){
			Math.abs(Pr.starPolygon(5, 2, 10).area() - 5 * 10 * (10 * Math.cos(2 * PI / 5) / Math.cos(PI / 5)) * Math.sin(PI / 5)).should.be.below(1e-9);
			Math.abs(Pr.rounded([[0, 0], [20, 0], [20, 10], [0, 10]], 2).area(256) - (200 - (4 - PI) * 4)).should.be.below(1e-3);
			Math.abs(Pr.arrow(30, 4, 10, 8).area() - (22 * 4 + 40)).should.be.below(1e-9);
		});
		it('round concave corners too (a rounded star stays one smooth face)', function(){
			var r = Pr.rounded(Pr.star(5, 20, 9).segments.map(function(s){ return s.curve.controlPoints[0].slice(0, 3); }), 1.5);
			r.pieces().length.should.be.equal(1);
			closed(P.prism(r, 5));
		});
		it('refuse what is not star-shaped about its cap centre, and out-of-range parameters', function(){
			(function(){ Pr.polygon([[0, 0], [10, 0], [10, 10], [9, 10], [9, 1], [1, 1], [1, 10], [0, 10]]); }).should.throw(/star-shaped/);
			(function(){ Pr.roundedRectangle(10, 4, 3); }).should.throw();
			(function(){ Pr.regular(2, 4); }).should.throw();
			(function(){ P.torus(5, 5); }).should.throw(/horn or spindle/);
			(function(){ P.revolve([lib.Profile.line([1, 0], [2, 1])]); }).should.throw(/axis/);
		});
	});

	describe('take part in rounds, Booleans and STEP as they are', function () {
		function rounded(s, r) {
			var E = BrepEdges.all(s).map(function(e){ return { solid : 0, faces : e.faces, radius : r }; });
			return BrepBoolean.evaluate([s], function(f){ return f[0]; }, { edges : E });
		}
		it('every edge of a hexagonal prism is found and rounded, and the result writes to STEP', function(){
			var s = P.regularPrism(6, 10, 20);
			BrepEdges.all(s).length.should.be.equal(18);
			var r = rounded(s, 1);
			r.report.fillets.should.be.equal(18);
			r.report.filletsFailed.should.be.equal(0);
			r.report.manifold.closedManifold.should.be.true();
			// a rounded prism has less volume than the sharp one, by about the edge length times r^2 (1 - pi/4)
			var lost = P.volume(s) - r.report.volume;
			lost.should.be.above(0.5 * (6 * 10 * 2 + 6 * 20) * (1 - PI / 4));
			Step.write(r, { tolerance : 0.01 }).should.match(/MANIFOLD_SOLID_BREP/);
		});
		it('a rounded-rectangle slab rounds along its two closed rims', function(){
			var r = rounded(P.prism(Pr.roundedRectangle(40, 20, 5), 10), 2);
			r.report.fillets.should.be.equal(2);
			r.report.manifold.closedManifold.should.be.true();
		});
		it('a star prism rounds all its 30 edges', function(){
			var r = rounded(P.prism(Pr.star(5, 20, 10), 10), 1);
			r.report.fillets.should.be.equal(30);
			r.report.manifold.closedManifold.should.be.true();
			r.report.manifold.genus.should.be.equal(0);
		});
		it('a cylinder minus a torus is one closed solid', function(){
			var cyl = P.cylinder(12, 10), ring = P.transformed(P.torus(11, 3), [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 2], [0, 0, 0, 1]]);
			var r = BrepBoolean.evaluate([cyl, ring], function(f){ return f[0] && !f[1]; });
			r.report.manifold.closedManifold.should.be.true();
			r.report.volume.should.be.below(P.volume(cyl));
		});
		it('faces of up to four sides come first, so their edges are found', function(){
			var s = P.platonic('cuboctahedron', 10);
			BrepEdges.all(s).length.should.be.equal(24);
			var t = P.platonic('truncatedIcosahedron', 10);
			// hexagon-hexagon edges are not found yet (docs/primitives.md, known limits)
			BrepEdges.all(t).length.should.be.equal(0);
		});
	});

	describe('the catalogue and the model', function () {
		it('every catalogued primitive builds a closed solid with its defaults', function(){
			this.timeout(budget(120000));
			lib.Catalog.ENTRIES.length.should.be.above(60);
			lib.Catalog.ENTRIES.forEach(function(e){
				var s = lib.Catalog.build(e.name);
				var r = s.tessellate().checkClosedManifold();
				r.closedManifold.should.be.true(e.name);
				P.volume(s).should.be.above(0, e.name);
			});
		});
		it('the Catalan solids have the face and vertex counts of their Archimedean duals, swapped', function(){
			var d = H.dual(H.snubCube());
			[d.vertices.length, d.faces.length].should.eql([38, 24]);
			d.faces.forEach(function(f){ f.length.should.be.equal(5); });
		});
		it('refuses unknown shapes, unknown parameters and values out of range', function(){
			(function(){ lib.Catalog.build('blob'); }).should.throw(/no primitive/);
			(function(){ lib.Catalog.build('box', { girth : 3 }); }).should.throw(/no parameter/);
			(function(){ lib.Catalog.build('cube', { edge : -1 }); }).should.throw(/takes edge/);
		});
		it('a model document places a hex nut: a primitive less a bore, its creases rounded by name', function(){
			var doc = { version : 1, parameters : { r : 20, h : 10 }, features : {
				nut : { type : 'primitive', shape : 'polygon prism', values : { sides : 6, radius : 'r', height : 'h' } },
				hole : { type : 'cylinder', from : [0, 0, -1], to : [0, 0, 11], radius : 8 },
				body : { type : 'difference', from : 'nut', minus : ['hole'] },
				rounded : { type : 'round', of : 'body', rules : [{ edges : 'nut.side.*|nut.side.*', radius : 1.5 }] } }, output : 'rounded' };
			var r = new lib.Model().evaluate(doc);
			r.verdict.kind.should.be.equal('buildable');
			r.result.report.fillets.should.be.equal(6);
			r.faceNames.filter(function(n){ return /^round\(nut\.side/.test(n); }).length.should.be.equal(6);
			r.result.report.manifold.genus.should.be.equal(1);
			(function(){ new lib.Model().evaluate({ version : 1, parameters : {}, features : { s : { type : 'primitive', shape : 'sphere' },
				h : { type : 'shell', of : 's', thickness : 1 } }, output : 'h' }); }).should.throw(/cannot yet offset the primitive/);
		});
		it('creases leave out tangent joins: a torus has none, a rounded-rectangle slab two', function(){
			P.creases(P.torus(20, 5)).length.should.be.equal(0);
			BrepEdges.all(P.torus(20, 5)).length.should.be.equal(1);
			P.creases(P.prism(Pr.roundedRectangle(40, 20, 5), 10)).length.should.be.equal(2);
			P.creases(P.capsule(5, 10)).length.should.be.equal(0);
		});
	});
});
