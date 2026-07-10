/** E2.5 — assembles the `Store.projections` surface (contracts.md). One instance per store. */
import type { AgentId, TaskId, WorkstreamId } from "@foundry/core";
import type { Db } from "../db/connection.js";
import { orgView, type OrgView } from "./orgView.js";
import { agentPage, type AgentPage } from "./agentPage.js";
import { workstreamTimeline, type Timeline, type TimelinePage } from "./workstreamTimeline.js";
import { delegationTree, type TreeView } from "./delegationTree.js";
import { inbox, type InboxItem } from "./inbox.js";
import { costRollup, type CostReport, type CostScope } from "./costRollup.js";

export interface Projections {
  orgView(): OrgView;
  agentPage(id: AgentId): AgentPage | undefined;
  workstreamTimeline(id: WorkstreamId, page?: TimelinePage): Timeline;
  delegationTree(rootTaskId: TaskId): TreeView;
  inbox(): InboxItem[];
  costRollup(scope: CostScope): CostReport;
}

export function createProjections(db: Db, dataDir: string): Projections {
  return {
    orgView: () => orgView(db),
    agentPage: (id) => agentPage(db, id),
    workstreamTimeline: (id, page) => workstreamTimeline(db, dataDir, id, page),
    delegationTree: (rootTaskId) => delegationTree(db, rootTaskId),
    inbox: () => inbox(db),
    costRollup: (scope) => costRollup(db, scope),
  };
}

export * from "./status.js";
export * from "./orgView.js";
export * from "./agentPage.js";
export * from "./workstreamTimeline.js";
export * from "./delegationTree.js";
export * from "./inbox.js";
export * from "./costRollup.js";
