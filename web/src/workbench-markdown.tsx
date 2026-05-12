import {
  Children,
  createElement,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { formatReferenceAnchor, parseWorkbenchLink } from "./message-links";
import {
  artifactBlockAnchor,
  artifactReferenceMarkdown,
  workbenchReferenceMarkdown,
} from "./reference-utils";
import type { ArtifactRecord } from "./types";

type WorkbenchMarkdownProps = {
  source: string;
  className?: string;
  artifact?: Pick<ArtifactRecord, "id" | "kind" | "title"> | null;
  highlightedAnchor?: string | null;
  onInsertReference?: (text: string) => void;
  onOpenEvidence?: (evidenceId: string, anchor?: string | null) => void;
  onOpenArtifact?: (artifactId: string, anchor?: string | null) => void;
};

type AnchorableTag =
  | "blockquote"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "ol"
  | "p"
  | "pre"
  | "table"
  | "ul";

type MarkdownBlockProps<Tag extends AnchorableTag> = ComponentPropsWithoutRef<Tag> & {
  node?: unknown;
};

function extractNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (!node) {
    return "";
  }

  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }

      if (isValidElement<{ children?: ReactNode }>(child)) {
        return extractNodeText(child.props.children);
      }

      return "";
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function blockReferenceLabel(text: string, index: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return `block ${index}`;
  }

  return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}

async function copyText(value: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return;
  }

  await navigator.clipboard.writeText(value);
}

export function WorkbenchMarkdown({
  source,
  className,
  artifact = null,
  highlightedAnchor = null,
  onInsertReference,
  onOpenEvidence,
  onOpenArtifact,
}: WorkbenchMarkdownProps) {
  const highlightedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!highlightedAnchor || !highlightedRef.current) {
      return;
    }

    highlightedRef.current.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [highlightedAnchor, source]);

  const components = useMemo(() => {
    let blockIndex = 0;

    const createAnchorableBlock = <Tag extends AnchorableTag>(tag: Tag) => {
      return function AnchorableBlock({
        children,
        node: _node,
        ...props
      }: MarkdownBlockProps<Tag>) {
        blockIndex += 1;
        const anchor = artifactBlockAnchor(blockIndex);
        const label = blockReferenceLabel(extractNodeText(children), blockIndex);
        const isActive = highlightedAnchor === anchor;
        const reference = artifact
          ? artifactReferenceMarkdown(artifact, {
              anchor,
              blockLabel: label,
            })
          : null;

        return (
          <div
            className={`markdown-block ${isActive ? "active" : ""}`}
            id={anchor}
            ref={(node) => {
              if (isActive) {
                highlightedRef.current = node;
              }
            }}
          >
            {artifact ? (
              <div className="markdown-block-toolbar">
                <span className="markdown-block-anchor">{anchor}</span>
                <button
                  className="secondary markdown-block-action"
                  onClick={() => {
                    if (!reference) {
                      return;
                    }
                    void copyText(reference);
                  }}
                  type="button"
                >
                  复制引用
                </button>
                {onInsertReference && reference ? (
                  <button
                    className="secondary markdown-block-action"
                    onClick={() => onInsertReference(reference)}
                    type="button"
                  >
                    引用到对话
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="markdown-block-content">
              {createElement(tag, props, children)}
            </div>
          </div>
        );
      };
    };

    const anchorableComponents: Partial<Components> = artifact
      ? {
          h1: createAnchorableBlock("h1"),
          h2: createAnchorableBlock("h2"),
          h3: createAnchorableBlock("h3"),
          h4: createAnchorableBlock("h4"),
          h5: createAnchorableBlock("h5"),
          h6: createAnchorableBlock("h6"),
          p: createAnchorableBlock("p"),
          blockquote: createAnchorableBlock("blockquote"),
          ul: createAnchorableBlock("ul"),
          ol: createAnchorableBlock("ol"),
          table: createAnchorableBlock("table"),
          pre: createAnchorableBlock("pre"),
        }
      : {};

    return {
      a: ({ href, children, ...props }: ComponentPropsWithoutRef<"a">) => {
        const target = parseWorkbenchLink(href);
        const anchorLabel = formatReferenceAnchor(target?.anchor);
        const referenceLabel = extractNodeText(children) || target?.id || "引用";

        if (target?.kind === "artifact") {
          return (
            <span className="inline-link-cluster">
              <button
                className="inline-link-button citation-artifact"
                onClick={() => onOpenArtifact?.(target.id, target.anchor)}
                type="button"
              >
                <span>{children}</span>
                <small>{anchorLabel ?? "结果"}</small>
              </button>
              {onInsertReference ? (
                <button
                  className="secondary inline-link-insert"
                  onClick={() =>
                    onInsertReference(
                      workbenchReferenceMarkdown({
                        kind: "artifact",
                        id: target.id,
                        label: referenceLabel,
                        anchor: target.anchor,
                      }),
                    )
                  }
                  type="button"
                >
                  引用
                </button>
              ) : null}
            </span>
          );
        }

        if (target?.kind === "evidence") {
          return (
            <span className="inline-link-cluster">
              <button
                className="inline-link-button citation-evidence"
                onClick={() => onOpenEvidence?.(target.id, target.anchor)}
                type="button"
              >
                <span>{children}</span>
                <small>{anchorLabel ?? "证据"}</small>
              </button>
              {onInsertReference ? (
                <button
                  className="secondary inline-link-insert"
                  onClick={() =>
                    onInsertReference(
                      workbenchReferenceMarkdown({
                        kind: "evidence",
                        id: target.id,
                        label: referenceLabel,
                        anchor: target.anchor,
                      }),
                    )
                  }
                  type="button"
                >
                  引用
                </button>
              ) : null}
            </span>
          );
        }

        return (
          <a {...props} href={href} rel="noreferrer" target="_blank">
            {children}
          </a>
        );
      },
      ...anchorableComponents,
    } satisfies Components;
  }, [artifact, highlightedAnchor, onInsertReference, onOpenArtifact, onOpenEvidence]);

  return (
    <Markdown className={className} components={components} remarkPlugins={[remarkGfm]}>
      {source}
    </Markdown>
  );
}
