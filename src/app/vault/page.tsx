"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

type Strategy = {
  id: string; name: string; version: number; underlying: string;
  is_frozen: boolean; updated_at: string;
  last_backtest_sharpe: number | null;
  last_backtest_cagr: number | null;
  last_backtest_max_dd: number | null;
};

export default function VaultPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "frozen">("all");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);

  const strategies = useQuery({
    queryKey: ["strategies", filter],
    queryFn: () => api.get<{ strategies: Strategy[] }>(`/api/vault/strategies?frozen_only=${filter === "frozen"}`),
  });

  const freezeMutation   = useMutation({ mutationFn: (id: string) => api.post(`/api/vault/strategies/${id}/freeze`),   onSuccess: () => qc.invalidateQueries({ queryKey: ["strategies"] }) });
  const unfreezeMutation = useMutation({ mutationFn: (id: string) => api.post(`/api/vault/strategies/${id}/unfreeze`), onSuccess: () => qc.invalidateQueries({ queryKey: ["strategies"] }) });
  const deleteMutation   = useMutation({ mutationFn: (id: string) => api.delete(`/api/vault/strategies/${id}`),        onSuccess: () => qc.invalidateQueries({ queryKey: ["strategies"] }) });

  const viewRecipe = async (id: string) => {
    const data = await api.get<{ strategy: Record<string, unknown> }>(`/api/vault/strategies/${id}`);
    setPreview(data.strategy);
  };

  const list = strategies.data?.strategies ?? [];

  const metricColor = (v: number | null, invert = false) => {
    if (v === null) return "var(--text-muted)";
    return (invert ? v < 0 : v > 0) ? "var(--green-hi)" : "var(--red-hi)";
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Strategy Vault</h1>
          <p className="page-sub">All saved strategy recipes. Freeze a version to mark it production-ready.</p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {(["all", "frozen"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className="btn btn-ghost btn-sm" style={{
              color: filter === f ? "var(--text)" : "var(--text-muted)",
              borderColor: filter === f ? "var(--accent-hi)" : "var(--border)",
              background: filter === f ? "rgba(37,99,235,.15)" : "var(--bg-elevated)",
            }}>
              {f === "all" ? "All" : "🔒 Frozen"}
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <div className="card" style={{ padding: 60, textAlign: "center" }}>
          <p style={{ color: "var(--text-muted)" }}>No strategies yet. Build one in the Strategy Builder.</p>
          <a href="/strategies" className="btn btn-primary" style={{ marginTop: 16, textDecoration: "none" }}>
            Open Builder →
          </a>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12 }}>
          {list.map((s) => (
            <div key={s.id} className="card" style={{
              padding: 16,
              borderLeft: `3px solid ${s.is_frozen ? "var(--green)" : "var(--border)"}`,
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{s.name}</span>
                    {s.is_frozen && <span className="badge badge-green">FROZEN</span>}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                    {s.underlying} · v{s.version} · <span className="mono">{s.id}</span>
                  </div>
                </div>
              </div>

              {/* Backtest metrics */}
              <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
                {[
                  { label: "Sharpe",  value: s.last_backtest_sharpe, fmt: (v: number) => v.toFixed(2) },
                  { label: "CAGR",    value: s.last_backtest_cagr,   fmt: (v: number) => `${(v*100).toFixed(1)}%` },
                  { label: "Max DD",  value: s.last_backtest_max_dd, fmt: (v: number) => `${(v*100).toFixed(1)}%` },
                ].map(({ label, value, fmt }) => (
                  <div key={label}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-muted)" }}>{label}</div>
                    <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: value !== null ? (label === "Max DD" ? "var(--red-hi)" : value > 0 ? "var(--green-hi)" : "var(--red-hi)") : "var(--text-dim)" }}>
                      {value !== null ? fmt(value) : "—"}
                    </div>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => viewRecipe(s.id)}>View JSON</button>
                {s.is_frozen
                  ? <button className="btn btn-ghost btn-sm" style={{ color: "var(--yellow-hi)" }} onClick={() => unfreezeMutation.mutate(s.id)}>Unfreeze</button>
                  : <button className="btn btn-ghost btn-sm" style={{ color: "var(--green-hi)", borderColor: "var(--green)44" }} onClick={() => freezeMutation.mutate(s.id)}>🔒 Freeze</button>
                }
                <a href={`/backtest`} className="btn btn-ghost btn-sm" style={{ textDecoration: "none" }}>Backtest</a>
                <button className="btn btn-ghost btn-sm" style={{ color: "var(--red-hi)", marginLeft: "auto" }}
                  onClick={() => { if (confirm(`Delete "${s.name}"?`)) deleteMutation.mutate(s.id); }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* JSON Preview Modal */}
      {preview && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 200,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }} onClick={() => setPreview(null)}>
          <div style={{
            background: "var(--bg-card)", border: "1px solid var(--border)",
            borderRadius: 12, padding: 24, maxWidth: 640, width: "100%",
            maxHeight: "80vh", display: "flex", flexDirection: "column",
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{String(preview.name)}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setPreview(null)}>✕ Close</button>
            </div>
            <pre style={{
              flex: 1, overflow: "auto", margin: 0,
              background: "var(--bg-elevated)", border: "1px solid var(--border-dim)",
              borderRadius: 6, padding: 12,
              fontFamily: "monospace", fontSize: 12,
              color: "var(--text-muted)", whiteSpace: "pre-wrap",
            }}>
              {JSON.stringify(preview, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
