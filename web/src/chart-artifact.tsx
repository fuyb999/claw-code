import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ChartArtifactPayload } from "./types";

const DEFAULT_COLORS = [
  "#195f59",
  "#d17b49",
  "#486994",
  "#9b5d73",
  "#5e8c31",
  "#ba4d62",
];

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

function isChartPayload(payload: unknown): payload is ChartArtifactPayload {
  return (
    isRecord(payload) &&
    typeof payload.type === "string" &&
    Array.isArray(payload.data)
  );
}

export default function ChartArtifact({ payload }: { payload: unknown }) {
  if (!isChartPayload(payload)) {
    return <pre>{summarizePayload(payload)}</pre>;
  }

  const height = payload.height ?? 280;
  const series = payload.series ?? [];
  const title = payload.title ?? null;
  const description = payload.description ?? null;

  const chartBody = (() => {
    switch (payload.type) {
      case "line":
        if (!payload.xKey || series.length === 0) {
          return <pre>{summarizePayload(payload)}</pre>;
        }
        return (
          <ResponsiveContainer height={height} width="100%">
            <LineChart data={payload.data}>
              <CartesianGrid stroke="rgba(25, 39, 49, 0.12)" strokeDasharray="3 3" />
              <XAxis dataKey={payload.xKey} stroke="#5c6875" />
              <YAxis stroke="#5c6875" />
              <Tooltip />
              <Legend />
              {series.map((entry, index) => (
                <Line
                  dataKey={entry.key}
                  key={entry.key}
                  name={entry.label ?? entry.key}
                  stroke={entry.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]}
                  strokeWidth={2}
                  type="monotone"
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        );
      case "bar":
        if (!payload.xKey || series.length === 0) {
          return <pre>{summarizePayload(payload)}</pre>;
        }
        return (
          <ResponsiveContainer height={height} width="100%">
            <BarChart data={payload.data}>
              <CartesianGrid stroke="rgba(25, 39, 49, 0.12)" strokeDasharray="3 3" />
              <XAxis dataKey={payload.xKey} stroke="#5c6875" />
              <YAxis stroke="#5c6875" />
              <Tooltip />
              <Legend />
              {series.map((entry, index) => (
                <Bar
                  dataKey={entry.key}
                  fill={entry.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]}
                  key={entry.key}
                  name={entry.label ?? entry.key}
                  radius={[10, 10, 2, 2]}
                  stackId={entry.stackId}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        );
      case "area":
        if (!payload.xKey || series.length === 0) {
          return <pre>{summarizePayload(payload)}</pre>;
        }
        return (
          <ResponsiveContainer height={height} width="100%">
            <AreaChart data={payload.data}>
              <CartesianGrid stroke="rgba(25, 39, 49, 0.12)" strokeDasharray="3 3" />
              <XAxis dataKey={payload.xKey} stroke="#5c6875" />
              <YAxis stroke="#5c6875" />
              <Tooltip />
              <Legend />
              {series.map((entry, index) => {
                const color = entry.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length];
                return (
                  <Area
                    dataKey={entry.key}
                    fill={color}
                    fillOpacity={0.18}
                    key={entry.key}
                    name={entry.label ?? entry.key}
                    stackId={entry.stackId}
                    stroke={color}
                    strokeWidth={2}
                    type="monotone"
                  />
                );
              })}
            </AreaChart>
          </ResponsiveContainer>
        );
      case "pie":
        if (!payload.labelKey || !payload.valueKey) {
          return <pre>{summarizePayload(payload)}</pre>;
        }
        return (
          <ResponsiveContainer height={height} width="100%">
            <PieChart>
              <Tooltip />
              <Legend />
              <Pie
                cx="50%"
                cy="50%"
                data={payload.data}
                dataKey={payload.valueKey}
                nameKey={payload.labelKey}
                outerRadius="72%"
              >
                {payload.data.map((_, index) => (
                  <Cell
                    fill={DEFAULT_COLORS[index % DEFAULT_COLORS.length]}
                    key={`pie-cell-${index}`}
                  />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        );
    }
  })();

  return (
    <div className="artifact-visual">
      {(title || description) && (
        <div className="artifact-visual-header">
          {title && <strong>{title}</strong>}
          {description && <span>{description}</span>}
        </div>
      )}
      {chartBody}
    </div>
  );
}
