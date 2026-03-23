"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatStrikeRef } from "@/lib/strikeLabels";
import { createChart, AreaSeries, CandlestickSeries, createSeriesMarkers, type IChartApi } from "lightweight-charts";

type Strategy = {
  id: string;
  name: string;
  underlying: string;
  version: number;
  param_ranges?: Record<string, unknown[]>;
};

type FullStrategy = Strategy & {
  params?: Record<string, unknown>;
  structure?: {
    legs?: Array<{ action: string; option_type: string; strike: string; lots: number }>;
  };
  exit_conditions?: Array<{ type: string; value?: unknown }>;
  indicators?: Array<{ name: string; type: string; params?: Record<string, unknown> }>;
};

type OptimizerRun = {
  id: string;
  strategy_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  mode: string;
  interval: string;
  best_sharpe: number | null;
  best_params_json: string | null;
};

type DataRange = {
  from_date: string;
  to_date: string;
  bar_count: number;
};

type TradeCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type Trade = {
  entry_bar: number;
  exit_bar: number;
  entry_time?: string;
  exit_time?: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  bars_held: number;
  entry_offset?: number;
  exit_offset?: number;
  candles?: TradeCandle[];
};

const METRICS_DEF = [
  { key: "sharpe",        label: "Sharpe",        fmt: (v: number) => v?.toFixed(2),                       color: (v: number) => v > 1 ? "var(--green-hi)" : v > 0 ? "var(--yellow-hi)" : "var(--red-hi)" },
  { key: "sortino",       label: "Sortino",        fmt: (v: number) => v?.toFixed(2),                       color: () => "var(--text)" },
  { key: "cagr",          label: "CAGR",           fmt: (v: number) => `${((v ?? 0) * 100).toFixed(1)}%`,  color: (v: number) => v > 0 ? "var(--green-hi)" : "var(--red-hi)" },
  { key: "max_drawdown",  label: "Max DD",          fmt: (v: number) => `${((v ?? 0) * 100).toFixed(1)}%`,  color: () => "var(--red-hi)" },
  { key: "calmar",        label: "Calmar",          fmt: (v: number) => v?.toFixed(2),                       color: () => "var(--text)" },
  { key: "win_rate",      label: "Win Rate",        fmt: (v: number) => `${((v ?? 0) * 100).toFixed(1)}%`,  color: (v: number) => v >= 0.5 ? "var(--green-hi)" : "var(--yellow-hi)" },
  { key: "profit_factor", label: "Profit Factor",   fmt: (v: number) => v?.toFixed(2),                       color: (v: number) => v > 1 ? "var(--green-hi)" : "var(--red-hi)" },
  { key: "total_trades",  label: "Trades",          fmt: (v: number) => String(v),                           color: () => "var(--text)" },
  { key: "avg_trade",     label: "Avg Trade",       fmt: (v: number) => `₹${v?.toFixed(0)}`,                color: (v: number) => v >= 0 ? "var(--green-hi)" : "var(--red-hi)" },
  { key: "total_pnl",     label: "Total P&L",       fmt: (v: number) => `₹${v?.toFixed(0)}`,                color: (v: number) => v >= 0 ? "var(--green-hi)" : "var(--red-hi)" },
];

const STAGES = [
  { label: "Resolving underlying instrument",  detail: "Looking up token from instruments table" },
  { label: "Loading candle data from DB",      detail: "Querying historical OHLCV data" },
  { label: "Compiling entry / exit signals",   detail: "Evaluating indicators and conditions on each bar" },
  { label: "Simulating trades bar-by-bar",     detail: "Applying exits: target, stop-loss, max holding" },
  { label: "Computing options P&L (B-S)",      detail: "Black-Scholes premium on each leg" },
  { label: "Calculating performance metrics",  detail: "Sharpe, CAGR, drawdown, win rate…" },
];

const MODE_LABELS: Record<string, string> = {
  grid: "Grid",
  random: "Random",
  walk_forward: "Walk-Forward",
  successive_halving: "Halving",
};

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function EquityChart({ data }: { data: number[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current || !data.length) return;

    if (chart.current) {
      try { chart.current.remove(); } catch { /* already removed */ }
      chart.current = null;
    }

    const initialCapital = data[0];

    const c = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 240,
      layout: { background: { color: "transparent" }, textColor: "#4d6b8a" },
      grid: { vertLines: { color: "#1a284044" }, horzLines: { color: "#1a284044" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: false },
    });

    // Equity curve
    const s = c.addSeries(AreaSeries, {
      lineColor: "#2563eb",
      topColor: "rgba(37,99,235,0.3)",
      bottomColor: "rgba(37,99,235,0.02)",
      lineWidth: 2,
    });
    s.setData(data.map((value, i) => ({ time: (1609459200 + i * 86400) as unknown as string, value })));

    // Starting capital baseline
    const baseline = c.addSeries(AreaSeries, {
      lineColor: "rgba(100,120,150,0.45)",
      topColor: "transparent",
      bottomColor: "transparent",
      lineWidth: 1,
      lineStyle: 2, // dashed
    });
    baseline.setData([
      { time: 1609459200 as unknown as string, value: initialCapital },
      { time: (1609459200 + (data.length - 1) * 86400) as unknown as string, value: initialCapital },
    ]);

    c.timeScale().fitContent();
    chart.current = c;

    const onResize = () => ref.current && c.applyOptions({ width: ref.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      try { c.remove(); } catch { /* already removed */ }
      chart.current = null;
    };
  }, [data]);

  // Show starting capital label
  const initialCapital = data[0];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
          Starting capital: <span className="mono" style={{ color: "var(--accent-hi)" }}>₹{initialCapital?.toLocaleString("en-IN")}</span>
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
          Final equity: <span className="mono" style={{ color: data[data.length - 1] >= initialCapital ? "var(--green-hi)" : "var(--red-hi)" }}>
            ₹{data[data.length - 1]?.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
          </span>
        </span>
      </div>
      <div ref={ref} />
    </div>
  );
}

function TradeDetailChart({ trade }: { trade: Trade }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !trade.candles?.length) return;

    const c = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 220,
      layout: { background: { color: "transparent" }, textColor: "#4d6b8a" },
      grid: { vertLines: { color: "#1a284044" }, horzLines: { color: "#1a284044" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
    });

    const cs = c.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    cs.setData(trade.candles.map((d) => ({
      time: d.time as unknown as string,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
    })));

    // Entry and exit markers
    const markers = [];
    if (trade.entry_offset != null && trade.candles[trade.entry_offset]) {
      markers.push({
        time: trade.candles[trade.entry_offset].time as unknown as string,
        position: "belowBar" as const,
        color: "#22c55e",
        shape: "arrowUp" as const,
        text: `Entry ₹${trade.entry_price.toFixed(0)}`,
        size: 1,
      });
    }
    if (trade.exit_offset != null && trade.candles[trade.exit_offset]) {
      const isProfit = trade.pnl >= 0;
      markers.push({
        time: trade.candles[trade.exit_offset].time as unknown as string,
        position: "aboveBar" as const,
        color: isProfit ? "#22c55e" : "#ef4444",
        shape: "arrowDown" as const,
        text: `Exit ${isProfit ? "+" : ""}₹${Math.round(trade.pnl)}`,
        size: 1,
      });
    }
    if (markers.length) {
      createSeriesMarkers(cs, markers);
    }

    c.timeScale().fitContent();

    const onResize = () => ref.current && c.applyOptions({ width: ref.current.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      try { c.remove(); } catch { /* already removed */ }
    };
  }, [trade]);

  if (!trade.candles?.length) return null;

  return (
    <div style={{
      marginTop: 12, padding: 14, borderRadius: 8,
      background: "var(--bg-elevated)", border: "1px solid var(--border)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 11 }}>
        <div style={{ display: "flex", gap: 16 }}>
          <span>
            <span style={{ color: "var(--text-muted)" }}>Entry: </span>
            <span style={{ color: "var(--green-hi)", fontWeight: 600 }}>
              {trade.entry_time ? trade.entry_time.replace("T", " ") : `Bar ${trade.entry_bar}`}
            </span>
            <span className="mono" style={{ color: "var(--text)", marginLeft: 6 }}>@ ₹{trade.entry_price.toFixed(1)}</span>
          </span>
          <span>
            <span style={{ color: "var(--text-muted)" }}>Exit: </span>
            <span style={{ color: trade.pnl >= 0 ? "var(--green-hi)" : "var(--red-hi)", fontWeight: 600 }}>
              {trade.exit_time ? trade.exit_time.replace("T", " ") : `Bar ${trade.exit_bar}`}
            </span>
            <span className="mono" style={{ color: "var(--text)", marginLeft: 6 }}>@ ₹{trade.exit_price.toFixed(1)}</span>
          </span>
          <span>
            <span style={{ color: "var(--text-muted)" }}>Held: </span>
            <span className="mono">{trade.bars_held} bars</span>
          </span>
        </div>
        <span className={`mono ${trade.pnl >= 0 ? "pos" : "neg"}`} style={{ fontWeight: 700, fontSize: 13 }}>
          {trade.pnl >= 0 ? "+" : ""}₹{Math.round(trade.pnl)}
        </span>
      </div>
      <div ref={ref} />
    </div>
  );
}

export default function BacktestPage() {
  const [strategyId, setStrategyId] = useState("");
  // Fixed: renamed from setInterval → setIntervalValue to avoid shadowing window.setInterval
  const [intervalVal, setIntervalValue] = useState("15m");
  const [stageIndex, setStageIndex] = useState(-1);
  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Optimizer preset
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [paramOverrides, setParamOverrides] = useState<Record<string, unknown> | null>(null);

  // Date range
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [result, setResult] = useState<{
    metrics: Record<string, number>;
    equity_curve: number[];
    trades: Trade[];
    date_from?: string;
    date_to?: string;
  } | null>(null);

  const [selectedTradeIdx, setSelectedTradeIdx] = useState<number | null>(null);

  // ── Data queries ──────────────────────────────────────────────────────────
  const strategies = useQuery({
    queryKey: ["strategies"],
    queryFn: () => api.get<{ strategies: Strategy[] }>("/api/vault/strategies"),
  });

  const fullStrategy = useQuery({
    queryKey: ["strategy", strategyId],
    queryFn: () =>
      strategyId
        ? api.get<{ strategy: FullStrategy }>(`/api/vault/strategies/${strategyId}`)
        : Promise.resolve(null),
    enabled: !!strategyId,
  });

  const selected = strategies.data?.strategies.find((s) => s.id === strategyId);
  const recipe = fullStrategy.data?.strategy;

  // Optimizer runs for selected strategy
  const optiRuns = useQuery({
    queryKey: ["optimizer-runs", strategyId],
    queryFn: () =>
      strategyId
        ? api.get<{ runs: OptimizerRun[] }>(
            `/api/optimizer/runs?strategy_id=${strategyId}&status=completed`
          )
        : Promise.resolve({ runs: [] }),
    enabled: !!strategyId,
  });

  // Available data range for selected strategy + interval
  const dataRange = useQuery({
    queryKey: ["data-range", selected?.underlying, intervalVal],
    queryFn: () =>
      selected
        ? api.get<DataRange>(
            `/api/backtest/data-range?underlying=${selected.underlying}&interval=${intervalVal}`
          )
        : Promise.resolve(null),
    enabled: !!selected,
  });

  // When data range loads, set default from/to
  useEffect(() => {
    if (dataRange.data) {
      setFromDate(dataRange.data.from_date);
      setToDate(dataRange.data.to_date);
    }
  }, [dataRange.data]);

  // When strategy changes, reset everything
  const handleStrategyChange = (id: string) => {
    setStrategyId(id);
    setResult(null);
    setStageIndex(-1);
    setSelectedRunId("");
    setParamOverrides(null);
    setFromDate("");
    setToDate("");
  };

  // When interval changes, reset dates and clear any optimizer preset
  useEffect(() => {
    setFromDate("");
    setToDate("");
    setSelectedRunId("");
    setParamOverrides(null);
  }, [intervalVal]);

  // When optimizer run is selected, load its params
  const handleRunSelect = (runId: string) => {
    setSelectedRunId(runId);
    if (!runId) {
      setParamOverrides(null);
      return;
    }
    const run = optiRuns.data?.runs.find((r) => r.id === runId);
    if (run?.best_params_json) {
      try {
        setParamOverrides(JSON.parse(run.best_params_json));
      } catch {
        setParamOverrides(null);
      }
    } else {
      setParamOverrides(null);
    }
  };

  // ── Backtest mutation ─────────────────────────────────────────────────────
  const backtestMutation = useMutation({
    mutationFn: async () => {
      const r = await api.get<{ strategy: Record<string, unknown> }>(`/api/vault/strategies/${strategyId}`);
      return api.post("/api/backtest/run", {
        recipe: r.strategy,
        interval: intervalVal,
        param_overrides: paramOverrides ?? undefined,
        from_date: fromDate || undefined,
        to_date: toDate || undefined,
        optimizer_run_id: selectedRunId || undefined,
      });
    },
    onSuccess: (data) => {
      clearStages();
      setStageIndex(STAGES.length);
      setResult(data as typeof result);
      setSelectedTradeIdx(null);
    },
    onError: () => {
      clearStages();
      setStageIndex(-1);
    },
  });

  function clearStages() {
    if (stageTimer.current) { clearInterval(stageTimer.current); stageTimer.current = null; }
  }

  function startStageAnimation() {
    clearStages();
    setStageIndex(0);
    let idx = 0;
    stageTimer.current = setInterval(() => {
      idx += 1;
      if (idx >= STAGES.length - 1) { clearStages(); setStageIndex(STAGES.length - 1); }
      else { setStageIndex(idx); }
    }, 1200);
  }

  function handleRun() {
    setResult(null);
    startStageAnimation();
    backtestMutation.mutate();
  }

  const isRunning = backtestMutation.isPending;
  const allCompletedRuns = optiRuns.data?.runs ?? [];
  // Filter to matching interval, then keep only best run per mode (highest sharpe)
  const completedRuns = Object.values(
    allCompletedRuns
      .filter((run) => run.interval === intervalVal)
      .reduce<Record<string, OptimizerRun>>((best, run) => {
        const prev = best[run.mode];
        if (!prev || (run.best_sharpe ?? -Infinity) > (prev.best_sharpe ?? -Infinity)) {
          best[run.mode] = run;
        }
        return best;
      }, {})
  );
  const selectedRun = completedRuns.find((r) => r.id === selectedRunId);

  const INTERVAL_LABELS: Record<string, string> = {
    "1m": "1 minute", "5m": "5 minute", "15m": "15 minute", "1h": "1 hour", "day": "Daily",
  };

  return (
    <div className="page">
      <div style={{ marginBottom: 20 }}>
        <h1 className="page-title">Backtester</h1>
        <p className="page-sub">
          Run a vectorized backtest on a vault strategy. Optionally use optimized parameters and restrict the date range.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16 }}>
        {/* ── Config panel ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div className="section-header">Run Config</div>

            {/* Strategy */}
            <span className="label">Strategy</span>
            <select
              className="input"
              style={{ marginBottom: 12 }}
              value={strategyId}
              onChange={(e) => handleStrategyChange(e.target.value)}
              disabled={isRunning}
            >
              <option value="">Select…</option>
              {strategies.data?.strategies.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.underlying})</option>
              ))}
            </select>

            {/* Interval */}
            <span className="label">Interval</span>
            <select
              className="input"
              style={{ marginBottom: 12 }}
              value={intervalVal}
              onChange={(e) => setIntervalValue(e.target.value)}
              disabled={isRunning}
            >
              <option value="1m">1 min</option>
              <option value="5m">5 min</option>
              <option value="15m">15 min</option>
              <option value="1h">1 hour</option>
              <option value="day">Daily</option>
            </select>

            {/* Optimizer preset */}
            {strategyId && (
              <>
                <span className="label">Optimizer Preset</span>
                <select
                  className="input"
                  style={{ marginBottom: completedRuns.length > 0 ? 8 : 12 }}
                  value={selectedRunId}
                  onChange={(e) => handleRunSelect(e.target.value)}
                  disabled={isRunning}
                >
                  <option value="">— Default params (from vault) —</option>
                  {completedRuns.map((run) => (
                    <option key={run.id} value={run.id}>
                      {MODE_LABELS[run.mode] ?? run.mode} · {run.interval}
                      {run.best_sharpe != null ? ` · Sharpe ${run.best_sharpe.toFixed(2)}` : ""}
                      {" · "}{run.completed_at ? fmtDate(run.completed_at.slice(0, 10)) : "—"}
                    </option>
                  ))}
                </select>

                {/* Show applied params when preset selected */}
                {paramOverrides && Object.keys(paramOverrides).length > 0 && (
                  <div style={{
                    marginBottom: 12, padding: "6px 10px", borderRadius: 6,
                    background: "rgba(217,119,6,.1)", border: "1px solid rgba(217,119,6,.25)",
                    fontSize: 11,
                  }}>
                    <div style={{ color: "var(--yellow-hi)", fontWeight: 600, marginBottom: 4 }}>
                      ✓ Optimizer params applied
                    </div>
                    {Object.entries(paramOverrides).map(([k, v]) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "var(--text-muted)" }}>{k}</span>
                        <span className="mono" style={{ color: "var(--text)" }}>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {completedRuns.length === 0 && !optiRuns.isLoading && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>
                    No completed optimizer runs yet for this strategy.
                  </div>
                )}
              </>
            )}

            {/* Date range */}
            {dataRange.data && (
              <>
                <span className="label">Date Range</span>
                <div style={{
                  fontSize: 11, color: "var(--text-muted)", marginBottom: 6,
                  padding: "4px 8px", background: "var(--bg-elevated)", borderRadius: 4,
                }}>
                  Available: {fmtDate(dataRange.data.from_date)} → {fmtDate(dataRange.data.to_date)}
                  <span style={{ color: "var(--accent-hi)" }}>
                    {" "}· {dataRange.data.bar_count.toLocaleString()} bars
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3 }}>From</div>
                    <input
                      type="date"
                      className="input"
                      style={{ padding: "5px 8px", fontSize: 11 }}
                      value={fromDate}
                      min={dataRange.data.from_date}
                      max={toDate || dataRange.data.to_date}
                      onChange={(e) => setFromDate(e.target.value)}
                      disabled={isRunning}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3 }}>To</div>
                    <input
                      type="date"
                      className="input"
                      style={{ padding: "5px 8px", fontSize: 11 }}
                      value={toDate}
                      min={fromDate || dataRange.data.from_date}
                      max={dataRange.data.to_date}
                      onChange={(e) => setToDate(e.target.value)}
                      disabled={isRunning}
                    />
                  </div>
                </div>
                {fromDate && toDate && (
                  <button
                    style={{
                      fontSize: 10, color: "var(--text-muted)", background: "none",
                      border: "none", cursor: "pointer", marginBottom: 8, padding: 0,
                    }}
                    onClick={() => { setFromDate(dataRange.data!.from_date); setToDate(dataRange.data!.to_date); }}
                  >
                    ↺ Reset to full range
                  </button>
                )}
              </>
            )}

            <button
              className="btn btn-success"
              style={{ width: "100%", justifyContent: "center" }}
              disabled={!strategyId || isRunning}
              onClick={handleRun}
            >
              {isRunning ? <><span className="spinner" /> Running…</> : result ? "Run Again" : "Run Backtest"}
            </button>
            {backtestMutation.isError && (
              <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--red-hi)" }}>
                ✗ {(backtestMutation.error as Error)?.message}
              </p>
            )}
          </div>

          {/* ── Execution Plan card ── */}
          {selected && (
            <div className="card" style={{ padding: 14 }}>
              <div className="section-header" style={{ marginBottom: 10 }}>Execution Plan</div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <PlanRow label="Strategy" value={`${selected.name} v${selected.version}`} />
                <PlanRow label="Underlying" value={selected.underlying} accent />
                <PlanRow label="Interval" value={INTERVAL_LABELS[intervalVal] ?? intervalVal} />
                {fromDate && toDate && fromDate !== dataRange.data?.from_date && (
                  <PlanRow
                    label="Period"
                    value={`${fmtDate(fromDate)} → ${fmtDate(toDate)}`}
                  />
                )}
                {selectedRun && (
                  <PlanRow
                    label="Params from"
                    value={`${MODE_LABELS[selectedRun.mode] ?? selectedRun.mode} optimizer`}
                    accent
                  />
                )}

                {/* Legs */}
                {recipe?.structure?.legs && recipe.structure.legs.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                      Options Legs
                    </div>
                    {recipe.structure.legs.map((leg, i) => (
                      <div key={i} style={{
                        fontSize: 11, fontFamily: "monospace", padding: "3px 8px",
                        background: "var(--bg-elevated)", borderRadius: 4, marginBottom: 3,
                        color: leg.action === "BUY" ? "var(--green-hi)" : "var(--red-hi)",
                      }}>
                        {leg.action} {leg.option_type} {formatStrikeRef(leg.strike)} × {leg.lots}L
                      </div>
                    ))}
                  </div>
                )}

                {/* Exit conditions */}
                {recipe?.exit_conditions && recipe.exit_conditions.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                      Exit Conditions
                    </div>
                    {recipe.exit_conditions.map((ec, i) => (
                      <div key={i} style={{
                        fontSize: 11, fontFamily: "monospace", padding: "3px 8px",
                        background: "var(--bg-elevated)", borderRadius: 4, marginBottom: 3,
                        color: "var(--text-muted)",
                      }}>
                        {ec.type}{ec.value !== undefined ? ` = ${ec.value}` : ""}
                      </div>
                    ))}
                  </div>
                )}

                {/* Active params — show overrides if present, else vault params */}
                {(() => {
                  const activeParams = paramOverrides && Object.keys(paramOverrides).length > 0
                    ? paramOverrides
                    : recipe?.params && Object.keys(recipe.params).length > 0
                      ? recipe.params
                      : null;
                  return activeParams ? (
                    <div style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                        Parameters {paramOverrides ? "(optimizer)" : "(vault)"}
                      </div>
                      {Object.entries(activeParams).map(([k, v]) => (
                        <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
                          <span style={{ color: "var(--text-muted)" }}>{k}</span>
                          <span className="mono" style={{ color: paramOverrides ? "var(--yellow-hi)" : "var(--accent-hi)" }}>{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null;
                })()}
              </div>
            </div>
          )}
        </div>

        {/* ── Main area ── */}
        <div>
          {!selected && !result && (
            <div className="card" style={{ padding: 40, textAlign: "center" }}>
              <p style={{ color: "var(--text-muted)" }}>Select a strategy to see the execution plan.</p>
            </div>
          )}

          {/* ── Stage timeline ── */}
          {selected && (isRunning || stageIndex >= 0) && !result && (
            <div className="card" style={{ padding: 20, marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div className="section-header" style={{ margin: 0 }}>Execution Stages</div>
                {isRunning && (
                  <span style={{ fontSize: 11, color: "var(--accent-hi)", display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
                    running
                  </span>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {STAGES.map((stage, i) => {
                  const done = i < stageIndex;
                  const active = i === stageIndex && isRunning;
                  const pending = i > stageIndex;
                  return (
                    <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 20 }}>
                        <div style={{
                          width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 10, fontWeight: 700,
                          background: done ? "var(--green-hi)" : active ? "var(--accent-hi)" : "var(--bg-elevated)",
                          border: `1.5px solid ${done ? "var(--green-hi)" : active ? "var(--accent-hi)" : "var(--border)"}`,
                          color: done || active ? "#000" : "var(--text-muted)",
                          zIndex: 1,
                        }}>
                          {done ? "✓" : active
                            ? <span className="spinner" style={{ width: 8, height: 8, borderWidth: 1.5, borderColor: "transparent", borderTopColor: "#000" }} />
                            : <span style={{ fontSize: 9 }}>{i + 1}</span>}
                        </div>
                        {i < STAGES.length - 1 && (
                          <div style={{
                            width: 1.5, flex: 1, minHeight: 16,
                            background: done ? "var(--green-hi)" : "var(--border)",
                            margin: "2px 0",
                          }} />
                        )}
                      </div>
                      <div style={{ paddingBottom: i < STAGES.length - 1 ? 14 : 0, paddingTop: 1 }}>
                        <div style={{
                          fontSize: 13, fontWeight: active ? 600 : 500,
                          color: done ? "var(--text)" : active ? "var(--accent-hi)" : pending ? "var(--text-muted)" : "var(--text)",
                        }}>
                          {stage.label}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                          {stage.detail}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Results ── */}
          {result && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Period banner */}
              {(result.date_from || selectedRun) && (
                <div style={{
                  padding: "8px 14px", borderRadius: 8,
                  background: "rgba(37,99,235,.07)", border: "1px solid rgba(37,99,235,.2)",
                  fontSize: 12, display: "flex", gap: 16, flexWrap: "wrap",
                }}>
                  {result.date_from && (
                    <span>
                      <span style={{ color: "var(--text-muted)" }}>Tested: </span>
                      <span style={{ color: "var(--accent-hi)", fontWeight: 600 }}>
                        {fmtDate(result.date_from)} → {fmtDate(result.date_to)}
                      </span>
                    </span>
                  )}
                  {selectedRun && (
                    <span>
                      <span style={{ color: "var(--text-muted)" }}>Params from: </span>
                      <span style={{ color: "var(--yellow-hi)", fontWeight: 600 }}>
                        {MODE_LABELS[selectedRun.mode] ?? selectedRun.mode} optimizer
                        {selectedRun.best_sharpe != null ? ` (opt Sharpe ${selectedRun.best_sharpe.toFixed(2)})` : ""}
                      </span>
                    </span>
                  )}
                </div>
              )}

              {/* Metrics */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
                {METRICS_DEF.map(({ key, label, fmt, color }) => (
                  <div key={key} className="card stat-card">
                    <div className="stat-label">{label}</div>
                    <div className="stat-value" style={{ fontSize: 18, color: color(result.metrics[key] ?? 0) }}>
                      {fmt(result.metrics[key] ?? 0)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Equity curve */}
              <div className="card" style={{ padding: 16 }}>
                <div className="section-header">Equity Curve</div>
                <EquityChart data={result.equity_curve} />
              </div>

              {/* Trade log */}
              <div className="card" style={{ padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div className="section-header" style={{ margin: 0 }}>Trade Log — {result.trades.length} trades</div>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Click any row to see the candlestick chart</span>
                </div>
                <div style={{ maxHeight: 320, overflowY: "auto" }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Entry Time</th>
                        <th>Exit Time</th>
                        <th>Entry ₹</th>
                        <th>Exit ₹</th>
                        <th>Bars</th>
                        <th>P&L (₹)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.trades.map((t, i) => {
                        const isSelected = selectedTradeIdx === i;
                        return (
                          <tr
                            key={i}
                            onClick={() => setSelectedTradeIdx(isSelected ? null : i)}
                            style={{
                              cursor: "pointer",
                              background: isSelected ? "rgba(37,99,235,0.12)" : undefined,
                              outline: isSelected ? "1px solid rgba(37,99,235,0.4)" : undefined,
                            }}
                          >
                            <td style={{ color: "var(--text-muted)" }}>{i + 1}</td>
                            <td className="mono" style={{ fontSize: 11 }}>
                              {t.entry_time ? t.entry_time.replace("T", " ") : `Bar ${t.entry_bar}`}
                            </td>
                            <td className="mono" style={{ fontSize: 11 }}>
                              {t.exit_time ? t.exit_time.replace("T", " ") : `Bar ${t.exit_bar}`}
                            </td>
                            <td className="mono">{t.entry_price.toFixed(1)}</td>
                            <td className="mono">{t.exit_price.toFixed(1)}</td>
                            <td className="mono">{t.bars_held}</td>
                            <td className={`mono ${t.pnl >= 0 ? "pos" : "neg"}`}>{t.pnl.toFixed(0)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Trade detail chart */}
                {selectedTradeIdx !== null && result.trades[selectedTradeIdx] && (
                  <TradeDetailChart trade={result.trades[selectedTradeIdx]} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ fontWeight: 600, color: accent ? "var(--accent-hi)" : "var(--text)" }}>{value}</span>
    </div>
  );
}
