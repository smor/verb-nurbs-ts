var should = require('should');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var verb = lib.default, Vec = lib.Vec, Eval = verb.eval.Eval, Make = verb.eval.Make;
var BrepSolid = lib.BrepSolid, BrepBoolean = lib.BrepBoolean, Step = lib.Step, SurfaceLoops = lib.SurfaceLoops, Sweep = lib.Sweep;

function roundedBox() {
	var b = BrepSolid.box([0, 0, 0], [40, 28, 20], 12);
	var E = lib.BrepEdges.all(b).map(function(e, k){ return { solid : 0, faces : e.faces, radius : [3, 4, 5][k % 3] }; });
	return BrepBoolean.evaluate([b], function(f){ return f[0]; }, { filletShape : 'curvature', edges : E });
}

function boss() {
	var line = function(a, b){ return Make.rationalBezierCurve([a, b]); };
	var disc = BrepSolid.cappedTube(Sweep.pipe(line([0, 0, -5], [0, 0, 5]), 30).surface, [8, 96]);
	var rod = BrepSolid.cappedTube(Sweep.pipe(line([0, 0, 0], [0, 0, 30]), 8).surface, [24, 96]);
	return BrepBoolean.union([disc, rod], { fillet : 4 });
}

// the instances of a STEP file, by id
function parse(text) {
	var out = {};
	text.split('\n').forEach(function(l){
		var m = /^#(\d+)=(.*);$/.exec(l);
		if (m) out[m[1]] = m[2];
	});
	return out;
}

// the distance from p to a surface: the nearest of a grid of samples, refined by projection
function distanceTo(s, p) {
	var d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
	var periodic = [lib.Analyze.isRationalSurfaceClosed(s, true), lib.Analyze.isRationalSurfaceClosed(s, false)];
	var best = null, bd = Infinity;
	for (var i = 0; i <= 24; i++) for (var j = 0; j <= 24; j++) {
		var uv = [d[0] + (d[1] - d[0]) * i / 24, d[2] + (d[3] - d[2]) * j / 24];
		var q = Eval.rationalSurfacePoint(s, uv[0], uv[1]), dist = Vec.dist(q, p);
		if (dist < bd) { bd = dist; best = uv; }
	}
	var uv2 = SurfaceLoops.project({ surface : s, periodic : periodic }, p, best);
	return uv2 == null ? bd : Math.min(bd, Vec.dist(Eval.rationalSurfacePoint(s, uv2[0], uv2[1]), p));
}

function nearestUV(s, p) {
	var d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
	var best = null, bd = Infinity;
	for (var i = 0; i <= 32; i++) for (var j = 0; j <= 32; j++) {
		var uv = [d[0] + (d[1] - d[0]) * i / 32, d[2] + (d[3] - d[2]) * j / 32];
		var dist = Vec.dist(Eval.rationalSurfacePoint(s, uv[0], uv[1]), p);
		if (dist < bd) { bd = dist; best = uv; }
	}
	return best;
}

// a capped tube cut with a ring round a rod on its seam: the wall keeps a disc inside the ring, which the seam
// splits into two regions
function ringOnSeam() {
	function line(a, b) { return Make.rationalBezierCurve([a, b]); }
	var cyl = lib.BrepSolid.cappedTube(lib.Sweep.pipe(line([0,0,0], [0,0,40]), 15).surface, [24, 96]);
	var big = lib.BrepSolid.cappedTube(lib.Sweep.pipe(line([8,0,20], [20,0,20]), 4).surface, [24, 48]);
	var small = lib.BrepSolid.cappedTube(lib.Sweep.pipe(line([6,0,20], [22,0,20]), 1.5).surface, [24, 48]);
	return lib.BrepBoolean.evaluate([cyl, big, small], function(f){ return f[0] && !(f[1] && !f[2]); });
}

function mug() {
	return lib.BooleanObjectsRecipe.mug({ divsU : 32, divsV : 128 }).result;
}

describe("verb.io.Step", function(){
	this.timeout(budget(120000));

	[['a box rounded with G2 fillets and setback corners', roundedBox], ['a rod on a disc, its foot filleted', boss], ['a mug: walls of revolution with a handle across their seam (genus 1)', mug], ['a ring cut round a rod on a seam: faces the seam splits in two', ringOnSeam]].forEach(function(c){
		describe(c[0], function(){
			var r, M, text, ents;
			before(function(){
				r = c[1]();
				r.report.manifold.closedManifold.should.be.true();
				M = Step.model(r);
				text = Step.write(r, { name : "test's solid" });
				ents = parse(text);
			});

			it('is a closed 2-manifold shell: every edge in exactly two loops, once each way, and V - E + F - (L - F) = 2 (1 - genus)', function(){
				var F = M.faces.length, L = 0;
				var uses = M.edges.map(function(){ return [0, 0]; });
				M.faces.forEach(function(face, fi){
					// one outer loop: a region of the parameter rectangle (none on a surface closed both ways)
					face.loops.filter(function(l){ return l.outer; }).length.should.be.equal(face.closed[0] && face.closed[1] ? 0 : 1);
					face.loops.forEach(function(loop){
						L++;
						loop.edges.forEach(function(x){
							uses[x[0]][x[1] ? 0 : 1]++;
							// the face is on the edge's left going forward, on its right going back
							(x[1] ? M.edges[x[0]].left : M.edges[x[0]].right).should.be.equal(fi);
						});
						// a loop closes: each edge ends where the next starts
						loop.edges.forEach(function(x, k){
							var y = loop.edges[(k + 1) % loop.edges.length], ex = M.edges[x[0]], ey = M.edges[y[0]];
							(x[1] ? ex.end : ex.start).should.be.equal(y[1] ? ey.start : ey.end);
						});
					});
				});
				uses.forEach(function(u){ u.should.be.eql([1, 1]); });
				(M.vertices.length - M.edges.length + F - (L - F)).should.be.equal(2 * (1 - r.report.manifold.genus));
			});

			it('cuts faces on closed surfaces along their seams: no edge crosses a seam, and seam edges run along them', function(){
				var seams = 0;
				M.faces.forEach(function(face, fi){
					if (face.closed[0] == face.closed[1]) return;
					var d = face.closed[0] ? 0 : 1, s = face.surface;
					var dom = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
					var c0 = dom[2 * d], per = dom[2 * d + 1] - c0;
					face.loops.forEach(function(loop){ loop.edges.forEach(function(x){
						var e = M.edges[x[0]], c = e.curve, kn = [c.knots[0], c.knots[c.knots.length - 1]], xs = [];
						for (var j = 1; j < 16; j++) {
							var p = Eval.rationalCurvePoint(c, kn[0] + (kn[1] - kn[0]) * j / 16);
							var uv = SurfaceLoops.project({ surface : s, periodic : face.closed }, p, nearestUV(s, p));
							var t = (uv[d] - c0) / per;
							if (xs.length > 0) t += Math.round(xs[xs.length - 1] - t);
							xs.push(t);
						}
						if (e.left == e.right) {
							seams++;
							// on the seam: the closed parameter at the domain's start (or end)
							xs.forEach(function(t){ Math.abs(t - Math.round(t)).should.be.below(1e-4, 'face ' + fi); });
						} else if (xs.every(function(t){ return Math.abs(t - Math.round(t)) < 1e-4; })) {
							// an edge between two faces of one surface, along its seam (a face the seam split in two)
							e.left.should.not.be.equal(e.right);
						} else {
							// inside the rectangle: never past the seam between its ends
							var lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
							Math.floor(lo + 1e-4).should.be.equal(Math.floor(hi - 1e-4), 'face ' + fi);
						}
					}); });
				});
				if (M.faces.some(function(f){ return f.closed[0] != f.closed[1]; })) seams.should.be.above(0);
			});

			it('fits each edge curve within the tolerance of both faces it joins, ending exactly at its vertices', function(){
				var worst = 0;
				M.edges.forEach(function(e){
					var crv = e.curve, d = [crv.knots[0], crv.knots[crv.knots.length - 1]];
					Vec.dist(Eval.rationalCurvePoint(crv, d[0]), M.vertices[e.start]).should.be.below(1e-9);
					Vec.dist(Eval.rationalCurvePoint(crv, d[1]), M.vertices[e.end]).should.be.below(1e-9);
					for (var j = 1; j < 8; j++) {
						var p = Eval.rationalCurvePoint(crv, d[0] + (d[1] - d[0]) * j / 8);
						worst = Math.max(worst, distanceTo(M.faces[e.left].surface, p), distanceTo(M.faces[e.right].surface, p));
					}
				});
				worst.should.be.below(0.01);
			});

			it('writes a well-formed exchange file: every reference defined, one face per face, one edge curve per edge', function(){
				text.indexOf('ISO-10303-21;').should.be.equal(0);
				text.should.containEql('END-ISO-10303-21;');
				text.should.containEql("MANIFOLD_SOLID_BREP('test''s solid'");
				Object.keys(ents).forEach(function(id){
					(ents[id].match(/#\d+/g) || []).forEach(function(ref){ should.exist(ents[ref.slice(1)], ref + ' in #' + id); });
				});
				var count = function(name){ return Object.keys(ents).filter(function(id){ return ents[id].indexOf(name + '(') == 0; }).length; };
				count('ADVANCED_FACE').should.be.equal(M.faces.length);
				count('EDGE_CURVE').should.be.equal(M.edges.length);
				count('VERTEX_POINT').should.be.equal(M.vertices.length);
				count('FACE_OUTER_BOUND').should.be.equal(M.faces.filter(function(f){ return f.loops.some(function(l){ return l.outer; }); }).length);
				// each edge curve is used by two oriented edges, one each way
				var by = {};
				Object.keys(ents).forEach(function(id){
					var m = /^ORIENTED_EDGE\('',\*,\*,#(\d+),\.(T|F)\.\)$/.exec(ents[id]);
					if (m) (by[m[1]] = by[m[1]] || []).push(m[2]);
				});
				Object.keys(by).length.should.be.equal(M.edges.length);
				Object.keys(by).forEach(function(e){ by[e].sort().should.be.eql(['F', 'T']); });
				// reals always carry a decimal point
				(text.match(/[(,]-?\d+E/g) || []).length.should.be.equal(0);
			});
		});
	});

	it('writes each region of a face the seam cuts in two as a face of its own', function(){
		var r = ringOnSeam(), M = Step.model(r);
		r.report.manifold.closedManifold.should.be.true();
		// the disc of wall left inside the ring falls apart into two halves at the seam
		M.faces.length.should.be.above(r.faces.length);
		var halves = M.edges.filter(function(e){ return e.left != e.right && M.faces[e.left].surface === M.faces[e.right].surface; });
		halves.length.should.be.above(0);
	});

	it('writes reals the way STEP wants them', function(){
		Step.real(1).should.be.equal('1.');
		Step.real(-0).should.be.equal('0.');
		Step.real(0.25).should.be.equal('0.25');
		Step.real(1e-20).should.be.equal('1.E-20');
		Step.real(-2.5e30).should.be.equal('-2.5E+30');
	});
});
