import { describe, expect, it } from "vitest";

import {
  buildThreadViewportState,
  buildMessageOutcomeSummary,
  collectLiveRunSignals,
  snapshotToThreadMessages,
} from "./assistant-thread-panel";
import type { ThreadSnapshot } from "./types";

function thread(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    id: "thread-1",
    workspace_root: "/tmp/project",
    session_path: "/tmp/project/.session.jsonl",
    project_id: "project-1",
    project_name: "Research Desk",
    knowledge_base_id: null,
    knowledge_base_name: null,
    model: "claude-sonnet-4-6",
    permission_mode: "read-only",
    topic: "分析仓库结构",
    status: "idle",
    last_error: null,
    draft_assistant_text: "",
    created_at_ms: 1,
    updated_at_ms: 2,
    messages: [],
    memory_notes: [],
    artifacts: [],
    audit_records: [],
    ...overrides,
  };
}

describe("snapshotToThreadMessages", () => {
  it("hides internal continuation prompts but keeps user-visible system guidance", () => {
    const messages = snapshotToThreadMessages(
      thread({
        messages: [
          {
            role: "system",
            blocks: [
              {
                type: "text",
                text: [
                  "This session is being continued from a previous conversation",
                  "Continue the conversation from where it left off",
                ].join("\n"),
              },
            ],
          },
          {
            role: "system",
            blocks: [{ type: "text", text: "已切换到深度分析模式" }],
          },
          {
            role: "user",
            blocks: [{ type: "text", text: "帮我总结仓库结构" }],
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "先从目录和模块边界开始。" }],
          },
        ],
      }),
    );

    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[2]?.role).toBe("assistant");
  });

  it("keeps final answer text separate from aggregated tool steps", () => {
    const messages = snapshotToThreadMessages(
      thread({
        messages: [
          {
            role: "assistant",
            blocks: [
              {
                type: "text",
                text: "已完成初步分析。",
              },
            ],
          },
          {
            role: "tool",
            blocks: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "read_file",
                input: JSON.stringify({ path: "/tmp/project/README.md" }),
              },
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                tool_name: "read_file",
                output: JSON.stringify({ ok: true }),
                is_error: false,
              },
            ],
          },
        ],
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([{ type: "text", text: "已完成初步分析。" }]);
    expect(messages[0]?.metadata?.custom).toMatchObject({
      steps: [
        expect.objectContaining({
          toolUseId: "tool-1",
          toolName: "read_file",
          requestDetail: "README.md",
          resultTitle: "查看文件完成",
        }),
      ],
    });
  });

  it("extracts anchored citations from assistant markdown", () => {
    const messages = snapshotToThreadMessages(
      thread({
        messages: [
          {
            role: "assistant",
            blocks: [
              {
                type: "text",
                text: [
                  "先看[结论段](artifact:artifact-9#block-3)，",
                  "再核对[证据命中](evidence:es-1#hit-2)。",
                ].join(""),
              },
            ],
          },
        ],
      }),
    );

    expect(messages[0]?.metadata?.custom).toMatchObject({
      artifactRefs: [
        {
          id: "artifact-9",
          label: "结论段",
          anchor: "block-3",
        },
      ],
      evidenceRefs: [
        {
          id: "es-1",
          label: "证据命中",
          anchor: "hit-2",
        },
      ],
    });
  });

  it("merges consecutive assistant messages into a single conversational turn", () => {
    const messages = snapshotToThreadMessages(
      thread({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "text", text: "第一段分析。" }],
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "第二段补充，并引用[结果 A](artifact:artifact-1)。" }],
          },
        ],
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "第一段分析。" },
      { type: "text", text: "第二段补充，并引用[结果 A](artifact:artifact-1)。" },
    ]);
    expect(messages[0]?.metadata?.custom).toMatchObject({
      artifactRefs: [{ id: "artifact-1", label: "结果 A", anchor: null }],
    });
  });

  it("retains tool-only messages by surfacing them as a step cluster", () => {
    const messages = snapshotToThreadMessages(
      thread({
        messages: [
          {
            role: "tool",
            blocks: [
              {
                type: "tool_use",
                id: "es-1",
                name: "EsSearch",
                input: JSON.stringify({ query: "repository overview" }),
              },
            ],
          },
        ],
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([]);
    expect(messages[0]?.metadata?.custom).toMatchObject({
      steps: [
        expect.objectContaining({
          toolUseId: "es-1",
          toolName: "EsSearch",
          requestDetail: "repository overview",
        }),
      ],
      evidenceRefs: [
        {
          id: "es-1",
          label: "repository overview",
          anchor: null,
        },
      ],
    });
  });
});

describe("buildMessageOutcomeSummary", () => {
  it("summarizes counts and recent preview references", () => {
    expect(
      buildMessageOutcomeSummary({
        artifactRefs: [
          { id: "artifact-1", label: "架构总览", anchor: null },
          { id: "artifact-2", label: "结论段落", anchor: "block-3" },
          { id: "artifact-3", label: "补充表格", anchor: null },
        ],
        evidenceRefs: [
          { id: "es-1", label: "命中 1", anchor: "hit-1" },
          { id: "es-2", label: "命中 2", anchor: "hit-2" },
        ],
        steps: [
          {
            toolUseId: "tool-1",
            toolName: "EsSearch",
            title: "检索证据",
            requestDetail: "query-a",
            requestInput: null,
            resultTitle: "找到 2 条来源",
            resultDetail: "query-a",
            resultOutput: "{\"hits\":[]}",
            isError: false,
          },
          {
            toolUseId: "tool-2",
            toolName: "ArtifactEmit",
            title: "整理结果",
            requestDetail: "markdown",
            requestInput: null,
            resultTitle: null,
            resultDetail: null,
            resultOutput: null,
            isError: false,
          },
          {
            toolUseId: "tool-3",
            toolName: "read_file",
            title: "查看文件",
            requestDetail: "README.md",
            requestInput: null,
            resultTitle: "查看文件失败",
            resultDetail: "denied",
            resultOutput: "denied",
            isError: true,
          },
        ],
      }),
    ).toEqual({
      artifactCount: 3,
      evidenceCount: 2,
      stepCount: 3,
      failedStepCount: 1,
      runningStepCount: 1,
      previewArtifacts: [
        { id: "artifact-3", label: "补充表格", anchor: null },
        { id: "artifact-2", label: "结论段落", anchor: "block-3" },
      ],
      previewEvidence: [
        { id: "es-2", label: "命中 2", anchor: "hit-2" },
        { id: "es-1", label: "命中 1", anchor: "hit-1" },
      ],
    });
  });

  it("returns null when the message has no outcomes", () => {
    expect(
      buildMessageOutcomeSummary({
        artifactRefs: [],
        evidenceRefs: [],
        steps: [],
      }),
    ).toBeNull();
  });
});

describe("collectLiveRunSignals", () => {
  it("collects user-visible progress from tool activity and draft reply", () => {
    const signals = collectLiveRunSignals(
      thread({
        status: "running",
        draft_assistant_text: "正在整理仓库结构和模块边界。",
        messages: [
          {
            role: "assistant",
            blocks: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "read_file",
                input: JSON.stringify({ path: "/tmp/project/README.md" }),
              },
            ],
          },
          {
            role: "tool",
            blocks: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                tool_name: "read_file",
                output: JSON.stringify({ ok: true }),
                is_error: false,
              },
            ],
          },
          {
            role: "assistant",
            blocks: [
              {
                type: "tool_use",
                id: "tool-2",
                name: "ArtifactEmit",
                input: JSON.stringify({ kind: "markdown", title: "仓库结构分析" }),
              },
            ],
          },
        ],
      }),
    );

    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "查看文件完成",
          state: "done",
        }),
        expect.objectContaining({
          label: "整理结果",
          state: "running",
        }),
        expect.objectContaining({
          label: "正在生成回复",
          state: "running",
        }),
      ]),
    );
  });
});

describe("buildThreadViewportState", () => {
  it("shows welcome state for a brand new idle thread", () => {
    expect(buildThreadViewportState(thread(), 0)).toEqual({ kind: "welcome" });
  });

  it("shows running state when analysis has started but no message arrived yet", () => {
    expect(
      buildThreadViewportState(
        thread({
          status: "running",
          audit_records: [
            {
              id: "audit-1",
              run_id: 1,
              kind: "run_started",
              created_at_ms: 3,
              payload: {},
            },
          ],
        }),
        0,
      ),
    ).toMatchObject({
      kind: "running",
      title: "正在分析资料",
    });
  });

  it("shows failed state when a thread failed before any visible reply", () => {
    expect(
      buildThreadViewportState(
        thread({
          status: "failed",
          last_error: "provider stream failed: api returned 403 Forbidden (insufficient_quota)",
          audit_records: [
            {
              id: "audit-1",
              run_id: 1,
              kind: "run_failed",
              created_at_ms: 3,
              payload: {},
            },
            {
              id: "audit-2",
              run_id: 1,
              kind: "assistant_turn",
              created_at_ms: 4,
              payload: {},
            },
          ],
        }),
        0,
      ),
    ).toMatchObject({
      kind: "failed",
      eyebrow: "额度不足",
      title: "模型服务当前额度不足",
    });
  });

  it("shows idle empty state when previous attempts existed but no visible reply remains", () => {
    expect(
      buildThreadViewportState(
        thread({
          audit_records: [
            {
              id: "audit-1",
              run_id: 1,
              kind: "run_started",
              created_at_ms: 3,
              payload: {},
            },
            {
              id: "audit-2",
              run_id: 1,
              kind: "run_finished",
              created_at_ms: 4,
              payload: {},
            },
          ],
        }),
        0,
      ),
    ).toMatchObject({
      kind: "idle_empty",
      eyebrow: "等待下一步",
    });
  });

  it("returns null when visible messages already exist", () => {
    expect(
      buildThreadViewportState(
        thread({
          status: "failed",
        }),
        2,
      ),
    ).toBeNull();
  });
});
