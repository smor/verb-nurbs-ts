// ESLint flat config: the recommended JavaScript and TypeScript rules over src/, tuned for numeric geometry code.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: [ "dist/", "node_modules/", "site/", "docs/", "out/", "scratch/", "benchmark/", "examples/", "playground/dist/", "viewer/dist/", "editor/dist/", "**/*.cjs", "**/*.mjs" ] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: [ "src/**/*.ts", "viewer/**/*.ts", "playground/**/*.ts", "editor/**/*.ts", "editor/**/*.tsx" ],
        rules: {
            // `_`-prefixed names mark parameters and bindings that are deliberately unused (callbacks, destructuring)
            "@typescript-eslint/no-unused-vars": [ "error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" } ],
            // `any` is confined to the worker/serialisation boundary; flag new uses without failing the build
            "@typescript-eslint/no-explicit-any": "warn",
            // upstream verb pre-declares loop temporaries; harmless, reported for gradual cleanup
            "no-useless-assignment": "warn",
            // a suppression must say why
            "@typescript-eslint/ban-ts-comment": [ "error", { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true } ],
        }
    },
    {
        files: [ "src/**/*.ts" ],
        rules: {
            // geometry must be reproducible: no hidden randomness in library code (see AGENTS.md)
            "no-restricted-properties": [ "error", { object: "Math", property: "random", message: "Library code must be deterministic. Take a seeded generator as a parameter." } ],
        }
    },
    {
        // Legacy upstream verb: randomised split points in subdivision. Known, listed here so the list can only shrink.
        files: [ "src/eval/Tess.ts", "src/core/SurfaceBoundingBoxTree.ts", "src/core/LazyCurveBoundingBoxTree.ts" ],
        rules: { "no-restricted-properties": "off" }
    },
    {
        linterOptions: { reportUnusedDisableDirectives: "error" }
    }
);
