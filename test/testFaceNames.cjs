var should = require('should');
var fs = require('fs'), path = require('path');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph;

// A face name per triangle (#68 A3): every triangle of a graph evaluation, of the analysis mesh and of the export
// mesh, has the persistent name of its face, in the grammar of docs/model.md, nested through components.

var FIXTURES = path.join(__dirname, 'fixtures');
function load(file) { return JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8')); }
function resolve(use) { return load(path.join('formats', use)); }

// a name of the grammar: segments of feature ids joined by "/", then ".<face>"; or round(...), corner(...); then
// optionally "#k" pieces and "~" for a shell's inside
var LEAF = '[A-Za-z_][A-Za-z0-9_]*(?:/[A-Za-z_][A-Za-z0-9_]*)*\\.[A-Za-z0-9_+\\-. ]+';
var NAME = new RegExp('^(?:(?:[A-Za-z_][A-Za-z0-9_]*/)*(?:' + LEAF + '|round\\(.+\\)|corner\\(.+\\))(?:#[0-9]+)*)$');

function names(r) {
	// every triangle of both meshes named
	r.result.faceOf.length.should.equal(r.result.mesh.triangles.length);
	r.result.faceOf.forEach(function(f){ (typeof r.faceNames[f]).should.equal('string'); });
	r.export.faceNames.length.should.equal(r.export.mesh.triangles.length);
	var all = new Set(r.faceNames);
	r.export.faceNames.forEach(function(n){ all.has(n).should.be.true(); });
	// each in the grammar, one face each (no two faces share a name), and found again through faceIndex
	all.size.should.equal(r.faceNames.length);
	all.forEach(function(n){
		n.should.match(NAME);
		r.faceNames[r.faceIndex[n]].should.equal(n);
	});
	// the export mesh names every face, as the analysis mesh does
	new Set(r.export.faceNames).size.should.equal(all.size);
	return all;
}

describe("Face names per triangle", function(){
	this.timeout(budget(180000));

	it('names every triangle of every 507 part, in both meshes', function(){
		var dir = path.join(FIXTURES, '507');
		fs.readdirSync(dir).forEach(function(f){
			var doc = load(path.join('507', f));
			Object.keys(doc.outputs).slice(0, 2).forEach(function(o){
				names(new Graph().evaluate(doc, { output : o, mesh : 'view' }));
			});
		});
	});

	it('nests names through components: each instance\'s faces carry its id, and two instances share none', function(){
		var doc = load('formats/crank-pair.graph.json'), g = new Graph();
		var a = names(g.evaluate(doc, { output : 'flywheel-1', resolve : resolve, mesh : 'view' }));
		var b = names(g.evaluate(doc, { output : 'flywheel-2', resolve : resolve, mesh : 'view' }));
		a.forEach(function(n){ n.should.match(/(^|\/|\()crank1\//); b.has(n).should.be.false(); });
		b.forEach(function(n){ n.should.match(/(^|\/|\()crank2\//); });
		var rod = names(g.evaluate(doc, { output : 'rod-2', resolve : resolve, mesh : 'view' }));
		rod.has('rod2/crank2/bar/crank2/barShape.+x').should.be.true();
	});

	it('keeps the names when a parameter changes', function(){
		var doc = load('formats/crank.graph.json'), g = new Graph();
		var nums = Object.keys(doc.nodes).filter(function(id){ return doc.nodes[id].type == 'number'; });
		nums.length.should.be.above(0);
		var before = names(g.evaluate(doc, { output : 'connecting-rod', mesh : 'view' }));
		var set = {}; set[nums[0]] = doc.nodes[nums[0]].in.value * 1.1;
		var after = names(g.evaluate(doc, { output : 'connecting-rod', set : set, mesh : 'view' }));
		Array.from(after).sort().should.eql(Array.from(before).sort());
	});
});
