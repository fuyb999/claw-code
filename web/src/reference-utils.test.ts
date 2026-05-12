import { describe, expect, it } from "vitest";

import {
  appendComposerText,
  artifactBlockAnchor,
  artifactReferenceHref,
  artifactReferenceLabel,
  artifactReferenceMarkdown,
  evidenceReferenceMarkdown,
  workbenchReferenceMarkdown,
} from "./reference-utils";
import type { ArtifactRecord } from "./types";

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: "artifact-1",
    kind: "markdown",
    title: "Release Summary",
    payload: "# Summary",
    created_at_ms: 1,
    ...overrides,
  };
}

describe("reference utils", () => {
  it("builds artifact deeplink markdown", () => {
    expect(artifactReferenceMarkdown(artifact())).toBe(
      "[Release Summary](artifact:artifact-1)",
    );
  });

  it("builds artifact block deeplink markdown", () => {
    expect(
      artifactReferenceMarkdown(artifact(), {
        anchor: artifactBlockAnchor(2),
        blockLabel: "关键结论段落",
      }),
    ).toBe("[Release Summary · 关键结论段落](artifact:artifact-1#block-2)");
    expect(artifactReferenceHref("artifact-1", "block-2")).toBe(
      "artifact:artifact-1#block-2",
    );
  });

  it("falls back to anchor text when no block label is provided", () => {
    expect(
      artifactReferenceLabel({
        artifact: artifact(),
        anchor: "block-4",
        blockLabel: "",
      }),
    ).toBe("Release Summary · block-4");
  });

  it("builds evidence deeplink markdown with hit anchor", () => {
    expect(
      evidenceReferenceMarkdown({
        evidenceId: "es-1",
        label: "Repository Overview",
        hitIndex: 1,
      }),
    ).toBe("[Repository Overview](evidence:es-1#hit-2)");
  });

  it("builds generic workbench markdown references with anchors", () => {
    expect(
      workbenchReferenceMarkdown({
        kind: "artifact",
        id: "artifact-9",
        label: "结论段落",
        anchor: "block-3",
      }),
    ).toBe("[结论段落](artifact:artifact-9#block-3)");
  });

  it("appends composer text without clobbering existing draft", () => {
    expect(appendComposerText("已有草稿", "[引用](artifact:artifact-1)")).toBe(
      "已有草稿\n\n[引用](artifact:artifact-1)",
    );
  });
});
