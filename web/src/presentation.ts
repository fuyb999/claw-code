import type { ArtifactKind, SkillScope } from "./types";

const HIDDEN_DIRECTORY_NAMES = new Set(["claw-code", "clawd", "claw"]);

function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

export function presentDirectoryName(path: string | null | undefined): string {
  const label = basename(path?.trim() ?? "");
  if (!label) {
    return "当前上下文";
  }

  if (label === "chat") {
    return "纯聊天";
  }

  return HIDDEN_DIRECTORY_NAMES.has(label.toLowerCase()) ? "当前上下文" : label;
}

export function presentPermissionMode(mode: string | null | undefined): string {
  switch (mode?.trim()) {
    case "read-only":
      return "只读";
    case "workspace-write":
      return "受限写入";
    case "danger-full-access":
      return "完全访问";
    case "":
    case undefined:
    case null:
      return "跟随默认";
    default:
      return mode?.trim() || "跟随默认";
  }
}

export function presentSkillScope(scope: SkillScope | string | null | undefined): string {
  switch (scope) {
    case "workspace":
      return "资料集";
    case "tenant":
      return "团队";
    default:
      return scope?.trim() || "未设置";
  }
}

export function presentSkillReference(reference: string): string {
  const normalized = reference.trim();
  if (!normalized) {
    return "未命名技能";
  }

  const separatorIndex = normalized.indexOf(":");
  if (separatorIndex === -1) {
    return normalized;
  }

  const scope = normalized.slice(0, separatorIndex);
  const name = normalized.slice(separatorIndex + 1).trim();
  if (!name) {
    return normalized;
  }

  return `${presentSkillScope(scope)} · ${name}`;
}

export function presentArtifactKind(kind: ArtifactKind | string | null | undefined): string {
  switch (kind) {
    case "text":
      return "文本";
    case "markdown":
      return "Markdown";
    case "table":
      return "表格";
    case "chart":
      return "图表";
    case "graph":
      return "关系图";
    default:
      return kind?.trim() || "结果";
  }
}
