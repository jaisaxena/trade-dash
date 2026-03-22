"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";

type Strategy = { id: string; name: string; underlying: string; is_frozen: boolean };
type Position = { tradingsymbol: string; quantity: number; avg_price: number; ltp: number; unrealised_pnl: number };
type Order    = { id: string; tradingsymbol: string; transaction_type: string; quantity: number; fill_price: number | null; price: number; status: string };

const STATUS_COLOR: Record<string, string> = {
  COMPLETE:  "badge-green",
  PENDING:   "badge-yellow",
  REJECTED:  "badge-red",
  CANCELLED: "badge-gray",
  OPEN:      "badge-blue",
};

export default function TradingPage() {
  const qc = useQueryClient();
  const { tradingMode, setTradingMode } = useAppStore();

  const [strategyId, setStrategyId] = useState("");
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [qty, setQty] = useState(25);
  const [price, setPrice] = useState(0);

  const prefix = tradingMode === "paper" ? "paper" : "live";

  const strategies = useQuery({
    queryKey: ["strategies"],
    queryFn: () => api.get<{ strategies: Strategy[] }>("/api/vault/strategies"),
  });

  const orders = useQuery({
    queryKey: ["orders", prefix],
    queryFn: () => api.get<{ orders: Order[] }>(`/api/trading/${prefix}/orders`),
    refetchInterval: 5000,
  });

  const positions = useQuery({
    queryKey: ["positions", prefix],
    queryFn: () => api.get<{ positions: Position[] }>(`/api/trading/${prefix}/positions`),
    refetchInterval: 5000,
  });

  const pnl = useQuery({
    queryKey: ["pnl", prefix],
    queryFn: () => tradingMode === "paper"
      ? api.get<{ total_pnl: number; positions: number; open_orders: number }>("/api/trading/paper/pnl")
      : Promise.resolve({ total_pnl: 0, positions: 0, open_orders: 0 }),
    refetchInterval: 5000,
  });

  const placeMutation = useMutation({
    mutationFn: () => api.post(`/api/trading/${prefix}/order`, {
      tradingsymbol: symbol.toUpperCase(),
      transaction_type: side,
      quantity: qty,
      price,
      strategy_id: strategyId || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
      setSymbol("");
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => api.post("/api/trading/paper/reset"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
    },
  });

  const totalPnl = pnl.data?.total_pnl ?? 0;

  return (
    <div className="page">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Trading Terminal</h1>
          <p className="page-sub">Paper-test or go live. Select a vault strategy to auto-load its recipe.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            display: "flex",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 3,
            gap: 3,
          }}>
            <button onClick={() => setTradingMode("paper")} style={{
              padding: "6px 20px", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer",
              border: "none",
              background: tradingMode === "paper" ? "var(--yellow)" : "transparent",
              color: tradingMode === "paper" ? "#fff" : "var(--text-muted)",
              transition: "all .15s",
            }}>PAPER</button>
            <button onClick={() => setTradingMode("live")} style={{
              padding: "6px 20px", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer",
              border: "none",
              background: tradingMode === "live" ? "var(--red)" : "transparent",
              color: tradingMode === "live" ? "#fff" : "var(--text-muted)",
              transition: "all .15s",
            }}>LIVE</button>
          </div>
        </div>
      </div>

      {tradingMode === "live" && (
        <div style={{
          background: "rgba(220,38,38,.1)", border: "1px solid var(--red)44",
          borderRadius: 8, padding: "10px 16px", marginBottom: 16,
          fontSize: 13, color: "var(--red-hi)", fontWeight: 600,
        }}>
          ⚠ LIVE MODE — Real orders will be placed via Kite Connect. Make sure you are authenticated.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
        {/* Order Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div className="section-header">Place Order</div>

            <span className="label">Strategy (auto-loads recipe)</span>
            <select className="input" style={{ marginBottom: 12 }} value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
              <option value="">Manual / No Strategy</option>
              {strategies.data?.strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.is_frozen ? "🔒 " : ""}{s.name} ({s.underlying})
                </option>
              ))}
            </select>

            <span className="label">Symbol</span>
            <input
              className="input mono"
              placeholder="NIFTY2530620000CE"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              style={{ marginBottom: 12 }}
            />

            <span className="label">Side</span>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <button onClick={() => setSide("BUY")} style={{
                flex: 1, padding: "8px", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${side === "BUY" ? "var(--green)" : "var(--border)"}`,
                background: side === "BUY" ? "rgba(5,150,105,.2)" : "var(--bg-elevated)",
                color: side === "BUY" ? "var(--green-hi)" : "var(--text-muted)",
              }}>BUY</button>
              <button onClick={() => setSide("SELL")} style={{
                flex: 1, padding: "8px", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${side === "SELL" ? "var(--red)" : "var(--border)"}`,
                background: side === "SELL" ? "rgba(220,38,38,.2)" : "var(--bg-elevated)",
                color: side === "SELL" ? "var(--red-hi)" : "var(--text-muted)",
              }}>SELL</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
              <div>
                <span className="label">Qty</span>
                <input type="number" className="input" value={qty} onChange={(e) => setQty(parseInt(e.target.value) || 1)} />
              </div>
              <div>
                <span className="label">Price (0=market)</span>
                <input type="number" className="input" value={price} onChange={(e) => setPrice(parseFloat(e.target.value) || 0)} />
              </div>
            </div>

            <button
              className={`btn ${side === "BUY" ? "btn-success" : "btn-danger"}`}
              style={{ width: "100%", justifyContent: "center" }}
              disabled={!symbol || placeMutation.isPending}
              onClick={() => placeMutation.mutate()}
            >
              {tradingMode === "paper" ? "📝 " : "⚡ "}{side} {qty} {symbol || "…"}
            </button>
            {placeMutation.isError && (
              <p style={{ fontSize: 12, color: "var(--red-hi)", margin: "8px 0 0" }}>
                ✗ {(placeMutation.error as Error)?.message}
              </p>
            )}

            {tradingMode === "paper" && (
              <button className="btn btn-ghost btn-sm" style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
                onClick={() => resetMutation.mutate()}>Reset Paper Book</button>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* P&L Summary */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {[
              { label: "Total P&L",        value: `₹${totalPnl.toFixed(2)}`, color: totalPnl >= 0 ? "var(--green-hi)" : "var(--red-hi)" },
              { label: "Open Positions",   value: String(pnl.data?.positions ?? 0),    color: "var(--text)" },
              { label: "Pending Orders",   value: String(pnl.data?.open_orders ?? 0),  color: "var(--text)" },
            ].map(({ label, value, color }) => (
              <div key={label} className="card stat-card">
                <div className="stat-label">{label}</div>
                <div className="stat-value" style={{ color, fontSize: 20 }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Positions */}
          <div className="card" style={{ padding: 16 }}>
            <div className="section-header">Positions</div>
            {(positions.data?.positions ?? []).length === 0 ? (
              <p style={{ color: "var(--text-dim)", fontSize: 13, padding: "8px 0" }}>No open positions</p>
            ) : (
              <table className="tbl">
                <thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>LTP</th><th>Unrealised P&L</th></tr></thead>
                <tbody>
                  {positions.data?.positions.map((p, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: 12 }}>{p.tradingsymbol}</td>
                      <td className="mono">{p.quantity}</td>
                      <td className="mono">{p.avg_price.toFixed(2)}</td>
                      <td className="mono">{p.ltp.toFixed(2)}</td>
                      <td className={`mono ${p.unrealised_pnl >= 0 ? "pos" : "neg"}`}>₹{p.unrealised_pnl.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Order book */}
          <div className="card" style={{ padding: 16 }}>
            <div className="section-header">Order Book</div>
            {(orders.data?.orders ?? []).length === 0 ? (
              <p style={{ color: "var(--text-dim)", fontSize: 13, padding: "8px 0" }}>No orders yet</p>
            ) : (
              <table className="tbl">
                <thead><tr><th>ID</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Fill</th><th>Status</th></tr></thead>
                <tbody>
                  {orders.data?.orders.map((o, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ color: "var(--text-muted)", fontSize: 11 }}>{o.id}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{o.tradingsymbol}</td>
                      <td style={{ color: o.transaction_type === "BUY" ? "var(--green-hi)" : "var(--red-hi)", fontWeight: 700 }}>{o.transaction_type}</td>
                      <td className="mono">{o.quantity}</td>
                      <td className="mono">{(o.fill_price ?? o.price).toFixed(2)}</td>
                      <td><span className={`badge ${STATUS_COLOR[o.status] ?? "badge-gray"}`}>{o.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
