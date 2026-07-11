/**
 * E6.2 — MCP server exposing org-tools (real SDK integration deferred to E9.2,
 * OPEN_ISSUES #33). Every tool derives its input schema from ORG_TOOL_INPUT_SCHEMAS;
 * handlers delegate to the same TOOL_HANDLERS used by the HTTP surface, authenticated
 * by the same bearer token (passed in MCP client config as a header).
 *
 * ponytail: this is a documented stub, not a wired MCP SDK server — no
 * @modelcontextprotocol/sdk dependency exists yet (add it back when E9.2 wires this up
 * for real). The HTTP + CLI shim surfaces are the two functional transports today.
 */
import { ORG_TOOL_INPUT_SCHEMAS, type OrgToolName } from "@foundry/core";
import type { RouteContext } from "../server.js";

/**
 * Create an MCP server that exposes org-tools as tools.
 * Handlers authenticate via bearer token in the MCP session headers.
 *
 * Implementation requires:
 * 1. Register each org-tool as an MCP Tool via the SDK
 * 2. For each tool call, resolve the token (from MCP session context)
 * 3. Delegate to TOOL_HANDLERS with the same RunCredential
 * 4. Return ToolResult as the response
 *
 * This is a documented stub for E9.2 (MCP integration with adapter).
 */
export function createOrgToolsMcpServer(_ctx: RouteContext): unknown {
  const toolNames = Object.keys(ORG_TOOL_INPUT_SCHEMAS) as OrgToolName[];

  return {
    id: "foundry-org-tools-mcp",
    name: "foundry-org-tools",
    version: "0.1.0",
    capabilities: { tools: {} },
    tools: toolNames.map((name) => ({
      name,
      description: `Foundry org-tool: ${name}`,
      inputSchema: { type: "object" },
    })),
  };
}
