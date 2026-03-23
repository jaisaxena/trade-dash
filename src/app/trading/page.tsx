"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createChart, CandlestickSeries, type IChartApi } from "lightweight-charts";
import { api } from "@/lib/api";
import { formatStrikeRef } from "@/lib/strikeLabels";
import { useAppStore } from "@/lib/store";

type Strategy = { id: string; name: string; underlying: string; is_frozen: boolean };
type Position = { tradingsymbol: string; quantity: number; avg_price: number; ltp: number; unrealised_pnl: number };
type Order    = { id: string; tradingsymbol: string; transaction_type: string; quantity: number; fill_price: number | null; price: number; status: string };
type Candle        = { timestamp: string; open: number; high: number; low: number; close: number; volume: number; ltp: number };
type FeedQuote     = { mode: string; replay_state: string | null; underlying: string; interval: string; quote: Candle | null; history: Candle[] };
type MonitorResult  = { verdict: "LONG" | "SHORT" | "NEUTRAL"; direction: string; timestamp: string | null; close: number; candles_used: number; reason: string | null };
type InstrumentRow  = { instrument_token: number; tradingsymbol: string; name: string | null; exchange: string; segment: string; instrument_type: string; strike: number | null; expiry: string | null; lot_size: number | null };
type SuggestionRow  = { tradingsymbol: string; instrument_token: number; option_type: string; strike: number; expiry: string; lot_size: number | null; action: string; lots: number; strike_ref: string };
type AutoTradeStatus = { enabled: boolean; status: "idle" | "in_long" | "in_short"; current_direction: string | null; strategy_id: string | null; trading_mode: string; open_legs: string[]; last_action: string | null };

const STATUS_COLOR: Record<string, string> = {
  COMPLETE:  "badge-green",
  PENDING:   "badge-yellow",
  REJECTED:  "badge-red",
  CANCELLED: "badge-gray",
  OPEN:      "badge-blue",
};

const UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"];
const INTERVALS   = ["1m", "5m", "15m", "1h", "day"];
const SPEEDS      = [0.5, 1, 2, 5, 10, 20];

const MONITOR_INTERVALS: { label: string; ms: number }[] = [
  { label: "1s",  ms: 1000  },
  { label: "3s",  ms: 3000  },
  { label: "5s",  ms: 5000  },
  { label: "10s", ms: 10000 },
  { label: "30s", ms: 30000 },
];

function toUnix(ts: string): number {
  // Append 'Z' so the naive market-time string is treated as UTC,
  // keeping the chart labels showing actual market time (09:15, not 03:45).
  return Math.floor(new Date(ts + "Z").getTime() / 1000);
}

function getPreviousMonday(): string {
  const d = new Date();
  const day = d.getDay(); // 0=Sun … 6=Sat
  // Days to subtract to reach the most recent past Monday (never today if today is Mon)
  const back = day === 0 ? 6 : day === 1 ? 7 : day - 1;
  d.setDate(d.getDate() - back);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:15`;
}

export default function TradingPage() {
  const qc = useQueryClient();
  const { tradingMode, setTradingMode } = useAppStore();

  // ── Order form state ───────────────────────────────────────────────
  const [symbol, setSymbol]         = useState("");
  const [symbolQuery, setSymbolQuery] = useState("");
  const [showSymbolDrop, setShowSymbolDrop] = useState(false);
  const symbolBoxRef                = useRef<HTMLDivElement>(null);
  const [side, setSide]             = useState<"BUY" | "SELL">("BUY");
  const [qty, setQty]               = useState(25);
  const [price, setPrice]           = useState(0);

  // ── Feed state ────────────────────────────────────────────────────
  const [feedMode, setFeedMode]           = useState<"live" | "replay">("live");
  const [feedUnderlying, setFeedUnderlying] = useState("NIFTY");
  const [feedInterval, setFeedInterval]   = useState("15m");
  const [replayStartDt, setReplayStartDt] = useState(getPreviousMonday);
  const [replaySpeed, setReplaySpeed]     = useState(1);
  const [feedConfigured, setFeedConfigured] = useState(false);

  // ── Strategy Monitor state ────────────────────────────────────────
  const [monitorStrategyId, setMonitorStrategyId] = useState("");
  const [monitorIntervalMs, setMonitorIntervalMs] = useState(5000);

  // ── Auto-trade state ──────────────────────────────────────────────
  const [autoTradeOn, setAutoTradeOn]       = useState(false);
  const [autoTradeStatus, setAutoTradeStatus] = useState<AutoTradeStatus | null>(null);

  // ── Symbol search debounce ────────────────────────────────────────
  const [debouncedSymbolQ, setDebouncedSymbolQ] = useState("");

  // ── Mini chart refs ───────────────────────────────────────────────
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef          = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candleSerRef      = useRef<any>(null);

  // ── Queries ───────────────────────────────────────────────────────
  const prefix = tradingMode === "paper" ? "paper" : "live";

  const strategies = useQuery({
    queryKey: ["strategies"],
    queryFn: () => api.get<{ strategies: Strategy[] }>("/api/vault/strategies"),
  });

  const feedQuery = useQuery({
    queryKey: ["feed-quotes"],
    queryFn: () => api.get<FeedQuote>("/api/feed/quotes?history=60"),
    refetchInterval: feedMode === "replay"
      ? Math.round(1000 / replaySpeed)
      : 1000,
  });

  const [confirmClose, setConfirmClose] = useState<string | null>(null);

  const monitorQuery = useQuery({
    queryKey: ["strategy-monitor", monitorStrategyId],
    queryFn: () => api.get<MonitorResult>(`/api/feed/analyze?strategy_id=${monitorStrategyId}`),
    enabled: !!monitorStrategyId,
    refetchInterval: monitorIntervalMs,
  });

  const monitorDirection = monitorQuery.data?.direction ?? "neutral";

  const suggestionsQuery = useQuery({
    queryKey: ["feed-suggestions", monitorStrategyId, monitorDirection],
    queryFn: () => api.get<{ suggestions: SuggestionRow[]; underlying: string; expiry: string; spot: number; atm_strike: number; reason?: string }>(
      `/api/feed/suggestions?strategy_id=${monitorStrategyId}&direction=${monitorDirection}`
    ),
    enabled: !!monitorStrategyId && monitorDirection !== "neutral",
    refetchInterval: monitorIntervalMs,
  });

  const instrumentSearchQuery = useQuery({
    queryKey: ["instruments-search", debouncedSymbolQ],
    queryFn: () => api.get<{ total: number; items: InstrumentRow[] }>(
      `/api/data/instruments?q=${encodeURIComponent(debouncedSymbolQ)}&limit=30`
    ),
    enabled: showSymbolDrop && debouncedSymbolQ.length > 0,
  });

  const refreshInstrumentsMutation = useMutation({
    mutationFn: () => api.post("/api/data/instruments/refresh"),
  });

  const refreshLtpsMutation = useMutation({
    mutationFn: () => api.post("/api/trading/refresh-ltps", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
    },
  });

  const closeMutation = useMutation({
    mutationFn: (sym: string) =>
      api.post(`/api/trading/${prefix}/position/${encodeURIComponent(sym)}/close`, {}),
    onSuccess: () => {
      setConfirmClose(null);
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
    },
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
      ? api.get<{ total_pnl: number; realized_pnl: number; unrealized_pnl: number; positions: number; open_orders: number }>("/api/trading/paper/pnl")
      : Promise.resolve({ total_pnl: 0, realized_pnl: 0, unrealized_pnl: 0, positions: 0, open_orders: 0 }),
    refetchInterval: 5000,
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const configureMutation = useMutation({
    mutationFn: () => api.post("/api/feed/configure", {
      mode: feedMode,
      underlying: feedUnderlying,
      interval: feedInterval,
      start_dt: feedMode === "replay" ? replayStartDt || undefined : undefined,
      speed: replaySpeed,
    }),
    onSuccess: () => {
      setFeedConfigured(true);
      qc.invalidateQueries({ queryKey: ["feed-quotes"] });
    },
  });

  const playMutation  = useMutation({ mutationFn: () => api.post("/api/feed/replay/play"),  onSuccess: () => qc.invalidateQueries({ queryKey: ["feed-quotes"] }) });
  const pauseMutation = useMutation({ mutationFn: () => api.post("/api/feed/replay/pause"), onSuccess: () => qc.invalidateQueries({ queryKey: ["feed-quotes"] }) });
  const resetMutation_feed = useMutation({ mutationFn: () => api.post("/api/feed/replay/reset"), onSuccess: () => qc.invalidateQueries({ queryKey: ["feed-quotes"] }) });

  const placeMutation = useMutation({
    mutationFn: () => api.post(`/api/trading/${prefix}/order`, {
      tradingsymbol: symbol.toUpperCase(),
      transaction_type: side,
      quantity: qty,
      price,
      strategy_id: monitorStrategyId || undefined,
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

  const autoTradeEnableMutation = useMutation({
    mutationFn: () => api.post<AutoTradeStatus>("/api/auto-trade/enable", {
      strategy_id: monitorStrategyId,
      trading_mode: tradingMode,
    }),
    onSuccess: (data) => { setAutoTradeStatus(data); setAutoTradeOn(true); },
  });

  const autoTradeDisableMutation = useMutation({
    mutationFn: () => api.post<AutoTradeStatus>("/api/auto-trade/disable", {}),
    onSuccess: (data) => { setAutoTradeStatus(data); setAutoTradeOn(false); },
  });

  const autoTradeTickMutation = useMutation({
    mutationFn: () => api.post<AutoTradeStatus>("/api/auto-trade/tick", {
      strategy_id: monitorStrategyId,
      trading_mode: tradingMode,
    }),
    onSuccess: (data) => {
      setAutoTradeStatus(data as unknown as AutoTradeStatus);
      // Refresh positions/orders if auto-trade took action
      if ((data as unknown as { action_taken: string | null }).action_taken) {
        qc.invalidateQueries({ queryKey: ["positions"] });
        qc.invalidateQueries({ queryKey: ["orders"] });
        qc.invalidateQueries({ queryKey: ["pnl"] });
      }
    },
  });

  // ── Refresh LTPs from Kite whenever the monitor ticks ────────────
  useEffect(() => {
    const currentPositions = positions.data?.positions ?? [];
    if (!currentPositions.length) return;
    refreshLtpsMutation.mutate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorQuery.dataUpdatedAt]);

  // ── Auto-trade tick — fires on every strategy monitor poll ────────
  useEffect(() => {
    if (!autoTradeOn || !monitorStrategyId) return;
    autoTradeTickMutation.mutate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorQuery.dataUpdatedAt]);

  // ── Symbol search debounce ────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSymbolQ(symbolQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [symbolQuery]);

  // ── Close symbol dropdown on outside click ────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (symbolBoxRef.current && !symbolBoxRef.current.contains(e.target as Node))
        setShowSymbolDrop(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Auto-refresh instruments list on terminal mount ───────────────
  useEffect(() => {
    refreshInstrumentsMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mini chart: init once ─────────────────────────────────────────
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const el = chartContainerRef.current;
    const c = createChart(el, {
      width:  el.clientWidth,
      height: el.clientHeight || 240,
      layout: { background: { color: "transparent" }, textColor: "#4d6b8a" },
      grid:   { vertLines: { color: "#1a284022" }, horzLines: { color: "#1a284022" } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    });

    candleSerRef.current = c.addSeries(CandlestickSeries, {
      upColor:         "#10b981",
      downColor:       "#ef4444",
      borderUpColor:   "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor:     "#10b981",
      wickDownColor:   "#ef4444",
    });

    chartRef.current = c;

    // Use ResizeObserver so the chart fills its container in both dimensions
    const ro = new ResizeObserver(() => {
      if (chartContainerRef.current)
        c.applyOptions({
          width:  chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      c.remove();
      chartRef.current     = null;
      candleSerRef.current = null;
    };
  }, []);

  // ── Mini chart: update data when feed changes ─────────────────────
  const prevHistLenRef = useRef(0);
  useEffect(() => {
    const history = feedQuery.data?.history;
    if (!history?.length || !candleSerRef.current) return;

    const sorted = [...history].sort((a, b) => toUnix(a.timestamp) - toUnix(b.timestamp));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chartData: any[] = sorted.map((c) => ({
      time:  toUnix(c.timestamp),
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
    }));

    // In live mode, update the last candle (the current forming candle
    // from Kite) with the real-time LTP so it moves between cache refreshes.
    const quote = feedQuery.data?.quote;
    if (feedQuery.data?.mode === "live" && quote && quote.ltp > 0 && chartData.length > 0) {
      const last = chartData[chartData.length - 1];
      last.close = quote.ltp;
      last.high  = Math.max(last.high, quote.ltp);
      last.low   = Math.min(last.low, quote.ltp);
    }

    candleSerRef.current.setData(chartData);

    if (sorted.length !== prevHistLenRef.current) {
      chartRef.current?.timeScale().fitContent();
      prevHistLenRef.current = sorted.length;
    }
  }, [feedQuery.data]);

  // ── Derived feed values ───────────────────────────────────────────
  const feed        = feedQuery.data;
  const currentLtp  = feed?.quote?.ltp ?? 0;
  const replayState = feed?.replay_state;
  const isPlaying   = replayState === "playing";
  const totalPnl    = pnl.data?.total_pnl ?? 0;
  const monitor     = monitorQuery.data;
  const verdict     = monitor?.verdict ?? "NEUTRAL";

  return (
    <div className="page">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Trading Terminal</h1>
          <p className="page-sub">Paper-test or go live. Select a vault strategy to auto-load its recipe.</p>
        </div>
        <div style={{ display: "flex", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8, padding: 3, gap: 3 }}>
          <button onClick={() => setTradingMode("paper")} style={{
            padding: "6px 20px", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none",
            background: tradingMode === "paper" ? "var(--yellow)" : "transparent",
            color: tradingMode === "paper" ? "#fff" : "var(--text-muted)", transition: "all .15s",
          }}>PAPER</button>
          <button onClick={() => setTradingMode("live")} style={{
            padding: "6px 20px", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none",
            background: tradingMode === "live" ? "var(--red)" : "transparent",
            color: tradingMode === "live" ? "#fff" : "var(--text-muted)", transition: "all .15s",
          }}>LIVE</button>
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

      {/* ── Market Feed Panel ─────────────────────────────────────── */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 20, height: 360 }}>

          {/* Left: controls */}
          <div style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)" }}>Market Feed</span>
              <div style={{ display: "flex", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, padding: 2, gap: 2 }}>
                {(["live", "replay"] as const).map((m) => (
                  <button key={m} onClick={() => { setFeedMode(m); setFeedConfigured(false); }} style={{
                    padding: "3px 12px", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none",
                    background: feedMode === m ? (m === "live" ? "var(--green)" : "var(--accent)") : "transparent",
                    color: feedMode === m ? "#fff" : "var(--text-muted)", transition: "all .15s",
                    textTransform: "uppercase",
                  }}>{m}</button>
                ))}
              </div>
            </div>

            {/* Underlying + Interval */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <span className="label">Underlying</span>
                <select className="input" value={feedUnderlying} onChange={(e) => { setFeedUnderlying(e.target.value); setFeedConfigured(false); }}>
                  {UNDERLYINGS.map((u) => <option key={u}>{u}</option>)}
                </select>
              </div>
              <div>
                <span className="label">Interval</span>
                <select className="input" value={feedInterval} onChange={(e) => { setFeedInterval(e.target.value); setFeedConfigured(false); }}>
                  {INTERVALS.map((i) => <option key={i}>{i}</option>)}
                </select>
              </div>
            </div>

            {/* Replay-only controls */}
            {feedMode === "replay" && (
              <>
                <div>
                  <span className="label">Start Date / Time</span>
                  <input type="datetime-local" className="input" value={replayStartDt}
                    onChange={(e) => { setReplayStartDt(e.target.value); setFeedConfigured(false); }} />
                </div>
                <div>
                  <span className="label">Speed (candles / sec)</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    {SPEEDS.map((s) => (
                      <button key={s} onClick={() => setReplaySpeed(s)} style={{
                        flex: 1, padding: "4px 0", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer",
                        border: `1px solid ${replaySpeed === s ? "var(--accent)" : "var(--border)"}`,
                        background: replaySpeed === s ? "rgba(37,99,235,.2)" : "var(--bg-elevated)",
                        color: replaySpeed === s ? "var(--accent-hi)" : "var(--text-muted)",
                      }}>{s}×</button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Configure button */}
            <button
              className="btn btn-primary btn-sm"
              style={{ justifyContent: "center" }}
              disabled={configureMutation.isPending || (feedMode === "replay" && !replayStartDt)}
              onClick={() => configureMutation.mutate()}
            >
              {configureMutation.isPending ? "Configuring…" : feedConfigured ? "Reconfigure" : "Configure Feed"}
            </button>

            {/* Replay playback controls */}
            {feedMode === "replay" && feedConfigured && (
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-sm" style={{ flex: 1, justifyContent: "center", background: "rgba(5,150,105,.15)", border: "1px solid var(--green)", color: "var(--green-hi)", fontWeight: 700 }}
                  disabled={isPlaying}
                  onClick={() => playMutation.mutate()}>
                  {replayState === "ended" ? "Restart" : "Play"}
                </button>
                <button className="btn btn-sm" style={{ flex: 1, justifyContent: "center" }}
                  disabled={!isPlaying}
                  onClick={() => pauseMutation.mutate()}>Pause</button>
                <button className="btn btn-ghost btn-sm" style={{ flex: 1, justifyContent: "center" }}
                  onClick={() => resetMutation_feed.mutate()}>Reset</button>
              </div>
            )}

            {configureMutation.isError && (
              <p style={{ fontSize: 11, color: "var(--red-hi)", margin: 0 }}>
                ✗ {(configureMutation.error as Error)?.message}
              </p>
            )}

            {/* Current quote snapshot */}
            {feed?.quote && currentLtp > 0 && (
              <div style={{ background: "var(--bg-elevated)", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, color: "var(--text)", fontSize: 13 }}>
                    {feed.underlying}
                  </span>
                  <span style={{ fontWeight: 800, fontSize: 16, color: "var(--accent-hi)" }}>
                    {currentLtp.toFixed(2)}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4, color: "var(--text-muted)" }}>
                  <span>O <span style={{ color: "var(--text)" }}>{feed.quote.open.toFixed(2)}</span></span>
                  <span>H <span style={{ color: "var(--green-hi)" }}>{feed.quote.high.toFixed(2)}</span></span>
                  <span>L <span style={{ color: "var(--red-hi)" }}>{feed.quote.low.toFixed(2)}</span></span>
                  <span>C <span style={{ color: "var(--text)" }}>{feed.quote.close.toFixed(2)}</span></span>
                </div>
                {feedMode === "replay" && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)" }}>
                    {replayState === "playing" && <span style={{ color: "var(--green-hi)" }}>● Playing {replaySpeed}×</span>}
                    {replayState === "paused"  && <span style={{ color: "var(--yellow)" }}>⏸ Paused</span>}
                    {replayState === "ended"   && <span style={{ color: "var(--text-muted)" }}>■ Ended</span>}
                    {replayState === "idle"    && <span style={{ color: "var(--text-dim)" }}>○ Ready</span>}
                    &nbsp;·&nbsp;{new Date(feed.quote.timestamp).toLocaleString()}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: chart fills all remaining width and height */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>
                {feed?.underlying ?? feedUnderlying} · {feed?.interval ?? feedInterval}
                {feed?.history?.length ? ` · last ${feed.history.length} candles` : ""}
              </span>
              {feedMode === "live" && (
                <span style={{ fontSize: 10, color: "var(--text-dim)" }}>auto-refreshes every 5s</span>
              )}
            </div>
            <div ref={chartContainerRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
              {(!feed?.history?.length) && (
                <div style={{
                  position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  pointerEvents: "none", fontSize: 12, color: "var(--text-dim)", zIndex: 1,
                }}>
                  {feedConfigured ? "No candle history for selected range" : "Configure feed to see chart"}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Strategy Monitor ─────────────────────────────────────── */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>

          {/* Title + strategy selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "1 1 300px" }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)", whiteSpace: "nowrap" }}>
              Strategy Monitor
            </span>
            <select
              className="input"
              style={{ flex: 1, minWidth: 0 }}
              value={monitorStrategyId}
              onChange={(e) => setMonitorStrategyId(e.target.value)}
            >
              <option value="">— Select strategy —</option>
              {strategies.data?.strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.is_frozen ? "🔒 " : ""}{s.name} ({s.underlying})
                </option>
              ))}
            </select>
          </div>

          {/* Poll interval */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap" }}>Poll every</span>
            {MONITOR_INTERVALS.map(({ label, ms }) => (
              <button key={ms} onClick={() => setMonitorIntervalMs(ms)} style={{
                padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${monitorIntervalMs === ms ? "var(--accent)" : "var(--border)"}`,
                background: monitorIntervalMs === ms ? "rgba(37,99,235,.2)" : "var(--bg-elevated)",
                color: monitorIntervalMs === ms ? "var(--accent-hi)" : "var(--text-muted)",
              }}>{label}</button>
            ))}
          </div>

          {/* Verdict display */}
          {monitorStrategyId && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0, marginLeft: "auto" }}>
              {monitor?.reason && (
                <span style={{ fontSize: 11, color: "var(--text-dim)", maxWidth: 220 }}>{monitor.reason}</span>
              )}
              {monitor && !monitor.reason && (
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {monitor.candles_used} candles · close {monitor.close.toFixed(2)}
                  {monitor.timestamp && (
                    <span style={{ marginLeft: 8, color: "var(--text-dim)" }}>
                      @ {new Date(monitor.timestamp + "Z").toLocaleTimeString()}
                    </span>
                  )}
                </div>
              )}
              <div style={{
                padding: "6px 20px",
                borderRadius: 6,
                fontWeight: 800,
                fontSize: 15,
                letterSpacing: 1,
                background: verdict === "LONG"  ? "rgba(5,150,105,.2)"  :
                            verdict === "SHORT" ? "rgba(220,38,38,.2)"   : "rgba(100,116,139,.15)",
                border: `2px solid ${verdict === "LONG"  ? "var(--green)"  :
                                     verdict === "SHORT" ? "var(--red)"    : "var(--border)"}`,
                color: verdict === "LONG"  ? "var(--green-hi)"  :
                       verdict === "SHORT" ? "var(--red-hi)"    : "var(--text-muted)",
                minWidth: 80,
                textAlign: "center",
              }}>
                {verdict}
              </div>
            </div>
          )}

          {!monitorStrategyId && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: "auto" }}>
              Select a strategy to start monitoring
            </span>
          )}
        </div>
      </div>

      {/* ── Main grid: order form + positions/orders ───────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
        {/* Order Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span className="section-header" style={{ margin: 0 }}>Place Order</span>
              {monitorStrategyId && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{
                    padding: "2px 10px", borderRadius: 4, fontWeight: 800, fontSize: 12,
                    background: verdict === "LONG"  ? "rgba(5,150,105,.2)"  :
                                verdict === "SHORT" ? "rgba(220,38,38,.2)"   : "rgba(100,116,139,.15)",
                    border: `1px solid ${verdict === "LONG"  ? "var(--green)"  :
                                         verdict === "SHORT" ? "var(--red)"    : "var(--border)"}`,
                    color: verdict === "LONG"  ? "var(--green-hi)"  :
                           verdict === "SHORT" ? "var(--red-hi)"    : "var(--text-muted)",
                  }}>{verdict}</span>
                </div>
              )}
            </div>

            {/* Auto-trade toggle */}
            {monitorStrategyId && (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginBottom: 12, padding: "7px 10px", borderRadius: 6,
                background: autoTradeOn
                  ? (autoTradeStatus?.status === "in_long" ? "rgba(5,150,105,.12)"
                    : autoTradeStatus?.status === "in_short" ? "rgba(220,38,38,.12)"
                    : "rgba(37,99,235,.1)")
                  : "var(--bg-elevated)",
                border: `1px solid ${autoTradeOn
                  ? (autoTradeStatus?.status === "in_long" ? "var(--green)"
                    : autoTradeStatus?.status === "in_short" ? "var(--red)"
                    : "var(--accent)")
                  : "var(--border)"}`,
              }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: autoTradeOn ? "var(--accent-hi)" : "var(--text-muted)" }}>
                    AUTO TRADE {autoTradeOn ? "ON" : "OFF"}
                  </span>
                  {autoTradeOn && autoTradeStatus && (
                    <span style={{ fontSize: 10, color:
                      autoTradeStatus.status === "in_long" ? "var(--green-hi)"
                      : autoTradeStatus.status === "in_short" ? "var(--red-hi)"
                      : "var(--text-dim)" }}>
                      {autoTradeStatus.status === "in_long"
                        ? `LONG · ${autoTradeStatus.open_legs.join(", ")}`
                        : autoTradeStatus.status === "in_short"
                          ? `SHORT · ${autoTradeStatus.open_legs.join(", ")}`
                          : "watching for directional signal…"}
                    </span>
                  )}
                  {autoTradeOn && autoTradeStatus?.last_action && (
                    <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                      last: {autoTradeStatus.last_action}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => {
                    if (autoTradeOn) {
                      autoTradeDisableMutation.mutate();
                    } else {
                      autoTradeEnableMutation.mutate();
                    }
                  }}
                  disabled={autoTradeEnableMutation.isPending || autoTradeDisableMutation.isPending}
                  style={{
                    padding: "4px 12px", borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: "pointer",
                    border: `1px solid ${autoTradeOn ? "var(--red)" : "var(--green)"}`,
                    background: autoTradeOn ? "rgba(220,38,38,.15)" : "rgba(5,150,105,.15)",
                    color: autoTradeOn ? "var(--red-hi)" : "var(--green-hi)",
                  }}
                >
                  {autoTradeOn ? "Stop" : "Start"}
                </button>
              </div>
            )}

            <span className="label">Symbol</span>
            <div ref={symbolBoxRef} style={{ position: "relative", marginBottom: symbol ? 4 : 12 }}>
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  className="input mono"
                  placeholder="Search symbol, name or token…"
                  value={symbolQuery || symbol}
                  onChange={(e) => {
                    setSymbolQuery(e.target.value);
                    if (e.target.value !== symbol) setSymbol("");
                    setShowSymbolDrop(true);
                  }}
                  onFocus={() => setShowSymbolDrop(true)}
                  style={{ flex: 1 }}
                />
                {symbol && (
                  <button onClick={() => { setSymbol(""); setSymbolQuery(""); }} style={{
                    padding: "0 8px", borderRadius: 4, fontSize: 12, cursor: "pointer",
                    border: "1px solid var(--border)", background: "var(--bg-elevated)",
                    color: "var(--text-muted)",
                  }}>✕</button>
                )}
              </div>

              {/* Selected chip */}
              {symbol && (
                <div style={{ fontSize: 11, color: "var(--accent-hi)", fontWeight: 700, fontFamily: "monospace", padding: "3px 0 6px" }}>
                  ✓ {symbol}
                </div>
              )}

              {/* Search dropdown */}
              {showSymbolDrop && symbolQuery.length > 0 && (
                <div style={{
                  position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50,
                  background: "var(--bg-card)", border: "1px solid var(--border)",
                  borderRadius: 6, maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 24px #0006",
                }}>
                  {instrumentSearchQuery.isLoading && (
                    <div style={{ padding: 10, fontSize: 11, color: "var(--text-dim)" }}>Searching…</div>
                  )}
                  {instrumentSearchQuery.data?.items.length === 0 && (
                    <div style={{ padding: 10, fontSize: 11, color: "var(--text-dim)" }}>No matches</div>
                  )}
                  {instrumentSearchQuery.data?.items.map((row) => (
                    <div
                      key={row.instrument_token}
                      onMouseDown={() => {
                        setSymbol(row.tradingsymbol);
                        setSymbolQuery("");
                        setShowSymbolDrop(false);
                        if (row.lot_size) setQty(row.lot_size);
                      }}
                      style={{
                        padding: "7px 10px", cursor: "pointer", borderBottom: "1px solid var(--border-dim)",
                        background: symbol === row.tradingsymbol ? "rgba(37,99,235,.15)" : "transparent",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(37,99,235,.1)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = symbol === row.tradingsymbol ? "rgba(37,99,235,.15)" : "transparent")}
                    >
                      <div style={{ fontWeight: 700, fontFamily: "monospace", fontSize: 11, color: "var(--accent-hi)" }}>
                        {row.tradingsymbol}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                        {row.name ?? "—"} · {row.instrument_type}
                        {row.strike ? ` · ${row.strike}` : ""}
                        {row.expiry ? ` · ${row.expiry}` : ""}
                        {row.lot_size ? ` · lot ${row.lot_size}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Strategy suggestions — only shown when the monitor has an actionable verdict */}
            {verdict !== "NEUTRAL" && suggestionsQuery.data?.suggestions && suggestionsQuery.data.suggestions.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <span style={{ fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>
                  Suggested · {suggestionsQuery.data.underlying} · expiry {suggestionsQuery.data.expiry}
                  {suggestionsQuery.data.spot > 0 ? ` · spot ${suggestionsQuery.data.spot.toFixed(0)} · ATM ${suggestionsQuery.data.atm_strike}` : ""}
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {suggestionsQuery.data.suggestions.map((s) => (
                    <button
                      key={s.tradingsymbol}
                      onClick={() => { setSymbol(s.tradingsymbol); setSymbolQuery(""); setSide(s.action as "BUY" | "SELL"); if (s.lot_size) setQty(s.lot_size); }}
                      style={{
                        textAlign: "left", padding: "5px 8px", borderRadius: 5, fontSize: 11,
                        cursor: "pointer", border: `1px solid ${s.action === "BUY" ? "var(--green)" : "var(--red)"}22`,
                        background: s.action === "BUY" ? "rgba(5,150,105,.08)" : "rgba(220,38,38,.08)",
                        color: "var(--text)",
                      }}
                    >
                      <span style={{ fontWeight: 700, fontFamily: "monospace", color: "var(--accent-hi)" }}>{s.tradingsymbol}</span>
                      <span style={{ marginLeft: 8, color: s.action === "BUY" ? "var(--green-hi)" : "var(--red-hi)", fontWeight: 700 }}>{s.action}</span>
                      <span style={{ marginLeft: 6, color: "var(--text-muted)" }}>{formatStrikeRef(s.strike_ref)} · {s.lots} lot{s.lots > 1 ? "s" : ""}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

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
                <span className="label">
                  Price (0=market)
                  {currentLtp > 0 && (
                    <button
                      onClick={() => setPrice(currentLtp)}
                      style={{
                        marginLeft: 6, padding: "1px 6px", borderRadius: 3, fontSize: 10,
                        fontWeight: 700, cursor: "pointer", border: "1px solid var(--accent)",
                        background: "rgba(37,99,235,.15)", color: "var(--accent-hi)",
                        verticalAlign: "middle",
                      }}
                    >
                      LTP {currentLtp.toFixed(0)}
                    </button>
                  )}
                </span>
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
            {/* Total P&L with realized/unrealized breakdown */}
            <div className="card stat-card">
              <div className="stat-label">Total P&L</div>
              <div className="stat-value" style={{ color: totalPnl >= 0 ? "var(--green-hi)" : "var(--red-hi)", fontSize: 20 }}>
                ₹{totalPnl.toFixed(2)}
              </div>
              {tradingMode === "paper" && (pnl.data?.realized_pnl !== 0 || pnl.data?.unrealized_pnl !== 0) && (
                <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                    R: <span style={{ color: (pnl.data?.realized_pnl ?? 0) >= 0 ? "var(--green-hi)" : "var(--red-hi)" }}>
                      ₹{(pnl.data?.realized_pnl ?? 0).toFixed(0)}
                    </span>
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                    U: <span style={{ color: (pnl.data?.unrealized_pnl ?? 0) >= 0 ? "var(--green-hi)" : "var(--red-hi)" }}>
                      ₹{(pnl.data?.unrealized_pnl ?? 0).toFixed(0)}
                    </span>
                  </span>
                </div>
              )}
            </div>
            {[
              { label: "Open Positions", value: String(pnl.data?.positions ?? 0),   color: "var(--text)" },
              { label: "Pending Orders", value: String(pnl.data?.open_orders ?? 0), color: "var(--text)" },
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
                <thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>LTP</th><th>Unrealised P&L</th><th></th></tr></thead>
                <tbody>
                  {positions.data?.positions.map((p, i) => {
                    const isAutoLeg = autoTradeStatus?.open_legs?.includes(p.tradingsymbol) ?? false;
                    return (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {p.tradingsymbol}
                        {isAutoLeg && (
                          <span style={{ marginLeft: 5, fontSize: 9, padding: "1px 4px", borderRadius: 3,
                            background: "rgba(37,99,235,.2)", color: "var(--accent-hi)", fontWeight: 700 }}>AUTO</span>
                        )}
                      </td>
                      <td className="mono">{p.quantity}</td>
                      <td className="mono">{p.avg_price.toFixed(2)}</td>
                      <td className="mono">{p.ltp.toFixed(2)}</td>
                      <td className={`mono ${p.unrealised_pnl >= 0 ? "pos" : "neg"}`}>₹{p.unrealised_pnl.toFixed(2)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {confirmClose === p.tradingsymbol ? (
                          <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                            <button
                              onClick={() => closeMutation.mutate(p.tradingsymbol)}
                              disabled={closeMutation.isPending}
                              style={{
                                padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800,
                                cursor: "pointer", border: "1px solid var(--red)",
                                background: "rgba(220,38,38,.25)", color: "var(--red-hi)",
                              }}
                            >{closeMutation.isPending ? "…" : "Confirm"}</button>
                            <button
                              onClick={() => setConfirmClose(null)}
                              style={{
                                padding: "2px 6px", borderRadius: 4, fontSize: 10,
                                cursor: "pointer", border: "1px solid var(--border)",
                                background: "var(--bg-elevated)", color: "var(--text-muted)",
                              }}
                            >✕</button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmClose(p.tradingsymbol)}
                            style={{
                              padding: "2px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                              cursor: "pointer", border: "1px solid var(--border)",
                              background: "var(--bg-elevated)", color: "var(--text-muted)",
                            }}
                          >Close</button>
                        )}
                      </td>
                    </tr>
                  );})}
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
