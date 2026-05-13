import { useMemo, useState } from "react";
import { Brain, Check, ChevronDown, ChevronRight, MessageCircle } from "lucide-react";

import type { DiscussionMode, Expert } from "./InspirationMode";

interface ExpertPanelProps {
  experts: Expert[];
  discussionMode: DiscussionMode;
  retryCount: number;
  concurrencyLimit: number;
  autoRetrieval: boolean;
  runStatusLabel?: string | null;
  onToggleExpert: (id: string) => void;
  onModeChange: (mode: DiscussionMode) => void;
  onRetryCountChange: (value: number) => void;
  onConcurrencyLimitChange: (value: number) => void;
  onAutoRetrievalChange: (value: boolean) => void;
}

interface TreeNode {
  label: string;
  children?: TreeNode[];
  expertId?: string;
}

const discussionModes = [
  { id: "qa" as DiscussionMode, icon: MessageCircle, label: "快速问答", desc: "单轮精准回答" },
  { id: "brainstorm" as DiscussionMode, icon: Brain, label: "头脑风暴", desc: "多维度发散探索" },
];

export function ExpertPanel({
  experts,
  discussionMode,
  retryCount,
  concurrencyLimit,
  autoRetrieval,
  runStatusLabel = null,
  onToggleExpert,
  onModeChange,
  onRetryCountChange,
  onConcurrencyLimitChange,
  onAutoRetrievalChange,
}: ExpertPanelProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(["现实主义", "自由主义", "方法论", "专家视角"]));

  const tree = useMemo<TreeNode[]>(() => {
    const typeMap = new Map<string, Expert[]>();
    experts.forEach((expert) => {
      const current = typeMap.get(expert.type) ?? [];
      current.push(expert);
      typeMap.set(expert.type, current);
    });

    return Array.from(typeMap.entries()).map(([type, typedExperts]) => {
      const domainMap = new Map<string, Expert[]>();
      typedExperts.forEach((expert) => {
        const current = domainMap.get(expert.domain) ?? [];
        current.push(expert);
        domainMap.set(expert.domain, current);
      });

      return {
        label: type,
        children: Array.from(domainMap.entries()).map(([domain, domainExperts]) => ({
          label: domain,
          children: domainExperts.map((expert) => ({
            label: expert.name,
            expertId: expert.id,
          })),
        })),
      };
    });
  }, [experts]);

  const toggleNode = (label: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(label)) {
        next.delete(label)
      } else {
        next.add(label)
      }
      return next
    })
  }

  const renderTreeNode = (node: TreeNode, depth: number = 0) => {
    const isExpanded = expandedNodes.has(node.label)
    const hasChildren = node.children && node.children.length > 0
    const expert = node.expertId ? experts.find((e) => e.id === node.expertId) : null

    return (
      <div key={node.label + (node.expertId || "")} className="select-none">
        <div
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-colors hover:bg-secondary/50 ${
            expert?.selected ? "bg-primary/10" : ""
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => {
            if (node.expertId) {
              onToggleExpert(node.expertId)
            } else if (hasChildren) {
              toggleNode(node.label)
            }
          }}
        >
          {/* Expand/Collapse icon */}
          {hasChildren && (
            <span className="text-muted-foreground w-3.5 h-3.5 flex items-center justify-center shrink-0">
              {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </span>
          )}

          {/* Checkbox for experts */}
          {expert && (
            <span
              className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                expert.selected
                  ? "bg-primary border-primary"
                  : "border-border hover:border-primary/50"
              }`}
            >
              {expert.selected && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
            </span>
          )}

          {/* Label */}
          <span
            className={`text-xs truncate ${
              expert
                ? expert.selected
                  ? "text-foreground font-medium"
                  : "text-muted-foreground"
                : depth === 0
                ? "text-foreground/80 font-medium"
                : "text-muted-foreground"
            }`}
          >
            {node.label}
          </span>

          {/* Expert description tooltip */}
          {expert && (
            <span className="ml-auto text-[10px] text-muted-foreground/50 truncate max-w-[80px]">
              {expert.domain}
            </span>
          )}
        </div>

        {/* Children */}
        {hasChildren && isExpanded && (
          <div>{node.children!.map((child) => renderTreeNode(child, depth + 1))}</div>
        )}
      </div>
    )
  }

  return (
    <aside className="w-64 shrink-0 flex flex-col border-l border-border/30 bg-card/30">
      <div className="border-b border-border/30 px-3 py-2">
        <div className="rounded-lg border border-border/30 bg-card/25 px-3 py-2">
          <p className="text-xs font-medium text-foreground">虚拟专家</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">选择专家后从聊天区发起会诊</p>
        </div>
      </div>

      {/* Discussion Mode Selector */}
      <div className="p-3 border-b border-border/30">
        <p className="text-[11px] text-muted-foreground mb-2 font-medium uppercase tracking-wider">讨论模式</p>
        <div className="space-y-1">
          {discussionModes.map((mode) => (
            <button
              key={mode.id}
              onClick={() => onModeChange(mode.id)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-all ${
                discussionMode === mode.id
                  ? "bg-primary/15 border border-primary/30 text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 border border-transparent"
              }`}
            >
              <mode.icon className={`w-3.5 h-3.5 shrink-0 ${discussionMode === mode.id ? "text-primary" : ""}`} />
              <div className="min-w-0">
                <p className="text-xs font-medium truncate">{mode.label}</p>
                <p className="text-[10px] text-muted-foreground/60 truncate">{mode.desc}</p>
              </div>
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[10px] text-muted-foreground">重试</span>
            <input
              className="h-7 w-full rounded-md border border-border/40 bg-background px-2 text-xs"
              max={3}
              min={0}
              onChange={(event) => onRetryCountChange(Number(event.target.value))}
              type="number"
              value={retryCount}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] text-muted-foreground">并发</span>
            <input
              className="h-7 w-full rounded-md border border-border/40 bg-background px-2 text-xs"
              max={8}
              min={1}
              onChange={(event) => onConcurrencyLimitChange(Number(event.target.value))}
              type="number"
              value={concurrencyLimit}
            />
          </label>
        </div>
        <label className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border/30 bg-secondary/20 px-2 py-1.5">
          <span>
            <span className="block text-[11px] font-medium text-foreground">自动检索</span>
            <span className="block text-[10px] text-muted-foreground/65">
              需要资料时让专家使用当前资料范围
            </span>
          </span>
          <input
            checked={autoRetrieval}
            className="h-4 w-4 accent-primary"
            onChange={(event) => onAutoRetrievalChange(event.target.checked)}
            type="checkbox"
          />
        </label>
        {runStatusLabel ? (
          <div className="mt-2 rounded-md border border-border/30 bg-secondary/25 px-2 py-1.5 text-[10px] text-muted-foreground">
            {runStatusLabel}
          </div>
        ) : null}
      </div>

      {/* Expert Tree */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
        <div className="flex items-center justify-between px-2 mb-2">
          <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">虚拟专家</p>
        </div>
        <div className="space-y-0.5">
          {tree.length > 0 ? (
            tree.map((node) => renderTreeNode(node))
          ) : (
            <div className="rounded-md border border-dashed border-border/40 px-2 py-3 text-[11px] text-muted-foreground">
              当前没有可用专家技能
            </div>
          )}
        </div>
      </div>

      {/* Selected count */}
      <div className="p-3 border-t border-border/30">
        <div className="flex flex-wrap gap-1">
          {experts
            .filter((e) => e.selected)
            .map((e) => (
              <span
                key={e.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/15 border border-primary/25 text-[10px] text-primary"
              >
                {e.name.length > 4 ? e.name.substring(0, 4) + "..." : e.name}
                <button
                  onClick={() => onToggleExpert(e.id)}
                  className="hover:text-destructive transition-colors"
                >
                  ×
                </button>
              </span>
            ))}
          {experts.filter((e) => e.selected).length === 0 && (
            <span className="text-[10px] text-muted-foreground/50">未选择专家</span>
          )}
        </div>
      </div>
    </aside>
  );
}
