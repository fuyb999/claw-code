import { describe, expect, it } from "vitest";

import {
  collectEvidenceEntries,
  collectEvidenceSourceLabels,
  summarizeEvidenceEntries,
  summarizeEvidenceHit,
} from "./evidence";
import type { ThreadSnapshot } from "./types";

function testThread(messages: ThreadSnapshot["messages"]): ThreadSnapshot {
  return {
    id: "thread-1",
    workspace_root: "/tmp/project",
    session_path: "/tmp/project/.session.jsonl",
    project_id: null,
    project_name: null,
    knowledge_base_id: null,
    knowledge_base_name: null,
    model: "claude-sonnet-4-6",
    permission_mode: "read-only",
    topic: "Evidence test",
    status: "idle",
    last_error: null,
    draft_assistant_text: "",
    created_at_ms: 1,
    updated_at_ms: 2,
    messages,
    memory_notes: [],
    artifacts: [],
    audit_records: [],
  };
}

describe("collectEvidenceEntries", () => {
  it("extracts successful and failed EsSearch runs from tool messages", () => {
    const thread = testThread([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "es-1",
            name: "EsSearch",
            input: JSON.stringify({
              query: "architecture overview",
              index: "docs",
              fields: ["title^2", "content"],
              source_fields: ["title", "path", "summary"],
            }),
          },
        ],
      },
      {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            tool_use_id: "es-1",
            tool_name: "EsSearch",
            output: JSON.stringify({
              query: "architecture overview",
              index: "docs",
              fields: ["title^2", "content"],
              source_fields: ["title", "path", "summary"],
              total: 2,
              hits: [
                {
                  _id: "doc-1",
                  _index: "docs",
                  _score: 1.23,
                  _source: {
                    title: "Repository Overview",
                    path: "docs/repository-overview.md",
                    summary: "Project structure and responsibilities",
                  },
                },
              ],
            }),
            is_error: false,
          },
        ],
      },
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "es-2",
            name: "EsSearch",
            input: JSON.stringify({
              query: "broken query",
              index: "docs",
              fields: ["content"],
            }),
          },
        ],
      },
      {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            tool_use_id: "es-2",
            tool_name: "EsSearch",
            output: JSON.stringify({
              kind: "es_search_error",
              message: "Elasticsearch returned status 400 Bad Request",
              status: 400,
              detail: { error: { reason: "failed to parse query" } },
            }),
            is_error: true,
          },
        ],
      },
    ]);

    const entries = collectEvidenceEntries(thread);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: "es-2",
      query: "broken query",
      index: "docs",
      isError: true,
      errorStatus: 400,
      fields: ["content"],
    });
    expect(entries[0].errorMessage).toContain("400");

    expect(entries[1]).toMatchObject({
      id: "es-1",
      query: "architecture overview",
      index: "docs",
      total: 2,
      isError: false,
      fields: ["title^2", "content"],
      sourceFields: ["title", "path", "summary"],
    });
    expect(entries[1].hits).toHaveLength(1);
  });

  it("summarizes entry counts for the evidence workbench", () => {
    const summary = summarizeEvidenceEntries([
      {
        id: "es-1",
        query: "a",
        index: "docs",
        fields: [],
        sourceFields: [],
        total: 2,
        hits: [{}, {}],
        isError: false,
        errorMessage: null,
        errorStatus: null,
        errorDetail: null,
        rawOutput: "{}",
      },
      {
        id: "es-2",
        query: "b",
        index: "docs",
        fields: [],
        sourceFields: [],
        total: null,
        hits: [],
        isError: true,
        errorMessage: "bad request",
        errorStatus: 400,
        errorDetail: null,
        rawOutput: "{}",
      },
    ]);

    expect(summary).toEqual({
      totalQueries: 2,
      successCount: 1,
      errorCount: 1,
      totalHitsPreview: 2,
    });
  });
});

describe("summarizeEvidenceHit", () => {
  it("extracts a readable label, location and preview from _source", () => {
    expect(
      summarizeEvidenceHit(
        {
          _id: "doc-1",
          _index: "docs",
          _source: {
            title: "Repository Overview",
            path: "docs/repository-overview.md",
            summary: "Project structure and responsibilities",
          },
        },
        0,
      ),
    ).toEqual({
      label: "Repository Overview",
      location: "docs/repository-overview.md",
      preview: "Project structure and responsibilities",
    });
  });

  it("falls back to hit index when the hit shape is unknown", () => {
    expect(summarizeEvidenceHit("raw text", 2)).toMatchObject({
      label: "命中 3",
      location: null,
    });
  });
});

describe("collectEvidenceSourceLabels", () => {
  it("returns up to three unique labels for the query overview", () => {
    expect(
      collectEvidenceSourceLabels({
        hits: [
          {
            _source: {
              title: "Repository Overview",
              summary: "a",
            },
          },
          {
            _source: {
              title: "Repository Overview",
              summary: "b",
            },
          },
          {
            _source: {
              path: "docs/web-agent-service-plan.md",
              summary: "c",
            },
          },
          {
            _source: {
              title: "Skill Authoring Guide",
              summary: "d",
            },
          },
          {
            _source: {
              title: "Extra Source",
              summary: "e",
            },
          },
        ],
      }),
    ).toEqual([
      "Repository Overview",
      "docs/web-agent-service-plan.md",
      "Skill Authoring Guide",
    ]);
  });
});
