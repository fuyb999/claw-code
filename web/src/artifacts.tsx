import { useState } from "react";
import { lazy, Suspense } from "react";

import { artifactClipboardText, artifactDownloadFile } from "./artifact-utils";
import { presentArtifactKind } from "./presentation";
import { artifactReferenceMarkdown } from "./reference-utils";
import type { ArtifactRecord, TableArtifactColumn, TableArtifactPayload } from "./types";
import { WorkbenchMarkdown } from "./workbench-markdown";

const LazyChartArtifact = lazy(async () => {
  const module = await import("./chart-artifact");
  return { default: module.default };
});

const LazyGraphArtifact = lazy(async () => {
  const module = await import("./graph-artifact");
  return { default: module.default };
});

function summarizePayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "unserializable payload";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTablePayload(payload: unknown): payload is TableArtifactPayload {
  return (
    isRecord(payload) &&
    Array.isArray(payload.columns) &&
    Array.isArray(payload.rows)
  );
}

function normalizedColumns(
  columns: Array<string | TableArtifactColumn>,
): TableArtifactColumn[] {
  return columns.map((column) =>
    typeof column === "string" ? { key: column, label: column } : column,
  );
}

function TableArtifact({ payload }: { payload: unknown }) {
  if (!isTablePayload(payload)) {
    return <pre>{summarizePayload(payload)}</pre>;
  }

  const columns = normalizedColumns(payload.columns);

  return (
    <table className="artifact-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key}>{column.label ?? column.key}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {payload.rows.map((row, index) => {
          const cells = Array.isArray(row)
            ? row
            : columns.map((column) => row[column.key]);

          return (
            <tr key={`row-${index}`}>
              {cells.map((cell, cellIndex) => (
                <td key={`cell-${index}-${cellIndex}`}>{String(cell ?? "")}</td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ArtifactFallback({ message }: { message: string }) {
  return <div className="artifact-loading">{message}</div>;
}

type ArtifactCardProps = {
  artifact: ArtifactRecord;
  onOpenEvidence?: (evidenceId: string, anchor?: string | null) => void;
  onOpenArtifact?: (artifactId: string, anchor?: string | null) => void;
  onInsertReference?: (text: string) => void;
  highlightedAnchor?: string | null;
};

export function ArtifactCard({
  artifact,
  onOpenEvidence,
  onOpenArtifact,
  onInsertReference,
  highlightedAnchor = null,
}: ArtifactCardProps) {
  const [copyLabel, setCopyLabel] = useState("复制");
  const [referenceCopyLabel, setReferenceCopyLabel] = useState("复制引用");

  async function handleCopy() {
    const text = artifactClipboardText(artifact);

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopyLabel("已复制");
        window.setTimeout(() => setCopyLabel("复制"), 1200);
      }
    } catch {
      setCopyLabel("复制失败");
      window.setTimeout(() => setCopyLabel("复制"), 1400);
    }
  }

  function handleDownload() {
    if (typeof document === "undefined") {
      return;
    }

    const file = artifactDownloadFile(artifact);
    const blob = new Blob([file.content], { type: file.mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function handleCopyReference() {
    const text = artifactReferenceMarkdown(artifact);

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setReferenceCopyLabel("已复制引用");
        window.setTimeout(() => setReferenceCopyLabel("复制引用"), 1200);
      }
    } catch {
      setReferenceCopyLabel("复制失败");
      window.setTimeout(() => setReferenceCopyLabel("复制引用"), 1400);
    }
  }

  return (
    <article className="artifact-card">
      <header>
        <span>{presentArtifactKind(artifact.kind)}</span>
        <strong>{artifact.title ?? "未命名结果"}</strong>
      </header>
      <div className="artifact-actions">
        <button className="secondary" onClick={() => void handleCopy()} type="button">
          {copyLabel}
        </button>
        <button className="secondary" onClick={() => void handleCopyReference()} type="button">
          {referenceCopyLabel}
        </button>
        {onInsertReference ? (
          <button
            className="secondary"
            onClick={() => onInsertReference(artifactReferenceMarkdown(artifact))}
            type="button"
          >
            引用到对话
          </button>
        ) : null}
        <button className="secondary" onClick={handleDownload} type="button">
          下载
        </button>
      </div>

      {artifact.kind === "text" && <pre>{summarizePayload(artifact.payload)}</pre>}
      {artifact.kind === "markdown" && (
        <div className="markdown-body">
          <WorkbenchMarkdown
            artifact={artifact}
            highlightedAnchor={highlightedAnchor}
            onInsertReference={onInsertReference}
            onOpenArtifact={onOpenArtifact}
            onOpenEvidence={onOpenEvidence}
            source={
              typeof artifact.payload === "string"
                ? artifact.payload
                : summarizePayload(artifact.payload)
            }
          />
        </div>
      )}
      {artifact.kind === "table" && <TableArtifact payload={artifact.payload} />}
      {artifact.kind === "chart" && (
        <Suspense fallback={<ArtifactFallback message="加载图表组件…" />}>
          <LazyChartArtifact payload={artifact.payload} />
        </Suspense>
      )}
      {artifact.kind === "graph" && (
        <Suspense fallback={<ArtifactFallback message="加载关系图组件…" />}>
          <LazyGraphArtifact payload={artifact.payload} />
        </Suspense>
      )}
    </article>
  );
}
