/**
 * E7.3 — Agent page (doc-06): identity, status, charter (editable, versioned),
 * open workstreams (linked to their timeline), open tasks, relationships, engine.
 * Charter edits PATCH /api/agents/:id {charter_md} and invalidate the agent query.
 */
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client.js";
import type { AgentPageDto } from "../api/types.js";
import { Badge } from "./OrgView.js";

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
    <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <div className="flex items-center gap-3 mb-2">
        <h2 className="font-semibold text-gray-800">Charter</h2>
        {charter && <span className="text-xs text-gray-500">v{charter.version}</span>}
        {!editing && (
          <button
            className="ml-auto text-sm text-blue-700 hover:underline"
            onClick={() => {
              setDraft(charter?.body_md ?? "");
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div>
          <textarea
            aria-label="Charter editor"
            className="w-full h-48 border border-gray-300 rounded p-2 text-sm font-mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="mt-2 flex gap-2 items-center">
            <button
              className="px-3 py-1 rounded bg-blue-600 text-white text-sm disabled:opacity-50"
              disabled={save.isPending}
              onClick={() => save.mutate(draft)}
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button className="text-sm text-gray-600" onClick={() => setEditing(false)}>
              Cancel
            </button>
            {save.error && (
              <span className="text-sm text-red-600">
                {save.error instanceof Error ? save.error.message : String(save.error)}
              </span>
            )}
          </div>
        </div>
      ) : charter ? (
        <pre className="whitespace-pre-wrap text-sm text-gray-800 font-sans">{charter.body_md}</pre>
      ) : (
        <p className="text-sm text-gray-500">No charter yet — use Edit to write one.</p>
      )}
    </section>
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
            ? // The runtime only ever reads `repo_path` off a git_worktree ref — it
              // derives its own worktree location and branch (E4.4) — so
              // worktree_path/branch here are schema-required placeholders, not
              // settings that do anything.
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
    <form
      className="bg-white border border-gray-200 rounded-lg p-4 mb-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) create.mutate();
      }}
    >
      <h2 className="font-semibold text-gray-800 mb-2 text-sm">New workstream</h2>
      <input
        aria-label="Workstream title"
        className="w-full border border-gray-300 rounded p-2 text-sm mb-2"
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={create.isPending}
      />
      <textarea
        aria-label="Goal"
        className="w-full h-16 border border-gray-300 rounded p-2 text-sm mb-2"
        placeholder="Goal (what should the agent accomplish?)"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        disabled={create.isPending}
      />
      <input
        aria-label="Repo path"
        className="w-full border border-gray-300 rounded p-2 text-sm mb-2"
        placeholder="Repo folder path (optional — e.g. C:\repos\my-project)"
        value={repoPath}
        onChange={(e) => setRepoPath(e.target.value)}
        disabled={create.isPending}
      />
      {repoPath.trim() && (
        <div className="mb-2">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
              disabled={create.isPending}
            />
            Use an isolated git worktree (recommended)
          </label>
          <p className="text-xs text-gray-500 mt-1">
            {useWorktree
              ? "The agent works in its own git worktree copy of this repo — changes stay isolated until you merge them."
              : "The agent works directly in this folder, no isolation — its edits land straight on your working tree."}
          </p>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="px-3 py-1 rounded bg-blue-600 text-white text-sm disabled:opacity-50"
          disabled={create.isPending || !title.trim()}
        >
          {create.isPending ? "Creating…" : "Create workstream"}
        </button>
        <button type="button" className="text-sm text-gray-500" onClick={onDone}>
          Cancel
        </button>
        {create.error && (
          <span className="text-xs text-red-600">
            {create.error instanceof Error ? create.error.message : String(create.error)}
          </span>
        )}
      </div>
    </form>
  );
}

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["agent", id],
    queryFn: () => apiClient.getAgent(id!),
    enabled: !!id,
  });
  const [showNewWorkstream, setShowNewWorkstream] = useState(false);

  if (isLoading) return <div className="p-6 text-gray-500">Loading agent…</div>;
  if (error)
    return <div className="p-6 text-red-600">Error: {error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return null;

  return (
    <div className="p-6 max-w-3xl">
      <header className="mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">{data.agent.name}</h1>
          <Badge status={data.status} />
        </div>
        <p className="text-sm text-gray-600 mt-1">
          {data.agent.role} · {data.agent.state} · engine: {data.agent.engine.id}
        </p>
      </header>

      <CharterSection agentId={data.agent.id} charter={data.charter} />

      <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <div className="flex items-center mb-2">
          <h2 className="font-semibold text-gray-800">Workstreams</h2>
          <button
            className="ml-auto text-sm text-blue-700 hover:underline"
            onClick={() => setShowNewWorkstream((s) => !s)}
          >
            {showNewWorkstream ? "Cancel" : "+ New workstream"}
          </button>
        </div>
        {showNewWorkstream && (
          <NewWorkstreamForm agentId={data.agent.id} onDone={() => setShowNewWorkstream(false)} />
        )}
        {data.workstreams.length === 0 ? (
          <p className="text-sm text-gray-500">None.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.workstreams.map((ws) => (
              <li key={ws.id} className="py-1.5 flex items-center gap-2 text-sm">
                <Link to={`/workstreams/${ws.id}`} className="text-blue-700 hover:underline">
                  {ws.title}
                </Link>
                <span className="text-xs text-gray-500">{ws.state}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h2 className="font-semibold text-gray-800 mb-2">Open tasks</h2>
        {data.openTasks.length === 0 ? (
          <p className="text-sm text-gray-500">None.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.openTasks.map((t) => (
              <li key={t.id} className="py-1.5 text-sm text-gray-800">
                {t.spec_md.slice(0, 100)}
                <span className="ml-2 text-xs text-gray-500">{t.state}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="font-semibold text-gray-800 mb-2">Relationships</h2>
        {data.relationships.length === 0 ? (
          <p className="text-sm text-gray-500">No interactions yet.</p>
        ) : (
          <ul className="text-sm text-gray-800 space-y-1">
            {data.relationships.map((r) => (
              <li key={r.actor_id}>
                {r.actor_id}
                <span className="ml-2 text-xs text-gray-500">
                  {r.weight} interaction{r.weight === 1 ? "" : "s"} · last {r.last_interaction_at}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
