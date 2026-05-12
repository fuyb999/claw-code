export type WorkbenchLinkTarget =
  | { kind: "artifact"; id: string; anchor: string | null }
  | { kind: "evidence"; id: string; anchor: string | null };

export type MessageReference = {
  id: string;
  label: string;
  anchor: string | null;
};

export type LinkedMessageReference = MessageReference & {
  kind: WorkbenchLinkTarget["kind"];
};

export function parseWorkbenchLink(href?: string | null): WorkbenchLinkTarget | null {
  const normalized = href?.trim();
  if (!normalized) {
    return null;
  }

  const [base, anchor] = normalized.split("#", 2);
  const normalizedAnchor = anchor?.trim() || null;

  if (base.startsWith("artifact:")) {
    const id = decodeURIComponent(base.slice("artifact:".length).trim());
    return id ? { kind: "artifact", id, anchor: normalizedAnchor } : null;
  }

  if (base.startsWith("evidence:")) {
    const id = decodeURIComponent(base.slice("evidence:".length).trim());
    return id ? { kind: "evidence", id, anchor: normalizedAnchor } : null;
  }

  return null;
}

export function appendMessageReference(
  refs: MessageReference[],
  ref: MessageReference | null | undefined,
): MessageReference[] {
  const id = ref?.id.trim();
  if (!id) {
    return refs;
  }

  const anchor = ref?.anchor?.trim() || null;
  const label = ref?.label.trim() || id;
  const existingIndex = refs.findIndex(
    (entry) => entry.id === id && (entry.anchor ?? null) === anchor,
  );
  if (existingIndex === -1) {
    return [...refs, { id, label, anchor }];
  }

  const existing = refs[existingIndex];
  if (existing.label !== existing.id || label === id) {
    return refs;
  }

  const next = [...refs];
  next[existingIndex] = { ...existing, label };
  return next;
}

export function extractWorkbenchReferencesFromMarkdown(source: string): LinkedMessageReference[] {
  const refs: LinkedMessageReference[] = [];
  const linkPattern = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  for (const match of source.matchAll(linkPattern)) {
    const label = match[1]?.trim();
    const href = match[2]?.trim();
    const target = parseWorkbenchLink(href);
    if (!target) {
      continue;
    }

    const nextRef: LinkedMessageReference = {
      kind: target.kind,
      id: target.id,
      anchor: target.anchor,
      label: label || target.id,
    };
    const existingIndex = refs.findIndex(
      (entry) =>
        entry.kind === nextRef.kind &&
        entry.id === nextRef.id &&
        (entry.anchor ?? null) === (nextRef.anchor ?? null),
    );
    if (existingIndex === -1) {
      refs.push(nextRef);
      continue;
    }

    if (refs[existingIndex].label === refs[existingIndex].id && nextRef.label !== nextRef.id) {
      refs[existingIndex] = nextRef;
    }
  }

  return refs;
}

export function formatReferenceAnchor(anchor?: string | null): string | null {
  const normalized = anchor?.trim();
  if (!normalized) {
    return null;
  }

  const blockMatch = /^block-(\d+)$/i.exec(normalized);
  if (blockMatch) {
    return `段落 ${blockMatch[1]}`;
  }

  const hitMatch = /^hit-(\d+)$/i.exec(normalized);
  if (hitMatch) {
    return `命中 ${hitMatch[1]}`;
  }

  return normalized;
}
