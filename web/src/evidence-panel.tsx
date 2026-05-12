import { useEffect, useRef, useState } from "react";

import type { ThreadSnapshot } from "./types";
import {
  collectEvidenceSourceLabels,
  collectEvidenceEntries,
  isRecord,
  readNumber,
  readString,
  summarizeEvidenceHit,
  stringifyValue,
} from "./evidence";
import { evidenceReferenceMarkdown } from "./reference-utils";

type EvidencePanelProps = {
  thread: ThreadSnapshot | null;
  operatorMode?: boolean;
  embedded?: boolean;
  title?: string;
  highlightedEntryId?: string | null;
  highlightedAnchor?: string | null;
  onInsertReference?: (text: string) => void;
};

function EvidenceHit({
  hit,
  index,
  operatorMode,
  highlighted,
  highlightedRef,
  evidenceId,
  onInsertReference,
}: {
  hit: unknown;
  index: number;
  operatorMode: boolean;
  highlighted: boolean;
  highlightedRef?: ((node: HTMLElement | null) => void) | undefined;
  evidenceId: string;
  onInsertReference?: (text: string) => void;
}) {
  const record = isRecord(hit) ? hit : null;
  const score = readNumber(record?._score);
  const hitIndex = readString(record?._index);
  const summary = summarizeEvidenceHit(hit, index);
  const [copyLabel, setCopyLabel] = useState("复制引用");

  async function handleCopyReference() {
    const text = evidenceReferenceMarkdown({
      evidenceId,
      label: summary.label,
      hitIndex: index,
    });

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopyLabel("已复制引用");
        window.setTimeout(() => setCopyLabel("复制引用"), 1200);
      }
    } catch {
      setCopyLabel("复制失败");
      window.setTimeout(() => setCopyLabel("复制引用"), 1400);
    }
  }

  return (
    <article
      className={`source-hit ${highlighted ? "active" : ""}`}
      data-highlighted={highlighted ? "true" : "false"}
      ref={highlightedRef}
    >
      <header>
        <div className="source-hit-heading">
          <strong>{summary.label}</strong>
          {summary.location ? <span>{summary.location}</span> : null}
        </div>
        <div className="source-hit-meta">
          <span>{hitIndex ? `${hitIndex}` : "未标注索引"}</span>
          {score !== null ? <span>相关度 {score.toFixed(3)}</span> : null}
        </div>
      </header>
      <p>{summary.preview}</p>
      <div className="source-actions">
        <button className="secondary" onClick={() => void handleCopyReference()} type="button">
          {copyLabel}
        </button>
        {onInsertReference ? (
          <button
            className="secondary"
            onClick={() =>
              onInsertReference(
                evidenceReferenceMarkdown({
                  evidenceId,
                  label: summary.label,
                  hitIndex: index,
                }),
              )
            }
            type="button"
          >
            引用到对话
          </button>
        ) : null}
      </div>
      {operatorMode ? (
        <details className="source-raw">
          <summary>原始命中</summary>
          <pre>{stringifyValue(hit)}</pre>
        </details>
      ) : null}
    </article>
  );
}

export function EvidencePanel({
  thread,
  operatorMode = false,
  embedded = false,
  title = "来源",
  highlightedEntryId = null,
  highlightedAnchor = null,
  onInsertReference,
}: EvidencePanelProps) {
  const entries = thread ? collectEvidenceEntries(thread) : [];
  const highlightedRef = useRef<HTMLElement | null>(null);
  const rawHighlightedHitIndex =
    highlightedAnchor?.startsWith("hit-")
      ? Number.parseInt(highlightedAnchor.slice(4), 10) - 1
      : null;
  const highlightedHitIndex =
    rawHighlightedHitIndex !== null && Number.isFinite(rawHighlightedHitIndex)
      ? rawHighlightedHitIndex
      : null;

  useEffect(() => {
    if (highlightedRef.current) {
      highlightedRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [highlightedAnchor, highlightedEntryId]);
  const content = entries.length ? (
    <div className="evidence-list">
      {entries.map((entry) => (
        <article
          className={`evidence-item ${entry.isError ? "error" : ""} ${
            highlightedEntryId === entry.id ? "active" : ""
          }`}
          data-highlighted={highlightedEntryId === entry.id ? "true" : "false"}
          key={entry.id}
          ref={(node) => {
            if (highlightedEntryId === entry.id) {
              highlightedRef.current = node;
            }
          }}
        >
          <header>
            <div className="source-title">
              <strong>{entry.query}</strong>
              <span>索引 {entry.index}</span>
            </div>
            <span className={`scope-pill ${entry.isError ? "scope-thread" : "scope-workspace"}`}>
              {entry.isError ? "检索失败" : `命中 ${entry.total ?? entry.hits.length}`}
            </span>
          </header>

          <div className="evidence-meta">
            {!entry.isError ? <span>预览来源 {entry.hits.length}</span> : null}
            {highlightedEntryId === entry.id ? (
              <span>
                已从对话定位
                {highlightedHitIndex !== null ? ` · 命中 ${highlightedHitIndex + 1}` : ""}
              </span>
            ) : null}
            {operatorMode && entry.fields.length ? (
              <span>fields: {entry.fields.join(", ")}</span>
            ) : null}
            {operatorMode && entry.sourceFields.length ? (
              <span>_source: {entry.sourceFields.join(", ")}</span>
            ) : null}
          </div>

          {!entry.isError && entry.hits.length ? (
            <section className="evidence-query-overview">
              <div className="evidence-query-copy">
                <strong>这轮检索带回了什么</strong>
                <p>
                  {entry.total ?? entry.hits.length} 条候选来源，当前优先展示最相关的前{" "}
                  {Math.min(entry.hits.length, 5)} 条。
                </p>
              </div>
              <div className="evidence-query-tags">
                {collectEvidenceSourceLabels(entry).map((label) => (
                  <span key={`${entry.id}-${label}`}>{label}</span>
                ))}
              </div>
            </section>
          ) : null}

          {entry.isError ? (
            <>
              <p className="evidence-error">{entry.errorMessage ?? "检索失败"}</p>
              {entry.errorStatus !== null ? (
                <div className="evidence-meta">
                  <span>status: {entry.errorStatus}</span>
                </div>
              ) : null}
              {operatorMode && entry.errorDetail ? (
                <details className="source-raw">
                  <summary>错误详情</summary>
                  <pre>{stringifyValue(entry.errorDetail)}</pre>
                </details>
              ) : null}
            </>
          ) : entry.hits.length ? (
            <div className="source-hit-list" role="list" aria-label={`${entry.query} 的来源列表`}>
              {entry.hits.slice(0, 5).map((hit, hitIndex) => (
                <EvidenceHit
                  evidenceId={entry.id}
                  hit={hit}
                  highlighted={
                    highlightedEntryId === entry.id &&
                    highlightedHitIndex === hitIndex
                  }
                  index={hitIndex}
                  key={`${entry.id}-hit-${hitIndex}`}
                  onInsertReference={onInsertReference}
                  operatorMode={operatorMode}
                  highlightedRef={(node) => {
                    if (
                      highlightedEntryId === entry.id &&
                      highlightedHitIndex === hitIndex
                    ) {
                      highlightedRef.current = node;
                    }
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="empty-state">检索成功，但没有命中结果。</div>
          )}

          {operatorMode ? (
            <details className="source-raw">
              <summary>原始结果</summary>
              <pre>{entry.rawOutput}</pre>
            </details>
          ) : null}
        </article>
      ))}
    </div>
  ) : (
    <div className="empty-state">
      运行中调用检索后，这里会出现 query、命中来源与摘要片段。
    </div>
  );

  if (embedded) {
    return (
      <>
        <div className="section-title">{title}</div>
        {content}
      </>
    );
  }

  return (
    <article className="card evidence-card">
      <div className="section-title">{title}</div>
      {content}
    </article>
  );
}
