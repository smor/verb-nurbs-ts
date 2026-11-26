var should = require('should');
var fs = require('fs');
var path = require('path');
var esbuild = require('esbuild');

// The editor's links (editor/storage.ts): a graph document travels whole in a link's fragment, deflated and
// base64url-encoded, and comes back the same.

var S;
before(function () {
	var out = esbuild.buildSync({ entryPoints : [path.join(__dirname, '..', 'editor', 'storage.ts')], bundle : true, format : 'cjs', platform : 'node', write : false, logLevel : 'error' });
	var m = { exports : {} };
	new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
	S = m.exports;
});

describe('editor links (editor/storage.ts)', function () {

	it('a document comes back from its link the same, and the link uses only URL-safe characters', async function () {
		var doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'editor', 'samples', 'art-nouveau-vase.graph.json'), 'utf8'));
		doc.meta.note = 'accents, quotes and symbols: Façade « » ' + "'" + ' " & # % ? = / + ±';
		var text = await S.encode(doc);
		text.should.match(/^[A-Za-z0-9_-]+$/);
		(await S.decode(text)).should.eql(doc);
		(await S.fromLink('#' + S.LINK_KEY + '=' + text)).should.eql(doc);
		should(await S.fromLink('#something-else')).be.null();
	});

	it('the link is compressed: a large collection fits in a few kilobytes per hundred nodes', async function () {
		var doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'editor', 'samples', 'ceramics', 'italy-by-period.graph.json'), 'utf8'));
		var json = JSON.stringify(doc), text = await S.encode(doc);
		(text.length).should.be.below(json.length / 2);
		(await S.decode(text)).should.eql(doc);
	});

	it('refuses a fragment that is not a deflated document', async function () {
		var failed = false;
		try { await S.decode('not-a-document'); } catch (e) { failed = true; }
		failed.should.be.true();
	});
});
