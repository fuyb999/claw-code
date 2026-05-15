import type { AgentTurnRecord } from "@/lib/clawd/agent-turns";
import {
  replaceEvidenceMarkersWithCitationNumbers,
  statusLabelForAgentTurn,
} from "@/lib/clawd/agent-turns";

import { AgentActivityTimeline } from "./AgentActivityTimeline";
import { AgentCitationList } from "./AgentCitationList";
import { AgentDebugDetails } from "./AgentDebugDetails";
import { MarkdownMessage } from "./MarkdownMessage";

function formatTurnTime(value: number): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AgentTurnView({
  isAdmin,
  turn,
}: {
  isAdmin: boolean;
  turn: AgentTurnRecord;
}) {
  const assistantText = replaceEvidenceMarkersWithCitationNumbers(
    turn.assistant_text,
    turn.citations,
  );

  return (
    <article className="flex w-full min-w-0 gap-3 py-2" data-agent-turn-id={turn.id}>
      <div className="relative flex w-14 shrink-0 justify-end pt-1 text-right">
        <span className="absolute right-[3px] top-0 h-full min-h-8 w-px bg-border/25" />
        <button
          aria-label={`定位到 ${formatTurnTime(turn.started_at_ms)} 的问题`}
          className="relative z-10 flex flex-col items-end gap-1 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
          type="button"
        >
          <span className="text-[10px] leading-4 text-muted-foreground/70">
            {formatTurnTime(turn.started_at_ms)}
          </span>
          <span className="h-2 w-2 rounded-full border border-primary/55 bg-primary/25" />
        </button>
      </div>

      <div className="min-w-0 flex-1 space-y-3">
        <div className="ml-auto max-w-[72%] rounded-2xl rounded-tr-sm border border-primary/20 bg-primary/15 px-4 py-3">
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
            {turn.user_message}
          </p>
        </div>

        <div className="max-w-[88%] overflow-hidden rounded-2xl rounded-tl-sm border border-border/40 bg-card/50 px-4 py-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium text-muted-foreground">AI 分析师</span>
            <span className="text-[10px] text-muted-foreground/70">
              {statusLabelForAgentTurn(turn.status)}
            </span>
          </div>

          {assistantText.trim() ? (
            <MarkdownMessage content={assistantText} streaming={turn.status === "running"} />
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">正在处理</p>
          )}

          <AgentActivityTimeline steps={turn.steps} />
          <AgentCitationList citations={turn.citations} />
          <AgentDebugDetails isAdmin={isAdmin} turn={turn} />
        </div>
      </div>
    </article>
  );
}
