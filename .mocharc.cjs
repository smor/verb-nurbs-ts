// Mocha configuration. The default time budget per test is scaled under coverage like the slow suites' budgets
// (see test/support/budget.cjs).
const budget = require('./test/support/budget.cjs');

module.exports = {
	spec : 'test/*.cjs',
	timeout : budget(20000),
	parallel : true,
};
