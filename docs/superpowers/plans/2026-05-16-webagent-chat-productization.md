# WebAgent Chat Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WebAgent chat area product-grade by moving run failures into the owning answer, fixing newest-message scrolling, adding fixed user-question timeline navigation, and rendering tool/retrieval/expert work as a nested pipeline.

**Architecture:** Keep the existing `AgentTurnRecord` main model. Frontend changes first stabilize `ConversationStage`, `AgentTurnView`, and `AgentActivityTimeline`; backend changes then enrich `AgentTurnStep.public_payload` so the UI can render pipeline outputs without parsing raw tool JSON.

**Tech Stack:** Rust `clawd`, Axum AG UI endpoint, React 18, TypeScript, Vite, Vitest/jsdom, Tailwind CSS, `@ag-ui/client`, existing custom conversation components.

---

## Scope

This plan implements `docs/superpowers/specs/2026-05-16-webagent-chat-productization-design.md`.

It does not change OIDC, admin configuration, model storage, ES configuration screens, or the broader AgentTurn database schema. It only changes chat rendering behavior and step payloads.

## File Structure

- Modify `webagent-ui/src/components/conversation/ConversationStage.tsx`
  - Owns page-level error placement, viewport scroll policy, floating latest button, and fixed timeline rail.
- Modify `webagent-ui/src/components/conversation/ConversationStage.test.tsx`
  - Locks run-error placement, auto-scroll, and timeline behavior.
- Modify `webagent-ui/src/components/conversation/AgentTurnView.tsx`
  - Renders turn-level failure state and passes structured step data to the pipeline renderer.
- Modify `webagent-ui/src/components/conversation/AgentTurnView.test.tsx`
  - Locks failure rendering and ordinary-user raw JSON hiding.
- Modify `webagent-ui/src/components/conversation/AgentActivityTimeline.tsx`
  - Renders grouped pipeline stages instead of a flat step list.
- Modify `webagent-ui/src/lib/clawd/agent-turns.ts`
  - Adds `groupAgentTurnSteps` and typed helpers for public payload extraction.
- Modify `webagent-ui/src/lib/clawd/agent-turns.test.ts`
  - Locks pipeline grouping and payload interpretation.
- Modify `webagent-ui/src/hooks/useWebAgentSession.ts`
  - Ensures local run failures create a failed step and remain attached to the turn.
- Modify `rust/crates/clawd/src/main.rs`
  - Enriches `AgentTurnStep.public_payload` for retrieval/tool/expert steps.

## Verification Commands

Frontend focused checks:

```bash
cd webagent-ui && npm test -- --run \
  src/components/conversation/ConversationStage.test.tsx \
  src/components/conversation/AgentTurnView.test.tsx \
  src/lib/clawd/agent-turns.test.ts
cd webagent-ui && npm run build
```

Backend focused checks:

```bash
cd rust && cargo fmt
cd rust && cargo test -p clawd agent_tool_updates
cd rust && cargo test -p clawd ag_ui
```

Real browser acceptance uses the existing screen setup:

- Backend: `http://127.0.0.1:3210`
- Frontend: `http://127.0.0.1:4173`
- Runtime database: `.clawd-dev/clawd.db`

---

### Task 1: Move Run Failures Into The Owning AgentTurn

**Files:**
- Modify: `webagent-ui/src/components/conversation/ConversationStage.test.tsx`
- Modify: `webagent-ui/src/components/conversation/ConversationStage.tsx`
- Modify: `webagent-ui/src/components/conversation/AgentTurnView.test.tsx`
- Modify: `webagent-ui/src/components/conversation/AgentTurnView.tsx`
- Modify: `webagent-ui/src/hooks/useWebAgentSession.ts`

- [ ] **Step 1: Add failing test for no top-level run failure banner**

Add this test inside `describe("ConversationStage", () => { ... })` in `webagent-ui/src/components/conversation/ConversationStage.test.tsx`:

```tsx
  it("keeps run-level failures inside the failed agent turn", async () => {
    const failedTurn = agentTurn({
      status: "failed",
      assistant_text: "",
      error: {
        public_message: "模型调用失败，请重试。",
        debug_message: "provider timeout",
        code: null,
      },
      steps: [
        {
          id: "step-failed",
          kind: "generation",
          label: "生成回答失败",
          detail: "模型调用失败，请重试。",
          status: "failed",
          started_at_ms: new Date("2026-05-15T10:00:04+08:00").getTime(),
          completed_at_ms: new Date("2026-05-15T10:00:07+08:00").getTime(),
          public_payload: { result_summary: "模型调用失败，请重试。", is_error: true },
        },
      ],
    });
    const { container, root } = await renderConversation(
      <ConversationStage
        agentTurns={[failedTurn]}
        error="模型调用失败，请重试。"
        isPlatformAdmin={false}
        messages={[]}
        onSendMessage={() => {}}
      />,
    );

    expect(container.textContent).toContain("分析平台资料");
    expect(container.textContent).toContain("处理失败");
    expect(container.textContent).toContain("模型调用失败，请重试。");
    expect(container.querySelector('[data-page-error="true"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd webagent-ui && npm test -- --run src/components/conversation/ConversationStage.test.tsx -t "keeps run-level failures inside the failed agent turn"
```

Expected: FAIL because `ConversationStage` currently renders `error` at the top of the AgentTurn path.

- [ ] **Step 3: Remove AgentTurn-path top banner for run errors**

In `ConversationStage.tsx`, replace the AgentTurn path `error` block with a page-level-only condition:

```tsx
                {!hasAgentTurnPath && error ? (
                  <div
                    className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                    data-page-error="true"
                  >
                    <p className="text-[11px] font-medium">处理异常</p>
                    <p className="mt-1 break-words [overflow-wrap:anywhere]">{error}</p>
                  </div>
                ) : null}
```

In the AgentTurn branch, delete the existing block:

```tsx
                {error ? (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    <p className="text-[11px] font-medium">处理异常</p>
                    <p className="mt-1 break-words [overflow-wrap:anywhere]">{error}</p>
                  </div>
                ) : null}
```

- [ ] **Step 4: Add turn-level failure rendering test**

Add this test to `webagent-ui/src/components/conversation/AgentTurnView.test.tsx`:

```tsx
  it("renders run failure inside the agent answer card", () => {
    render(
      <AgentTurnView
        isAdmin={false}
        turn={{
          ...turn,
          status: "failed",
          assistant_text: "",
          error: {
            public_message: "模型调用失败，请重试。",
            debug_message: "provider timeout",
            code: null,
          },
          steps: [
            {
              id: "step-failed",
              kind: "generation",
              label: "生成回答失败",
              detail: "模型调用失败，请重试。",
              status: "failed",
              started_at_ms: turn.started_at_ms,
              completed_at_ms: turn.completed_at_ms,
              public_payload: { result_summary: "模型调用失败，请重试。", is_error: true },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("处理失败")).toBeInTheDocument();
    expect(screen.getByText("模型调用失败，请重试。")).toBeInTheDocument();
    expect(screen.getByText("生成回答失败")).toBeInTheDocument();
  });
```

- [ ] **Step 5: Implement turn-level failure block**

In `AgentTurnView.tsx`, add this block between the header and assistant text:

```tsx
          {turn.error ? (
            <div className="mb-3 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <p className="text-[11px] font-medium">处理失败</p>
              <p className="mt-1 break-words text-xs leading-5 [overflow-wrap:anywhere]">
                {turn.error.public_message}
              </p>
            </div>
          ) : null}
```

Then change the empty assistant copy:

```tsx
          {assistantText.trim() ? (
            <MarkdownMessage content={assistantText} streaming={turn.status === "running"} />
          ) : turn.status === "failed" ? null : (
            <p className="text-sm leading-6 text-muted-foreground">正在处理</p>
          )}
```

- [ ] **Step 6: Add failed step when local run catches an error**

In `webagent-ui/src/hooks/useWebAgentSession.ts`, inside the `catch` block where `turn.status` becomes `failed`, replace the turn update with:

```ts
              ? {
                  ...turn,
                  status: "failed",
                  completed_at_ms: Date.now(),
                  steps: mergeById(turn.steps, [
                    {
                      id: `${runId}-failed`,
                      kind: "generation",
                      label: "生成回答失败",
                      detail: message,
                      status: "failed",
                      started_at_ms: turn.started_at_ms,
                      completed_at_ms: Date.now(),
                      public_payload: {
                        result_summary: message,
                        is_error: true,
                      },
                    },
                  ]),
                  error: {
                    public_message: "处理失败",
                    debug_message: message,
                    code: null,
                  },
                }
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
cd webagent-ui && npm test -- --run \
  src/components/conversation/ConversationStage.test.tsx \
  src/components/conversation/AgentTurnView.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add webagent-ui/src/components/conversation/ConversationStage.tsx \
  webagent-ui/src/components/conversation/ConversationStage.test.tsx \
  webagent-ui/src/components/conversation/AgentTurnView.tsx \
  webagent-ui/src/components/conversation/AgentTurnView.test.tsx \
  webagent-ui/src/hooks/useWebAgentSession.ts
git commit -m "fix: keep webagent run failures inside turns"
```

### Task 2: Fix Auto-Scroll For New AgentTurns And Streaming Updates

**Files:**
- Modify: `webagent-ui/src/components/conversation/ConversationStage.test.tsx`
- Modify: `webagent-ui/src/components/conversation/ConversationStage.tsx`

- [ ] **Step 1: Add failing test for AgentTurn append scroll**

Add this test in `ConversationStage.test.tsx`:

```tsx
  it("scrolls to the newest agent turn when a new turn appears", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    const { container, root } = await renderConversation(
      <ConversationStage
        agentTurns={[agentTurn({ id: "turn-1" })]}
        isPlatformAdmin={false}
        messages={[]}
        onSendMessage={() => {}}
      />,
    );

    await act(async () => {
      root.render(
        <ConversationStage
          agentTurns={[
            agentTurn({ id: "turn-1" }),
            agentTurn({
              id: "turn-2",
              user_message: "继续分析",
              assistant_text: "新的回答",
              started_at_ms: new Date("2026-05-15T10:03:00+08:00").getTime(),
            }),
          ]}
          isPlatformAdmin={false}
          messages={[]}
          onSendMessage={() => {}}
        />,
      );
    });

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: expect.any(Number), behavior: "smooth" }),
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
```

- [ ] **Step 2: Add failing test for user scroll-up suppression**

Add this test:

```tsx
  it("does not force-scroll streaming updates after the user scrolls upward", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    const { container, root } = await renderConversation(
      <ConversationStage
        agentTurns={[agentTurn({ id: "turn-1", status: "running", assistant_text: "开始" })]}
        isPlatformAdmin={false}
        messages={[]}
        onSendMessage={() => {}}
      />,
    );

    const viewport = container.querySelector('[data-chat-viewport="true"]') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    if (viewport) {
      Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 2000 });
      Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 600 });
      viewport.scrollTop = 200;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    scrollTo.mockClear();

    await act(async () => {
      root.render(
        <ConversationStage
          agentTurns={[
            agentTurn({
              id: "turn-1",
              status: "running",
              assistant_text: "开始继续输出",
            }),
          ]}
          isPlatformAdmin={false}
          messages={[]}
          onSendMessage={() => {}}
        />,
      );
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.textContent).toContain("回到最新内容");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
```

- [ ] **Step 3: Add viewport marker**

In both AgentTurn and fallback viewport elements in `ConversationStage.tsx`, add:

```tsx
data-chat-viewport="true"
```

For the AgentTurn branch:

```tsx
            <div
              className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4 scrollbar-thin"
              data-chat-viewport="true"
              ref={viewportRef}
            >
```

- [ ] **Step 4: Track latest AgentTurn separately from stream changes**

In `ConversationStage.tsx`, add:

```ts
  const latestAgentTurn = agentTurns[agentTurns.length - 1] ?? null;
  const latestAgentTurnId = latestAgentTurn?.id ?? null;
  const agentTurnStreamKey = latestAgentTurn
    ? `${latestAgentTurn.id}:${latestAgentTurn.status}:${latestAgentTurn.assistant_text.length}:${latestAgentTurn.steps.length}:${latestAgentTurn.citations.length}`
    : "";
```

Change `viewportDependencyKey` for AgentTurn mode to:

```ts
  const viewportDependencyKey = hasAgentTurnPath
    ? agentTurnStreamKey
    : runtimeMessages.length;
```

- [ ] **Step 5: Force near-bottom only when a new turn is appended**

Add this effect after the scroll listener effect:

```ts
  useEffect(() => {
    if (!hasAgentTurnPath || !latestAgentTurnId) {
      return;
    }
    nearBottomRef.current = true;
    setShowJumpToBottom(false);
    const viewport = viewportRef.current;
    if (viewport) {
      requestAnimationFrame(() => scrollElementToBottom(viewport));
    }
  }, [hasAgentTurnPath, latestAgentTurnId]);
```

Keep the existing streaming-follow effect, but make sure it only scrolls when `nearBottomRef.current` is true:

```ts
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !nearBottomRef.current) {
      return;
    }

    scrollElementToBottom(viewport);
  }, [
    viewportDependencyKey,
    threadSnapshot?.draft_assistant_text,
    pendingMessages.length,
    running,
    sending,
  ]);
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd webagent-ui && npm test -- --run src/components/conversation/ConversationStage.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add webagent-ui/src/components/conversation/ConversationStage.tsx \
  webagent-ui/src/components/conversation/ConversationStage.test.tsx
git commit -m "fix: follow latest webagent turn scrolling"
```

### Task 3: Add Fixed User-Question Timeline Navigation

**Files:**
- Create: `webagent-ui/src/components/conversation/AgentTurnTimelineRail.tsx`
- Modify: `webagent-ui/src/components/conversation/ConversationStage.tsx`
- Modify: `webagent-ui/src/components/conversation/ConversationStage.test.tsx`

- [ ] **Step 1: Create the timeline rail component**

Create `webagent-ui/src/components/conversation/AgentTurnTimelineRail.tsx`:

```tsx
import type { AgentTurnRecord } from "@/lib/clawd/agent-turns";

function formatPointTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compactQuestion(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 54 ? `${trimmed.slice(0, 54)}...` : trimmed;
}

export function AgentTurnTimelineRail({
  onJumpToTurn,
  turns,
}: {
  onJumpToTurn: (turnId: string) => void;
  turns: AgentTurnRecord[];
}) {
  if (!turns.length) return null;

  return (
    <nav
      aria-label="问题时间线"
      className="pointer-events-none absolute left-2 top-4 z-10 hidden h-[calc(100%-2rem)] w-10 flex-col items-center md:flex"
      data-agent-timeline-rail="true"
    >
      <div className="relative flex h-full w-full flex-col items-center">
        <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border/25" />
        <div className="relative flex w-full flex-col gap-3">
          {turns.map((turn) => (
            <button
              aria-label={`定位到 ${formatPointTime(turn.started_at_ms)} 的问题：${compactQuestion(turn.user_message)}`}
              className="pointer-events-auto group relative mx-auto h-5 w-5 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
              key={turn.id}
              onClick={() => onJumpToTurn(turn.id)}
              title={`${formatPointTime(turn.started_at_ms)}\n${compactQuestion(turn.user_message)}`}
              type="button"
            >
              <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/55 bg-background shadow-sm transition-colors group-hover:bg-primary/20" />
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Add failing test for fixed timeline rail**

Add this test to `ConversationStage.test.tsx`:

```tsx
  it("renders a fixed timeline rail for agent user questions", async () => {
    const { container, root } = await renderConversation(
      <ConversationStage
        agentTurns={[
          agentTurn({ id: "turn-1", user_message: "第一个问题" }),
          agentTurn({ id: "turn-2", user_message: "第二个问题" }),
        ]}
        isPlatformAdmin={false}
        messages={[]}
        onSendMessage={() => {}}
      />,
    );

    const rail = container.querySelector('[data-agent-timeline-rail="true"]');
    expect(rail).not.toBeNull();
    const points = container.querySelectorAll('[aria-label^="定位到"]');
    expect(Array.from(points).some((item) => item.getAttribute("aria-label")?.includes("第一个问题"))).toBe(true);
    expect(Array.from(points).some((item) => item.getAttribute("aria-label")?.includes("第二个问题"))).toBe(true);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
```

- [ ] **Step 3: Add jump target IDs to AgentTurnView**

In `AgentTurnView.tsx`, add `data-agent-turn-question-id` to the article:

```tsx
    <article
      className="flex w-full min-w-0 gap-3 py-2"
      data-agent-turn-id={turn.id}
      data-agent-turn-question-id={turn.id}
    >
```

- [ ] **Step 4: Wire the fixed rail into ConversationStage**

Import:

```tsx
import { AgentTurnTimelineRail } from "./AgentTurnTimelineRail";
```

Add helper in the component:

```ts
  const jumpToAgentTurn = (turnId: string) => {
    const viewport = viewportRef.current;
    const target = viewport?.querySelector(`[data-agent-turn-question-id="${turnId}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      nearBottomRef.current = false;
      setShowJumpToBottom(true);
    }
  };
```

Render it as the first child inside the AgentTurn viewport:

```tsx
              <AgentTurnTimelineRail
                onJumpToTurn={jumpToAgentTurn}
                turns={agentTurns}
              />
```

Add left padding to the AgentTurn list wrapper so the rail does not overlap content:

```tsx
              <div className="flex min-h-full flex-col gap-4 pb-2 pl-10">
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
cd webagent-ui && npm test -- --run src/components/conversation/ConversationStage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add webagent-ui/src/components/conversation/AgentTurnTimelineRail.tsx \
  webagent-ui/src/components/conversation/AgentTurnView.tsx \
  webagent-ui/src/components/conversation/ConversationStage.tsx \
  webagent-ui/src/components/conversation/ConversationStage.test.tsx
git commit -m "feat: add fixed webagent question timeline"
```

### Task 4: Group Agent Steps Into Product Pipeline Sections

**Files:**
- Modify: `webagent-ui/src/lib/clawd/agent-turns.ts`
- Modify: `webagent-ui/src/lib/clawd/agent-turns.test.ts`
- Modify: `webagent-ui/src/components/conversation/AgentActivityTimeline.tsx`
- Modify: `webagent-ui/src/components/conversation/AgentTurnView.tsx`
- Modify: `webagent-ui/src/components/conversation/AgentTurnView.test.tsx`

- [ ] **Step 1: Add failing pipeline grouping tests**

Append to `agent-turns.test.ts`:

```ts
import type { AgentTurnStep, AgentCitation, AgentExpertResult } from "./agent-turns";
import { groupAgentTurnSteps } from "./agent-turns";

describe("groupAgentTurnSteps", () => {
  it("groups retrieval steps with output summaries and citations", () => {
    const steps: AgentTurnStep[] = [
      {
        id: "step-es",
        kind: "retrieval",
        label: "检索 Sina Elasticsearch",
        detail: "命中 2 篇资料",
        status: "succeeded",
        started_at_ms: 1,
        completed_at_ms: 2,
        public_payload: {
          source_name: "Sina Elasticsearch",
          query: "供应链风险",
          hit_count: 2,
          citation_numbers: [1, 2],
        },
      },
    ];
    const citations: AgentCitation[] = [
      {
        id: "cite-1",
        number: 1,
        source_kind: "es",
        source_label: "Sina Elasticsearch",
        title: "供应链报道",
        location: "sina#1",
        preview: "港口风险上升。",
      },
      {
        id: "cite-2",
        number: 2,
        source_kind: "es",
        source_label: "Sina Elasticsearch",
        title: "物流报道",
        location: "sina#2",
        preview: "物流链承压。",
      },
    ];

    const groups = groupAgentTurnSteps(steps, citations, []);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("retrieval");
    expect(groups[0]?.title).toBe("资料检索");
    expect(groups[0]?.items[0]?.output).toContain("命中 2 篇资料");
    expect(groups[0]?.items[0]?.references).toEqual([1, 2]);
  });

  it("groups expert results into the expert pipeline section", () => {
    const expertResults: AgentExpertResult[] = [
      {
        expert_name: "Howard Wang",
        status: "succeeded",
        summary: "军事视角认为需要关注后勤节点。",
        citation_numbers: [1],
        error: null,
      },
    ];

    const groups = groupAgentTurnSteps([], [], expertResults);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("expert");
    expect(groups[0]?.items[0]?.title).toContain("Howard Wang");
    expect(groups[0]?.items[0]?.output).toContain("军事视角");
  });
});
```

- [ ] **Step 2: Implement pipeline view model types and helper**

In `agent-turns.ts`, add:

```ts
export type AgentPipelineGroupKind = "retrieval" | "tool" | "expert" | "artifact" | "generation";

export interface AgentPipelineItem {
  id: string;
  title: string;
  action: string;
  output: string;
  status: AgentTurnStep["status"] | AgentExpertResult["status"];
  references: number[];
  detail: string | null;
  started_at_ms: number | null;
  completed_at_ms: number | null;
}

export interface AgentPipelineGroup {
  kind: AgentPipelineGroupKind;
  title: string;
  items: AgentPipelineItem[];
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringPayload(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberPayload(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberListPayload(payload: Record<string, unknown>, key: string): number[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : [];
}

function groupTitle(kind: AgentPipelineGroupKind): string {
  switch (kind) {
    case "retrieval":
      return "资料检索";
    case "tool":
      return "工具执行";
    case "expert":
      return "专家分析";
    case "artifact":
      return "产物生成";
    case "generation":
      return "回答生成";
  }
}

function groupKindForStep(step: AgentTurnStep): AgentPipelineGroupKind {
  if (step.kind === "retrieval" || step.kind === "citation") return "retrieval";
  if (step.kind === "expert") return "expert";
  if (step.kind === "artifact") return "artifact";
  if (step.kind === "generation") return "generation";
  return "tool";
}

export function groupAgentTurnSteps(
  steps: AgentTurnStep[],
  citations: AgentCitation[],
  expertResults: AgentExpertResult[],
): AgentPipelineGroup[] {
  const groups = new Map<AgentPipelineGroupKind, AgentPipelineGroup>();
  const addItem = (kind: AgentPipelineGroupKind, item: AgentPipelineItem) => {
    const group = groups.get(kind) ?? { kind, title: groupTitle(kind), items: [] };
    group.items.push(item);
    groups.set(kind, group);
  };

  for (const step of steps) {
    const payload = payloadRecord(step.public_payload);
    const kind = groupKindForStep(step);
    const hitCount = numberPayload(payload, "hit_count");
    const references = numberListPayload(payload, "citation_numbers");
    const sourceName = stringPayload(payload, "source_name");
    const query = stringPayload(payload, "query");
    const resultSummary = stringPayload(payload, "result_summary");
    const output =
      resultSummary ??
      (hitCount !== null
        ? `命中 ${hitCount} 篇资料${references.length ? `，形成 ${references.length} 条引用` : ""}`
        : step.detail ?? "步骤已更新");
    const action = query
      ? `查询：${query}`
      : sourceName
        ? `来源：${sourceName}`
        : step.label;
    addItem(kind, {
      id: step.id,
      title: step.label,
      action,
      output,
      status: step.status,
      references,
      detail: step.detail,
      started_at_ms: step.started_at_ms,
      completed_at_ms: step.completed_at_ms,
    });
  }

  for (const expert of expertResults) {
    addItem("expert", {
      id: `expert-${expert.expert_name}`,
      title: `${expert.expert_name} 分析`,
      action: "专家视角分析",
      output: expert.summary ?? expert.error ?? "专家步骤已更新",
      status: expert.status,
      references: expert.citation_numbers,
      detail: expert.error,
      started_at_ms: null,
      completed_at_ms: null,
    });
  }

  if (!steps.length && citations.length) {
    addItem("retrieval", {
      id: "citations",
      title: "引用资料",
      action: "整理引用",
      output: `形成 ${citations.length} 条引用`,
      status: "succeeded",
      references: citations.map((citation) => citation.number),
      detail: null,
      started_at_ms: null,
      completed_at_ms: null,
    });
  }

  return ["retrieval", "tool", "expert", "artifact", "generation"]
    .map((kind) => groups.get(kind as AgentPipelineGroupKind))
    .filter((group): group is AgentPipelineGroup => Boolean(group));
}
```

- [ ] **Step 3: Replace AgentActivityTimeline renderer**

In `AgentActivityTimeline.tsx`, replace the component with:

```tsx
import type { AgentCitation, AgentExpertResult, AgentTurnStep } from "@/lib/clawd/agent-turns";
import { groupAgentTurnSteps } from "@/lib/clawd/agent-turns";

function formatEventTime(value: number | null): string {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusTone(status: string): string {
  if (status === "failed") return "bg-destructive/70";
  if (status === "running" || status === "retrying") return "bg-primary/70";
  if (status === "skipped") return "bg-muted-foreground/45";
  return "bg-emerald-500/70";
}

export function AgentActivityTimeline({
  citations,
  expertResults,
  steps,
}: {
  citations: AgentCitation[];
  expertResults: AgentExpertResult[];
  steps: AgentTurnStep[];
}) {
  const groups = groupAgentTurnSteps(steps, citations, expertResults);
  if (!groups.length) return null;

  return (
    <div className="mt-3 space-y-2">
      {groups.map((group) => (
        <section
          className="rounded-md border border-border/30 bg-background/45 px-3 py-2"
          key={group.kind}
        >
          <p className="mb-2 text-[11px] font-medium text-foreground/85">{group.title}</p>
          <div className="space-y-2">
            {group.items.map((item) => (
              <details className="group rounded-sm" key={item.id}>
                <summary className="flex cursor-pointer list-none gap-2">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${statusTone(item.status)}`}
                    title={formatEventTime(item.completed_at_ms ?? item.started_at_ms)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11px] font-medium text-foreground/85">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block break-words text-[10px] text-muted-foreground">
                      {item.output}
                    </span>
                  </span>
                </summary>
                <div className="ml-3 mt-1 border-l border-border/30 pl-3 text-[10px] leading-5 text-muted-foreground">
                  <p>{item.action}</p>
                  {item.references.length ? (
                    <p>引用：{item.references.map((number) => `[${number}]`).join(" ")}</p>
                  ) : null}
                  {item.detail ? <p>{item.detail}</p> : null}
                </div>
              </details>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Pass citations and expert results from AgentTurnView**

In `AgentTurnView.tsx`, change:

```tsx
          <AgentActivityTimeline steps={turn.steps} />
```

to:

```tsx
          <AgentActivityTimeline
            citations={turn.citations}
            expertResults={turn.expert_results}
            steps={turn.steps}
          />
```

- [ ] **Step 5: Extend AgentTurnView test**

In `AgentTurnView.test.tsx`, change the fixture step payload:

```ts
      public_payload: {
        source_name: "Sina Elasticsearch",
        query: "供应链风险",
        hit_count: 1,
        citation_numbers: [1],
      },
```

Add assertions to the first test:

```ts
    expect(screen.getByText("资料检索")).toBeInTheDocument();
    expect(screen.getByText(/命中 1 篇资料/)).toBeInTheDocument();
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd webagent-ui && npm test -- --run \
  src/lib/clawd/agent-turns.test.ts \
  src/components/conversation/AgentTurnView.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add webagent-ui/src/lib/clawd/agent-turns.ts \
  webagent-ui/src/lib/clawd/agent-turns.test.ts \
  webagent-ui/src/components/conversation/AgentActivityTimeline.tsx \
  webagent-ui/src/components/conversation/AgentTurnView.tsx \
  webagent-ui/src/components/conversation/AgentTurnView.test.tsx
git commit -m "feat: render webagent activity as pipeline"
```

### Task 5: Enrich Backend Agent Step Public Payloads

**Files:**
- Modify: `rust/crates/clawd/src/main.rs`

- [ ] **Step 1: Add failing Rust test for retrieval public payload**

Add this test near existing `map_tool_result_to_agent_updates` tests in `rust/crates/clawd/src/main.rs`:

```rust
    #[test]
    fn es_search_updates_include_product_payload_fields() {
        let output = serde_json::json!({
            "data_source_name": "Sina Elasticsearch",
            "index": "sina_articles",
            "query": "供应链风险",
            "hits": [
                {
                    "title": "供应链报道",
                    "preview": "港口风险上升。",
                    "location": "sina#1"
                },
                {
                    "title": "物流报道",
                    "preview": "物流链承压。",
                    "location": "sina#2"
                }
            ]
        })
        .to_string();

        let mapped = map_tool_result_to_agent_updates(
            "tool-es",
            "EsSearch",
            r#"{"query":"供应链风险"}"#,
            &output,
            false,
        );

        let payload = mapped.steps[0]
            .public_payload
            .as_object()
            .expect("public payload object");
        assert_eq!(payload["source_name"], "Sina Elasticsearch");
        assert_eq!(payload["query"], "供应链风险");
        assert_eq!(payload["hit_count"], 2);
        assert_eq!(payload["citation_numbers"], serde_json::json!([1, 2]));
        assert_eq!(payload["empty_result"], false);
    }
```

- [ ] **Step 2: Add failing Rust test for generic tool payload**

Add:

```rust
    #[test]
    fn generic_tool_updates_include_product_summary_payload() {
        let mapped = map_tool_result_to_agent_updates(
            "tool-db",
            "DbQuery",
            r#"{"query":"select 1"}"#,
            r#"{"rows":[{"count":1}]}"#,
            false,
        );

        let payload = mapped.steps[0]
            .public_payload
            .as_object()
            .expect("public payload object");
        assert_eq!(payload["tool_purpose"], "DbQuery");
        assert_eq!(payload["is_error"], false);
        assert!(payload["result_summary"].as_str().unwrap().contains("执行完成"));
    }
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
cd rust && cargo test -p clawd es_search_updates_include_product_payload_fields generic_tool_updates_include_product_summary_payload
```

Expected: command syntax accepts only one filter, so run them separately:

```bash
cd rust && cargo test -p clawd es_search_updates_include_product_payload_fields
cd rust && cargo test -p clawd generic_tool_updates_include_product_summary_payload
```

Expected: FAIL because payload fields are not present.

- [ ] **Step 4: Add public payload helpers**

Near `value_string`, add:

```rust
fn value_usize(value: &Value, keys: &[&str]) -> Option<usize> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_u64)
            .and_then(|item| usize::try_from(item).ok())
    })
}

fn extract_query_from_tool_input(input: &str) -> Option<String> {
    serde_json::from_str::<Value>(input)
        .ok()
        .and_then(|value| value_string(&value, &["query", "q", "text", "prompt"]))
}

fn summarize_tool_output(output: &str, is_error: bool) -> String {
    if is_error {
        return output.chars().take(160).collect();
    }
    let parsed = serde_json::from_str::<Value>(output).unwrap_or(Value::String(output.to_string()));
    if let Some(rows) = parsed.get("rows").and_then(Value::as_array) {
        return format!("执行完成，返回 {} 行结果", rows.len());
    }
    if let Some(hits) = parsed.get("hits").and_then(Value::as_array) {
        return format!("执行完成，返回 {} 条命中", hits.len());
    }
    "执行完成".to_string()
}

fn build_step_public_payload(
    tool_name: &str,
    input: &str,
    parsed_output: &Value,
    citations: &[AgentCitation],
    is_error: bool,
) -> Value {
    if matches!(tool_name, "EsSearch" | "SourceSearch") {
        let hit_count = parsed_output
            .get("hits")
            .and_then(Value::as_array)
            .map(Vec::len)
            .or_else(|| value_usize(parsed_output, &["hit_count", "count"]))
            .unwrap_or(0);
        return json!({
            "source_name": parsed_output
                .get("data_source_name")
                .or_else(|| parsed_output.get("source_name"))
                .or_else(|| parsed_output.get("index"))
                .and_then(Value::as_str)
                .unwrap_or("平台资料库"),
            "source_id": parsed_output
                .get("data_source_id")
                .or_else(|| parsed_output.get("source_id"))
                .and_then(Value::as_str),
            "query": parsed_output
                .get("query")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .or_else(|| extract_query_from_tool_input(input)),
            "hit_count": hit_count,
            "citation_numbers": citations.iter().map(|citation| citation.number).collect::<Vec<_>>(),
            "empty_result": hit_count == 0,
            "is_error": is_error,
            "result_summary": if is_error {
                summarize_tool_output(&parsed_output.to_string(), true)
            } else {
                format!("命中 {hit_count} 篇资料，形成 {} 条引用", citations.len())
            },
        });
    }

    json!({
        "tool_purpose": tool_name,
        "result_summary": summarize_tool_output(&parsed_output.to_string(), is_error),
        "is_error": is_error,
    })
}
```

- [ ] **Step 5: Use the public payload helper in tool mapping**

In `map_tool_result_to_agent_updates`, replace:

```rust
            public_payload: json!({ "citation_count": citations.len() }),
```

with:

```rust
            public_payload: build_step_public_payload(
                tool_name,
                input,
                &parsed,
                &citations,
                is_error,
            ),
```

- [ ] **Step 6: Run focused Rust tests**

Run:

```bash
cd rust && cargo test -p clawd es_search_updates_include_product_payload_fields
cd rust && cargo test -p clawd generic_tool_updates_include_product_summary_payload
cd rust && cargo test -p clawd agent_tool_updates
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add rust/crates/clawd/src/main.rs
git commit -m "feat: enrich webagent step payloads"
```

### Task 6: Final Verification And Browser Acceptance

**Files:**
- Modify only if verification exposes small defects in files already touched by Tasks 1-5.

- [ ] **Step 1: Run frontend verification**

Run:

```bash
cd webagent-ui && npm test -- --run \
  src/components/conversation/ConversationStage.test.tsx \
  src/components/conversation/AgentTurnView.test.tsx \
  src/lib/clawd/agent-turns.test.ts
cd webagent-ui && npm run build
```

Expected: PASS. Vite may print the known chunk-size warning.

- [ ] **Step 2: Run backend verification**

Run:

```bash
cd rust && cargo fmt
cd rust && cargo test -p clawd agent_tool_updates
cd rust && cargo test -p clawd ag_ui
```

Expected: PASS.

- [ ] **Step 3: Restart screen services with the fixed database**

Run from `.worktrees/webagent-route1`:

```bash
mkdir -p .logs
screen -S clawd-webagent -X quit || true
screen -S webagent-preview -X quit || true
CLAWD_BIND_ADDR=127.0.0.1:3210 \
CLAWD_DATA_DIR=/Users/fuyb/IdeaProjects/claw-code/.worktrees/webagent-route1/.clawd-dev \
CLAWD_DATABASE_URL=sqlite:///Users/fuyb/IdeaProjects/claw-code/.worktrees/webagent-route1/.clawd-dev/clawd.db \
screen -dmS clawd-webagent bash -lc 'cd /Users/fuyb/IdeaProjects/claw-code/.worktrees/webagent-route1 && rust/target/debug/clawd > .logs/clawd-webagent.log 2>&1'
screen -dmS webagent-preview bash -lc 'cd /Users/fuyb/IdeaProjects/claw-code/.worktrees/webagent-route1/webagent-ui && npm run preview -- --host 127.0.0.1 --port 4173 > ../.logs/webagent-ui-preview.log 2>&1'
```

- [ ] **Step 4: Verify service health**

Run:

```bash
lsof -nP -iTCP:3210 -sTCP:LISTEN
lsof -nP -iTCP:4173 -sTCP:LISTEN
curl -sS http://127.0.0.1:3210/healthz
curl -I -sS http://127.0.0.1:4173/
lsof -p $(lsof -tiTCP:3210 -sTCP:LISTEN) | grep .clawd-dev/clawd.db
```

Expected:

- backend listens on `3210`
- frontend listens on `4173`
- health returns `{"ok":true}`
- frontend returns 200
- backend process has `.clawd-dev/clawd.db` open

- [ ] **Step 5: Browser acceptance**

In Chrome DevTools, open `http://127.0.0.1:4173/` and verify:

- selecting one platform source shows `1 个来源`
- sending a message immediately shows the user message and running answer
- viewport scrolls to the newest turn
- activity appears under that answer as pipeline sections
- a run-level failure appears inside the answer card, not at the top of chat
- left timeline rail points hover with time/question and click-scroll to user questions
- ordinary view does not display raw JSON/tool args

- [ ] **Step 6: Commit any acceptance fixes**

If Step 5 reveals small defects, fix them and commit:

```bash
git add webagent-ui/src/components/conversation rust/crates/clawd/src/main.rs
git commit -m "fix: polish webagent chat acceptance"
```

Skip this commit if no changes were required.

### Task 7: Follow-up Chat Product Details

**Files:**
- Modify: `webagent-ui/src/components/conversation/AgentTurnView.tsx`
- Modify: `webagent-ui/src/components/conversation/AgentTurnView.test.tsx`
- Modify: `webagent-ui/src/components/conversation/AgentActivityTimeline.tsx`
- Modify: `webagent-ui/src/components/conversation/AgentActivityTimeline.test.tsx`
- Modify: `webagent-ui/src/hooks/useWebAgentSession.ts`
- Modify: `webagent-ui/src/hooks/useWebAgentSession.test.ts`
- Modify: `webagent-ui/src/lib/clawd/agent-turns.ts`
- Modify: `webagent-ui/src/lib/clawd/agent-turns.test.ts`

- [ ] **Step 1: Lock user question bubble sizing**

Add a render test that verifies the user bubble uses content-sized layout (`w-fit` / `max-w-*`) rather than full-width stretching. Implement by making the user bubble `ml-auto w-fit max-w-[72%]`.

- [ ] **Step 2: Add long-answer folding**

Add a render test with long assistant text. Verify the answer is collapsed by default, shows `展开全文`, and toggles to `收起`. Implement a small local fold state in `AgentTurnView`; fold only when content is long enough.

- [ ] **Step 3: Restore selected-expert execution in the pipeline**

Add hook/model tests proving selected experts create or preserve expert pipeline items when a question is sent. Expert selection must appear in the current answer pipeline as `专家分析`, not only in the right-side panel.

- [ ] **Step 4: Polish pipeline status indicators**

Add component tests for failed, succeeded, and running pipeline items. Implement red dot for failed, green dot for succeeded, and spinner for running/retrying, with accessible status labels.

- [ ] **Step 5: Verify**

Run:

```bash
cd webagent-ui && npm test -- --run \
  src/components/conversation/AgentTurnView.test.tsx \
  src/components/conversation/AgentActivityTimeline.test.tsx \
  src/hooks/useWebAgentSession.test.ts \
  src/lib/clawd/agent-turns.test.ts
cd webagent-ui && npm run build
```

Expected: PASS. Vite may print the known chunk-size warning.

### Task 8: Tree-Shaped Agent Execution Pipeline

**Files:**
- Modify: `webagent-ui/src/lib/clawd/agent-turns.ts`
- Modify: `webagent-ui/src/lib/clawd/agent-turns.test.ts`
- Modify: `webagent-ui/src/components/conversation/AgentActivityTimeline.tsx`
- Modify: `webagent-ui/src/components/conversation/AgentActivityTimeline.test.tsx`

- [ ] **Step 1: Add a tree grouping test**

Build steps for `模型接口响应内容 -> 计划 -> 工具调用 -> 检索分词 -> 检索 -> 结果`. Assert that `groupAgentTurnSteps` returns top-level model/plan items first, with tool/retrieval/result rows nested as children rather than appearing as separate top-level rows.

- [ ] **Step 2: Add child item support**

Add `children?: AgentPipelineItem[]` and optional `parent_id` / `phase` interpretation from `public_payload`. If explicit parent IDs are unavailable, use conservative heuristics: generation/plan items are top-level, tool items are parents, and retrieval/citation/result-like steps after a tool attach to the most recent tool parent.

- [ ] **Step 3: Render tree UI**

Render nested child items with indentation and connector borders. Child rows keep their own status indicator and summaries. Do not duplicate the assistant answer text inside a tool row.

- [ ] **Step 4: Verify**

Run:

```bash
cd webagent-ui && npm test -- --run \
  src/lib/clawd/agent-turns.test.ts \
  src/components/conversation/AgentActivityTimeline.test.tsx
```

Expected: PASS.

## Self-Review

- Spec coverage: Tasks cover run-level error ownership, conditional auto-scroll, fixed user-question timeline, pipeline process rendering, backend public payload enrichment, and real browser acceptance.
- Placeholder scan: No `TBD`, `TODO`, or unspecified implementation steps remain. Each task has concrete files, code snippets, commands, and expected outcomes.
- Type consistency: The plan consistently uses existing `AgentTurnRecord`, `AgentTurnStep`, `AgentCitation`, `AgentExpertResult`, `public_payload`, `debug_payload`, `ConversationStage`, `AgentTurnView`, and `AgentActivityTimeline` names.
