/**
 * Enforces the layer/dependency-direction rule from
 * docs/implementation/contracts.md ("Repository structure"):
 *
 *   L0 core                                  -> depends on nothing in-repo
 *   L1 store, adapter-api                    -> core
 *   L2 adapter-fake, adapter-claude-code      -> adapter-api (+ core)
 *   L2 runtime                                -> core, store, adapter-api
 *   L3 server                                 -> core, store, runtime, adapter-api
 *   L4 ui, cli                                -> core only (talk to L3 over HTTP/SSE, never import it)
 *
 * Packages may only depend on lower layers. Same-layer and upward imports are forbidden.
 */

/** @type {Record<string, string[]>} package name -> allowed in-repo dependency package names */
const ALLOWED = {
  core: [],
  store: ["core"],
  "adapter-api": ["core"],
  "adapter-fake": ["core", "adapter-api"],
  "adapter-claude-code": ["core", "adapter-api"],
  runtime: ["core", "store", "adapter-api"],
  server: ["core", "store", "runtime", "adapter-api"],
  ui: ["core"],
  cli: ["core"],
};

/**
 * Same-layer packages a package may import from *.test.ts only (contracts.md "Testing
 * strategy": "Runtime ... Integration tests: runtime + store + fake adapter scenarios").
 * Production code under `src/**\/!(*.test).ts` stays strictly layered.
 * @type {Record<string, string[]>}
 */
const TEST_ONLY_ALLOWED = {
  runtime: ["adapter-fake"],
  server: ["adapter-fake"],
};

const fromToRules = Object.entries(ALLOWED).flatMap(([from, allowed]) => {
  const testOnly = TEST_ONLY_ALLOWED[from] ?? [];
  const forbiddenAlways = Object.keys(ALLOWED).filter(
    (to) => to !== from && !allowed.includes(to) && !testOnly.includes(to)
  );
  const forbiddenOutsideTests = testOnly.filter((to) => to !== from);

  const rules = [];
  if (forbiddenAlways.length > 0) {
    rules.push({
      name: `layer-violation-${from}`,
      severity: "error",
      comment: `packages/${from} may only depend on lower layers (${
        allowed.length ? allowed.join(", ") : "nothing"
      }); see docs/implementation/contracts.md`,
      from: { path: `^packages/${from}/src` },
      to: {
        path: `^packages/(${forbiddenAlways.join("|")})/src`,
      },
    });
  }
  if (forbiddenOutsideTests.length > 0) {
    rules.push({
      name: `layer-violation-${from}-nontest`,
      severity: "error",
      comment: `packages/${from} may only import ${forbiddenOutsideTests.join(
        ", "
      )} from *.test.ts (integration-test fixture, per contracts.md Testing strategy)`,
      from: { path: `^packages/${from}/src`, pathNot: "\\.test\\.ts$" },
      to: { path: `^packages/(${forbiddenOutsideTests.join("|")})/src` },
    });
  }
  return rules;
});

module.exports = {
  forbidden: [
    ...fromToRules,
    {
      name: "no-l4-to-store-or-runtime",
      severity: "error",
      comment:
        "L4 (ui, cli) must talk to the server over HTTP/SSE only, never import store/runtime/server directly.",
      from: { path: "^packages/(ui|cli)/src" },
      to: { path: "^packages/(store|runtime|server)/src" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
