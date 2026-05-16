import { LoaderCircle } from "lucide-react";

import type {
  AgentCitation,
  AgentExpertResult,
  AgentPipelineItem,
  AgentTurnStep,
} from "@/lib/clawd/agent-turns";
import { groupAgentTurnSteps } from "@/lib/clawd/agent-turns";

function formatEventTime(value: number | null): string {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusDotClass(status: AgentPipelineItem["status"]): string {
  switch (status) {
    case "failed":
      return "bg-destructive";
    case "running":
    case "retrying":
      return "text-primary";
    case "skipped":
      return "bg-muted-foreground/45";
    case "succeeded":
      return "bg-emerald-500";
  }
}

function statusLabel(status: AgentPipelineItem["status"]): string {
  switch (status) {
    case "failed":
      return "失败";
    case "running":
      return "进行中";
    case "retrying":
      return "重试中";
    case "skipped":
      return "已跳过";
    case "succeeded":
      return "已完成";
  }
}

function formatReferences(references: number[]): string {
  return references.map((reference) => `[${reference}]`).join(" ");
}

function accessibilityLabelForItem(item: AgentPipelineItem): string {
  const eventTime = formatEventTime(item.completed_at_ms ?? item.started_at_ms);
  return eventTime ? `状态：${statusLabel(item.status)}，时间：${eventTime}` : `状态：${statusLabel(item.status)}`;
}

function extraContentForItem(item: AgentPipelineItem): string[] {
  return [
    item.action !== item.title ? item.action : null,
    item.detail && item.detail !== item.output ? item.detail : null,
  ].filter((value): value is string => Boolean(value));
}

function AgentActivitySummary({
  expandable,
  item,
  level,
}: {
  item: AgentPipelineItem;
  expandable: boolean;
  level: number;
}) {
  const isRunning = item.status === "running" || item.status === "retrying";

  return (
    <>
      {isRunning ? (
        <LoaderCircle
          aria-label={accessibilityLabelForItem(item)}
          className={`mt-1 h-3 w-3 shrink-0 animate-spin ${statusDotClass(item.status)}`}
          data-step-status-indicator="true"
          data-step-status={item.status}
        />
      ) : (
        <span
          aria-label={accessibilityLabelForItem(item)}
          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(item.status)}`}
          data-step-status-indicator="true"
          data-step-status={item.status}
          title={formatEventTime(item.completed_at_ms ?? item.started_at_ms)}
        />
      )}
      <span className="min-w-0 flex-1">
        <span
          className={`block break-words text-[11px] font-medium text-foreground/85 ${
            level > 0 ? "pl-3" : ""
          }`}
        >
          {item.title}
        </span>
        <span
          className={`mt-0.5 block break-words text-[10px] leading-4 text-muted-foreground ${
            level > 0 ? "pl-3" : ""
          }`}
        >
          {item.output}
        </span>
      </span>
      {item.references.length ? (
        <span className={`shrink-0 text-[10px] text-primary/80 ${level > 0 ? "pl-3" : ""}`}>
          {formatReferences(item.references)}
        </span>
      ) : null}
      {expandable ? (
        <span
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-[10px] text-muted-foreground transition-transform group-open:rotate-90"
        >
          &gt;
        </span>
      ) : null}
    </>
  );
}

function AgentActivityItemTree({
  item,
  level,
}: {
  item: AgentPipelineItem;
  level: number;
}) {
  const extraContent = extraContentForItem(item);
  const hasExtraContent = extraContent.length > 0;

  return (
    <div
      className={`min-w-0 rounded-md border border-border/25 bg-card/35 px-2.5 py-2 ${
        level > 0 ? "ml-4 border-l-2 border-l-border/40" : ""
      }`}
      data-pipeline-item={item.id}
      data-pipeline-level={level}
      data-step-status={item.status}
    >
      {hasExtraContent ? (
        <details className="group" open={level === 0}>
          <summary className="flex min-w-0 cursor-pointer list-none gap-2 [&::-webkit-details-marker]:hidden">
            <AgentActivitySummary expandable item={item} level={level} />
          </summary>
          <div className="ml-3.5 mt-1.5 space-y-1 border-l border-border/25 pl-2 text-[10px] leading-4 text-muted-foreground">
            {extraContent.map((content) => (
              <p className="break-words" key={content}>
                {content}
              </p>
            ))}
            {item.children?.length ? (
              <div className="mt-2 space-y-1.5">
                {item.children.map((child) => (
                  <AgentActivityItemTree item={child} level={level + 1} key={child.id} />
                ))}
              </div>
            ) : null}
          </div>
        </details>
      ) : (
        <div className="flex min-w-0 gap-2">
          <AgentActivitySummary expandable={false} item={item} level={level} />
        </div>
      )}
      {!hasExtraContent && item.children?.length ? (
        <div className="mt-2 space-y-1.5">
          {item.children.map((child) => (
            <AgentActivityItemTree item={child} level={level + 1} key={child.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AgentActivityTimeline({
  citations,
  expertResults,
  steps,
}: {
  steps: AgentTurnStep[];
  citations: AgentCitation[];
  expertResults: AgentExpertResult[];
}) {
  const groups = groupAgentTurnSteps(steps, citations, expertResults);
  if (!groups.length) return null;

  return (
    <div className="mt-3 rounded-md border border-border/30 bg-background/45 px-3 py-2">
      <div className="space-y-3">
        {groups.map((group) => (
          <section className="min-w-0" key={group.kind}>
            <p className="text-[11px] font-medium text-foreground/85">{group.title}</p>
            <div className="mt-1.5 space-y-1.5">
              {group.items.map((item) => (
                <AgentActivityItemTree item={item} key={item.id} level={0} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
