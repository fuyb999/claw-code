import {
  FileSearch,
  FileText,
  Lightbulb,
  MessageSquare,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import type { TimelineEvent, TimelineEventReference } from "@/lib/clawd/timeline-events";

interface TimelineEventCardProps {
  event: TimelineEvent;
  onOpenReference?: (reference: TimelineEventReference) => void;
}

function iconFor(kind: TimelineEvent["kind"]) {
  switch (kind) {
    case "retrieval":
      return FileSearch;
    case "expert_message":
      return Lightbulb;
    case "expert_failed":
      return TriangleAlert;
    case "synthesis":
      return Sparkles;
    case "artifact":
      return FileText;
    default:
      return MessageSquare;
  }
}

export function TimelineEventCard({ event, onOpenReference }: TimelineEventCardProps) {
  const Icon = iconFor(event.kind);
  const clickable = Boolean(event.reference && onOpenReference);

  return (
    <button
      className={`flex w-full items-start gap-2 rounded-lg border border-border/30 bg-secondary/20 px-3 py-2 text-left ${
        clickable ? "transition-colors hover:border-primary/30 hover:bg-secondary/35" : ""
      }`}
      disabled={!clickable}
      onClick={() => {
        if (event.reference) {
          onOpenReference?.(event.reference);
        }
      }}
      type="button"
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium text-foreground">{event.title}</p>
        <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
          {event.subtitle}
        </p>
      </div>
    </button>
  );
}
