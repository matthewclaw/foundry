import { describe, expect, it } from "vitest";
import { newAgentId, newTeamId } from "../ids.js";
import {
  DelegateTaskInputSchema,
  EscalateInputSchema,
  ListOrgInputSchema,
  ORG_TOOL_INPUT_SCHEMAS,
  RequestApprovalInputSchema,
  SearchHistoryInputSchema,
  SendMessageInputSchema,
} from "./schemas.js";

describe("delegate_task", () => {
  const base = {
    title: "Fix bug #482",
    spec_md: "spec",
    acceptance_criteria_md: "- [ ] repro fixed",
  };

  it("accepts an explicit assignee", () => {
    expect(() =>
      DelegateTaskInputSchema.parse({ ...base, assignee_agent_id: newAgentId() })
    ).not.toThrow();
  });

  it("accepts a routing spec", () => {
    expect(() =>
      DelegateTaskInputSchema.parse({ ...base, routing: { team_id: newTeamId() } })
    ).not.toThrow();
  });

  it("rejects neither assignee nor routing", () => {
    expect(() => DelegateTaskInputSchema.parse(base)).toThrow();
  });

  it("rejects both assignee and routing", () => {
    expect(() =>
      DelegateTaskInputSchema.parse({
        ...base,
        assignee_agent_id: newAgentId(),
        routing: { role: "backend-engineer" },
      })
    ).toThrow();
  });

  it("rejects missing acceptance criteria (ADR-006)", () => {
    expect(() =>
      DelegateTaskInputSchema.parse({
        title: "x",
        spec_md: "y",
        acceptance_criteria_md: "",
        assignee_agent_id: newAgentId(),
      })
    ).toThrow();
  });
});

describe("send_message", () => {
  it("excludes escalation and completion from the sendable type set", () => {
    expect(() =>
      SendMessageInputSchema.parse({
        type: "escalation",
        to_actor_id: newAgentId(),
        body_md: "x",
      })
    ).toThrow();
    expect(() =>
      SendMessageInputSchema.parse({
        type: "completion",
        to_actor_id: newAgentId(),
        body_md: "x",
      })
    ).toThrow();
  });

  it("requires exactly one of to_actor_id / to_team_id", () => {
    expect(() =>
      SendMessageInputSchema.parse({ type: "status", body_md: "x" })
    ).toThrow();
    expect(() =>
      SendMessageInputSchema.parse({
        type: "status",
        to_actor_id: newAgentId(),
        to_team_id: newTeamId(),
        body_md: "x",
      })
    ).toThrow();
    expect(() =>
      SendMessageInputSchema.parse({ type: "status", to_actor_id: newAgentId(), body_md: "x" })
    ).not.toThrow();
  });
});

describe("escalate", () => {
  it("requires a closed-set severity", () => {
    expect(() =>
      EscalateInputSchema.parse({ severity: "decision_needed", body_md: "help" })
    ).not.toThrow();
    expect(() => EscalateInputSchema.parse({ severity: "urgent", body_md: "help" })).toThrow();
  });
});

describe("search_history", () => {
  it("scope is optional and, when present, closed-set", () => {
    expect(() => SearchHistoryInputSchema.parse({ query: "auth bug" })).not.toThrow();
    expect(() =>
      SearchHistoryInputSchema.parse({ query: "auth bug", scope: "org" })
    ).not.toThrow();
    expect(() =>
      SearchHistoryInputSchema.parse({ query: "auth bug", scope: "everywhere" })
    ).toThrow();
  });
});

describe("request_approval", () => {
  it("requires kind and description", () => {
    expect(() =>
      RequestApprovalInputSchema.parse({ kind: "budget_increase", description: "need $50 more" })
    ).not.toThrow();
    expect(() => RequestApprovalInputSchema.parse({ kind: "budget_increase" })).toThrow();
  });
});

describe("list_org", () => {
  it("takes no input", () => {
    expect(() => ListOrgInputSchema.parse({})).not.toThrow();
    expect(() => ListOrgInputSchema.parse({ extra: true })).toThrow();
  });
});

describe("ORG_TOOL_INPUT_SCHEMAS registry", () => {
  it("has exactly the contracts.md toolset plus E8.1's accept_task/reject_task and E8.6's cancel_task (OPEN_ISSUES #35)", () => {
    expect(new Set(Object.keys(ORG_TOOL_INPUT_SCHEMAS))).toEqual(
      new Set([
        "delegate_task",
        "update_task",
        "deliver_task",
        "accept_task",
        "reject_task",
        "cancel_task",
        "send_message",
        "escalate",
        "request_approval",
        "search_history",
        "get_task",
        "get_thread",
        "list_org",
      ])
    );
  });
});
