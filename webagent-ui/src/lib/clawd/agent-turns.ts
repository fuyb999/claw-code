export type AgentTurnStatus = "queued" | "running" | "succeeded" | "interrupted" | "failed";

export interface AgentTurnStep {
  id: string;
  kind: "retrieval" | "tool" | "expert" | "citation" | "artifact" | "generation";
  label: string;
  detail: string | null;
  status: "running" | "succeeded" | "failed" | "skipped";
  started_at_ms: number | null;
  completed_at_ms: number | null;
  public_payload: unknown;
  debug_payload?: unknown;
}

export interface AgentCitation {
  id: string;
  number: number;
  source_kind: string;
  source_label: string;
  title: string | null;
  location: string | null;
  preview: string;
  debug_payload?: unknown;
}

export interface AgentExpertResult {
  expert_name: string;
  status: "running" | "succeeded" | "retrying" | "failed" | "skipped";
  summary: string | null;
  citation_numbers: number[];
  error: string | null;
}

export interface AgentTurnRecord {
  id: string;
  conversation_id: string;
  tenant_id: string | null;
  owner_id: string;
  user_message: string;
  assistant_text: string;
  status: AgentTurnStatus;
  started_at_ms: number;
  completed_at_ms: number | null;
  steps: AgentTurnStep[];
  citations: AgentCitation[];
  expert_results: AgentExpertResult[];
  artifacts: unknown[];
  error: { public_message: string; debug_message: string | null; code: string | null } | null;
  debug_events: Array<{ event_type: string; at_ms: number; payload: unknown }>;
}

export function statusLabelForAgentTurn(status: AgentTurnStatus): string {
  switch (status) {
    case "queued":
      return "等待发送";
    case "running":
      return "正在处理";
    case "succeeded":
      return "已完成";
    case "interrupted":
      return "已停止";
    case "failed":
      return "处理失败";
  }
}

export function replaceEvidenceMarkersWithCitationNumbers(
  text: string,
  citations: Array<{ id: string; number: number }>,
): string {
  return text.replace(/evidence:([^\s`),.;，。；）]+)/g, (raw, id: string) => {
    const citation = citations.find((item) => item.id === id);
    return citation ? `[${citation.number}]` : raw;
  });
}

export function groupTurnsByDisplayDate<T extends { started_at_ms: number }>(
  turns: T[],
  now: Date = new Date(),
): Array<{ key: string; label: string; turns: T[] }> {
  const groups = new Map<string, { key: string; label: string; turns: T[] }>();
  for (const turn of turns) {
    const date = new Date(turn.started_at_ms);
    const key = date.toLocaleDateString("zh-CN");
    const sameYear = date.getFullYear() === now.getFullYear();
    const label = formatDisplayDate(date, sameYear);
    const group = groups.get(key) ?? { key, label, turns: [] };
    group.turns.push(turn);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function formatDisplayDate(date: Date, sameYear: boolean): string {
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  const weekday = WEEKDAYS[date.getDay()];
  return sameYear ? `${monthDay} ${weekday}` : `${date.getFullYear()}年${monthDay} ${weekday}`;
}
