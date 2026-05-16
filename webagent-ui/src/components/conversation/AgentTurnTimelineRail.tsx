import type { AgentTurnRecord } from "@/lib/clawd/agent-turns";

export interface AgentTurnTimelineRailProps {
  turns: AgentTurnRecord[];
  onJumpToTurn: (turnId: string) => void;
}

function formatTimelineTime(value: number): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compactQuestion(question: string): string {
  const compact = question.replace(/\s+/g, " ").trim();
  return compact.length > 28 ? `${compact.slice(0, 28)}...` : compact;
}

export function AgentTurnTimelineRail({
  turns,
  onJumpToTurn,
}: AgentTurnTimelineRailProps) {
  return (
    <nav
      aria-label="问题时间线"
      className="sticky left-3 top-4 z-20 hidden h-0 w-7 md:block"
      data-agent-timeline-rail="true"
    >
      <div className="relative flex max-h-[calc(100vh-15rem)] w-7 flex-col items-center overflow-y-auto py-1 scrollbar-thin">
        <div className="absolute left-1/2 top-1 bottom-1 w-px -translate-x-1/2 bg-border/35" />
        <div className="relative z-10 flex flex-col items-center gap-2">
          {turns.map((turn) => {
            const time = formatTimelineTime(turn.started_at_ms);
            const question = compactQuestion(turn.user_message);
            const label = `${time} ${question}`;

            return (
              <button
                aria-label={label}
                className="flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                key={turn.id}
                onClick={() => onJumpToTurn(turn.id)}
                title={label}
                type="button"
              >
                <span className="h-2 w-2 rounded-full border border-primary/60 bg-background shadow-sm" />
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
