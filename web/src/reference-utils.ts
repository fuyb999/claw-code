import type { ArtifactRecord } from "./types";
import { presentArtifactKind } from "./presentation";

function sanitizeReferenceLabel(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[[\]]/g, " ").trim() || "引用";
}

function markdownLink(label: string, href: string): string {
  return `[${sanitizeReferenceLabel(label)}](${href})`;
}

function truncateReferenceLabel(value: string, maxLength = 72): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

export function artifactBlockAnchor(blockIndex: number): string {
  return `block-${Math.max(1, Math.trunc(blockIndex))}`;
}

export function artifactReferenceHref(
  artifactId: string,
  anchor?: string | null,
): string {
  const base = workbenchReferenceHref("artifact", artifactId);
  return anchor?.trim() ? `${base}#${anchor.trim()}` : base;
}

export function workbenchReferenceHref(
  kind: "artifact" | "evidence",
  id: string,
  anchor?: string | null,
): string {
  const base = `${kind}:${encodeURIComponent(id)}`;
  return anchor?.trim() ? `${base}#${anchor.trim()}` : base;
}

export function evidenceReferenceHref(
  evidenceId: string,
  hitIndex?: number | null,
): string {
  if (typeof hitIndex === "number" && Number.isFinite(hitIndex) && hitIndex >= 0) {
    return workbenchReferenceHref("evidence", evidenceId, `hit-${hitIndex + 1}`);
  }

  return workbenchReferenceHref("evidence", evidenceId);
}

export function artifactReferenceLabel(options: {
  artifact: Pick<ArtifactRecord, "kind" | "title">;
  anchor?: string | null;
  blockLabel?: string | null;
}): string {
  const baseLabel = options.artifact.title ?? presentArtifactKind(options.artifact.kind);
  const normalizedBlockLabel = options.blockLabel?.trim();
  if (!options.anchor?.trim()) {
    return baseLabel;
  }

  if (normalizedBlockLabel) {
    return truncateReferenceLabel(`${baseLabel} · ${normalizedBlockLabel}`);
  }

  return truncateReferenceLabel(`${baseLabel} · ${options.anchor.trim()}`);
}

export function artifactReferenceMarkdown(
  artifact: Pick<ArtifactRecord, "id" | "kind" | "title">,
  options?: {
    anchor?: string | null;
    blockLabel?: string | null;
  },
): string {
  return markdownLink(
    artifactReferenceLabel({
      artifact,
      anchor: options?.anchor,
      blockLabel: options?.blockLabel,
    }),
    artifactReferenceHref(artifact.id, options?.anchor),
  );
}

export function evidenceReferenceMarkdown(options: {
  evidenceId: string;
  label: string;
  hitIndex?: number | null;
}): string {
  return markdownLink(
    options.label,
    evidenceReferenceHref(options.evidenceId, options.hitIndex),
  );
}

export function workbenchReferenceMarkdown(options: {
  kind: "artifact" | "evidence";
  id: string;
  label: string;
  anchor?: string | null;
}): string {
  return markdownLink(
    options.label,
    workbenchReferenceHref(options.kind, options.id, options.anchor),
  );
}

export function appendComposerText(current: string, next: string): string {
  const normalizedCurrent = current.trim();
  const normalizedNext = next.trim();
  if (!normalizedNext) {
    return normalizedCurrent;
  }
  if (!normalizedCurrent) {
    return normalizedNext;
  }

  return `${normalizedCurrent}\n\n${normalizedNext}`;
}
