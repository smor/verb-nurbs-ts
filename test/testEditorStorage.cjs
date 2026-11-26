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

	it('zips files as stored entries a reader finds through the central directory, each with its CRC-32', function () {
		// the CRC-32 check value of the zip format (and of IEEE 802.3): "123456789" -> 0xCBF43926
		S.crc32(new TextEncoder().encode('123456789')).should.equal(0xCBF43926);
		var a = new Uint8Array([1, 2, 3, 4, 5]), b = new TextEncoder().encode('solid façade\n');
		var buf = S.zip([{ name : 'a.stl', data : a }, { name : 'façade.stl', data : b }]), v = new DataView(buf), u = new Uint8Array(buf);
		// the end record: two entries, then the central directory, each entry pointing at its local header
		var end = buf.byteLength - 22;
		v.getUint32(end, true).should.equal(0x06054b50);
		v.getUint16(end + 10, true).should.equal(2);
		var at = v.getUint32(end + 16, true), found = [];
		for (var i = 0; i < 2; i++) {
			v.getUint32(at, true).should.equal(0x02014b50);
			var n = v.getUint32(at + 24, true), len = v.getUint16(at + 28, true), local = v.getUint32(at + 42, true), crc = v.getUint32(at + 16, true);
			var name = new TextDecoder().decode(u.subarray(at + 46, at + 46 + len));
			v.getUint32(local, true).should.equal(0x04034b50);
			var data = u.subarray(local + 30 + v.getUint16(local + 26, true), local + 30 + v.getUint16(local + 26, true) + n);
			S.crc32(data).should.equal(crc);
			found.push([name, Array.from(data)]);
			at += 46 + len;
		}
		found.should.eql([['a.stl', Array.from(a)], ['façade.stl', Array.from(b)]]);
	});

	it('refuses a fragment that is not a deflated document', async function () {
		var failed = false;
		try { await S.decode('not-a-document'); } catch (e) { failed = true; }
		failed.should.be.true();
	});
});
