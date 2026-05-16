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

export type AgentPipelineGroupKind =
  | "retrieval"
  | "tool"
  | "expert"
  | "artifact"
  | "generation";

export interface AgentPipelineItem {
  id: string;
  title: string;
  action: string;
  output: string;
  status: AgentTurnStep["status"] | AgentExpertResult["status"];
  references: number[];
  detail: string | null;
  started_at_ms: number | null;
  completed_at_ms: number | null;
}

export interface AgentPipelineGroup {
  kind: AgentPipelineGroupKind;
  title: string;
  items: AgentPipelineItem[];
}

const PIPELINE_GROUP_TITLES: Record<AgentPipelineGroupKind, string> = {
  retrieval: "资料检索",
  tool: "工具执行",
  expert: "专家分析",
  artifact: "产物生成",
  generation: "回答生成",
};

const PIPELINE_GROUP_ORDER: AgentPipelineGroupKind[] = [
  "retrieval",
  "tool",
  "expert",
  "artifact",
  "generation",
];

export function groupAgentTurnSteps(
  steps: AgentTurnStep[],
  citations: AgentCitation[],
  expertResults: AgentExpertResult[],
): AgentPipelineGroup[] {
  const groups = new Map<AgentPipelineGroupKind, AgentPipelineGroup>();

  for (const step of steps) {
    const kind = pipelineGroupKindForStep(step.kind);
    addPipelineItem(groups, kind, {
      id: step.id,
      title: step.label,
      action: actionForStep(step),
      output: outputForStep(step),
      status: step.status,
      references: citationNumbersFromPayload(step.public_payload),
      detail: step.detail,
      started_at_ms: step.started_at_ms,
      completed_at_ms: step.completed_at_ms,
    });
  }

  expertResults.forEach((result, index) => {
    addPipelineItem(groups, "expert", {
      id: `expert-result-${result.expert_name}-${index}`,
      title: `${result.expert_name} 分析`,
      action: "专家视角分析",
      output: result.summary ?? result.error ?? "专家分析已更新",
      status: result.status,
      references: result.citation_numbers,
      detail: null,
      started_at_ms: null,
      completed_at_ms: null,
    });
  });

  if (!steps.length && citations.length) {
    addPipelineItem(groups, "retrieval", {
      id: "citations-summary",
      title: "引用资料",
      action: "资料检索",
      output: `形成 ${citations.length} 条引用`,
      status: "succeeded",
      references: citations.map((citation) => citation.number),
      detail: null,
      started_at_ms: null,
      completed_at_ms: null,
    });
  }

  return PIPELINE_GROUP_ORDER.flatMap((kind) => {
    const group = groups.get(kind);
    return group && group.items.length ? [group] : [];
  });
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

function addPipelineItem(
  groups: Map<AgentPipelineGroupKind, AgentPipelineGroup>,
  kind: AgentPipelineGroupKind,
  item: AgentPipelineItem,
): void {
  const group = groups.get(kind) ?? {
    kind,
    title: PIPELINE_GROUP_TITLES[kind],
    items: [],
  };
  group.items.push(item);
  groups.set(kind, group);
}

function pipelineGroupKindForStep(kind: AgentTurnStep["kind"]): AgentPipelineGroupKind {
  switch (kind) {
    case "retrieval":
    case "citation":
      return "retrieval";
    case "expert":
      return "expert";
    case "artifact":
      return "artifact";
    case "generation":
      return "generation";
    case "tool":
      return "tool";
  }
}

function actionForStep(step: AgentTurnStep): string {
  const payload = payloadRecord(step.public_payload);
  const query = stringValue(payload.query);
  if (query) return `查询：${query}`;

  const sourceName = stringValue(payload.source_name);
  if (sourceName) return `来源：${sourceName}`;

  return step.label;
}

function outputForStep(step: AgentTurnStep): string {
  const payload = payloadRecord(step.public_payload);
  const resultSummary = stringValue(payload.result_summary);
  if (resultSummary) return resultSummary;

  const hitCount = numericValue(payload.hit_count);
  if (hitCount !== null) {
    const references = citationNumbersFromPayload(step.public_payload);
    const referenceSummary = references.length ? `，引用 ${formatCitationNumbers(references)}` : "";
    return `命中 ${hitCount} 篇资料${referenceSummary}`;
  }

  return step.detail ?? "步骤已更新";
}

function citationNumbersFromPayload(payload: unknown): number[] {
  const value = payloadRecord(payload).citation_numbers;
  if (!Array.isArray(value)) return [];

  return value.filter((item): item is number => Number.isFinite(item));
}

function formatCitationNumbers(numbers: number[]): string {
  return numbers.map((number) => `[${number}]`).join(" ");
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
