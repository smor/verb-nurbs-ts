// ESLint flat config: the recommended JavaScript and TypeScript rules over src/, tuned for numeric geometry code.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: [ "dist/", "node_modules/", "site/", "docs/", "out/", "scratch/", "benchmark/", "examples/", "playground/dist/", "viewer/dist/", "**/*.cjs", "**/*.mjs" ] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: [ "src/**/*.ts", "viewer/**/*.ts", "playground/**/*.ts" ],
        rules: {
            // `_`-prefixed names mark parameters and bindings that are deliberately unused (callbacks, destructuring)
            "@typescript-eslint/no-unused-vars": [ "error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" } ],
            // `any` is confined to the worker/serialisation boundary; flag new uses without failing the build
            "@typescript-eslint/no-explicit-any": "warn",
            // upstream verb pre-declares loop temporaries; harmless, reported for gradual cleanup
            "no-useless-assignment": "warn",
        }
    }
);
