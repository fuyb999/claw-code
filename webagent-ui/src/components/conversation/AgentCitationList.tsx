import type { AgentCitation } from "@/lib/clawd/agent-turns";

export function AgentCitationList({ citations }: { citations: AgentCitation[] }) {
  if (!citations.length) return null;

  return (
    <section className="mt-3 border-t border-border/30 pt-3">
      <p className="text-[11px] font-medium text-muted-foreground">引用资料</p>
      <div className="mt-2 space-y-2">
        {citations.map((citation) => (
          <article
            className="rounded-md border border-border/35 bg-background/60 px-3 py-2"
            key={citation.id}
          >
            <div className="flex items-start gap-2">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                [{citation.number}]
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-foreground">
                  {citation.title ?? citation.source_label}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {citation.preview}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground/65">
                  {citation.source_label}
                  {citation.location ? ` · ${citation.location}` : ""}
                </p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
