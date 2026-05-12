import { describe, expect, it } from "vitest";

import {
  appendMessageReference,
  extractWorkbenchReferencesFromMarkdown,
  formatReferenceAnchor,
  parseWorkbenchLink,
} from "./message-links";

describe("message links", () => {
  it("parses workbench deeplinks", () => {
    expect(parseWorkbenchLink("artifact:artifact-1")).toEqual({
      kind: "artifact",
      id: "artifact-1",
      anchor: null,
    });
    expect(parseWorkbenchLink("artifact:artifact-1#block-2")).toEqual({
      kind: "artifact",
      id: "artifact-1",
      anchor: "block-2",
    });
    expect(parseWorkbenchLink("evidence:tool-use-2#hit-3")).toEqual({
      kind: "evidence",
      id: "tool-use-2",
      anchor: "hit-3",
    });
  });

  it("ignores regular links", () => {
    expect(parseWorkbenchLink("https://example.com")).toBeNull();
  });

  it("deduplicates message references and upgrades fallback labels when a better one appears", () => {
    const refs = appendMessageReference([], { id: "artifact-1", label: "", anchor: null });
    const deduped = appendMessageReference(refs, {
      id: "artifact-1",
      label: "Quarterly Report",
      anchor: null,
    });

    expect(deduped).toEqual([{ id: "artifact-1", label: "Quarterly Report", anchor: null }]);
  });

  it("keeps separate references for different anchors", () => {
    const refs = appendMessageReference([], {
      id: "artifact-1",
      label: "Summary",
      anchor: "block-2",
    });
    const next = appendMessageReference(refs, {
      id: "artifact-1",
      label: "Summary",
      anchor: "block-4",
    });

    expect(next).toEqual([
      { id: "artifact-1", label: "Summary", anchor: "block-2" },
      { id: "artifact-1", label: "Summary", anchor: "block-4" },
    ]);
  });

  it("extracts workbench references from markdown text", () => {
    expect(
      extractWorkbenchReferencesFromMarkdown(
        [
          "请先看[架构总览](artifact:artifact-1#block-2)，",
          "再核对[命中 3](evidence:search-1#hit-3)。",
        ].join(""),
      ),
    ).toEqual([
      {
        kind: "artifact",
        id: "artifact-1",
        label: "架构总览",
        anchor: "block-2",
      },
      {
        kind: "evidence",
        id: "search-1",
        label: "命中 3",
        anchor: "hit-3",
      },
    ]);
  });

  it("formats anchor labels for user-facing citation chips", () => {
    expect(formatReferenceAnchor("block-2")).toBe("段落 2");
    expect(formatReferenceAnchor("hit-3")).toBe("命中 3");
    expect(formatReferenceAnchor("custom-anchor")).toBe("custom-anchor");
  });
});
