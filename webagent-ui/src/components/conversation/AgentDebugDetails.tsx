import type { AgentTurnRecord } from "@/lib/clawd/agent-turns";

export function AgentDebugDetails({
  isAdmin,
  turn,
}: {
  isAdmin: boolean;
  turn: AgentTurnRecord;
}) {
  if (!isAdmin) return null;

  return (
    <details className="mt-3 rounded-md border border-border/30 bg-background/60 px-3 py-2">
      <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
        技术细节
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
        {JSON.stringify({ steps: turn.steps, events: turn.debug_events }, null, 2)}
      </pre>
    </details>
  );
}
