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
import { discoverSkills } from "../skills/discover.js";

export interface ComposeArgs {
  store: Store;
  dataDir: string;
  run: Run;
  workstream: Workstream;
  agent: Agent;
  /** Absolute cwd the engine actually runs this run in (facade.ts's acquireWorkspace) —
   * without this, an agent asked to write a file has nothing in its context to tell it
   * where "here" is, and falls back to guessing from the only other absolute paths it's
   * seen (its memory/skills dirs, which live in the control plane's own data dir, not
   * its workspace) — confirmed live: it guessed wrong every time. */
  workspaceDir: string;
}

/** Composes and writes the run's context file; returns its absolute path. */
export function composeContext(args: ComposeArgs): string {
  const path = resolve(args.dataDir, args.run.input_context_ref);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, composeContextText(args), "utf8");
  return path;
}

/** The pure composition — exported separately so golden-fixture tests need no filesystem. */
export function composeContextText({ store, dataDir, run, workstream, agent, workspaceDir }: ComposeArgs): string {
  return [
    charterSection(store, agent),
    memorySection(dataDir, agent),
    workstreamSection(store, workstream),
    triggerSection(store, run, workstream, agent),
    pendingSection(store, agent),
    orgToolsSection(),
    skillsSection(dataDir, agent),
    workspaceSection(workspaceDir),
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
        task
          ? `**Task:** \`${task.id}\`\n\n**Spec:**\n${task.spec_md}\n\n**Acceptance criteria:**\n` +
            `${task.acceptance_criteria_md}\n\n` +
            "When you're done, call `deliver_task` with this task's id and a summary (that's how " +
            "your delegator sees the result and accepts it); use `update_task` with the id to note " +
            "progress or report a blocker. Without the id above you can't close the loop — don't guess it."
          : "(task not found)"
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
    case "interactive_message":
      // E13 "drop in": these turns never call composeContext — the message goes
      // straight into the already-attached session's stdin, not through a freshly
      // composed context file. This case only exists so the switch stays exhaustive.
      lines.push("A human is talking to you live in an interactive session.");
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
  // The engine reaches these via the `foundry-org-tool` CLI shim (server package's bin),
  // authenticated by the per-run token in its env (mintRunCredential, server.ts). This
  // section is what actually teaches the engine the shim exists and how to call it —
  // without the invocation form + tool list here, the token in env goes unused.
  // ponytail: MCP transport (mcp.ts) is still a stub; the CLI shim is the live path.
  return [
    "# Org-tools",
    "",
    "You are part of an organisation, and you act in it through **org-tools** — commands",
    "wired into this run. Run one from your shell (`$FOUNDRY_ORG_TOOL_BIN` holds the path):",
    "",
    "```",
    "node \"$FOUNDRY_ORG_TOOL_BIN\" <tool-name> '<json-input>'",
    "```",
    "",
    "Auth is already set up (a per-run token is in your env). Each call prints a JSON",
    'result: `{"ok":true,...}` or `{"ok":false,"error":{code,message}}` — react to the code.',
    "**Run `node \"$FOUNDRY_ORG_TOOL_BIN\" <tool-name> --help` for a tool's exact input**",
    "**fields** (don't guess the payload — a wrong call also echoes the fields back).",
    "",
    "- **Delegate** (this is how you spawn a sub-agent): `delegate_task` — assign work to",
    "  another agent; `update_task` / `deliver_task` / `accept_task` / `reject_task` /",
    "  `cancel_task` drive a task's lifecycle; `get_task` reads its state.",
    "- **Communicate:** `send_message`, `escalate` (raise to a human when blocked or",
    "  irreversible), `request_approval` (before an irreversible action), `get_thread`.",
    "- **Discover:** `list_org` (teams/agents you can delegate to — find an `assignee_agent_id`",
    "  or a valid role), `search_history` (full-text search over org history).",
    "",
    "Never assume on anything irreversible — escalate or request approval rather than guess.",
  ].join("\n");
}

function skillsSection(dataDir: string, agent: Agent): string {
  // E11.4: skills directory and discovered skills (one line per skill, matching memory
  // INDEX.md convention). Tolerant: skip invalid skills, render empty state plainly.
  const skillsDir = resolve(dataDir, agent.memory_ref.replace(/[\\/]memory$/, ""), "skills");
  const skills = discoverSkills(dataDir, agent.memory_ref);
  const lines = [
    "# Skills",
    "",
    "You keep every native capability of your engine — its built-in tools, slash commands,",
    "and any globally installed skills or plugins. Those are always available; nothing here",
    "removes them. The directory below is an *additional*, org-specific skill set you curate",
    "yourself — treat it as extra, not as the full list of what you can do.",
    "",
    `Your skills directory: \`${skillsDir}\``,
  ];

  if (skills.length === 0) {
    lines.push("", "(no org-specific skills yet — add them as SKILL.md files in subdirectories here)");
  } else {
    lines.push("");
    for (const skill of skills) {
      lines.push(`- **${skill.name}** — ${skill.description}`);
    }
  }

  return lines.join("\n");
}

function workspaceSection(workspaceDir: string): string {
  if (!workspaceDir) {
    return ["# Workspace", "", "No working directory for this run (not a code workstream)."].join("\n");
  }
  return [
    "# Workspace",
    "",
    `Your working directory for this run: \`${workspaceDir}\``,
    "Use relative paths for file tools — this is separate from your memory/skills directory above.",
  ].join("\n");
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
