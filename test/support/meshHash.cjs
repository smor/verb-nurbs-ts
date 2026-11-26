// The bytes of a graph evaluation that leave the library, hashed: the analysis mesh, the export mesh and both lists of
// face names. Vertices are hashed as IEEE 754 doubles, little-endian, so two results hash alike only if every
// coordinate is the same to the last bit.
var crypto = require('crypto');
var fs = require('fs'), path = require('path');

function meshBytes(hash, m) {
	var v = new Float64Array(m.vertices.length * 3);
	m.vertices.forEach(function(p, i){ v[3 * i] = p[0]; v[3 * i + 1] = p[1]; v[3 * i + 2] = p[2]; });
	var t = new Int32Array(m.triangles.length * 3);
	m.triangles.forEach(function(x, i){ t[3 * i] = x[0]; t[3 * i + 1] = x[1]; t[3 * i + 2] = x[2]; });
	var dv = Buffer.alloc(v.length * 8), dt = Buffer.alloc(t.length * 4);
	v.forEach(function(x, i){ dv.writeDoubleLE(x, 8 * i); });
	t.forEach(function(x, i){ dt.writeInt32LE(x, 4 * i); });
	hash.update(dv).update(dt);
}

function hashOf(r) {
	var h = crypto.createHash('sha256');
	meshBytes(h, r.result.mesh);
	h.update(JSON.stringify(r.faceNames));
	if (r.export) { meshBytes(h, r.export.mesh); h.update(JSON.stringify(r.export.faceNames)); }
	return h.digest('hex').slice(0, 16);
}

// The parts the determinism test builds: ~92's crank and rod, and 507's slotted block.
var FIXTURES = path.join(__dirname, '..', 'fixtures');
var PARTS = [
	['formats/crank.graph.json', 'flywheel'],
	['formats/crank.graph.json', 'connecting-rod'],
	['507/B-rounded-rectangle-prism.graph.json', 'slotted'],
];

// Each part's hash, built with one graph (in the order given) at the print preset.
function hashes(lib, order) {
	var g = new lib.Graph(), out = {};
	(order || PARTS).forEach(function(p){
		var doc = JSON.parse(fs.readFileSync(path.join(FIXTURES, p[0]), 'utf8'));
		out[p[0] + '#' + p[1]] = hashOf(g.evaluate(doc, { output : p[1], mesh : 'print' }));
	});
	return out;
}

module.exports = { hashOf : hashOf, hashes : hashes, PARTS : PARTS };

// run as a script: print the hashes as JSON (the test runs this in separate processes)
if (require.main === module) process.stdout.write(JSON.stringify(hashes(require('../../dist/index.js'))));
