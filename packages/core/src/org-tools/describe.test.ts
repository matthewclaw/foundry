import { describe, it, expect } from "vitest";
import { describeOrgToolInput, listOrgTools } from "./describe.js";

describe("describeOrgToolInput", () => {
  it("lists deliver_task's fields with required/optional and the ref format", () => {
    const help = describeOrgToolInput("deliver_task");
    expect(help).toContain("task_id: string (required)");
    expect(help).toContain("summary_md: string (required)");
    // artifact_refs is Ref[] — the described element format is what agents kept guessing wrong
    expect(help).toMatch(/artifact_refs: .*<kind>:<id>.*\[\] \(required\)/);
  });

  it("marks optional fields (delegate_task, whose schema is a refined object) optional", () => {
    const help = describeOrgToolInput("delegate_task");
    expect(help).toContain("title: string (required)");
    expect(help).toContain("acceptance_criteria_md: string (required)");
    expect(help).toContain("assignee_agent_id: string (optional)");
    expect(help).toContain("routing: { team_id, role } (optional)");
  });

  it("lists every tool name", () => {
    const list = listOrgTools();
    for (const name of ["delegate_task", "deliver_task", "list_org", "search_history"]) {
      expect(list).toContain(name);
    }
  });
});
