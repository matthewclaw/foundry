// Regenerates docs/generated/event-catalogue.md from the built @foundry/core event
// catalogue. Not part of the package's exported API — a dev-time doc generator only.
// Run after `pnpm build`: `node scripts/generate-catalogue.mjs`.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateCatalogueMarkdown } from "../dist/events/catalogue.js";

const outDir = fileURLToPath(new URL("../../../docs/generated/", import.meta.url));
const outFile = fileURLToPath(new URL("../../../docs/generated/event-catalogue.md", import.meta.url));

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, generateCatalogueMarkdown());
console.log(`wrote ${outFile}`);
