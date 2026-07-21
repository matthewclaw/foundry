#!/usr/bin/env node
/**
 * E6.2 — CLI shim for org-tools: reads FOUNDRY_ORG_TOOLS_URL + FOUNDRY_ORG_TOOLS_TOKEN,
 * argv = <tool-name> <json-input>, POSTs to <url>/<tool-name> with bearer token,
 * prints result JSON, exits 0 when result comes back (even {ok:false}), exits 1 on transport error.
 */
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { ORG_TOOL_INPUT_SCHEMAS, describeOrgToolInput, listOrgTools, type OrgToolName } from "@foundry/core";

// `--help` (or no tool): print the tool roster or a tool's exact input schema, derived
// from the Zod definitions — no network/auth needed. This is the discovery path so an
// agent never has to guess a payload (or which fields a tool wants).
const helpIdx = process.argv.findIndex((a) => a === "--help" || a === "-h");
const firstArg = process.argv[2];
if (helpIdx !== -1 || !firstArg) {
  const tool = firstArg && firstArg in ORG_TOOL_INPUT_SCHEMAS ? (firstArg as OrgToolName) : undefined;
  console.log(tool ? describeOrgToolInput(tool) : `Usage: foundry-org-tool <tool-name> '<json-input>'\n\n${listOrgTools()}`);
  process.exit(0);
}

const url = process.env.FOUNDRY_ORG_TOOLS_URL;
const token = process.env.FOUNDRY_ORG_TOOLS_TOKEN;

if (!url || !token) {
  console.error("Error: FOUNDRY_ORG_TOOLS_URL and FOUNDRY_ORG_TOOLS_TOKEN env vars required");
  process.exit(1);
}

const urlStr = url;
const tokenStr = token;

if (process.argv.length < 4) {
  console.error("Usage: foundry-org-tool <tool-name> <json-input>");
  process.exit(1);
}

const toolName = process.argv[2]!;
let input: unknown = {};
try {
  input = JSON.parse(process.argv[3]!);
} catch (e) {
  console.error(`Invalid JSON input: ${e}`);
  process.exit(1);
}

// POST to <url>/<tool-name>
const toolUrl = new URL(`${urlStr}/${toolName}`);
const isHttps = toolUrl.protocol === "https:";
const reqFn = isHttps ? httpsRequest : request;

const payload = JSON.stringify(input);
const req = reqFn(
  {
    hostname: toolUrl.hostname,
    port: toolUrl.port || (isHttps ? 443 : 80),
    path: toolUrl.pathname + toolUrl.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Authorization: `Bearer ${tokenStr}`,
    },
  },
  (res) => {
    let body = "";
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      // Print result (even 4xx/5xx — the ToolResult contains the error in-band)
      console.log(body);
      // Always exit 0 when a response comes back (per contract: {ok:true} or {ok:false} both go to stdout)
      process.exit(0);
    });
  }
);

req.on("error", (e) => {
  console.error(`Transport error: ${e.message}`);
  process.exit(1);
});

req.write(payload);
req.end();
