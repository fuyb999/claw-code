import type { ArtifactRecord } from "./types";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  return JSON.stringify(payload, null, 2);
}

export function artifactClipboardText(artifact: ArtifactRecord): string {
  if (artifact.kind === "text" || artifact.kind === "markdown") {
    return stringifyPayload(artifact.payload);
  }

  return JSON.stringify(
    {
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      payload: artifact.payload,
      created_at_ms: artifact.created_at_ms,
    },
    null,
    2,
  );
}

export function artifactDownloadFile(artifact: ArtifactRecord): {
  filename: string;
  content: string;
  mimeType: string;
} {
  const base = slugify(artifact.title ?? artifact.kind) || artifact.kind;

  if (artifact.kind === "markdown") {
    return {
      filename: `${base}.md`,
      content: stringifyPayload(artifact.payload),
      mimeType: "text/markdown;charset=utf-8",
    };
  }

  if (artifact.kind === "text") {
    return {
      filename: `${base}.txt`,
      content: stringifyPayload(artifact.payload),
      mimeType: "text/plain;charset=utf-8",
    };
  }

  return {
    filename: `${base}.json`,
    content: JSON.stringify(artifact.payload, null, 2),
    mimeType: "application/json;charset=utf-8",
  };
}
