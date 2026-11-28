var should = require('should');

// A verdict that is buildable, or unproven only for want of the proofs the kernel does not make by default: the
// Booleans' certificate (`certify`, the "intersections" check) and a sweep's self-contact. Every check passed.
module.exports = function made(v, message) {
	if (v.kind == 'buildable') return v;
	v.kind.should.equal('unproven', message != null ? message : (v.reasons || []).join('; '));
	v.checks.filter(function (c) { return c.passed && c.proven === false; }).forEach(function (c) {
		['intersections', 'self-contact'].should.containEql(c.name);
	});
	return v;
};
