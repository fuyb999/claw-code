import type { ArtifactRecord, ThreadSnapshot } from "./types";

export type ExpertPanelEvent = {
  id: string;
  panelId: string;
  expertName: string | null;
  stage: string | null;
  summary: string | null;
  artifactId: string | null;
  queryRefs: string[];
  status: string;
  createdAtMs: number;
};

export type ExpertPanelSeed = {
  panelId: string;
  masterSkill: string | null;
  experts: Array<{
    skill: string;
    label: string;
  }>;
  createdAtMs: number;
};

export type ExpertPanelSummary = {
  panelId: string;
  masterSkill: string | null;
  plannedExperts: string[];
  totalEvents: number;
  completedExperts: string[];
  pendingExperts: string[];
  latestStage: string | null;
  latestStageLabel: string | null;
  latestSummary: string | null;
  finalSummaryReady: boolean;
};

export type ExpertPanelExpertStatus = {
  expertName: string;
  skill: string | null;
  status: string;
  stage: string | null;
  stageLabel: string | null;
  summary: string | null;
  artifactId: string | null;
  queryRefs: string[];
  completed: boolean;
};

export function presentExpertPanelStage(stage: string | null): string | null {
  switch (stage?.trim().toLowerCase()) {
    case "phase_0":
    case "topic":
    case "topic_framing":
      return "议题构建";
    case "phase_1":
    case "independent":
    case "independent_review":
      return "独立评估";
    case "phase_2":
    case "debate":
    case "cross_debate":
      return "交叉辩论";
    case "phase_3":
    case "consensus":
    case "consensus_map":
      return "共识与分歧";
    case "phase_4":
    case "summary":
    case "final":
      return "综合结论";
    default:
      return stage;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => readString(item))
    .filter((item): item is string => item !== null);
}

export function collectExpertPanelSeeds(thread: ThreadSnapshot | null): ExpertPanelSeed[] {
  const records = thread?.audit_records ?? [];
  return records
    .filter((record) => record.kind === "run_started")
    .map((record) => {
      const payload = asObject(record.payload);
      const panel = asObject(payload?.expert_panel);
      const panelId = readString(panel?.panel_id);
      if (!panelId) {
        return null;
      }
      const experts = Array.isArray(panel?.experts)
        ? panel.experts
            .map((entry) => {
              const object = asObject(entry);
              const label = readString(object?.label);
              const skill = readString(object?.skill);
              if (!label || !skill) {
                return null;
              }
              return { label, skill };
            })
            .filter((entry): entry is { label: string; skill: string } => entry !== null)
        : [];
      return {
        panelId,
        masterSkill: readString(panel?.master_skill),
        experts,
        createdAtMs: record.created_at_ms,
      };
    })
    .filter((item): item is ExpertPanelSeed => item !== null);
}

export function collectExpertPanelEvents(thread: ThreadSnapshot | null): ExpertPanelEvent[] {
  const records = thread?.audit_records ?? [];
  return records
    .filter((record) => record.kind === "expert_panel_emit")
    .map((record) => {
      const payload = asObject(record.payload);
      const panelId = readString(payload?.panel_id);
      if (!panelId) {
        return null;
      }
      return {
        id: record.id,
        panelId,
        expertName: readString(payload?.expert_name),
        stage: readString(payload?.stage),
        summary: readString(payload?.summary),
        artifactId: readString(payload?.artifact_id),
        queryRefs: readStringArray(payload?.query_refs),
        status: readString(payload?.status) ?? "completed",
        createdAtMs: record.created_at_ms,
      };
    })
    .filter((item): item is ExpertPanelEvent => item !== null);
}

export function summarizeExpertPanels(
  events: ExpertPanelEvent[],
  seed: ExpertPanelSeed | null = null,
): ExpertPanelSummary | null {
  if (!events.length && !seed) {
    return null;
  }
  const latest = events[events.length - 1] ?? null;
  const completedExperts = Array.from(
    new Set(
      events
        .filter((event) => event.expertName && event.status === "completed")
        .map((event) => event.expertName as string),
    ),
  );
  const plannedExperts = seed?.experts.map((expert) => expert.label) ?? completedExperts;
  const pendingExperts = plannedExperts.filter(
    (name) => !completedExperts.includes(name),
  );
  return {
    panelId: latest?.panelId ?? seed?.panelId ?? "expert-panel",
    masterSkill: seed?.masterSkill ?? null,
    plannedExperts,
    totalEvents: events.length,
    completedExperts,
    pendingExperts,
    latestStage: latest?.stage ?? null,
    latestStageLabel: presentExpertPanelStage(latest?.stage ?? null),
    latestSummary: latest?.summary ?? null,
    finalSummaryReady: events.some(
      (event) =>
        !event.expertName &&
        (event.stage === "final" || event.stage === "summary" || event.stage === "phase_4"),
    ),
  };
}

function metadataValue(
  artifact: ArtifactRecord,
  key: string,
): string | null {
  const metadata = artifact.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function collectExpertPanelExpertStatuses(
  seed: ExpertPanelSeed | null,
  events: ExpertPanelEvent[],
  artifacts: ArtifactRecord[],
): ExpertPanelExpertStatus[] {
  const eventMap = new Map<string, ExpertPanelEvent>();
  for (const event of events) {
    if (!event.expertName) {
      continue;
    }
    eventMap.set(event.expertName, event);
  }

  const artifactMap = new Map<string, ArtifactRecord>();
  for (const artifact of artifacts) {
    const group = metadataValue(artifact, "group");
    const expertName = metadataValue(artifact, "expert_name");
    const panelId = metadataValue(artifact, "panel");
    if (
      group === "expert_view" &&
      expertName &&
      (!seed?.panelId || !panelId || panelId === seed.panelId)
    ) {
      artifactMap.set(expertName, artifact);
    }
  }

  const plannedExperts = seed?.experts ?? [];
  const fallbackExperts = Array.from(eventMap.keys()).map((expertName) => ({
    label: expertName,
    skill: null,
  }));
  const experts = plannedExperts.length ? plannedExperts : fallbackExperts;

  return experts.map((expert) => {
    const event = eventMap.get(expert.label) ?? null;
    const artifact = artifactMap.get(expert.label) ?? null;
    const status = event?.status ?? (artifact ? "completed" : "planned");
    return {
      expertName: expert.label,
      skill: expert.skill,
      status,
      stage: event?.stage ?? null,
      stageLabel: presentExpertPanelStage(event?.stage ?? null),
      summary: event?.summary ?? null,
      artifactId: event?.artifactId ?? artifact?.id ?? null,
      queryRefs: event?.queryRefs ?? [],
      completed: status === "completed" || artifact !== null,
    };
  });
}
