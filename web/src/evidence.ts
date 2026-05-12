import type { ThreadSnapshot } from "./types";

type SearchInputShape = {
  query?: string;
  index?: string;
  fields?: string[];
  source_fields?: string[];
};

export type EvidenceEntry = {
  id: string;
  query: string;
  index: string;
  fields: string[];
  sourceFields: string[];
  total: number | null;
  hits: unknown[];
  isError: boolean;
  errorMessage: string | null;
  errorStatus: number | null;
  errorDetail: unknown;
  rawOutput: string;
};

export type EvidenceCollectionSummary = {
  totalQueries: number;
  successCount: number;
  errorCount: number;
  totalHitsPreview: number;
};

export type EvidenceHitSummary = {
  label: string;
  location: string | null;
  preview: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseSearchInput(raw: string): SearchInputShape | null {
  const parsed = parseJson(raw);
  return isRecord(parsed) ? parsed : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "unserializable value";
  }
}

export function truncate(value: string, maxLength = 260): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function findFirstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

export function summarizeEvidenceHit(hit: unknown, index: number): EvidenceHitSummary {
  if (!isRecord(hit)) {
    return {
      label: `命中 ${index + 1}`,
      location: null,
      preview: truncate(stringifyValue(hit)),
    };
  }

  const source = isRecord(hit._source) ? hit._source : null;
  if (!source) {
    return {
      label: readString(hit._id) ?? `命中 ${index + 1}`,
      location: readString(hit._index),
      preview: truncate(stringifyValue(hit)),
    };
  }

  const label =
    findFirstString(source, ["title", "name", "path", "file", "filepath", "url", "uri"]) ??
    readString(hit._id) ??
    `命中 ${index + 1}`;
  const location = findFirstString(source, ["path", "file", "filepath", "url", "uri"]);
  const preview =
    findFirstString(source, [
      "summary",
      "snippet",
      "content",
      "text",
      "body",
      "description",
    ]) ?? stringifyValue(source);

  return {
    label,
    location: location && location !== label ? location : null,
    preview: truncate(preview),
  };
}

export function collectEvidenceSourceLabels(entry: Pick<EvidenceEntry, "hits">): string[] {
  const labels: string[] = [];

  for (const [index, hit] of entry.hits.entries()) {
    const nextLabel = summarizeEvidenceHit(hit, index).label;
    if (!labels.includes(nextLabel)) {
      labels.push(nextLabel);
    }
    if (labels.length >= 3) {
      break;
    }
  }

  return labels;
}

export function collectEvidenceEntries(thread: ThreadSnapshot): EvidenceEntry[] {
  const inputs = new Map<string, SearchInputShape>();
  const entries: EvidenceEntry[] = [];

  for (const message of thread.messages) {
    for (const block of message.blocks) {
      if (
        block.type === "tool_use" &&
        (block.name === "EsSearch" || block.name === "SourceSearch")
      ) {
        inputs.set(block.id, parseSearchInput(block.input) ?? {});
        continue;
      }

      if (
        block.type !== "tool_result" ||
        (block.tool_name !== "EsSearch" && block.tool_name !== "SourceSearch")
      ) {
        continue;
      }

      const input = inputs.get(block.tool_use_id) ?? {};
      const parsed = parseJson(block.output);
      const parsedRecord = isRecord(parsed) ? parsed : null;
      const hits = Array.isArray(parsedRecord?.hits) ? parsedRecord.hits : [];

      entries.push({
        id: block.tool_use_id,
        query:
          readString(parsedRecord?.query) ??
          readString(input.query) ??
          "未提供 query",
        index:
          readString(parsedRecord?.index) ??
          readString(input.index) ??
          (block.tool_name === "SourceSearch" ? "uploaded_documents" : "default"),
        fields: readStringArray(parsedRecord?.fields ?? input.fields),
        sourceFields: readStringArray(
          parsedRecord?.source_fields ?? input.source_fields,
        ),
        total: readNumber(parsedRecord?.total),
        hits,
        isError: block.is_error,
        errorMessage: block.is_error
          ? readString(parsedRecord?.message) ?? block.output
          : null,
        errorStatus: readNumber(parsedRecord?.status),
        errorDetail: parsedRecord?.detail ?? null,
        rawOutput: block.output,
      });
    }
  }

  return entries.reverse();
}

export function summarizeEvidenceEntries(entries: EvidenceEntry[]): EvidenceCollectionSummary {
  return {
    totalQueries: entries.length,
    successCount: entries.filter((entry) => !entry.isError).length,
    errorCount: entries.filter((entry) => entry.isError).length,
    totalHitsPreview: entries.reduce((sum, entry) => sum + entry.hits.length, 0),
  };
}
