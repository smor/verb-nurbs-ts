var should = require('should');

var lib = require('../dist/index.js');
var Growth = lib.Growth, Makeable = lib.Makeable;

function euler(m) {
	var e = new Set();
	m.triangles.forEach(function(t){ for (var k = 0; k < 3; k++) { var a = t[k], b = t[(k + 1) % 3]; e.add(a < b ? a + ',' + b : b + ',' + a); } });
	return m.vertices.length - e.size + m.triangles.length;
}
function heightRange(m) {
	var lo = Infinity, hi = -Infinity;
	m.vertices.forEach(function(p){ lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); });
	return hi - lo;
}

describe("verb.solid.Growth", function(){
	this.timeout(120000);

	it('lays out flat sheets: a disc and a rectangle, each one piece with one boundary (Euler characteristic 1)', function(){
		var d = Growth.disc(10, 1.5), r = Growth.rectangle(20, 10, 2);
		euler(d).should.be.equal(1);
		euler(r).should.be.equal(1);
		d.area().should.be.approximately(Math.PI * 100, 0.02 * Math.PI * 100);
		r.area().should.be.approximately(200, 1e-9);
		d.checkClosedManifold().badEdges.should.be.equal(0);
	});

	var grown;
	before(function(){
		grown = Growth.grow(Growth.disc(10, 1.5), { zones : [{ kind : "edge", rate : 0.012, reach : 3 }], steps : 90, bending : 0.3, maxVertices : 1500,
		                                           pin : function(m){ return Math.hypot(m[0], m[1]) < 2.5; } });
	});

	it('grows the rim and buckles it out of plane, keeping the sheet one piece with one boundary', function(){
		grown.areaGrowth.should.be.above(1.8);
		heightRange(grown.mesh).should.be.above(3);
		euler(grown.mesh).should.be.equal(1);
		grown.mesh.checkClosedManifold().badEdges.should.be.equal(0);
		grown.material.length.should.be.equal(grown.mesh.vertices.length);
	});

	it('leaves pinned material where it was, and grows only where the zones reach (partial growth)', function(){
		var disc = Growth.disc(10, 1.5);
		grown.material.forEach(function(m, i){
			if (Math.hypot(m[0], m[1]) < 2.5 && i < disc.vertices.length) {
				var p = grown.mesh.vertices[i], q = disc.vertices[i];
				// pinned: still where laid out (up to the first step's seeded ruffle, a fiftieth of an edge)
				Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]).should.be.below(0.05);
			}
		});
		// vertices were added where the sheet grew (by the rim), hardly near its centre (a few, where the laid-out
		// disc's own edges were already longer than the split length)
		function count(ps, r0, r1) { return ps.filter(function(p){ var r = Math.hypot(p[0], p[1]); return r >= r0 && r < r1; }).length; }
		(count(grown.material, 0, 4) / count(disc.vertices, 0, 4)).should.be.below(1.4);
		(count(grown.material, 6, 8) / count(disc.vertices, 6, 8)).should.be.above(3);
	});

	it('is deterministic: the same sheet and options grow the same shape', function(){
		var a = Growth.grow(Growth.disc(6, 1.5), { zones : [{ kind : "everywhere", rate : 0.01 }], steps : 25 });
		var b = Growth.grow(Growth.disc(6, 1.5), { zones : [{ kind : "everywhere", rate : 0.01 }], steps : 25 });
		a.mesh.vertices.should.be.eql(b.mesh.vertices);
	});

	it('grows along a direction only, when the zone has one', function(){
		var g = Growth.grow(Growth.rectangle(20, 6, 1.5), { zones : [{ kind : "everywhere", rate : 0.01, direction : [1, 0, 0] }], steps : 40, bending : 0.3 });
		var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
		g.material.forEach(function(m){ for (var k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], m[k]); hi[k] = Math.max(hi[k], m[k]); } });
		// the sheet's arc length along x grew (its edges along x lengthened); along y it did not
		var along = function(k){ var s = 0, n = 0; g.mesh.triangles.forEach(function(t){ for (var i = 0; i < 3; i++) {
			var a = t[i], b = t[(i + 1) % 3], dm = [g.material[b][0] - g.material[a][0], g.material[b][1] - g.material[a][1]];
			var lm = Math.hypot(dm[0], dm[1]); if (lm == 0 || Math.abs(dm[k]) / lm < 0.99) continue;
			var p = g.mesh.vertices[a], q = g.mesh.vertices[b]; s += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / lm; n++; } }); return s / n; };
		along(0).should.be.above(1.25);
		along(1).should.be.below(1.1);
	});

	it('thickens the grown sheet into a closed solid with walls as thick as asked, makeable in SLS nylon', function(){
		var s = Growth.thicken(grown, 1.0, 0.4);
		var m = s.mesh.checkClosedManifold();
		m.closedManifold.should.be.true();
		s.mesh.signedVolume().should.be.above(0);
		s.expectedGenus.should.be.equal(0);
		s.separate.should.be.true();
		var r = Makeable.check(s.mesh, 'sls');
		r.makeable.should.be.true();
		r.wall.median.should.be.approximately(1.0, 0.05);
	});
});
