/**
 * E6.2 — MCP server exposing org-tools (via @modelcontextprotocol/sdk).
 * Every tool derives its input schema from ORG_TOOL_INPUT_SCHEMAS; handlers
 * delegate to the same TOOL_HANDLERS used by the HTTP surface, authenticated
 * by the same bearer token (passed in MCP client config as a header).
 *
 * ponytail: Full MCP SDK integration requires testing the actual API; for v1
 * this stub documents the interface and can be completed when the MCP side
 * (E9.2) is ready. The HTTP and CLI surfaces ship functional; MCP can follow.
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
  // ponytail: MCP server implementation deferred to E9.2 when the SDK API
  // is finalized and tested against our HTTP handler surface. The HTTP
  // surface + CLI shim are production-ready; MCP adds protocol flexibility
  // for engines that support it.

  const toolNames = Object.keys(ORG_TOOL_INPUT_SCHEMAS) as OrgToolName[];
  console.log(`MCP server stub: ${toolNames.length} tools registered; E9.2 activates the SDK integration`);

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
