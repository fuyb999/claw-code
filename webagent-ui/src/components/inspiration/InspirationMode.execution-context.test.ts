import { describe, expect, it } from "vitest";

import {
  buildExecutionContextPayload,
  buildSourceContextLabel,
  type PendingExecutionScope,
} from "./InspirationMode";

describe("InspirationMode execution context helpers", () => {
  it("distinguishes preserve-current behavior from explicit clear", () => {
    expect(buildExecutionContextPayload(null, true)).toEqual({
      auto_retrieval: true,
    });

    expect(
      buildExecutionContextPayload(
        {
          kind: "clear",
        },
        true,
      ),
    ).toEqual({
      knowledge_base_id: null,
      auto_retrieval: true,
    });

    expect(
      buildExecutionContextPayload(
        {
          kind: "select",
          knowledgeBaseId: "kb-next",
        },
        false,
      ),
    ).toEqual({
      knowledge_base_id: "kb-next",
      auto_retrieval: false,
    });
  });

  it("does not fall back to thread scope after an explicit clear for the next operation", () => {
    const pendingScope: PendingExecutionScope = { kind: "clear" };

    expect(
      buildSourceContextLabel({
        pendingScope,
        pendingKnowledgeBaseName: null,
        threadKnowledgeBaseName: "线程资料库",
        activeKnowledgeBaseName: null,
      }),
    ).toBe("下一条消息或专家会诊将不使用资料范围");
  });
});
