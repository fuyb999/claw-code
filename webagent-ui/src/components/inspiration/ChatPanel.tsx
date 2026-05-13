import { useEffect, useRef, useState } from "react";
import {
  Copy,
  Download,
  FileSearch,
  FolderKanban,
  Send,
  Star,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  TimelineReferenceTarget,
} from "@/lib/clawd/chat-adapter";
import type { TimelineEvent } from "@/lib/clawd/timeline-events";
import { RichContentRenderer } from "@/components/rich-content/RichContentRenderer";

import type { ChatMessage } from "./InspirationMode";
import { TimelineEventCard } from "./TimelineEventCard";

interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (content: string) => Promise<void> | void;
  sending?: boolean;
  loading?: boolean;
  error?: string | null;
  sourceContextLabel?: string | null;
  expertRunLabel?: string | null;
  threadTitle?: string;
  timelineEvents?: TimelineEvent[];
  onOpenReference?: (target: TimelineReferenceTarget) => void;
}

export function ChatPanel({
  error = null,
  loading = false,
  messages,
  onOpenReference,
  onSendMessage,
  sending = false,
  sourceContextLabel = null,
  expertRunLabel = null,
  threadTitle = "灵感工作台",
  timelineEvents = [],
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!input.trim() || sending) {
      return;
    }

    const content = input.trim();
    setInput("");

    try {
      await onSendMessage(content);
    } catch {
      setInput(content);
    }
  };

  const handleCopy = (id: string, content: string) => {
    void navigator.clipboard.writeText(content);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDownload = (content: string, expertName?: string) => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${expertName || threadTitle}_${new Date().toLocaleDateString("zh-CN")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const openArtifactReference = (
    id: string,
    anchor: string | null,
  ) => {
    onOpenReference?.({ kind: "artifact", id, anchor });
  };

  const openEvidenceReference = (
    id: string,
    anchor: string | null,
  ) => {
    onOpenReference?.({ kind: "evidence", id, anchor });
  };

  return (
    <div className="relative flex-1 flex flex-col min-w-0 border-x border-border/30">
      <div className="shrink-0 border-b border-border/30 px-6 py-3">
        <p className="text-sm font-medium text-foreground truncate">{threadTitle}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {loading ? "正在同步线程状态..." : sending ? "消息已发送，等待后端执行..." : "已连接到当前会话"}
        </p>
        <p className="text-[11px] text-muted-foreground/80 mt-1 truncate">
          {sourceContextLabel ?? "当前是纯聊天会话"}
        </p>
        {expertRunLabel ? (
          <p className="text-[11px] text-primary/80 mt-1 truncate">{expertRunLabel}</p>
        ) : null}
        <div className="mt-2">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/75">
            时间线
          </p>
          {timelineEvents.length === 0 ? (
            <p className="text-[10px] text-muted-foreground/60">
              用户问题、检索、专家观点、引用和产物会在这里串联。
            </p>
          ) : (
            <div className="grid gap-1 md:grid-cols-2 xl:grid-cols-3">
              {timelineEvents.slice(-3).map((event) => (
                <TimelineEventCard
                  event={event}
                  key={event.id}
                  onOpenReference={(reference) => onOpenReference?.(reference)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 scrollbar-thin">
        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`animate-fade-in ${message.role === "user" ? "flex justify-end" : ""}`}
          >
            {message.role === "user" ? (
              <div className="max-w-[75%] bg-primary/15 border border-primary/20 rounded-xl rounded-tr-sm px-4 py-3">
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {message.content}
                </p>
              </div>
            ) : (
              <div className="max-w-[85%]">
                {message.role === "expert" && message.expertName && (
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="w-5 h-5 rounded-full bg-secondary flex items-center justify-center">
                      <span className="text-[10px] font-medium text-secondary-foreground">
                        {message.expertName.charAt(0)}
                      </span>
                    </div>
                    <span className="text-xs font-medium text-primary">{message.expertName}</span>
                  </div>
                )}

                <div className="bg-card/50 border border-border/40 rounded-xl rounded-tl-sm px-4 py-3 group relative">
                  <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
                    {message.content}
                  </p>
                  {(message.artifactRefs?.length || message.evidenceRefs?.length) ? (
                    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/25 pt-3">
                      {message.artifactRefs?.map((ref) => (
                        <button
                          key={`artifact-${message.id}-${ref.id}-${ref.anchor ?? "root"}`}
                          className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-secondary/25 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                          onClick={() => openArtifactReference(ref.id, ref.anchor)}
                          type="button"
                        >
                          <FolderKanban className="h-3 w-3" />
                          {ref.label}
                        </button>
                      ))}
                      {message.evidenceRefs?.map((ref) => (
                        <button
                          key={`evidence-${message.id}-${ref.id}-${ref.anchor ?? "root"}`}
                          className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-secondary/25 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                          onClick={() => openEvidenceReference(ref.id, ref.anchor)}
                          type="button"
                        >
                          <FileSearch className="h-3 w-3" />
                          {ref.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {message.richContent && (
                    <div className="mt-3">
                      <RichContentRenderer content={message.richContent} />
                    </div>
                  )}
                  {message.id !== "welcome" && (
                    <div className="flex items-center gap-1 mt-2.5 pt-2 border-t border-border/30 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => handleCopy(message.id, message.content)}
                      >
                        <Copy className="w-3 h-3 mr-1" />
                        {copiedId === message.id ? "已复制" : "复制"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => handleDownload(message.content, message.expertName)}
                      >
                        <Download className="w-3 h-3 mr-1" />
                        下载
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        <Star className="w-3 h-3 mr-1" />
                        收藏
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {sending && (
          <div className="max-w-[85%]">
            <div className="bg-card/40 border border-border/30 rounded-xl rounded-tl-sm px-4 py-3">
              <p className="text-sm text-muted-foreground">正在生成回复...</p>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="shrink-0 p-4 border-t border-border/30">
        <form onSubmit={handleSubmit} className="relative">
          <div className="glass-strong rounded-xl overflow-hidden transition-all duration-300 focus-within:glow-teal">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSubmit(event);
                }
              }}
              placeholder="输入您的研究问题，或与专家们展开深入讨论..."
              rows={2}
              className="w-full bg-transparent px-4 py-3 pr-12 text-foreground placeholder:text-muted-foreground/40 focus:outline-none text-sm resize-none scrollbar-thin"
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              className="absolute right-2 bottom-2 text-muted-foreground hover:text-primary"
              disabled={!input.trim() || sending}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground/40 px-1">
            Enter 发送 · Shift+Enter 换行
          </p>
        </form>
      </div>
    </div>
  );
}
