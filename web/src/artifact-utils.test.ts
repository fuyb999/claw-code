import { describe, expect, it } from "vitest";

import { artifactClipboardText, artifactDownloadFile } from "./artifact-utils";
import type { ArtifactRecord } from "./types";

function artifact(overrides: Partial<ArtifactRecord>): ArtifactRecord {
  return {
    id: "artifact-1",
    kind: "table",
    title: "Quarterly Report",
    payload: { columns: ["name"], rows: [{ name: "alpha" }] },
    created_at_ms: 1,
    ...overrides,
  };
}

describe("artifact utils", () => {
  it("uses markdown extension for markdown artifacts", () => {
    const file = artifactDownloadFile(
      artifact({
        kind: "markdown",
        title: "Release Summary",
        payload: "# Summary",
      }),
    );

    expect(file.filename).toBe("release-summary.md");
    expect(file.mimeType).toContain("text/markdown");
    expect(file.content).toBe("# Summary");
  });

  it("serializes structured artifacts for clipboard export", () => {
    const text = artifactClipboardText(artifact({ kind: "graph" }));

    expect(text).toContain("\"kind\": \"graph\"");
    expect(text).toContain("\"payload\"");
  });
});
