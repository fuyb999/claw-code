import { describe, expect, it } from "vitest";

import {
  filterKeyForThread,
  groupThreadsByProject,
  projectFilterKey,
  workspaceFilterKey,
  workspaceLabel,
} from "./thread-groups";
import type { ProjectSummary, ThreadSummary } from "./types";

function thread(overrides: Partial<ThreadSummary>): ThreadSummary {
  return {
    id: "thread-1",
    workspace_root: "/tmp/project-a",
    project_id: null,
    project_name: null,
    knowledge_base_id: null,
    knowledge_base_name: null,
    model: "claude-sonnet-4-6",
    topic: "topic",
    status: "idle",
    updated_at_ms: 1,
    ...overrides,
  };
}

function project(overrides: Partial<ProjectSummary>): ProjectSummary {
  return {
    id: "project-1",
    name: "Project One",
    description: null,
    workspace_root: "/tmp/project-a",
    default_topic: null,
    default_model: null,
    model_base_url: null,
    model_base_url_env: null,
    model_api_key_env: null,
    model_api_key_configured: false,
    default_permission_mode: null,
    starter_prompt: null,
    default_instructions: null,
    default_skill_names: [],
    created_at_ms: 1,
    updated_at_ms: 1,
    ...overrides,
  };
}

describe("thread groups", () => {
  it("groups project threads by explicit project and keeps empty projects visible", () => {
    const groups = groupThreadsByProject(
      [
        thread({
          id: "t1",
          project_id: "project-1",
          project_name: "Project One",
          updated_at_ms: 4,
        }),
        thread({
          id: "t2",
          project_id: null,
          project_name: null,
          workspace_root: "/tmp/fallback-workspace",
          updated_at_ms: 3,
        }),
      ],
      [
        project({
          id: "project-1",
          name: "Project One",
          workspace_root: "/tmp/project-a",
          updated_at_ms: 2,
        }),
        project({
          id: "project-2",
          name: "Project Two",
          workspace_root: "/tmp/project-b",
          updated_at_ms: 5,
        }),
      ],
    );

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({
      filterKey: projectFilterKey("project-2"),
      label: "Project Two",
      threadCount: 0,
      latestThreadId: null,
      isExplicitProject: true,
    });
    expect(groups[1]).toMatchObject({
      filterKey: projectFilterKey("project-1"),
      label: "Project One",
      latestThreadId: "t1",
      threadCount: 1,
      latestModel: "claude-sonnet-4-6",
    });
    expect(groups[2]).toMatchObject({
      filterKey: workspaceFilterKey("/tmp/fallback-workspace"),
      label: "fallback-workspace",
      latestThreadId: "t2",
      threadCount: 1,
      isExplicitProject: false,
    });
  });

  it("derives filter keys from projects when available", () => {
    expect(
      filterKeyForThread(
        thread({
          project_id: "project-9",
          project_name: "Project Nine",
        }),
      ),
    ).toBe(projectFilterKey("project-9"));
    expect(filterKeyForThread(thread({ project_id: null }))).toBe(
      workspaceFilterKey("/tmp/project-a"),
    );
  });

  it("derives a concise workspace label", () => {
    expect(workspaceLabel("/Users/demo/research/project-x")).toBe("project-x");
    expect(workspaceLabel("/tmp/managed-workspaces/user/chat")).toBe("纯聊天");
  });
});
