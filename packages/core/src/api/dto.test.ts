import { describe, expect, it } from "vitest";
import { newAgentId } from "../ids.js";
import {
  AgentLifecycleActionSchema,
  CreateAgentRequestSchema,
  CreateTaskRequestSchema,
  CreateWorkstreamRequestSchema,
  PostWorkstreamMessageRequestSchema,
  RejectTaskRequestSchema,
} from "./dto.js";
import { POLICY_ERROR_CODES, PolicyErrorSchema, ProblemDetailsSchema, toolResultSchema } from "./errors.js";
import { z } from "zod";

describe("CreateAgentRequestSchema", () => {
  it("accepts a minimal valid agent creation request", () => {
    expect(() =>
      CreateAgentRequestSchema.parse({
        name: "Orbit Backend Engineer",
        role: "backend-engineer",
        charter_md: "# Purpose\n\nBuild things.",
        engine: { id: "claude-code" },
      })
    ).not.toThrow();
  });
});

describe("AgentLifecycleActionSchema", () => {
  it("is exactly suspend/resume/retire", () => {
    for (const a of ["suspend", "resume", "retire"]) {
      expect(AgentLifecycleActionSchema.parse(a)).toBe(a);
    }
    expect(() => AgentLifecycleActionSchema.parse("delete")).toThrow();
  });
});

describe("CreateWorkstreamRequestSchema", () => {
  it("requires an agent_id, title, goal_md", () => {
    expect(() =>
      CreateWorkstreamRequestSchema.parse({
        agent_id: newAgentId(),
        title: "Auth refactor",
        goal_md: "Do the thing",
      })
    ).not.toThrow();
    expect(() => CreateWorkstreamRequestSchema.parse({ title: "x", goal_md: "y" })).toThrow();
  });
});

describe("PostWorkstreamMessageRequestSchema", () => {
  it("defaults kind to message", () => {
    const parsed = PostWorkstreamMessageRequestSchema.parse({ body_md: "hi" });
    expect(parsed.kind).toBe("message");
  });

  it("accepts redirect explicitly", () => {
    const parsed = PostWorkstreamMessageRequestSchema.parse({
      kind: "redirect",
      body_md: "change course",
    });
    expect(parsed.kind).toBe("redirect");
  });
});

describe("CreateTaskRequestSchema (human delegation) matches delegate_task's schema", () => {
  it("rejects a task without acceptance criteria, same as the org-tool", () => {
    expect(() =>
      CreateTaskRequestSchema.parse({
        title: "x",
        spec_md: "y",
        acceptance_criteria_md: "",
        assignee_agent_id: newAgentId(),
      })
    ).toThrow();
  });
});

describe("RejectTaskRequestSchema", () => {
  it("requires a reason", () => {
    expect(() => RejectTaskRequestSchema.parse({})).toThrow();
    expect(() => RejectTaskRequestSchema.parse({ reason: "needs more tests" })).not.toThrow();
  });
});

describe("policy error codes", () => {
  it("PolicyErrorSchema carries one of the enumerated machine-readable codes", () => {
    for (const code of POLICY_ERROR_CODES) {
      expect(() => PolicyErrorSchema.parse({ code, message: "nope" })).not.toThrow();
    }
    expect(() => PolicyErrorSchema.parse({ code: "made_up", message: "nope" })).toThrow();
  });

  it("ProblemDetailsSchema defaults type to about:blank and accepts an optional code", () => {
    const parsed = ProblemDetailsSchema.parse({ title: "Bad Request", status: 400 });
    expect(parsed.type).toBe("about:blank");
    expect(() =>
      ProblemDetailsSchema.parse({ title: "Nope", status: 422, code: "budget_exceeded" })
    ).not.toThrow();
  });

  it("toolResultSchema discriminates ok:true/false and validates each branch", () => {
    const schema = toolResultSchema(z.object({ task_id: z.string() }));
    expect(schema.parse({ ok: true, data: { task_id: "t1" } })).toEqual({
      ok: true,
      data: { task_id: "t1" },
    });
    expect(
      schema.parse({ ok: false, error: { code: "budget_exceeded", message: "too much" } })
    ).toEqual({ ok: false, error: { code: "budget_exceeded", message: "too much" } });
    expect(() => schema.parse({ ok: true, data: { task_id: 123 } })).toThrow();
  });
});
