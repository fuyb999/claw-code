import type {
  DataSourceKind,
  DataSourceSummary,
  KnowledgeBaseSummary,
} from "./types";

export type SourceRailSection = "personal_uploads" | "favorites" | "platform_sources";

export interface SourceRailDataSource {
  id: string;
  knowledgeBaseId: string;
  label: string;
  description: string | null;
  kind: DataSourceKind;
  kindLabel: string;
  status: string | null;
  searchable: boolean;
  fileCount: number;
  leadFileName: string | null;
  lastSyncedAtMs: number | null;
}

export interface SourceRailScope {
  id: string;
  label: string;
  dataSourceCount: number;
}

export interface SourceRailModel {
  currentScope: SourceRailScope | null;
  personalUploads: SourceRailDataSource[];
  favorites: SourceRailDataSource[];
  platformSources: SourceRailDataSource[];
}

interface BuildSourceRailModelInput {
  dataSources: DataSourceSummary[];
  knowledgeBases: KnowledgeBaseSummary[];
  selectedKnowledgeBaseId: string | null;
}

function kindLabel(kind: DataSourceKind): string {
  switch (kind) {
    case "upload":
      return "我的上传";
    case "es":
      return "平台检索";
    case "web":
      return "网页";
    case "db":
      return "数据库";
    default:
      return "资料源";
  }
}

function isSearchable(kind: DataSourceKind, status: string | null): boolean {
  const normalizedStatus = status?.toLowerCase() ?? null;
  if (normalizedStatus !== "ready") {
    return false;
  }
  return kind === "upload" || kind === "es" || kind === "web" || kind === "db";
}

function toRailSource(source: DataSourceSummary): SourceRailDataSource {
  return {
    id: source.id,
    knowledgeBaseId: source.knowledge_base_id,
    label: source.name,
    description: source.description,
    kind: source.kind,
    kindLabel: kindLabel(source.kind),
    status: source.status,
    searchable: isSearchable(source.kind, source.status),
    fileCount: source.uploaded_files.length,
    leadFileName: source.uploaded_files[0]?.file_name ?? null,
    lastSyncedAtMs: source.last_synced_at_ms,
  };
}

export function buildSourceRailModel({
  dataSources,
  knowledgeBases,
  selectedKnowledgeBaseId,
}: BuildSourceRailModelInput): SourceRailModel {
  const currentKnowledgeBase =
    knowledgeBases.find((item) => item.id === selectedKnowledgeBaseId) ?? null;
  const railSources = dataSources.map(toRailSource);

  return {
    currentScope: currentKnowledgeBase
      ? {
          id: currentKnowledgeBase.id,
          label: currentKnowledgeBase.name,
          dataSourceCount: currentKnowledgeBase.data_source_count,
        }
      : null,
    personalUploads: railSources.filter((source) => source.kind === "upload"),
    favorites: [],
    platformSources: railSources.filter(
      (source) =>
        source.kind === "es" ||
        source.kind === "db" ||
        source.kind === "web" ||
        source.kind === "notion" ||
        source.kind === "confluence",
    ),
  };
}

export function presentSourceStatus(source: Pick<SourceRailDataSource, "searchable" | "status">): string {
  const status = source.status?.toLowerCase() ?? null;
  if (status === "syncing" || status === "indexing") {
    return "同步中";
  }
  if (status === "failed" || status === "error") {
    return "需处理";
  }
  if (source.searchable) {
    return "可检索";
  }
  return "已接入";
}
