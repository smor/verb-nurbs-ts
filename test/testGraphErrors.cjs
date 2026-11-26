var should = require('should');
var fs = require('fs'), path = require('path');
var lib = require('../dist/index.js');
var Graph = lib.Graph, GraphError = lib.GraphError, ModelError = lib.ModelError, Model = lib.Model;

// Failures a caller can report (#68 A6): a GraphError says at which stage, at which node (through component
// instances), of which type, at which port or output, besides its message.

var FIXTURES = path.join(__dirname, 'fixtures', 'formats');
function load(f) { return JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8')); }
function fails(f) {
	try { f(); } catch (e) { return e; }
	throw new Error('expected a failure');
}
function where(e) { return { stage : e.stage, node : e.node, type : e.type, port : e.port, output : e.output }; }

describe("Graph failures", function(){
	this.timeout(60000);

	it('names the node, its type and the port of a node\'s own failure', function(){
		var doc = load('crank.graph.json');
		doc.nodes.bore.in.of = '@nothing';
		var e = fails(function(){ new Graph().evaluate(doc); });
		e.should.be.instanceof(GraphError);
		e.message.should.match(/bore\.of/);
		where(e).should.eql({ stage : 'node', node : 'bore', type : 'transform/move', port : 'of', output : undefined });

		doc = load('crank.graph.json');
		doc.nodes.disc.type = 'primitive/nonesuch';
		where(fails(function(){ Graph.compile(doc); })).should.eql({ stage : 'node', node : 'disc', type : 'primitive/nonesuch', port : undefined, output : undefined });

		doc = load('crank.graph.json');
		doc.nodes.disc.in.colour = 3;
		where(fails(function(){ Graph.compile(doc); })).should.eql({ stage : 'node', node : 'disc', type : 'primitive/cylinder', port : 'colour', output : undefined });
	});

	it('names the output of a document\'s failure', function(){
		var doc = load('crank.graph.json');
		where(fails(function(){ new Graph().evaluate(doc, { output : 'nope' }); })).should.eql({ stage : 'document', node : undefined, type : undefined, port : undefined, output : 'nope' });
		doc.outputs.broken = '@crank';
		var e = fails(function(){ Graph.compile(doc); });
		e.should.be.instanceof(GraphError);
		where(e).should.eql({ stage : 'document', node : undefined, type : undefined, port : undefined, output : 'broken' });
	});

	it('names the node of a build\'s failure, with the model\'s error as its cause', function(){
		var doc = load('crank.graph.json');
		doc.nodes.disc.in.radius = 'flywheelRadius / 0';
		var e = fails(function(){ new Graph().evaluate(doc); });
		e.should.be.instanceof(GraphError);
		where(e).should.eql({ stage : 'build', node : 'disc', type : 'primitive/cylinder', port : undefined, output : undefined });
		// a round of a round fails while building, in the kernel's stages
		doc = { version : 2, nodes : {
			b : { type : 'primitive/box', in : { width : 20, depth : 20, height : 10 } },
			r1 : { type : 'finish/round', in : { of : '@b', edges : 'b.+z|*', radius : 2 } },
			m : { type : 'transform/move', in : { of : '@r1', z : 1 } },
			c : { type : 'primitive/cylinder', in : { radius : 3, height : 30 } },
			d : { type : 'boolean/difference', in : { from : '@m', minus : '@c' } },
			r2 : { type : 'finish/round', in : { of : '@d', edges : 'c.*|*', radius : 1 } },
		}, outputs : { part : '@r2' } };
		e = fails(function(){ new Graph().evaluate(doc); });
		e.should.be.instanceof(GraphError);
		e.stage.should.equal('build');
		e.node.should.equal('r2');
		e.type.should.equal('finish/round');
	});

	it('names nodes inside component instances by their path', function(){
		var doc = load('crank-pair.graph.json');
		// (unpinned: the component is edited below)
		delete doc.nodes.crank1.hash; delete doc.nodes.crank2.hash;
		// the component's own node at fault, in either instance
		var broken = function(use){ var d = load(use); d.nodes.bore.in.of = '@nothing'; return d; };
		var e = fails(function(){ new Graph().evaluate(doc, { output : 'flywheel-1', resolve : broken }); });
		where(e).should.eql({ stage : 'node', node : 'crank1/bore', type : 'transform/move', port : 'of', output : undefined });
		// a build failing inside an instance
		var zero = function(use){ var d = load(use); d.nodes.disc.in.radius = 'flywheelRadius / 0'; return d; };
		e = fails(function(){ new Graph().evaluate(doc, { output : 'flywheel-2', resolve : zero }); });
		where(e).should.eql({ stage : 'build', node : 'crank2/disc', type : 'primitive/cylinder', port : undefined, output : undefined });
		// the instance's own input
		var d2 = load('crank-pair.graph.json');
		d2.nodes.crank1.in = { nonesuch : 1 };
		e = fails(function(){ new Graph().evaluate(d2, { output : 'flywheel-1', resolve : function(use){ return load(use); } }); });
		where(e).should.eql({ stage : 'node', node : 'crank1', type : 'component', port : 'nonesuch', output : undefined });
	});

	it('gives a model\'s own failures the feature and its type', function(){
		var e = fails(function(){ new Model().evaluate({ version : 1, output : 'a', features : { a : { type : 'box', min : [0, 0, 0], max : ['1 / 0', 1, 1] } } }); });
		e.should.be.instanceof(ModelError);
		e.feature.should.equal('a');
		e.type.should.equal('box');
	});
});
