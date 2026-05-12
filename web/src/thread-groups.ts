import type { ProjectSummary, ThreadStatus, ThreadSummary } from "./types";

export type WorkspaceStatusCounts = Record<ThreadStatus, number>;

export type ProjectThreadGroup = {
  filterKey: string;
  projectId: string | null;
  label: string;
  description: string | null;
  workspaceRoot: string;
  latestThreadId: string | null;
  latestTopic: string | null;
  latestModel: string | null;
  threadCount: number;
  updatedAtMs: number;
  recentTopics: string[];
  statusCounts: WorkspaceStatusCounts;
  threads: ThreadSummary[];
  isExplicitProject: boolean;
};

type MutableProjectThreadGroup = ProjectThreadGroup;

function emptyStatusCounts(): WorkspaceStatusCounts {
  return {
    idle: 0,
    running: 0,
    interrupt_requested: 0,
    failed: 0,
  };
}

export function workspaceLabel(path: string): string {
  if (path.includes("/managed-workspaces/") || path.endsWith("/chat")) {
    return "纯聊天";
  }
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function projectFilterKey(projectId: string): string {
  return `project:${projectId}`;
}

export function workspaceFilterKey(workspaceRoot: string): string {
  return `workspace:${workspaceRoot}`;
}

export function filterKeyForThread(thread: ThreadSummary): string {
  if (thread.project_id) {
    return projectFilterKey(thread.project_id);
  }
  if (thread.knowledge_base_id) {
    return `knowledge-base:${thread.knowledge_base_id}`;
  }
  return workspaceFilterKey(thread.workspace_root);
}

function sortThreadsByRecency(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((left, right) => right.updated_at_ms - left.updated_at_ms);
}

export function groupThreadsByProject(
  threads: ThreadSummary[],
  projects: ProjectSummary[],
): ProjectThreadGroup[] {
  const groups = new Map<string, MutableProjectThreadGroup>();

  for (const project of projects) {
    groups.set(projectFilterKey(project.id), {
      filterKey: projectFilterKey(project.id),
      projectId: project.id,
      label: project.name,
      description: project.description,
      workspaceRoot: project.workspace_root,
      latestThreadId: null,
      latestTopic: null,
      latestModel: null,
      threadCount: 0,
      updatedAtMs: project.updated_at_ms,
      recentTopics: [],
      statusCounts: emptyStatusCounts(),
      threads: [],
      isExplicitProject: true,
    });
  }

  for (const thread of threads) {
    const filterKey = filterKeyForThread(thread);
    const existing = groups.get(filterKey);
    if (existing) {
      existing.threads.push(thread);
      continue;
    }

    groups.set(filterKey, {
      filterKey,
      projectId: thread.project_id,
      label: thread.project_name ?? thread.knowledge_base_name ?? workspaceLabel(thread.workspace_root),
      description: null,
      workspaceRoot: thread.workspace_root,
      latestThreadId: null,
      latestTopic: null,
      latestModel: null,
      threadCount: 0,
      updatedAtMs: thread.updated_at_ms,
      recentTopics: [],
      statusCounts: emptyStatusCounts(),
      threads: [thread],
      isExplicitProject: Boolean(thread.project_id),
    });
  }

  return Array.from(groups.values())
    .map((group) => {
      const sorted = sortThreadsByRecency(group.threads);
      const latest = sorted[0] ?? null;
      const statusCounts = sorted.reduce<WorkspaceStatusCounts>((counts, thread) => {
        counts[thread.status] += 1;
        return counts;
      }, emptyStatusCounts());

      return {
        ...group,
        latestThreadId: latest?.id ?? null,
        latestTopic: latest?.topic ?? null,
        latestModel: latest?.model ?? null,
        threadCount: sorted.length,
        updatedAtMs: Math.max(
          group.updatedAtMs,
          latest?.updated_at_ms ?? 0,
        ),
        recentTopics: Array.from(
          new Set(
            sorted
              .map((thread) => thread.topic?.trim())
              .filter((topic): topic is string => Boolean(topic)),
          ),
        ).slice(0, 3),
        statusCounts,
        threads: sorted,
      };
    })
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}
