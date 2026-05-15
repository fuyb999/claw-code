import type { AgentTurnStep } from "@/lib/clawd/agent-turns";

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

export function AgentActivityTimeline({ steps }: { steps: AgentTurnStep[] }) {
  if (!steps.length) return null;

  return (
    <div className="mt-3 rounded-md border border-border/30 bg-background/45 px-3 py-2">
      <div className="space-y-2">
        {steps.slice(0, 5).map((step) => (
          <div className="flex min-w-0 gap-2" key={step.id}>
            <span
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60"
              title={formatEventTime(step.completed_at_ms ?? step.started_at_ms)}
            />
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-foreground/85">{step.label}</p>
              {step.detail ? (
                <p className="mt-0.5 break-words text-[10px] text-muted-foreground">
                  {step.detail}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
