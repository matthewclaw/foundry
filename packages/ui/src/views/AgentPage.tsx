/**
 * Agent page (doc-06): identity, status, charter (editable, versioned), open workstreams
 * (linked to their timeline), open tasks, relationships, engine. Charter edits PATCH
 * /api/agents/:id {charter_md} and invalidate the agent query.
 */
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { AgentPageDto } from "../api/types.js";
import Markdown from "react-markdown";
import {
  Badge,
} from "./OrgView.js";
import {
  Button,
  EmptyState,
  ErrorState,
  ErrorText,
  Icon,
  Label,
  Loading,
  PageHeader,
  Section,
  TextArea,
  TextInput,
  cx,
} from "../components/ui.js";

function CharterSection({ agentId, charter }: { agentId: string; charter: AgentPageDto["charter"] }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: (charter_md: string) => apiClient.patchAgent(agentId, { charter_md }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
    },
  });

  return (
    <Section
      title="Charter"
      meta={charter && <span className="font-mono text-xs text-gray-500">v{charter.version}</span>}
      actions={
        !editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(charter?.body_md ?? "");
              setEditing(true);
            }}
          >
            <Icon name="pencil" size={12} /> Edit
          </Button>
        )
      }
    >
      {editing ? (
        <div>
          <TextArea
            aria-label="Charter editor"
            className="h-56 font-mono text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-3">
            <Button variant="primary" size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {save.error && <ErrorText error={save.error} />}
          </div>
        </div>
      ) : charter ? (
        <div className="prose prose-sm prose-invert max-w-none">
          <Markdown>{charter.body_md}</Markdown>
        </div>
      ) : (
        <p className="text-sm text-gray-500">No charter yet — use Edit to write one.</p>
      )}
    </Section>
  );
}

function NewWorkstreamForm({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [useWorktree, setUseWorktree] = useState(true);
  const create = useMutation({
    mutationFn: () =>
      apiClient.createWorkstream({
        agent_id: agentId,
        title,
        goal_md: goal,
        workspace_ref: !repoPath.trim()
          ? undefined
          : useWorktree
            ? // The runtime only ever reads `repo_path` off a git_worktree ref — it derives
              // its own worktree location and branch (E4.4) — so worktree_path/branch here
              // are schema-required placeholders, not settings that do anything.
              { kind: "git_worktree", repo_path: repoPath.trim(), worktree_path: repoPath.trim(), branch: "main" }
            : { kind: "plain_dir", path: repoPath.trim() },
      }),
    onSuccess: (ws) => {
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      onDone();
      navigate(`/workstreams/${ws.id}`);
    },
  });

  return (
    <div className="mb-3 rounded-lg border border-gray-800 bg-gray-950/40 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <h3 className="mb-3 text-sm font-semibold text-gray-200">New workstream</h3>
        <div className="mb-3">
          <Label>Title</Label>
          <TextInput aria-label="Workstream title" placeholder="What is this thread of work?" value={title} onChange={(e) => setTitle(e.target.value)} disabled={create.isPending} />
        </div>
        <div className="mb-3">
          <Label>Goal</Label>
          <TextArea aria-label="Goal" className="h-16" placeholder="What should the agent accomplish?" value={goal} onChange={(e) => setGoal(e.target.value)} disabled={create.isPending} />
        </div>
        <div className="mb-3">
          <Label>Repo folder (optional)</Label>
          <TextInput aria-label="Repo path" placeholder="e.g. C:\repos\my-project" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} disabled={create.isPending} />
        </div>
        {repoPath.trim() && (
          <div className={cx("mb-3 rounded-md border p-3", useWorktree ? "border-gray-800 bg-gray-900/40" : "border-amber-800/50 bg-amber-950/20")}>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" className="accent-green-600" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} disabled={create.isPending} />
              Use an isolated git worktree (recommended)
            </label>
            <p className={cx("mt-1.5 text-xs", useWorktree ? "text-gray-500" : "text-amber-400/90")}>
              {useWorktree ? (
                "The agent works in its own git worktree copy — changes stay isolated until you merge them."
              ) : (
                <><Icon name="alert" size={11} className="mr-1 inline" />No isolation — the agent's edits land straight on your working tree.</>
              )}
            </p>
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="sm" disabled={create.isPending || !title.trim()}>
            {create.isPending ? "Creating…" : "Create workstream"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          {create.error && <ErrorText error={create.error} />}
        </div>
      </form>
    </div>
  );
}

const WS_STATE_CLASS: Record<string, string> = {
  active: "text-green-400",
  waiting: "text-amber-400",
  blocked: "text-red-400",
  review: "text-blue-400",
  closed: "text-gray-500",
};

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["agent", id],
    queryFn: () => apiClient.getAgent(id!),
    enabled: !!id,
  });
  const [showNewWorkstream, setShowNewWorkstream] = useState(false);

  if (isLoading) return <Loading label="Loading agent…" />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader
        breadcrumb={
          <Link to="/" className="inline-flex items-center gap-1 hover:text-gray-300">
            <Icon name="arrow-left" size={12} /> Organization
          </Link>
        }
        title={data.agent.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge status={data.status} />
            <span className="text-gray-500">{data.agent.role}</span>
            <span className="text-gray-700" aria-hidden>·</span>
            <span className="text-gray-500">engine: {data.agent.engine.id}</span>
          </span>
        }
      />

      <CharterSection agentId={data.agent.id} charter={data.charter} />

      <Section
        title="Workstreams"
        actions={
          <Button variant="ghost" size="sm" onClick={() => setShowNewWorkstream((s) => !s)}>
            {showNewWorkstream ? "Cancel" : "+ New workstream"}
          </Button>
        }
      >
        {showNewWorkstream && <NewWorkstreamForm agentId={data.agent.id} onDone={() => setShowNewWorkstream(false)} />}
        {data.workstreams.length === 0 ? (
          !showNewWorkstream && (
            <EmptyState
              compact
              icon={<Icon name="message" size={24} />}
              title="No workstreams yet."
              hint="A workstream is a long-lived thread of intent against this agent."
            />
          )
        ) : (
          <ul className="divide-y divide-gray-800/70">
            {data.workstreams.map((ws) => (
              <li key={ws.id} className="flex items-center gap-2 py-2">
                <Link to={`/workstreams/${ws.id}`} className="text-sm text-gray-200 hover:text-green-300 hover:underline">
                  {ws.title}
                </Link>
                <span className={cx("ml-auto text-xs", WS_STATE_CLASS[ws.state] ?? "text-gray-500")}>{ws.state}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Open tasks">
        {data.openTasks.length === 0 ? (
          <p className="text-sm text-gray-500">None — nothing delegated to this agent is open.</p>
        ) : (
          <ul className="divide-y divide-gray-800/70">
            {data.openTasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-2 text-sm text-gray-200">
                <span className="min-w-0 flex-1 truncate">{t.spec_md.slice(0, 100)}</span>
                <span className="ml-auto flex-shrink-0 text-xs text-gray-500">{t.state}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Relationships">
        {data.relationships.length === 0 ? (
          <p className="text-sm text-gray-500">No interactions yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {data.relationships.map((r) => (
              <li key={r.actor_id} className="flex items-center gap-2">
                <Icon name="users" size={13} className="text-gray-600" />
                <span className="font-mono text-xs text-gray-300">{r.actor_id}</span>
                <span className="ml-auto text-xs text-gray-500">
                  {r.weight} interaction{r.weight === 1 ? "" : "s"} · last {new Date(r.last_interaction_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
