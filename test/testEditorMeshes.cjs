var should = require('should');
var fs = require('fs');
var path = require('path');
var esbuild = require('esbuild');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph;

// The editor's meshes (editor/meshes.ts): the analysis mesh and the view mesh as the 3D view gets them, with a face
// name per triangle and the exact surface normal at every triangle corner. Bundled here against the built library.

var M;
before(function () {
	var out = esbuild.buildSync({ entryPoints : [path.join(__dirname, '..', 'editor', 'meshes.ts')], bundle : true, format : 'cjs', platform : 'node',
		write : false, logLevel : 'error', external : ['../src/index.js'] });
	var m = { exports : {} };
	var req = function (p) { return p == '../src/index.js' ? lib : require(p); };
	new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, req);
	M = m.exports;
});

// for each triangle corner of a packed mesh: its position, its normal, its face's name
var corners = function (a) {
	var out = [];
	for (var t = 0; t < a.idx.length / 3; t++) for (var k = 0; k < 3; k++) {
		var v = a.idx[3 * t + k];
		out.push({ p : [a.pos[3 * v], a.pos[3 * v + 1], a.pos[3 * v + 2]], n : [a.normal[9 * t + 3 * k], a.normal[9 * t + 3 * k + 1], a.normal[9 * t + 3 * k + 2]],
			face : a.names[a.face[t]] });
	}
	return out;
};

describe('editor meshes (editor/meshes.ts)', function () {
	this.timeout(budget(60000));

	it('a cylinder\'s meshes carry the exact normals: radial on its side, along z on its caps, all outward and of unit length', function () {
		var doc = { version : 2, nodes : { c : { type : 'primitive/cylinder', in : { radius : 10, height : 20 } } }, outputs : { c : '@c' } };
		var g = new Graph(), r = g.evaluate(doc);
		[M.analysis(r), M.view(g, r)].forEach(function (a, which) {
			var cs = corners(a), side = 0, caps = 0;
			cs.forEach(function (c) {
				Math.hypot(c.n[0], c.n[1], c.n[2]).should.be.approximately(1, 1e-6);
				var rho = Math.hypot(c.p[0], c.p[1]);
				if (Math.abs(c.n[2]) < 1e-6) {
					// the side: the normal is the position's direction from the axis
					side++;
					rho.should.be.approximately(10, 0.11);
					c.n[0].should.be.approximately(c.p[0] / rho, 2e-3);
					c.n[1].should.be.approximately(c.p[1] / rho, 2e-3);
				} else {
					caps++;
					Math.abs(c.n[2]).should.be.approximately(1, 1e-6);
					(c.n[2] > 0).should.equal(c.p[2] > 10, 'cap normals point out, at z = ' + c.p[2]);
				}
			});
			side.should.be.above(0, which ? 'view' : 'analysis');
			caps.should.be.above(0);
		});
	});

	it('an STL file holds every triangle of the print mesh, with unit normals pointing out of the solid', function () {
		var doc = { version : 2, nodes : { c : { type : 'primitive/cylinder', in : { radius : 10, height : 20 } } }, outputs : { c : '@c' } };
		var g = new Graph(), r = g.evaluate(doc), f = M.printStl(g, r, 'cylinder');
		var v = new DataView(f.data), n = v.getUint32(80, true);
		n.should.equal(f.triangles);
		f.data.byteLength.should.equal(84 + 50 * n);
		f.deviation.should.be.below(0.021);
		var vol = 0;
		for (var i = 0; i < n; i++) {
			var o = 84 + 50 * i, q = [];
			for (var k = 0; k < 12; k++) q.push(v.getFloat32(o + 4 * k, true));
			Math.hypot(q[0], q[1], q[2]).should.be.approximately(1, 1e-5);
			// the signed volume of the tetrahedron from the origin: the triangles wind outward when the sum is positive
			var a = q.slice(3, 6), b = q.slice(6, 9), c = q.slice(9, 12);
			vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
		}
		vol.should.be.approximately(Math.PI * 100 * 20, 0.005 * Math.PI * 100 * 20);
	});

	it('the vase\'s view mesh is a tenth of its analysis mesh, every corner has its face\'s normal, close to its triangle\'s', function () {
		var doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'editor', 'samples', 'art-nouveau-vase.graph.json'), 'utf8'));
		var g = new Graph(), r = g.evaluate(doc), a = M.analysis(r), v = M.view(g, r);
		(v.idx.length).should.be.below(a.idx.length / 10);
		v.deviation.should.be.below(0.11);
		v.names.slice().sort().should.eql(a.names.slice().sort());
		var off = 0, zero = 0;
		for (var t = 0; t < v.idx.length / 3; t++) {
			var p = [0, 1, 2].map(function (k) { var i = v.idx[3 * t + k]; return [v.pos[3 * i], v.pos[3 * i + 1], v.pos[3 * i + 2]]; });
			var e1 = [0, 1, 2].map(function (j) { return p[1][j] - p[0][j]; }), e2 = [0, 1, 2].map(function (j) { return p[2][j] - p[0][j]; });
			var tn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], L = Math.hypot(tn[0], tn[1], tn[2]);
			for (var k = 0; k < 3; k++) {
				var n = [v.normal[9 * t + 3 * k], v.normal[9 * t + 3 * k + 1], v.normal[9 * t + 3 * k + 2]];
				if (n[0] == 0 && n[1] == 0 && n[2] == 0) { zero++; continue; }
				// the view preset keeps neighbouring normals within 20 degrees: a corner's is within that of its triangle's
				if ((n[0] * tn[0] + n[1] * tn[1] + n[2] * tn[2]) / L < Math.cos(25 * Math.PI / 180)) off++;
			}
		}
		zero.should.equal(0);
		off.should.be.below(v.idx.length * 0.01);
	});
});
