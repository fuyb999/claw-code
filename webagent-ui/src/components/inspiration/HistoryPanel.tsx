import { Database, FileText, FolderKanban, MessageSquare, Search, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  presentSourceStatus,
  type SourceRailDataSource,
  type SourceRailModel,
} from "@/lib/clawd/source-model";

import type { Discussion } from "./InspirationMode";

interface HistoryPanelProps {
  discussions: Discussion[];
  sourceModel: SourceRailModel;
  selectedKnowledgeBaseId: string | null;
  selectedDiscussionId: string | null;
  loading?: boolean;
  uploading?: boolean;
  threadGroups: Array<{
    id: string;
    label: string;
    count: number;
  }>;
  onCreateDiscussion: () => Promise<void> | void;
  onSelectKnowledgeBase: (knowledgeBaseId: string | null) => void;
  onSelectDiscussion: (discussionId: string) => void;
  onUploadFiles: (files: File[]) => Promise<void> | void;
}

function statusLabel(status: Discussion["status"]): string {
  switch (status) {
    case "running":
      return "执行中";
    case "interrupt_requested":
      return "中断中";
    case "failed":
      return "失败";
    default:
      return "空闲";
  }
}

function SourceList({
  emptyLabel,
  icon,
  items,
  onSelectKnowledgeBase,
  selectedKnowledgeBaseId,
}: {
  emptyLabel: string;
  icon: "upload" | "platform";
  items: SourceRailDataSource[];
  onSelectKnowledgeBase: (knowledgeBaseId: string | null) => void;
  selectedKnowledgeBaseId: string | null;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border/40 px-2 py-2 text-[11px] text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  const Icon = icon === "platform" ? Database : FileText;

  return (
    <div className="space-y-1">
      {items.map((source) => {
        const active = source.knowledgeBaseId === selectedKnowledgeBaseId;
        return (
          <button
            className={`w-full rounded-md border px-2 py-1.5 text-left transition-colors ${
              active
                ? "border-primary/25 bg-primary/10"
                : "border-border/30 bg-secondary/30 hover:bg-secondary/45"
            }`}
            key={source.id}
            onClick={() => onSelectKnowledgeBase(source.knowledgeBaseId)}
            type="button"
          >
            <div className="flex items-center gap-2">
              <Icon className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {source.label}
              </p>
              <span className="shrink-0 text-[10px] text-muted-foreground/45">
                {presentSourceStatus(source)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground/50">
              {source.leadFileName
                ? `${source.leadFileName}${source.fileCount > 1 ? ` 等 ${source.fileCount} 个文件` : ""}`
                : source.kindLabel}
            </p>
          </button>
        );
      })}
    </div>
  );
}

export function HistoryPanel({
  discussions,
  sourceModel,
  selectedKnowledgeBaseId,
  loading = false,
  uploading = false,
  selectedDiscussionId,
  threadGroups,
  onCreateDiscussion,
  onSelectKnowledgeBase,
  onSelectDiscussion,
  onUploadFiles,
}: HistoryPanelProps) {
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) {
      return;
    }
    await onUploadFiles(files);
    event.target.value = "";
  };

  return (
    <aside className="w-60 shrink-0 flex flex-col bg-card/20">
      <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
            对话历史
          </p>
          <Button
            onClick={() => void onCreateDiscussion()}
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px] text-primary hover:text-primary"
          >
            + 新建
          </Button>
        </div>

        {threadGroups.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1">
            {threadGroups.slice(0, 4).map((group) => (
              <span
                key={group.id}
                className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-secondary/30 px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                <FolderKanban className="w-2.5 h-2.5" />
                {group.label}
                <span className="text-muted-foreground/60">{group.count}</span>
              </span>
            ))}
          </div>
        )}

        <div className="space-y-1">
          {loading && discussions.length === 0 ? (
            <div className="rounded-lg border border-border/40 bg-secondary/20 px-3 py-3 text-xs text-muted-foreground">
              正在加载线程...
            </div>
          ) : discussions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/40 px-3 py-4 text-xs text-muted-foreground">
              暂无历史会话
            </div>
          ) : (
            discussions.map((discussion) => {
              const active = discussion.id === selectedDiscussionId;
              return (
                <button
                  key={discussion.id}
                  className={`w-full text-left px-3 py-2.5 rounded-lg transition-all ${
                    active
                      ? "bg-primary/10 border border-primary/20"
                      : "hover:bg-secondary/50 border border-transparent"
                  }`}
                  onClick={() => onSelectDiscussion(discussion.id)}
                >
                  <div className="flex items-start gap-2">
                    <MessageSquare
                      className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                        active ? "text-primary" : "text-muted-foreground/50"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className={`text-xs font-medium truncate ${active ? "text-foreground" : "text-muted-foreground"}`}>
                        {discussion.title}
                      </p>
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5 truncate">
                        {discussion.subtitle}
                      </p>
                      <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                        {discussion.timestamp.toLocaleDateString("zh-CN")} · {statusLabel(discussion.status)}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="h-80 border-t border-border/30 p-3 flex flex-col">
        <div className="mb-2 shrink-0 rounded-md border border-border/30 bg-secondary/20 px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <Search className="h-3 w-3 text-primary" />
            <p className="text-[11px] font-medium text-foreground">当前资料范围</p>
          </div>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {sourceModel.currentScope
              ? `${sourceModel.currentScope.label} · ${sourceModel.currentScope.dataSourceCount} 个来源`
              : "未限定资料范围"}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground/60">
            下一条消息或专家会诊将使用这里选择的资料范围。
          </p>
        </div>

        <div className="mb-2 flex items-center justify-between shrink-0">
          <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
            我的上传
          </p>
          <label className="cursor-pointer">
            <input className="hidden" multiple onChange={handleFileChange} type="file" />
            <Button
              disabled={uploading}
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-primary"
            >
              <span>
                <Upload className="w-3 h-3" />
              </span>
            </Button>
          </label>
        </div>
        <p className="mb-2 shrink-0 text-[10px] text-muted-foreground/60">
          点击来源会切换资料范围，用于下一条消息或专家会诊。
        </p>
        <SourceList
          emptyLabel="还没有上传资料"
          icon="upload"
          items={sourceModel.personalUploads}
          onSelectKnowledgeBase={onSelectKnowledgeBase}
          selectedKnowledgeBaseId={selectedKnowledgeBaseId}
        />

        <p className="mb-2 mt-3 shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          平台资料源
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <SourceList
            emptyLabel="暂无可检索的平台资料源"
            icon="platform"
            items={sourceModel.platformSources}
            onSelectKnowledgeBase={onSelectKnowledgeBase}
            selectedKnowledgeBaseId={selectedKnowledgeBaseId}
          />
        </div>
        <label className="w-full mt-2 shrink-0 cursor-pointer">
          <input
            className="hidden"
            multiple
            onChange={handleFileChange}
            type="file"
          />
          <span className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/50 py-1.5 text-[10px] text-muted-foreground/50 transition-colors hover:border-border hover:text-muted-foreground">
            <Upload className="w-3 h-3" />
            {uploading ? "上传中..." : "上传资料"}
          </span>
        </label>
      </div>
    </aside>
  );
}
