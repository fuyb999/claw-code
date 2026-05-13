import {
  Database,
  FolderKanban,
  Layers3,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  DataSourceSummary,
  KnowledgeBaseSummary,
  SkillSummary,
} from "@/lib/clawd/types";

interface ManagementDrawerProps {
  dataSources: DataSourceSummary[];
  expertSkills: SkillSummary[];
  isOpen: boolean;
  knowledgeBases: KnowledgeBaseSummary[];
  onClose: () => void;
}

export function ManagementDrawer({
  dataSources,
  expertSkills,
  isOpen,
  knowledgeBases,
  onClose,
}: ManagementDrawerProps) {
  if (!isOpen) {
    return null;
  }

  const uploadSources = dataSources.filter((source) => source.kind === "upload");
  const esSources = dataSources.filter((source) => source.kind === "es");

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-end bg-black/30 backdrop-blur-sm md:items-stretch">
      <button
        aria-label="关闭工作区设置"
        className="absolute inset-0"
        onClick={onClose}
        type="button"
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-border/30 bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border/30 px-5 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">设置</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">工作区设置</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              这里只展示资料与专家摘要。上传、检索和专家选择仍在主工作台完成。
            </p>
          </div>
          <Button onClick={onClose} size="icon" type="button" variant="ghost">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid flex-1 gap-4 overflow-auto px-5 py-4 md:grid-cols-2">
          <section className="rounded-xl border border-border/30 bg-card/20 p-4">
            <div className="flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium text-foreground">资料与专家摘要</h3>
            </div>
            <div className="mt-3 space-y-2">
              {knowledgeBases.length === 0 ? (
                <p className="text-xs text-muted-foreground">当前还没有资料空间。</p>
              ) : (
                knowledgeBases.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg border border-border/25 bg-secondary/20 px-3 py-2"
                  >
                    <p className="text-xs font-medium text-foreground">{item.name}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      来源 {item.data_source_count} 个
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl border border-border/30 bg-card/20 p-4">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium text-foreground">数据接入</h3>
            </div>
            <div className="mt-3 space-y-2">
              <div className="rounded-lg border border-border/25 bg-secondary/20 px-3 py-2">
                <p className="text-xs font-medium text-foreground">平台资料源</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  已发布 {esSources.length} 个可检索来源。连接参数由平台维护。
                </p>
              </div>
              <div className="rounded-lg border border-border/25 bg-secondary/20 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-xs font-medium text-foreground">用户上传资料</p>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  已接入 {uploadSources.length} 个上传源，可继续从左栏直接上传文件。
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border/30 bg-card/20 p-4 md:col-span-2">
            <div className="flex items-center gap-2">
              <Layers3 className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium text-foreground">专家技能</h3>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {expertSkills.length === 0 ? (
                <p className="text-xs text-muted-foreground">当前没有加载到专家技能。</p>
              ) : (
                expertSkills.map((skill) => (
                  <span
                    key={`${skill.scope}:${skill.name}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-secondary/25 px-2 py-1 text-[11px] text-muted-foreground"
                  >
                    <span className="font-medium text-foreground">{skill.name}</span>
                    <span>{skill.scope === "workspace" ? "资料集" : "团队"}</span>
                  </span>
                ))
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
