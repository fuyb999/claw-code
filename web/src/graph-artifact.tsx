import { useMemo } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";

import type { GraphArtifactPayload } from "./types";

function summarizePayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "unserializable payload";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGraphPayload(payload: unknown): payload is GraphArtifactPayload {
  return (
    isRecord(payload) &&
    Array.isArray(payload.nodes) &&
    Array.isArray(payload.edges)
  );
}

function fallbackPosition(index: number, total: number) {
  const columns = Math.max(2, Math.ceil(Math.sqrt(total)));
  const row = Math.floor(index / columns);
  const column = index % columns;
  return {
    x: 40 + column * 220,
    y: 40 + row * 140,
  };
}

export default function GraphArtifact({ payload }: { payload: unknown }) {
  const normalized = useMemo(() => {
    if (!isGraphPayload(payload)) {
      return null;
    }

    const nodes: Node[] = payload.nodes.map((node, index) => {
      const position =
        typeof node.x === "number" && typeof node.y === "number"
          ? { x: node.x, y: node.y }
          : fallbackPosition(index, payload.nodes.length);
      return {
        id: node.id,
        data: { label: node.label },
        position,
        style: {
          background: "rgba(255, 253, 247, 0.96)",
          border: "1px solid rgba(44, 63, 79, 0.18)",
          borderRadius: 18,
          padding: 8,
          width: 180,
          fontSize: 14,
          color: "#1e2731",
        },
      };
    });

    const edges: Edge[] = payload.edges.map((edge, index) => ({
      id: edge.id ?? `edge-${edge.source}-${edge.target}-${index}`,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      animated: false,
      style: { stroke: "#486994", strokeWidth: 1.5 },
      labelStyle: { fill: "#5c6875", fontSize: 12 },
    }));

    return {
      title: payload.title ?? null,
      description: payload.description ?? null,
      nodes,
      edges,
    };
  }, [payload]);

  if (!normalized) {
    return <pre>{summarizePayload(payload)}</pre>;
  }

  return (
    <div className="artifact-visual">
      {(normalized.title || normalized.description) && (
        <div className="artifact-visual-header">
          {normalized.title && <strong>{normalized.title}</strong>}
          {normalized.description && <span>{normalized.description}</span>}
        </div>
      )}
      <div className="artifact-graph">
        <ReactFlow
          edges={normalized.edges}
          fitView
          nodes={normalized.nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="rgba(25, 95, 89, 0.08)" gap={20} />
          <MiniMap
            maskColor="rgba(255, 255, 255, 0.75)"
            nodeColor="rgba(25, 95, 89, 0.45)"
            pannable
            zoomable
          />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
