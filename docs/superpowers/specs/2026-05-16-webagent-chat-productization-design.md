# WebAgent Chat Productization Design

Date: 2026-05-16

## Context

The AG UI WebAgent rebuild has moved the main chat path to database-backed `AgentTurn` records, but the current page still exposes several non-product behaviors:

- run failures can appear as a global error card at the top of the chat content
- newly sent messages and streaming updates do not always scroll into view
- tool calls, retrieval events, and expert progress are visible, but still read like a flat execution log instead of a user-facing agent process
- the left-side timeline is attached to message flow rather than acting as a fixed navigation aid

This design keeps the confirmed main model: one user question maps to one `AgentTurn`; all retrieval, tool, expert, citation, artifact, and answer state belongs inside that turn.

## Confirmed Boundaries

1. Run-level failures belong to the owning `AgentTurn`, not to the top of the chat.
2. Page-level errors are reserved for authentication, history loading, backend unavailable, and other whole-page failures.
3. Auto-scroll follows only when the user is near the bottom or has just sent a message.
4. If the user scrolls upward to inspect history, streaming updates do not force the viewport downward.
5. The left timeline is fixed to the chat content height and acts as navigation, not as part of the message scroll flow.
6. The timeline shows only user-question points. AI replies do not get main timeline points.
7. Hovering a timeline point shows the full time and the user question summary.
8. Clicking a timeline point scrolls the chat content to that user question.
9. Agent process display is a pipeline. Each step must show action, output, and status.
10. Ordinary users can see query terms, hit titles/summaries, citation numbers, expert summaries, artifact summaries, duration, and failure summaries.
11. Raw JSON, tool arguments, full tool returns, AG UI event payloads, and debug payloads are admin-only.
12. Failed tool/retrieval/expert steps stay visible in the pipeline with retry/skip/recovered state when available.

## Design

### 1. Error Ownership

`ConversationStage` should stop rendering run-level failures as a top-of-viewport `处理异常` card in the AgentTurn path.

`useWebAgentSession.error` remains for page-level failures:

- cannot load conversation list
- cannot load turns for selected conversation
- auth/session failure
- backend unavailable before a run starts

When a run fails after a local turn exists, the failure is stored in that turn:

- `turn.status = "failed"`
- `turn.error.public_message` contains the user-facing failure summary
- a failed `AgentTurnStep` is appended or updated with a specific failed stage

`AgentTurnView` renders the failure inside the answer card. The card header shows `处理失败`; the body shows a compact failure block; the pipeline shows the failed step. Retry remains in `ConversationComposer` as a light action tied to the failed pending message or latest failed turn.

### 2. Auto-Scroll

The chat viewport has one scroll owner. AgentTurn mode and fallback mode should both use the same scroll policy.

Scrolling follows these triggers:

- local turn appended after send
- first assistant text delta
- activity snapshot or pipeline update
- citation update
- run finished

The viewport scrolls only when:

- the user just sent a message, or
- the viewport is already near the bottom

If the user manually scrolls upward, `nearBottomRef` becomes false. Updates continue rendering, but the viewport does not jump. A floating `回到最新内容` button appears in the bottom-right of the chat viewport above the composer. It must not occupy a row in the message flow.

The scroll dependency key for AgentTurn mode should include:

- selected conversation id
- latest turn id
- latest turn status
- latest assistant text length
- latest step count
- latest citation count
- sending/running flags

### 3. Fixed Timeline Navigation

The left timeline should be separated from the message flow. It is fixed inside the central chat content area and has the same visual height as the message viewport.

Timeline behavior:

- one point per user question
- point positions are calculated from the corresponding question element inside the scroll viewport
- hover shows a tooltip with exact time and user question summary
- click scrolls the viewport to that question
- same-day labels stay compact; cross-day groups show a compact date marker

The timeline is not a second message list. It is a navigation rail. AI replies and internal steps do not create main timeline points.

### 4. Pipeline Process Display

`AgentActivityTimeline` becomes a pipeline renderer instead of a flat list. Each pipeline item answers:

- what happened
- what it produced
- whether it is running, succeeded, failed, skipped, retrying, or recovered

Pipeline groups:

- retrieval: platform source search, query, hit count, citations produced
- tool: tool purpose, result summary, artifact/citation side effects
- expert: expert name, attempt, summary, citation count, retry state
- artifact: artifact kind and summary
- generation: answer drafting and finalization

Default view shows concise product copy:

- `检索 Sina Elasticsearch`
- `查询：供应链风险`
- `产出：命中 8 篇资料，形成 3 条引用`
- `Howard Wang 分析完成，产出 1 段专家摘要`

Expanded view for ordinary users may include:

- query terms
- hit titles
- hit previews
- citation numbers
- expert summary
- artifact summary
- duration
- failure reason summary

Follow-up UI constraints confirmed on 2026-05-16:

- User question bubbles are content-sized with a max width; short questions should not stretch to a uniform row width.
- Assistant replies use long-content folding. Short replies stay fully visible; long replies default to a preview of about 10 lines with `展开全文` / `收起`.
- Selecting experts before asking a question must be reflected in the current answer pipeline. Expert execution cannot only appear in the right panel.
- Every pipeline item shows an end-state indicator: green for succeeded, red for failed, and a spinner for running/retrying. Status must also be available as text for accessibility.
- Pipeline steps render as a parent-child execution chain, not a flat list. The normal order is model response / plan, then tool call, then tool-owned child steps such as retrieval tokenization, retrieval, and result. Retrieval/expert/result details must attach under their owning parent instead of appearing as unrelated rows after the answer.

Admin-only details stay in `AgentDebugDetails`:

- raw AG UI events
- tool args
- raw tool result
- debug payload
- internal IDs beyond citation/source labels

### 5. Backend Step Payload Contract

The backend should enrich `AgentTurnStep.public_payload` so the frontend does not parse raw text or raw JSON.

Retrieval payload should include:

- `source_id`
- `source_name`
- `query`
- `hit_count`
- `citation_numbers`
- `empty_result`

Tool payload should include:

- `tool_purpose`
- `result_summary`
- `is_error`

Expert payload should include:

- `expert_name`
- `attempt`
- `summary`
- `citation_numbers`
- `retry_state`

Raw inputs/results stay in `debug_payload`.

## Implementation Order

1. Move run failures from the top-level chat banner into `AgentTurnView`.
2. Fix AgentTurn auto-scroll and floating latest-content button behavior.
3. Add the fixed left timeline navigation rail.
4. Add frontend pipeline grouping helpers and tests.
5. Upgrade `AgentActivityTimeline` to render grouped pipeline steps.
6. Enrich backend `public_payload` for retrieval/tool/expert steps.
7. Run real browser acceptance with one selected platform source and a forced failure case.

## Testing

Frontend tests:

- failed AgentTurn renders failure inside its own card
- AgentTurn path does not show top-level `处理异常` for run-level errors
- new local turn triggers scroll-to-bottom
- streaming updates follow only when near bottom
- user scroll-up suppresses forced auto-scroll
- timeline point click scrolls to the matching user question
- timeline hover exposes time and question summary
- retrieval/tool/expert steps group into pipeline sections
- ordinary view does not expose raw JSON or tool args

Backend tests:

- `EsSearch` tool updates include retrieval product payload fields
- generic tool updates include product summary fields
- expert updates include expert payload fields
- debug payload still carries raw diagnostic details for admins

## Acceptance

In the running UI:

- sending a message immediately shows the user message and a running answer card
- the viewport scrolls to the newest answer unless the user is reading history
- run failure appears inside the failed answer, not at the top of all chat content
- tool/retrieval/expert progress appears under the current answer as pipeline steps
- each step shows action, output summary, and status
- clicking a fixed left timeline point jumps to that user question
- ordinary users do not see raw tool JSON
- admins can still expand technical details

## Self-Review

No placeholders remain. The design is scoped to chat productization only and does not reopen the broader AG UI architecture, database migration, OIDC, or admin configuration work. The error, scroll, timeline, and pipeline requirements are consistent with the existing `AgentTurn` model and can be implemented incrementally.
