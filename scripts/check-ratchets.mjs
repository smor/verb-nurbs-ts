// Checks that no quality gate was loosened relative to a base revision (see AGENTS.md, "Ratchets").
//
//   node scripts/check-ratchets.mjs [base]      base defaults to $RATCHET_BASE, then origin/main
//
// Compared: the lint warning cap, the coverage thresholds, the strict compiler flags, and the list of files
// exempt from the determinism rule. Exits non-zero, naming each loosened gate.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? process.env.RATCHET_BASE ?? "origin/main";

function atBase(path) {
    try {
        return execFileSync("git", [ "show", `${base}:${path}` ], { encoding: "utf8", stdio: [ "ignore", "pipe", "ignore" ] });
    } catch {
        return null;
    }
}

function current(path) {
    return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// tsconfig.json may hold comments; strip them before parsing
function json(text) {
    return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
}

function coverage(pkg) {
    const script = pkg.scripts?.coverage ?? "";
    const out = {};
    for (const k of [ "lines", "branches", "functions", "statements" ]) {
        const m = script.match(new RegExp(`--${k}\\s+(\\d+(?:\\.\\d+)?)`));
        if (m) out[k] = Number(m[1]);
    }
    return out;
}

function exempt(config) {
    const m = config.match(/Legacy upstream verb[\s\S]*?files:\s*\[([^\]]*)\]/);
    return m ? [ ...m[1].matchAll(/"([^"]+)"/g) ].map(x => x[1]) : [];
}

const problems = [];
const basePkgText = atBase("package.json");
if (basePkgText === null) {
    console.log(`ratchets: base ${base} not found, nothing to compare`);
    process.exit(0);
}

const [ was, now ] = [ JSON.parse(basePkgText), JSON.parse(current("package.json")) ];

// older revisions wrote the cap straight into the lint script
const cap = pkg => Number(pkg.config?.maxLintWarnings ?? pkg.scripts?.lint?.match(/--max-warnings\s+(\d+)/)?.[1]);
const capWas = cap(was), capNow = Number(now.config?.maxLintWarnings);
if (!Number.isFinite(capNow)) problems.push("package.json config.maxLintWarnings is missing");
else if (Number.isFinite(capWas) && capNow > capWas) problems.push(`lint warning cap went up: ${capWas} → ${capNow}`);

const covWas = coverage(was), covNow = coverage(now);
for (const [ k, v ] of Object.entries(covWas)) {
    if (!(k in covNow)) problems.push(`coverage threshold --${k} was removed (was ${v})`);
    else if (covNow[k] < v) problems.push(`coverage threshold --${k} went down: ${v} → ${covNow[k]}`);
}

const tsWasText = atBase("tsconfig.json");
if (tsWasText !== null) {
    const optWas = json(tsWasText).compilerOptions ?? {}, optNow = json(current("tsconfig.json")).compilerOptions ?? {};
    for (const [ k, v ] of Object.entries(optWas)) {
        if (v === true && /^(strict|no[A-Z]|exactOptional|useUnknown|forceConsistent)/.test(k) && optNow[k] !== true) {
            problems.push(`compiler flag ${k} was turned off`);
        }
    }
}

const lintWasText = atBase("eslint.config.js");
if (lintWasText !== null) {
    const before = new Set(exempt(lintWasText));
    for (const f of exempt(current("eslint.config.js"))) {
        if (before.size > 0 && !before.has(f)) problems.push(`${f} was added to the determinism exemptions`);
    }
}

if (problems.length) {
    console.error(`ratchets: gates loosened relative to ${base}:\n` + problems.map(p => `  - ${p}`).join("\n"));
    console.error("Fix the code instead, or loosen the gate in its own pull request with a reason (AGENTS.md).");
    process.exit(1);
}
console.log(`ratchets: no gate loosened relative to ${base}`);
