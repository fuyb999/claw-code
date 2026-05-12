import type { ArtifactRecord } from "./types";
import { presentExpertPanelStage } from "./expert-panels";

export type ExpertArtifactGroup = {
  panelId: string | null;
  summaryArtifacts: ArtifactRecord[];
  consensusArtifacts: ArtifactRecord[];
  stageArtifacts: Array<{
    stage: string;
    stageLabel: string | null;
    artifact: ArtifactRecord;
  }>;
  expertArtifacts: Array<{
    expertName: string;
    artifact: ArtifactRecord;
  }>;
  otherArtifacts: ArtifactRecord[];
};

function normalizeTitle(title: string | null): string {
  return title?.trim() ?? "";
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

function artifactPanelId(artifact: ArtifactRecord): string | null {
  return metadataValue(artifact, "panel");
}

function artifactStage(artifact: ArtifactRecord): string | null {
  return metadataValue(artifact, "stage");
}

function expertNameFromTitle(title: string): string | null {
  if (!title.startsWith("专家视角 /")) {
    return null;
  }
  const name = title.slice("专家视角 /".length).trim();
  return name || null;
}

function isSummaryArtifact(title: string): boolean {
  return (
    title.startsWith("专家会诊 / 综合结论") ||
    title.startsWith("专家会诊 / 行动建议") ||
    title.startsWith("专家会诊 / 综合分析")
  );
}

function isConsensusArtifact(title: string): boolean {
  return (
    title.startsWith("专家会诊 / 共识") ||
    title.startsWith("专家会诊 / 分歧") ||
    title.startsWith("专家会诊 / 风险矩阵")
  );
}

export function groupExpertArtifacts(artifacts: ArtifactRecord[]): ExpertArtifactGroup {
  const panelCounts = new Map<string, number>();
  for (const artifact of artifacts) {
    const panelId = artifactPanelId(artifact);
    if (!panelId) {
      continue;
    }
    panelCounts.set(panelId, (panelCounts.get(panelId) ?? 0) + 1);
  }
  const dominantPanelId =
    panelCounts.size > 0
      ? [...panelCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
      : null;
  const summaryArtifacts: ArtifactRecord[] = [];
  const consensusArtifacts: ArtifactRecord[] = [];
  const stageArtifacts: ExpertArtifactGroup["stageArtifacts"] = [];
  const expertArtifacts: ExpertArtifactGroup["expertArtifacts"] = [];
  const otherArtifacts: ArtifactRecord[] = [];

  for (const artifact of artifacts) {
    const panelId = artifactPanelId(artifact);
    if (dominantPanelId && panelId && panelId !== dominantPanelId) {
      otherArtifacts.push(artifact);
      continue;
    }
    const title = normalizeTitle(artifact.title);
    const metadataGroup = metadataValue(artifact, "group");
    const metadataExpertName = metadataValue(artifact, "expert_name");
    const metadataStage = artifactStage(artifact);
    if (metadataGroup === "expert_summary") {
      summaryArtifacts.push(artifact);
      continue;
    }
    if (metadataGroup === "expert_consensus") {
      consensusArtifacts.push(artifact);
      continue;
    }
    if (
      metadataStage &&
      metadataGroup !== "expert_view" &&
      metadataGroup !== "expert_summary" &&
      metadataGroup !== "expert_consensus"
    ) {
      stageArtifacts.push({
        stage: metadataStage,
        stageLabel: presentExpertPanelStage(metadataStage),
        artifact,
      });
      continue;
    }
    if (metadataGroup === "expert_view" && metadataExpertName) {
      expertArtifacts.push({ expertName: metadataExpertName, artifact });
      continue;
    }
    const expertName = expertNameFromTitle(title);
    if (expertName) {
      expertArtifacts.push({ expertName, artifact });
      continue;
    }
    if (isSummaryArtifact(title)) {
      summaryArtifacts.push(artifact);
      continue;
    }
    if (isConsensusArtifact(title)) {
      consensusArtifacts.push(artifact);
      continue;
    }
    otherArtifacts.push(artifact);
  }

  return {
    panelId: dominantPanelId,
    summaryArtifacts,
    consensusArtifacts,
    stageArtifacts,
    expertArtifacts,
    otherArtifacts,
  };
}

export function hasExpertArtifactPresentation(artifacts: ArtifactRecord[]): boolean {
  const grouped = groupExpertArtifacts(artifacts);
  return (
    grouped.summaryArtifacts.length > 0 ||
    grouped.consensusArtifacts.length > 0 ||
    grouped.stageArtifacts.length > 0 ||
    grouped.expertArtifacts.length > 0
  );
}
