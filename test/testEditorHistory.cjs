var should = require('should');
var path = require('path');
var esbuild = require('esbuild');
var lib = require('../dist/index.js');
var budget = require('./support/budget.cjs');
var Graph = lib.Graph;

// The editor's undo history (editor/history.ts): snapshots of the graph document. The module has no DOM, so it is
// bundled here and run in Node.

var load = function (file) {
	var out = esbuild.buildSync({ entryPoints : [path.join(__dirname, '..', 'editor', file)], bundle : true, format : 'cjs',
		platform : 'node', write : false, logLevel : 'error' });
	var m = { exports : {} };
	new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
	return m.exports;
};
var H = load('history.ts');
var SAMPLE = load('sample.ts').SAMPLE;
var clone = function (x) { return JSON.parse(JSON.stringify(x)); };
var same = function (a, b) { JSON.stringify(a).should.equal(JSON.stringify(b)); };

describe('editor undo history', function () {

	it('undoing every edit returns each earlier document byte for byte, and redoing returns the later ones', function () {
		var h = new H.History(), doc = clone(SAMPLE), states = [clone(doc)];
		h.reset(doc);
		var edits = [
			function (d) { d.nodes.box.in.width = 80; },
			function (d) { d.nodes.extra = { type : 'number', in : { value : 3 } }; },
			function (d) { delete d.nodes.extra; d.view = { show : 'cut' }; },
			function (d) { d.nodes.round.in.radius = 2; },
		];
		edits.forEach(function (e, i) { e(doc); h.commit(doc, null, 5000 * i).should.be.true(); states.push(clone(doc)); });
		for (var i = states.length - 2; i >= 0; i--) same(h.undo(), states[i]);
		h.canUndo.should.be.false();
		should(h.undo()).be.null();
		for (var j = 1; j < states.length; j++) same(h.redo(), states[j]);
		h.canRedo.should.be.false();
		should(h.redo()).be.null();
	});

	it('the document returned is a fresh object: mutating it does not change the history', function () {
		var h = new H.History(), doc = clone(SAMPLE);
		h.reset(doc);
		doc.nodes.box.in.width = 80; h.commit(doc);
		var back = h.undo();
		back.nodes.box.in.width = 1;
		same(h.redo().nodes.box.in.width, 80);
		same(h.undo().nodes.box.in.width, SAMPLE.nodes.box.in.width);
	});

	it('an edit after an undo drops the redo branch, and an unchanged document records nothing', function () {
		var h = new H.History(), doc = clone(SAMPLE);
		h.reset(doc);
		h.commit(doc).should.be.false();
		doc.nodes.box.in.width = 80; h.commit(doc);
		doc = h.undo();
		doc.nodes.box.in.width = 70; h.commit(doc).should.be.true();
		h.canRedo.should.be.false();
		h.undo().nodes.box.in.width.should.equal(SAMPLE.nodes.box.in.width);
	});

	it('a slider drag is one step; a pause, another key or an undo starts a new one', function () {
		var h = new H.History(), doc = clone(SAMPLE), w0 = SAMPLE.nodes.box.in.width;
		h.reset(doc);
		for (var t = 0; t < 30; t++) { doc.nodes.box.in.width = 61 + t; h.commit(doc, 'box.width', 100 * t); }
		h.undo().nodes.box.in.width.should.equal(w0);
		h.canUndo.should.be.false();
		doc = h.redo();
		doc.nodes.box.in.width.should.equal(90);
		// a pause longer than the coalescing window
		doc.nodes.box.in.width = 95; h.commit(doc, 'box.width', 100 * 29 + H.COALESCE_MS);
		h.undo().nodes.box.in.width.should.equal(90);
		// a different slider, right away
		doc = h.redo();
		doc.nodes.box.in.depth = 50; h.commit(doc, 'box.depth', 100 * 29 + H.COALESCE_MS + 10);
		h.undo().nodes.box.in.width.should.equal(95);
	});

	it('dragging a slider back to where it began leaves no step, and the next edit does not merge into an older one', function () {
		var h = new H.History(), doc = clone(SAMPLE), w0 = SAMPLE.nodes.box.in.width;
		h.reset(doc);
		doc.nodes.box.in.height = 30; h.commit(doc, null, 0);
		doc.nodes.box.in.width = w0 + 5; h.commit(doc, 'box.width', 5000);
		doc.nodes.box.in.width = w0; h.commit(doc, 'box.width', 5100);
		doc.nodes.box.in.width = w0 + 1; h.commit(doc, 'box.width', 5200);
		same(h.undo().nodes.box.in, Object.assign(clone(SAMPLE.nodes.box.in), { height : 30 }));
		same(h.undo(), SAMPLE);
	});

	it('keeps the most recent MAX_STEPS steps', function () {
		var h = new H.History(), doc = { version : 2, nodes : {}, n : 0 };
		h.reset(doc);
		for (var i = 1; i <= H.MAX_STEPS + 50; i++) { doc.n = i; h.commit(doc, null, 0); }
		var undone = 0, last = null;
		while (h.canUndo) { last = h.undo(); undone++; }
		undone.should.equal(H.MAX_STEPS);
		last.n.should.equal(50);
	});

	it('an undone graph evaluates to the solid it had before the edit, from the evaluator\'s cache', function () {
		this.timeout(budget(60000));
		var h = new H.History(), g = new Graph(), doc = clone(SAMPLE);
		h.reset(doc);
		var before = g.evaluate(doc);
		doc.nodes.box.in.width = 80; h.commit(doc);
		var after = g.evaluate(doc);
		after.result.report.volume.should.be.above(before.result.report.volume * 1.1);
		var back = g.evaluate(h.undo());
		back.result.report.volume.should.equal(before.result.report.volume);
		Object.keys(back.nodes).forEach(function (k) { back.nodes[k].should.not.equal('built'); });
		same(back.faceNames, before.faceNames);
	});
});
