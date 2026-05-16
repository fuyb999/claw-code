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
      return "bg-primary";
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
}: {
  item: AgentPipelineItem;
  expandable: boolean;
}) {
  return (
    <>
      <span
        aria-label={accessibilityLabelForItem(item)}
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(item.status)}`}
        title={formatEventTime(item.completed_at_ms ?? item.started_at_ms)}
      />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[11px] font-medium text-foreground/85">
          {item.title}
        </span>
        <span className="mt-0.5 block break-words text-[10px] leading-4 text-muted-foreground">
          {item.output}
        </span>
      </span>
      {item.references.length ? (
        <span className="shrink-0 text-[10px] text-primary/80">
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
              {group.items.map((item) => {
                const extraContent = extraContentForItem(item);
                const hasExtraContent = extraContent.length > 0;

                return hasExtraContent ? (
                  <details
                    className="group rounded-md border border-border/25 bg-card/35 px-2.5 py-2"
                    key={item.id}
                  >
                    <summary className="flex min-w-0 cursor-pointer list-none gap-2 [&::-webkit-details-marker]:hidden">
                      <AgentActivitySummary expandable item={item} />
                    </summary>
                    <div className="ml-3.5 mt-1.5 space-y-1 border-l border-border/25 pl-2 text-[10px] leading-4 text-muted-foreground">
                      {extraContent.map((content) => (
                        <p className="break-words" key={content}>
                          {content}
                        </p>
                      ))}
                    </div>
                  </details>
                ) : (
                  <div
                    className="flex min-w-0 gap-2 rounded-md border border-border/25 bg-card/35 px-2.5 py-2"
                    key={item.id}
                  >
                    <AgentActivitySummary expandable={false} item={item} />
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
