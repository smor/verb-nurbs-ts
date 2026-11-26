var should = require('should');
var path = require('path'), child = require('child_process');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var meshHash = require('./support/meshHash.cjs');

// The same document and options give the same bytes (#68 A2): vertices to the last bit, triangles, face names, for the
// analysis mesh and the export mesh, in every process, whatever was evaluated before, and on every machine and Node
// version CI runs (against the hashes checked in, test/fixtures/mesh-hashes.json). When a change moves a mesh on
// purpose, regenerate them with `node test/support/meshHash.cjs` and say why in the commit.
describe("Deterministic evaluation", function(){
	this.timeout(budget(180000));

	var script = path.join(__dirname, 'support', 'meshHash.cjs');
	var run = function(){ return JSON.parse(child.execFileSync(process.execPath, [script], { encoding : 'utf8' })); };

	it('gives byte-identical meshes and face names in two separate processes, and the hashes checked in', function(){
		var a = run(), b = run();
		a.should.eql(b);
		a.should.eql(require('./fixtures/mesh-hashes.json'));
	});

	it('gives the same bytes from a warm cache, whatever was evaluated before', function(){
		var reversed = meshHash.PARTS.slice().reverse();
		var warm = meshHash.hashes(lib, meshHash.PARTS.concat(reversed));
		warm.should.eql(require('./fixtures/mesh-hashes.json'));
		// and a graph that built the parts in the other order first
		meshHash.hashes(lib, reversed).should.eql(warm);
	});
});
