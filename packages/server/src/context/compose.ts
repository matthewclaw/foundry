/**
 * E5.6 ⚠ KEYSTONE — context composition (03 "Context composition", contracts.md "Composed
 * context"). The control plane — not the engine — decides what a run knows. Composed per
 * run at execute time, written to `<dataDir>/runs/<run-id>/context.md` (the run row's
 * `input_context_ref`), so "what did it know when it decided X" is always answerable.
 *
 * The section ORDER and HEADINGS below are a contract: fixed, so context diffs between
 * runs are meaningful. Add sections only at the end; never reorder (golden-fixture tests
 * pin this).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Agent, Run, Workstream } from "@foundry/core";
import type { Store } from "@foundry/store";

export interface ComposeArgs {
  store: Store;
  dataDir: string;
  run: Run;
  workstream: Workstream;
  agent: Agent;
}

/** Composes and writes the run's context file; returns its absolute path. */
export function composeContext(args: ComposeArgs): string {
  const path = resolve(args.dataDir, args.run.input_context_ref);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, composeContextText(args), "utf8");
  return path;
}

/** The pure composition — exported separately so golden-fixture tests need no filesystem. */
export function composeContextText({ store, dataDir, run, workstream, agent }: ComposeArgs): string {
  return [
    charterSection(store, agent),
    memorySection(dataDir, agent),
    workstreamSection(store, workstream),
    triggerSection(store, run, workstream, agent),
    pendingSection(store, agent),
    orgToolsSection(),
  ].join("\n\n");
}

function charterSection(store: Store, agent: Agent): string {
  const charter = store.agents.getCharter(agent.id);
  return [
    "# Charter",
    "",
    `You are **${agent.name}**, ${agent.role}. (agent:${agent.id}, charter v${agent.charter_version})`,
    "",
    charter?.body_md ?? "(no charter recorded)",
  ].join("\n");
}

function memorySection(dataDir: string, agent: Agent): string {
  const memoryDir = resolve(dataDir, agent.memory_ref);
  const skillsDir = resolve(dataDir, agent.memory_ref.replace(/[\\/]memory$/, ""), "skills");
  const indexPath = join(memoryDir, "INDEX.md");
  const index = existsSync(indexPath) ? readFileSync(indexPath, "utf8").trim() : null;
  return [
    "# Memory",
    "",
    "> Recalled memory (provenance: your own notes from earlier work) — not new input.",
    "",
    `Your memory directory (read and curate it with ordinary file tools): \`${memoryDir}\``,
    `Your skills directory: \`${skillsDir}\``,
    "",
    "## Memory index",
    "",
    index ?? "(no memory index yet — create INDEX.md as you learn things worth keeping)",
    "",
    "> Curation: when you learn something durable (a fact, a decision, a procedure that",
    "> worked), write it to your memory/skills directory and keep INDEX.md current — one",
    "> line per file. Fix or delete notes you discover to be wrong. Your memory is",
    "> git-versioned after every run; edit freely.",
  ].join("\n");
}

function workstreamSection(store: Store, workstream: Workstream): string {
  const lines = [
    "# Workstream",
    "",
    `**${workstream.title}** (workstream:${workstream.id}, state: ${workstream.state})`,
    "",
    workstream.goal_md || "(no goal recorded)",
  ];
  // Prior-run summary (03: "summary of prior runs; engine session resume where supported")
  const prior = store.runs
    .list({ workstream_id: workstream.id })
    .filter((r) => r.ended_at !== null)
    .slice(-5);
  if (prior.length > 0) {
    lines.push("", "## Prior runs", "");
    for (const r of prior) {
      const outcome = r.result?.outcome ?? r.state;
      const text = r.result?.final_text ? ` — ${truncate(r.result.final_text, 300)}` : "";
      lines.push(`- run ${r.seq} (${outcome})${text}`);
    }
  }
  return lines.join("\n");
}

function triggerSection(store: Store, run: Run, workstream: Workstream, agent: Agent): string {
  const lines = ["# Trigger", ""];
  switch (run.trigger) {
    case "human_message":
    case "agent_message": {
      const thread = store.commands.getOrCreateThread("workstream", workstream.id);
      const last = store.messages.listByThread(thread.id).at(-1);
      lines.push(
        run.trigger === "human_message" ? "A human sent you a message on this workstream:" : "Another agent sent you a message on this workstream:",
        "",
        last ? `> ${last.body_md.split("\n").join("\n> ")}` : "(message not found — check the workstream thread)"
      );
      break;
    }
    case "task_assigned": {
      const task = workstream.task_id ? store.tasks.get(workstream.task_id) : undefined;
      lines.push(
        "You have been assigned a task:",
        "",
        task ? `**Spec:**\n${task.spec_md}\n\n**Acceptance criteria:**\n${task.acceptance_criteria_md}` : "(task not found)"
      );
      break;
    }
    case "approval_granted": {
      lines.push("An approval you were waiting on has been decided. Continue the work accordingly.");
      const decided = store.approvals.listDecidedFor(agent.actor_id, 3);
      if (decided.length > 0) {
        lines.push("", "Recent decisions:");
        for (const a of decided) {
          const desc = (a.payload as { description?: string } | undefined)?.description ?? a.kind;
          lines.push(`- ${a.state.toUpperCase()}: ${desc} (approval:${a.id})`);
        }
      }
      break;
    }
    case "resume":
      lines.push("You are resuming previous work on this workstream after an interruption. Pick up where the prior runs left off.");
      break;
    case "schedule":
      lines.push("This run was triggered by your schedule. Review the workstream and act on anything that needs attention.");
      break;
  }
  return lines.join("\n");
}

function pendingSection(store: Store, agent: Agent): string {
  const open = store.messages.listOpenForActor(agent.actor_id);
  const lines = ["# Pending items", ""];
  if (open.length === 0) {
    lines.push("(none)");
  } else {
    for (const m of open) {
      lines.push(`- [${m.type}] from actor:${m.from_actor_id} — ${truncate(m.body_md, 200)} (message:${m.id})`);
    }
  }
  return lines.join("\n");
}

function orgToolsSection(): string {
  // ponytail: connection info (MCP config / per-run token) lands here in E6.2/E6.1 —
  // until then this section carries only the standing instructions, so the section
  // order/heading contract is already final.
  return [
    "# Org-tools",
    "",
    "You are part of an organisation. Use the Foundry org-tools (when connected) to",
    "delegate tasks, send typed messages, escalate, request approvals, and search your",
    "history — never assume; escalate rather than guess on anything irreversible. Policy",
    "limits (budget, delegation depth) are enforced at the tool boundary and errors carry",
    "machine-readable codes you can react to.",
  ].join("\n");
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
