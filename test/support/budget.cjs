// Time budgets for slow suites.
//
// A budget guards against performance regressions in the plain test runs (`npm test`, and CI on Node 20 and 24 on main and releases).
// Under coverage (c8 sets NODE_V8_COVERAGE) every function is instrumented and runs several times slower, so the
// same budget would fail for reasons unrelated to the change being tested: there it is scaled up.
const SLOWDOWN = process.env.NODE_V8_COVERAGE ? 5 : 1;

module.exports = function budget(ms) {
	return ms * SLOWDOWN;
};
