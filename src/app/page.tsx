"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { ReactFlow, Background, Controls, type Node, type Edge, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const STEPS = [
  { id: "data",       x: 40,   label: "01 · Data",       sub: "Sync OHLCV",        color: "#2563eb" },
  { id: "strategies", x: 250,  label: "02 · Strategy",   sub: "Build recipes",     color: "#7c3aed" },
  { id: "optimizer",  x: 460,  label: "03 · Optimizer",  sub: "Grid / WF search",  color: "#d97706" },
  { id: "backtest",   x: 670,  label: "04 · Backtest",   sub: "VectorBT engine",   color: "#059669" },
  { id: "vault",      x: 880,  label: "05 · Vault",      sub: "Store & version",   color: "#6366f1" },
  { id: "trading",    x: 1090, label: "06 · Terminal",   sub: "Paper / live",      color: "#dc2626" },
];

const NODES: Node[] = STEPS.map(({ id, x, label, sub, color }) => ({
  id,
  position: { x, y: 80 },
  data: { label: `${label}\n${sub}` },
  style: {
    background: "transparent",
    border: `1px solid ${color}55`,
    borderRadius: 10,
    padding: "14px 18px",
    color: "#dce8f5",
    fontWeight: 600,
    fontSize: 13,
    width: 170,
    cursor: "pointer",
    boxShadow: `0 0 20px ${color}22`,
    whiteSpace: "pre-line",
    lineHeight: 1.5,
  },
}));

const EDGES: Edge[] = STEPS.slice(0, -1).map((s, i) => ({
  id: `e${i}`,
  source: s.id,
  target: STEPS[i + 1].id,
  animated: true,
  style: { stroke: "#1a2840", strokeWidth: 2 },
}));

const LIVE_EDGE: Edge = {
  id: "live",
  source: "data",
  target: "trading",
  label: "live feed",
  style: { stroke: "#1a2840", strokeDasharray: "5 4", strokeWidth: 1.5 },
  labelStyle: { fill: "#4d6b8a", fontSize: 10 },
};

const INFO = [
  { id: "data",       color: "#2563eb", title: "Data Module",        desc: "Pick underlyings (NIFTY, BANKNIFTY…), choose intervals, set date range. One click downloads and caches everything locally in DuckDB." },
  { id: "strategies", color: "#7c3aed", title: "Strategy Builder",   desc: "Build option strategies visually — select legs, add indicator conditions, set exit rules. No JSON editing required." },
  { id: "optimizer",  color: "#d97706", title: "Optimizer",          desc: "Grid search or walk-forward optimization across millions of param combinations using all CPU cores via joblib + VectorBT." },
  { id: "backtest",   color: "#059669", title: "Backtester",         desc: "Full vectorized backtest with Black-Scholes options P&L, equity curve, trade log and 10 performance metrics." },
  { id: "vault",      color: "#6366f1", title: "Strategy Vault",     desc: "Version-controlled recipe storage. Freeze production-ready versions. All backtest badges attached." },
  { id: "trading",    color: "#dc2626", title: "Trading Terminal",   desc: "Select a frozen strategy — recipe loads automatically. Toggle paper or live mode. Real-time P&L via Kite WebSocket." },
];

export default function PipelinePage() {
  const router = useRouter();
  const onNodeClick: NodeMouseHandler = useCallback((_, node) => router.push(`/${node.id}`), [router]);

  return (
    <div className="page">
      <div style={{ marginBottom: 24 }}>
        <h1 className="page-title">Options Trading Pipeline</h1>
        <p className="page-sub">Click any module to open it. Data flows left → right.</p>
      </div>

      <div className="card" style={{ height: 260, marginBottom: 32 }}>
        <ReactFlow
          nodes={NODES}
          edges={[...EDGES, LIVE_EDGE]}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          style={{ background: "transparent" }}
        >
          <Background color="#1a2840" gap={24} size={1} />
          <Controls
            showInteractive={false}
            style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
          />
        </ReactFlow>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {INFO.map(({ id, color, title, desc }) => (
          <a
            key={id}
            href={`/${id}`}
            style={{
              textDecoration: "none",
              display: "block",
              background: "var(--bg-card)",
              border: `1px solid var(--border)`,
              borderRadius: "var(--radius)",
              padding: "16px 18px",
              transition: "border-color .15s, box-shadow .15s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.borderColor = color + "66";
              (e.currentTarget as HTMLAnchorElement).style.boxShadow = `0 0 16px ${color}18`;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.borderColor = "var(--border)";
              (e.currentTarget as HTMLAnchorElement).style.boxShadow = "none";
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
              <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{title}</span>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>{desc}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
