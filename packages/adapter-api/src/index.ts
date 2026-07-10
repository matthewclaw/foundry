// @foundry/adapter-api — L1 execution-adapter contract. No engine I/O. See
// docs/implementation/contracts.md "@foundry/adapter-api".

export * from "./types.js";
// The conformance suite imports vitest and would crash any non-test consumer (e.g. the
// server daemon importing an adapter package) — it lives on the "./conformance"
// subpath export, for *.test.ts files only.
