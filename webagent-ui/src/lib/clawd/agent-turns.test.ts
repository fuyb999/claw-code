import { describe, expect, it } from "vitest";

import {
  groupTurnsByDisplayDate,
  replaceEvidenceMarkersWithCitationNumbers,
  statusLabelForAgentTurn,
} from "./agent-turns";

describe("agent-turn helpers", () => {
  it("replaces raw evidence markers with numbered citations", () => {
    const result = replaceEvidenceMarkersWithCitationNumbers(
      "结论来自 evidence:tool-1#hit-0 和 evidence:tool-1#hit-1",
      [
        { id: "tool-1#hit-0", number: 1 },
        { id: "tool-1#hit-1", number: 2 },
      ],
    );

    expect(result).toBe("结论来自 [1] 和 [2]");
  });

  it("uses compact date separators", () => {
    const groups = groupTurnsByDisplayDate(
      [
        { id: "a", started_at_ms: new Date("2026-05-15T08:00:00+08:00").getTime() },
        { id: "b", started_at_ms: new Date("2026-05-16T08:00:00+08:00").getTime() },
      ],
      new Date("2026-05-16T12:00:00+08:00"),
    );

    expect(groups.map((group) => group.label)).toEqual(["5月15日 周五", "5月16日 周六"]);
  });

  it("uses ordinary user status labels", () => {
    expect(statusLabelForAgentTurn("running")).toBe("正在处理");
    expect(statusLabelForAgentTurn("failed")).toBe("处理失败");
  });
});
