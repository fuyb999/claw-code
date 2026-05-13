# Execution Context And Expandable Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make source scope and automatic retrieval controls affect the next message or expert run, and expand the center timeline from a three-event summary into a compact-plus-expandable full history.

**Architecture:** Extend the current frontend request adapters and Rust request payloads with optional one-shot execution-context fields. Keep the current mounted route shape (`HistoryPanel` -> `ChatPanel` -> `ExpertPanel`), but add a pending execution scope on the frontend, compatible backend request handling, and a shared timeline event model that supports both compact summary and expanded full history.

**Tech Stack:** React 18, TypeScript, Vitest, Vite, Rust, serde, existing `webagent-ui/src/lib/clawd` adapter layer, `rust/crates/clawd`, `rust/crates/api`.

---

## File Structure

- `webagent-ui/src/lib/clawd/types.ts`
  - Extend `CreateExpertPanelRunRequest` and `ThreadCommand` user-message payload with optional `knowledge_base_id` and `auto_retrieval`.
- `webagent-ui/src/lib/clawd/expert-runs.ts`
  - Extend `buildExpertRunRequest()` to carry execution-context fields into expert panel run requests.
- `webagent-ui/src/lib/clawd/expert-runs.test.ts`
  - Add request-shape tests for new execution-context fields and current compatibility behavior.
- `webagent-ui/src/lib/clawd/timeline-events.ts`
  - Add event kinds and derivation logic for one-shot execution scope and retrieval policy.
- `webagent-ui/src/lib/clawd/timeline-events.test.ts`
  - Add event-derivation tests for execution scope and retrieval policy visibility.
- `webagent-ui/src/components/inspiration/HistoryPanel.tsx`
  - Update copy so source selection is explicitly framed as applying to the next message or expert run.
- `webagent-ui/src/components/inspiration/ChatPanel.tsx`
  - Add expanded timeline toggle and render the full event list in expanded mode while preserving the compact summary.
- `webagent-ui/src/components/inspiration/InspirationMode.tsx`
  - Track pending execution scope, pass execution-context fields into message/run requests, show center-header context copy, and clear pending scope on successful send/run start.
- `webagent-ui/src/components/layout/app-shell.test.tsx`
  - Extend boundary coverage for the expanded timeline control and the updated source-scope copy.
- `rust/crates/clawd/src/main.rs`
  - Update `CommandRequest::UserMessage`, `ExpertPanelRunRequest`, normalization helpers, request handlers, and existing tests to support optional `knowledge_base_id` and `auto_retrieval`.

## Verification Commands

Run focused frontend tests while implementing:

```bash
cd webagent-ui && npm test -- --run \
  src/lib/clawd/expert-runs.test.ts \
  src/lib/clawd/timeline-events.test.ts \
  src/components/layout/app-shell.test.tsx
```

Run focused Rust tests after backend changes:

```bash
cd rust && cargo test normalize_expert_panel_run_request
cd rust && cargo test user_message_command_records_structured_expert_panel_context
```

Run final verification:

```bash
cd webagent-ui && npm run build
cd rust && cargo fmt
cd rust && cargo clippy --workspace --all-targets -- -D warnings
cd rust && cargo test --workspace
```

---

### Task 1: Extend Frontend Request Types And Expert Run Builder

**Files:**
- Modify: `webagent-ui/src/lib/clawd/types.ts`
- Modify: `webagent-ui/src/lib/clawd/expert-runs.ts`
- Modify: `webagent-ui/src/lib/clawd/expert-runs.test.ts`

- [ ] **Step 1: Write the failing frontend request-shape tests**

Update `webagent-ui/src/lib/clawd/expert-runs.test.ts` with tests that assert:

```ts
it("includes execution context when building an expert panel run request", () => {
  expect(
    buildExpertRunRequest({
      question: "分析当前风险",
      experts: [
        {
          skill: "allison",
          scope: "workspace",
          label: "艾利森",
        },
      ],
      retryCount: 1,
      concurrencyLimit: 3,
      knowledgeBaseId: "kb-platform",
      autoRetrieval: false,
    }),
  ).toMatchObject({
    question: "分析当前风险",
    knowledge_base_id: "kb-platform",
    auto_retrieval: false,
  });
});

it("keeps existing payload shape when no execution context is provided", () => {
  expect(
    buildExpertRunRequest({
      question: "分析当前风险",
      experts: [
        {
          skill: "allison",
          scope: "workspace",
          label: "艾利森",
        },
      ],
      retryCount: 1,
      concurrencyLimit: 3,
    }),
  ).not.toHaveProperty("knowledge_base_id");
});
```

- [ ] **Step 2: Run the failing frontend tests**

Run:

```bash
cd webagent-ui && npm test -- --run src/lib/clawd/expert-runs.test.ts
```

Expected: FAIL because the builder input and output do not yet support the new fields.

- [ ] **Step 3: Extend frontend types and builder**

In `webagent-ui/src/lib/clawd/types.ts`, update the request interfaces so the user-message variant and expert-run request both support:

```ts
knowledge_base_id?: string;
auto_retrieval?: boolean;
```

In `webagent-ui/src/lib/clawd/expert-runs.ts`, extend `BuildExpertRunRequestOptions`:

```ts
  knowledgeBaseId?: string;
  autoRetrieval?: boolean;
```

and return them conditionally from `buildExpertRunRequest()`:

```ts
    ...(options.knowledgeBaseId?.trim()
      ? { knowledge_base_id: options.knowledgeBaseId.trim() }
      : {}),
    ...(typeof options.autoRetrieval === "boolean"
      ? { auto_retrieval: options.autoRetrieval }
      : {}),
```

- [ ] **Step 4: Run the frontend tests to green**

Run:

```bash
cd webagent-ui && npm test -- --run src/lib/clawd/expert-runs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  webagent-ui/src/lib/clawd/types.ts \
  webagent-ui/src/lib/clawd/expert-runs.ts \
  webagent-ui/src/lib/clawd/expert-runs.test.ts
git commit -m "feat: add execution context to frontend requests"
```

### Task 2: Carry Pending Execution Context Through The Main Frontend Flow

**Files:**
- Modify: `webagent-ui/src/components/inspiration/HistoryPanel.tsx`
- Modify: `webagent-ui/src/components/inspiration/InspirationMode.tsx`
- Modify: `webagent-ui/src/components/layout/app-shell.test.tsx`

- [ ] **Step 1: Add failing UI boundary assertions**

Extend `webagent-ui/src/components/layout/app-shell.test.tsx` with assertions that the mounted UI contains the updated source-scope copy and expanded-timeline affordance:

```ts
expect(html).toContain("下一次消息或专家会诊");
expect(html).toContain("展开时间线");
```

- [ ] **Step 2: Run the failing UI test**

Run:

```bash
cd webagent-ui && npm test -- --run src/components/layout/app-shell.test.tsx
```

Expected: FAIL because current copy and timeline controls do not match.

- [ ] **Step 3: Add pending execution scope to `InspirationMode`**

In `webagent-ui/src/components/inspiration/InspirationMode.tsx`, add state:

```ts
const [pendingExecutionScope, setPendingExecutionScope] = useState<string | null>(null);
```

Update source selection so it sets both the visual selection and the one-shot scope:

```ts
const handleSelectKnowledgeBase = (knowledgeBaseId: string | null) => {
  selectKnowledgeBase(knowledgeBaseId);
  setPendingExecutionScope(knowledgeBaseId);
};
```

When sending a user message, extend `sendUserMessage()` in `useClawdSession.ts` to accept an optional execution-context argument and include the one-shot context:

```ts
await sendUserMessage(content, undefined, {
  knowledgeBaseId: pendingExecutionScope,
  autoRetrieval,
});
```

When starting an expert run, include the same fields:

```ts
buildExpertRunRequest({
  question: content,
  experts: selectedExperts.map((expert) => ({
    skill: expert.skill.name,
    scope: expert.skill.scope,
    label: expert.name,
    description: expert.description,
  })),
  retryCount,
  concurrencyLimit,
  knowledgeBaseId: pendingExecutionScope,
  autoRetrieval,
})
```

and only clear the pending scope after `sendUserMessage(...)` or `expertRun.start(...)` resolves successfully.

- [ ] **Step 4: Update the left-rail and center-header copy**

In `webagent-ui/src/components/inspiration/HistoryPanel.tsx`, replace:

```tsx
点击来源会切换到它所属的资料范围。
```

with:

```tsx
选择后会用于下一次消息或专家会诊。
```

In `InspirationMode.tsx`, make the center header prefer one-shot execution-context wording:

```ts
sourceContextLabel={
  pendingExecutionScope && activeKnowledgeBase
    ? `下一次消息将使用：${activeKnowledgeBase.name}`
    : selectedThread?.knowledge_base_name
      ? `当前线程资料空间：${selectedThread.knowledge_base_name}`
      : activeKnowledgeBase
        ? `下一次新建会话将连接：${activeKnowledgeBase.name}`
        : null
}
```

- [ ] **Step 5: Run the UI test to green**

Run:

```bash
cd webagent-ui && npm test -- --run src/components/layout/app-shell.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  webagent-ui/src/components/inspiration/HistoryPanel.tsx \
  webagent-ui/src/components/inspiration/InspirationMode.tsx \
  webagent-ui/src/components/layout/app-shell.test.tsx
git commit -m "feat: wire pending execution scope through ui"
```

### Task 3: Add Expandable Timeline Presentation

**Files:**
- Modify: `webagent-ui/src/lib/clawd/timeline-events.ts`
- Modify: `webagent-ui/src/lib/clawd/timeline-events.test.ts`
- Modify: `webagent-ui/src/components/inspiration/ChatPanel.tsx`
- Modify: `webagent-ui/src/components/inspiration/TimelineEventCard.tsx`
- Modify: `webagent-ui/src/components/layout/app-shell.test.tsx`

- [ ] **Step 1: Write failing timeline tests**

Add a failing derivation test in `webagent-ui/src/lib/clawd/timeline-events.test.ts` using the existing thread-builder style:

```ts
it("adds execution context events for scoped runs and retrieval policy", () => {
  const events = buildTimelineEvents(
    thread({
      messages: [
        {
          id: "m-user",
          role: "user",
          blocks: [{ type: "text", text: "分析当前风险" }],
          metadata: {
            knowledge_base_name: "平台知识",
            auto_retrieval: false,
          },
        },
      ],
    }),
  );

  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "execution_scope",
        title: "本次使用资料范围",
      }),
      expect.objectContaining({
        kind: "retrieval_policy",
        title: "自动检索已关闭",
      }),
    ]),
  );
});
```

Add a UI boundary assertion in `app-shell.test.tsx`:

```ts
expect(html).toContain("展开时间线");
```

- [ ] **Step 2: Run the failing timeline tests**

Run:

```bash
cd webagent-ui && npm test -- --run \
  src/lib/clawd/timeline-events.test.ts \
  src/components/layout/app-shell.test.tsx
```

Expected: FAIL because the new event kinds and expand control do not exist.

- [ ] **Step 3: Extend timeline event derivation**

In `webagent-ui/src/lib/clawd/timeline-events.ts`, add two event kinds:

```ts
| "execution_scope"
| "retrieval_policy"
```

Derive them from message metadata or audit payloads that carry effective execution context. Use user-facing labels only:

```ts
{
  id: `scope-${message.id}`,
  kind: "execution_scope",
  title: "本次使用资料范围",
  subtitle: message.knowledge_base_name ?? "当前资料范围",
  atMs,
  reference: null,
}
```

```ts
{
  id: `retrieval-policy-${message.id}`,
  kind: "retrieval_policy",
  title: autoRetrieval ? "自动检索已开启" : "自动检索已关闭",
  subtitle: autoRetrieval ? "回答前可默认检索资料" : "不做默认前置检索",
  atMs,
  reference: null,
}
```

- [ ] **Step 4: Add expanded timeline mode in `ChatPanel`**

In `webagent-ui/src/components/inspiration/ChatPanel.tsx`, add local state:

```ts
const [timelineExpanded, setTimelineExpanded] = useState(false);
```

Add a toggle button next to the timeline header:

```tsx
<button
  className="text-[10px] text-primary transition-colors hover:text-primary/80"
  onClick={() => setTimelineExpanded((current) => !current)}
  type="button"
>
  {timelineExpanded ? "收起时间线" : "展开时间线"}
</button>
```

Render compact vs expanded event lists:

```tsx
const visibleTimelineEvents = timelineExpanded
  ? timelineEvents
  : timelineEvents.slice(-3);
```

and adjust the layout so expanded mode stacks events vertically:

```tsx
<div className={timelineExpanded ? "space-y-1.5" : "grid gap-1 md:grid-cols-2 xl:grid-cols-3"}>
```

- [ ] **Step 5: Run the timeline tests to green**

Run:

```bash
cd webagent-ui && npm test -- --run \
  src/lib/clawd/timeline-events.test.ts \
  src/components/layout/app-shell.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  webagent-ui/src/lib/clawd/timeline-events.ts \
  webagent-ui/src/lib/clawd/timeline-events.test.ts \
  webagent-ui/src/components/inspiration/ChatPanel.tsx \
  webagent-ui/src/components/inspiration/TimelineEventCard.tsx \
  webagent-ui/src/components/layout/app-shell.test.tsx
git commit -m "feat: add expandable timeline history"
```

### Task 4: Extend Backend Request Compatibility

**Files:**
- Modify: `rust/crates/clawd/src/main.rs`

- [ ] **Step 1: Find the concrete Rust request types and add failing tests**

Add failing tests alongside the existing ones in `rust/crates/clawd/src/main.rs` that verify:

```rust
// old payload still deserializes
// payload with knowledge_base_id + auto_retrieval also deserializes
// auto_retrieval=false is preserved as false
```

- [ ] **Step 2: Run the failing Rust tests**

Run:

```bash
cd rust && cargo test normalize_expert_panel_run_request
cd rust && cargo test user_message_command_records_structured_expert_panel_context
```

Expected: FAIL because the Rust request types do not yet accept the new fields.

- [ ] **Step 3: Add optional fields to Rust request parsing**

Update the relevant Rust request models to include:

```rust
pub knowledge_base_id: Option<String>,
pub auto_retrieval: Option<bool>,
```

Apply this to:

- `CommandRequest::UserMessage`
- `ExpertPanelRunRequest`

Keep them optional so existing clients remain valid.

- [ ] **Step 4: Thread the fields into runtime execution**

Update the code path that handles user-message execution and expert panel run creation so:

- `knowledge_base_id` is available to the run context for this operation
- `auto_retrieval: Some(false)` suppresses default pre-search
- later retrieval remains available to the runtime if explicitly needed

Do not change thread-level permanent source binding in this task.

- [ ] **Step 5: Run the focused Rust tests to green**

Run:

```bash
cd rust && cargo test normalize_expert_panel_run_request
cd rust && cargo test user_message_command_records_structured_expert_panel_context
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rust
git commit -m "feat: add backend execution context compatibility"
```

### Task 5: Final Verification

**Files:**
- Review only unless test fixes are required.

- [ ] **Step 1: Run focused frontend verification**

Run:

```bash
cd webagent-ui && npm test -- --run \
  src/lib/clawd/expert-runs.test.ts \
  src/lib/clawd/timeline-events.test.ts \
  src/components/layout/app-shell.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run:

```bash
cd webagent-ui && npm run build
```

Expected: PASS.

- [ ] **Step 3: Run Rust verification**

Run:

```bash
cd rust && cargo fmt
cd rust && cargo clippy --workspace --all-targets -- -D warnings
cd rust && cargo test --workspace
```

Expected: PASS.

- [ ] **Step 4: Review diff scope**

Run:

```bash
git diff --stat
git diff -- webagent-ui/src rust docs/superpowers/specs/2026-05-13-execution-context-expandable-timeline-design.md docs/superpowers/plans/2026-05-13-execution-context-expandable-timeline.md
```

Expected: changes stay limited to execution-context requests, mounted UI flow, timeline presentation, Rust compatibility, and the new planning docs.

- [ ] **Step 5: Report final verification in the completion response**

Include:

- focused frontend tests PASS/FAIL
- `npm run build` PASS/FAIL
- Rust verification PASS/FAIL
- any remaining deliberate follow-up, especially if deeper retrieval-policy logic is still staged behind compatibility plumbing
