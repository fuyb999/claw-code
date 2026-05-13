# Execution Context And Expandable Timeline Design

Date: 2026-05-13

## Purpose

Turn the next WebAgent UI slice from visible controls into effective behavior. This design covers three confirmed decisions:

- Source selection applies only to the next user message or next expert panel run.
- Disabling automatic retrieval does not ban retrieval; it only removes retrieval as the default pre-step.
- The center timeline keeps a compact summary by default and exposes the full run history through an expand action.

This is a focused continuation of the AI Analyst WebAgent migration. It does not introduce thread-level source editing, a new workbench, or a full research-task system.

## Current Problem

The migrated UI has the right product structure, but several primary-path controls are still incomplete:

- The left source rail says a source changes the active material scope, but for an existing thread it mainly affects future thread creation.
- The `自动检索` control is local UI state and does not reach backend execution.
- The center timeline only renders the last three events, so users cannot inspect longer expert or retrieval runs.

These issues make the main WebAgent surface look interactive while hiding the actual execution policy.

## Execution Context

Add a one-shot execution context for the next operation. It is not a thread default and is not written back to historical thread metadata.

The context contains:

- `knowledge_base_id`: the user-facing source scope selected from the left rail for the next operation.
- `auto_retrieval`: whether this operation should default to a retrieval pre-step.

Behavior:

- Selecting a source in the left rail updates a pending execution scope.
- Sending a user message consumes the pending scope and current retrieval preference.
- Starting an expert panel run consumes the pending scope and current retrieval preference.
- After a successful send or run start, the pending execution scope is cleared.
- The selected thread's stored `knowledge_base_id` is not changed by this one-shot context.
- If no pending scope is set, requests preserve existing behavior.

User-facing copy should say that the selected source applies to the next message or expert run. It should not imply a permanent thread switch.

## Retrieval Policy

`auto_retrieval` controls the default execution plan, not the maximum permission boundary.

When `auto_retrieval` is `true`:

- The backend may run retrieval as a default pre-step within the provided source scope.
- Expert panel runs may use the selected scope before expert calls if the backend supports that path.

When `auto_retrieval` is `false`:

- The backend should not force a retrieval pre-step before answering or running experts.
- Retrieval remains allowed later in the run if the agent or expert workflow explicitly decides it is needed.
- The UI should present this as "no default pre-search" rather than "retrieval disabled".

This preserves user intent without pretending the system has no retrieval capability.

## API Shape

Extend existing request types with optional fields for compatibility.

For normal thread messages, extend `ThreadCommand` user-message payload:

```ts
{
  type: "user_message";
  content: string;
  expert_panel?: ExpertPanelContext;
  knowledge_base_id?: string;
  auto_retrieval?: boolean;
}
```

For expert panel runs, extend `CreateExpertPanelRunRequest`:

```ts
{
  question?: string;
  source_message_id?: string;
  experts: ExpertSelection[];
  retry_count?: number;
  concurrency_limit?: number;
  knowledge_base_id?: string;
  auto_retrieval?: boolean;
}
```

Backend compatibility rules:

- Missing fields must preserve current behavior.
- Unknown or unauthorized `knowledge_base_id` must fail with a normal request error.
- The backend may initially record the fields and route them to the existing run logic before deeper retrieval-policy execution is implemented.

## Frontend State Flow

The frontend should separate persistent UI selection from one-shot execution context:

- `selectedKnowledgeBaseId`: current left-rail selection used for display and pending context.
- `pendingExecutionScope`: the one-shot source scope to include in the next operation.
- `autoRetrieval`: right-rail preference included in the next operation.

The send/run flow:

1. User selects a source from the left rail.
2. Center header shows that the next message or expert run will use that source.
3. User sends a message or starts an expert panel run.
4. Request includes `knowledge_base_id` and `auto_retrieval`.
5. On success, `pendingExecutionScope` is cleared.
6. Timeline records the context used by the operation.

If request fails, the pending scope should remain so the user can retry without reselecting it.

## Timeline Presentation

The center timeline has two layers.

Compact summary:

- Keep the timeline strip above the chat messages.
- Show the most recent three key events by default.
- Include execution context events when present, such as "本次使用: 平台知识" and "自动检索: 关闭".
- Keep the strip compact so chat remains the primary reading surface.

Expanded timeline:

- Add an explicit "展开时间线" action in the center timeline strip.
- Expanded mode shows all timeline events in chronological order.
- Expanded mode must remain inside the center stage and must not recreate the old right-side workbench.
- The same `TimelineEvent` model should power both compact and expanded views.

Event coverage should include:

- Execution scope and retrieval policy.
- Retrieval start, result, or failure.
- Expert completion, retry, and failure.
- Synthesis.
- Artifact generation.

Reference-bearing events continue to open the existing contextual detail layer.

## Testing Boundaries

Frontend tests:

- `expert-runs.test.ts` should assert `knowledge_base_id` and `auto_retrieval` are included when provided.
- `ChatPanel` or timeline interaction tests should cover compact summary and expanded full-history rendering.
- `app-shell.test.tsx` should assert the expanded timeline entry exists and forbidden workbench terms do not return.
- Source rail tests should assert copy says the selected source applies to the next message or expert run.

Rust tests:

- Request deserialization accepts old payloads without the new fields.
- Request deserialization accepts the new fields.
- `auto_retrieval=false` does not force a default retrieval pre-step.
- `auto_retrieval=false` does not prohibit retrieval later in execution when the agent workflow explicitly needs it.

## Out Of Scope

This slice does not implement:

- Thread-level permanent source switching.
- Historical editing of a thread's knowledge base.
- A right-side result or evidence workbench.
- Full research-task conversion.
- ES admin configuration UI.
- Private user-created experts.

## Acceptance Criteria

This slice is complete when:

1. A selected source scope is included in the next user message or expert panel run request.
2. The selected one-shot scope is cleared after a successful operation and preserved after a failed operation.
3. `auto_retrieval` reaches both normal message and expert panel run execution payloads.
4. Disabling automatic retrieval means no default pre-search, while later retrieval remains permitted by execution logic.
5. The center timeline keeps the default three-event summary.
6. Users can expand the center timeline to inspect all events in order.
7. No old workbench/result/evidence tab language returns to the main mounted path.
