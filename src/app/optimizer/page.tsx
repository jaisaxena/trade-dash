"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

type Strategy = {
  id: string;
  name: string;
  underlying: string;
  version: number;
  param_ranges?: Record<string, unknown[]>;
};

type RunResult = {
  params: Record<string, unknown>;
  metrics: Record<string, number>;
};

type WindowResult = {
  window: number;
  is_bars: number;
  oos_bars: number;
  best_params: Record<string, unknown>;
  is_metrics: Record<string, number>;
  oos_metrics: Record<string, number>;
  error?: string;
};

type Progress = {
  run_id: string;
  status: "running" | "completed" | "failed";
  mode: string;
  total: number;
  completed: number;
  current_params: Record<string, unknown> | null;
  partial_results: RunResult[];
  all_combos: Record<string, unknown>[];
  n_windows: number | null;
  current_window: number | null;
  window_results: WindowResult[];
  error: string | null;
  final_result: {
    ranked_results?: RunResult[];
    avg_oos_sharpe?: number;
    robustness_score?: number;
    recommended_params?: Record<string, unknown>;
    windows?: WindowResult[];
  } | null;
  // data range
  date_from: string | null;
  date_to: string | null;
  bar_count: number | null;
  // timing
  started_at: string | null;
  last_result_at: string | null;
  // successive halving
  current_stage: number | null;
  n_stages: number | null;
  stage_meta: StageMeta[] | null;
  sh_stage_results: ShStageResult[] | null;
};

type StageMeta = {
  stage: number;
  n_combos: number;
  data_fraction: number;
  bar_count: number;
  date_from: string;
  date_to: string;
};

type ShStageResult = {
  stage: number;
  n_tested: number;
  n_valid: number;
  n_survived: number;
  data_fraction: number;
  bar_count: number;
  date_from: string;
  date_to: string;
  top_result_sharpe: number | null;
  top_result_params: Record<string, unknown> | null;
  top_results: RunResult[];
};

function pct(completed: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.round((completed / total) * 100));
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
}

function fmtBars(n: number | null) {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

function formatParams(params: Record<string, unknown> | null) {
  if (!params) return "—";
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}

function ShStagePlan({
  stageMeta,
  stageResults,
  currentStage,
  isRunning,
}: {
  stageMeta: StageMeta[];
  stageResults: ShStageResult[];
  currentStage: number | null;
  isRunning: boolean;
}) {
  return (
    <>
      <div className="section-header" style={{ marginBottom: 12 }}>
        Successive Halving — {stageMeta.length} Stages
      </div>

      {/* Stage funnel overview */}
      <div style={{
        display: "flex", alignItems: "center", gap: 0,
        marginBottom: 16, padding: "10px 14px",
        background: "var(--bg-elevated)", borderRadius: 8,
        fontSize: 11, color: "var(--text-muted)",
      }}>
        {stageMeta.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ textAlign: "center" }}>
              <div style={{
                fontWeight: 700, fontSize: 13,
                color: currentStage === s.stage ? "var(--accent-hi)" : "var(--text)",
              }}>
                {s.n_combos}
              </div>
              <div>{Math.round(s.data_fraction * 100)}% data</div>
            </div>
            {i < stageMeta.length - 1 && (
              <div style={{ margin: "0 10px", fontSize: 16, color: "var(--border)" }}>→</div>
            )}
          </div>
        ))}
        <div style={{ marginLeft: "auto", fontStyle: "italic" }}>
          combos entering each stage
        </div>
      </div>

      {/* Per-stage cards */}
      <div style={{ display: "grid", gap: 8 }}>
        {stageMeta.map((meta) => {
          const result = stageResults.find((r) => r.stage === meta.stage);
          const isCurrent = currentStage === meta.stage && isRunning;
          const isDone = !!result;
          const isPending = !isDone && !isCurrent;

          return (
            <div
              key={meta.stage}
              style={{
                display: "flex", alignItems: "flex-start", gap: 12,
                padding: "10px 14px", borderRadius: 8,
                background: isDone
                  ? "rgba(34,197,94,.05)"
                  : isCurrent ? "rgba(37,99,235,.08)" : "var(--bg-elevated)",
                border: `1px solid ${isDone ? "rgba(34,197,94,.2)" : isCurrent ? "rgba(37,99,235,.2)" : "var(--border)"}`,
              }}
            >
              {/* Badge */}
              <span style={{
                width: 24, height: 24, borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 700, flexShrink: 0, marginTop: 1,
                background: isDone ? "var(--green-hi)" : isCurrent ? "var(--accent-hi)" : "var(--border)",
                color: isDone || isCurrent ? "#000" : "var(--text-muted)",
              }}>
                {isDone
                  ? "✓"
                  : isCurrent
                    ? <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "transparent", borderTopColor: "#000" }} />
                    : meta.stage}
              </span>

              <div style={{ flex: 1 }}>
                {/* Header */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
                    Stage {meta.stage} — {Math.round(meta.data_fraction * 100)}% of data
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {fmtDate(meta.date_from)} → {fmtDate(meta.date_to)}
                  </span>
                </div>

                {/* Sub-info */}
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                  {meta.n_combos} combinations · {meta.bar_count.toLocaleString()} bars
                  {meta.stage < stageMeta.length && (
                    <span style={{ color: "var(--text-muted)" }}>
                      {" "}→ keep top {Math.round(100 / 3)}%
                    </span>
                  )}
                  {meta.stage === stageMeta.length && (
                    <span style={{ color: "var(--yellow-hi)" }}> ← full data, final ranking</span>
                  )}
                </div>

                {/* Completed result */}
                {isDone && result && (
                  <div style={{
                    marginTop: 6, padding: "5px 8px", borderRadius: 5,
                    background: "rgba(34,197,94,.08)",
                    fontSize: 11, display: "flex", gap: 12,
                  }}>
                    <span style={{ color: "var(--text-muted)" }}>
                      Valid: <span style={{ color: "var(--text)" }}>{result.n_valid}/{result.n_tested}</span>
                    </span>
                    {result.n_survived > 0 && (
                      <span style={{ color: "var(--text-muted)" }}>
                        Survived: <span style={{ color: "var(--accent-hi)", fontWeight: 700 }}>{result.n_survived}</span>
                      </span>
                    )}
                    {result.top_result_sharpe != null && (
                      <span style={{ color: "var(--text-muted)" }}>
                        Best Sharpe: <span style={{
                          color: result.top_result_sharpe > 1
                            ? "var(--green-hi)"
                            : result.top_result_sharpe > 0
                              ? "var(--yellow-hi)"
                              : "var(--red-hi)",
                          fontWeight: 700,
                        }}>
                          {result.top_result_sharpe.toFixed(2)}
                        </span>
                      </span>
                    )}
                    {result.top_result_params && (
                      <span style={{ color: "var(--text-muted)" }}>
                        <ParamLabel params={result.top_result_params} />
                      </span>
                    )}
                  </div>
                )}

                {isCurrent && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--accent-hi)" }}>
                    Testing in progress…
                  </div>
                )}
                {isPending && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
                    Waiting for earlier stages to complete
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function TimingRow({
  startedAt,
  lastResultAt,
  completed,
  total,
}: {
  startedAt: string;
  lastResultAt: string | null;
  completed: number;
  total: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const elapsedMs = now - new Date(startedAt).getTime();
  const avgMsPerTest = completed > 0 ? elapsedMs / completed : 0;
  const remaining = total - completed;
  // ETA accounts for parallelism: results arrive faster than avgMsPerTest suggests,
  // so we use wall-clock elapsed / completed as the effective rate.
  const etaMs = avgMsPerTest * remaining;

  // Time since last result — the key "is it stuck?" signal
  const sinceLastMs = lastResultAt ? now - new Date(lastResultAt).getTime() : elapsedMs;
  const isStale = sinceLastMs > Math.max(avgMsPerTest * 3, 15_000); // warn if >3× avg or >15s

  // Current-test mini progress bar: how far into the average test duration has elapsed
  const currentTestPct = avgMsPerTest > 0
    ? Math.min(99, (sinceLastMs / avgMsPerTest) * 100)
    : 0;

  return (
    <div style={{ marginTop: 8 }}>
      {/* avg + ETA row */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
        <span>~{fmtDuration(Math.round(avgMsPerTest / 1000) * 1000)} / test</span>
        <span>ETA: {remaining > 0 ? fmtDuration(etaMs) : "—"}</span>
      </div>

      {/* current-test progress */}
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              width: 6, height: 6, borderRadius: "50%",
              background: isStale ? "var(--yellow-hi)" : "var(--green-hi)",
              display: "inline-block",
              boxShadow: isStale
                ? "0 0 6px var(--yellow-hi)"
                : "0 0 6px var(--green-hi)",
            }}
          />
          {isStale
            ? `No result for ${fmtDuration(sinceLastMs)} — long test in progress`
            : `Current test running for ${fmtDuration(sinceLastMs)}`}
        </span>
      </div>
      <div style={{ background: "var(--bg-elevated)", borderRadius: 3, height: 3, overflow: "hidden" }}>
        <div style={{
          width: `${currentTestPct}%`,
          height: "100%",
          background: isStale ? "var(--yellow-hi)" : "var(--accent-hi)",
          borderRadius: 3,
          transition: "width 0.5s linear",
        }} />
      </div>
    </div>
  );
}

const MODE_INFO: Record<string, { label: string; description: string }> = {
  grid: {
    label: "Grid",
    description:
      "Exhaustively tests every possible combination of your parameter ranges. " +
      "Nothing is skipped — guaranteed to find the global optimum within the search space. " +
      "Best when the grid is small (< ~500 combos). Runtime scales multiplicatively with each added parameter value.",
  },
  random: {
    label: "Random",
    description:
      "Randomly samples N combinations from the full grid. " +
      "Covers a large parameter space in a fraction of the time — ideal for an initial scan or when the grid has thousands of combos. " +
      "Results are probabilistic, not exhaustive. You control the sample size.",
  },
  walk_forward: {
    label: "Walk-Forward",
    description:
      "Time-aware validation that actively fights overfitting. " +
      "Your data is split into windows. Each window optimizes on the In-Sample (IS) period, then immediately validates on the unseen Out-of-Sample (OOS) period. " +
      "The final score is the average OOS Sharpe across all windows — the closest proxy to live performance you can get from historical data.",
  },
  successive_halving: {
    label: "Halving",
    description:
      "Progressive pruning across time horizons. " +
      "All combos are tested on a short recent slice first (10% of data). " +
      "Only the top third survive to Stage 2 (33% of data), and the top third of those reach Stage 3 (full data). " +
      "~75% less total compute than grid search, while still running full backtests on the best candidates.",
  },
};

function ModeButton({
  value,
  active,
  disabled,
  onClick,
}: {
  value: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const [open, setOpen] = useState(false);
  const info = MODE_INFO[value];
  return (
    <div
      style={{ flex: 1, position: "relative" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          width: "100%", padding: "6px 4px", borderRadius: 6, fontSize: 12,
          fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
          border: `1px solid ${active ? "var(--yellow-hi)" : "var(--border)"}`,
          background: active ? "rgba(217,119,6,.2)" : "var(--bg-elevated)",
          color: active ? "var(--yellow-hi)" : "var(--text-muted)",
        }}
      >
        {info.label}
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)",
          width: 230, padding: "10px 12px",
          background: "var(--bg-card)", border: "1px solid var(--border)",
          borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.5)",
          fontSize: 11, lineHeight: 1.6, color: "var(--text-muted)",
          zIndex: 100, pointerEvents: "none",
        }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: "var(--text)", marginBottom: 4 }}>
            {info.label} Search
          </div>
          {info.description}
        </div>
      )}
    </div>
  );
}

function ParamLabel({ params }: { params: Record<string, unknown> }) {
  return (
    <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>
      {formatParams(params)}
    </span>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div style={{ background: "var(--bg-elevated)", borderRadius: 4, height: 8, overflow: "hidden" }}>
      <div
        style={{
          width: `${value}%`,
          height: "100%",
          background: "linear-gradient(90deg, var(--accent) 0%, var(--yellow-hi) 100%)",
          borderRadius: 4,
          transition: "width 0.4s ease",
        }}
      />
    </div>
  );
}

function MetricCell({ value, metric }: { value: number; metric: string }) {
  const colorMap: Record<string, (v: number) => string> = {
    sharpe: (v) => v > 1 ? "var(--green-hi)" : v > 0 ? "var(--yellow-hi)" : "var(--red-hi)",
    cagr: (v) => v > 0 ? "var(--green-hi)" : "var(--red-hi)",
    max_drawdown: () => "var(--red-hi)",
    win_rate: (v) => v >= 0.5 ? "var(--green-hi)" : "var(--yellow-hi)",
  };
  const color = colorMap[metric]?.(value) ?? "var(--text)";
  const fmt =
    metric === "sharpe" || metric === "calmar" ? value?.toFixed(2)
    : metric === "cagr" || metric === "max_drawdown" || metric === "win_rate"
      ? `${((value ?? 0) * 100).toFixed(1)}%`
    : String(value ?? "—");
  return <td className="mono" style={{ color }}>{fmt}</td>;
}

const SESSION_KEY = "optimizer_run_id";

export default function OptimizerPage() {
  const [strategyId, setStrategyId] = useState("");
  const [interval, setIntervalValue] = useState("15m");
  const [mode, setMode] = useState("grid");
  const [maxRandom, setMaxRandom] = useState(500);
  const [nSplits, setNSplits] = useState(5);
  const [shEta, setShEta] = useState(3);

  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [activeTab, setActiveTab] = useState<"plan" | "live">("plan");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const strategies = useQuery({
    queryKey: ["strategies"],
    queryFn: () => api.get<{ strategies: Strategy[] }>("/api/vault/strategies"),
  });

  const selected = strategies.data?.strategies.find((s) => s.id === strategyId);

  const paramRanges = (selected as Strategy | undefined)?.param_ranges ?? {};
  const gridSize = Object.values(paramRanges).reduce<number>(
    (acc, v) => acc * ((v as unknown[]).length || 1),
    1,
  );

  // ── restore in-progress run from sessionStorage (survives page navigation) ──
  useEffect(() => {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved && !runId) {
      setRunId(saved);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── polling ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!runId) return;

    let stopped = false;

    const doPoll = async () => {
      try {
        const p = await api.get<Progress>(`/api/optimizer/runs/${runId}/progress`);
        if (stopped) return;
        setProgress(p);
        if (p.status !== "running") {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          sessionStorage.removeItem(SESSION_KEY);
          // Only switch to live results tab on success, not on failure
          if (p.status === "completed") setActiveTab("live");
        }
      } catch {
        // transient errors during polling are fine
      }
    };

    doPoll();
    pollRef.current = setInterval(doPoll, 1000);
    return () => {
      stopped = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [runId]);

  // ── submit ────────────────────────────────────────────────────────────────
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleRun() {
    if (!strategyId) return;
    setSubmitError(null);
    setSubmitting(true);
    // stop any existing polling before resetting state
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setProgress(null);
    setRunId(null);
    try {
      const r = await api.get<{ strategy: Record<string, unknown> }>(`/api/vault/strategies/${strategyId}`);
      const resp = await api.post<Progress & { run_id: string; all_combos: Record<string, unknown>[] }>(
        "/api/optimizer/run",
        {
          recipe: r.strategy,
          interval,
          mode,
          max_random: (mode === "random" || mode === "successive_halving") ? maxRandom : undefined,
          n_splits: mode === "walk_forward" ? nSplits : undefined,
          sh_eta: mode === "successive_halving" ? shEta : undefined,
        },
      );
      // Persist so the run survives page navigation
      sessionStorage.setItem(SESSION_KEY, resp.run_id);
      setRunId(resp.run_id);
      setProgress({
        run_id: resp.run_id,
        status: "running",
        mode,
        total: resp.total,
        completed: 0,
        current_params: null,
        partial_results: [],
        all_combos: resp.all_combos ?? [],
        n_windows: resp.n_windows ?? null,
        current_window: null,
        window_results: [],
        error: null,
        final_result: null,
        date_from: resp.date_from ?? null,
        date_to: resp.date_to ?? null,
        bar_count: resp.bar_count ?? null,
        started_at: new Date().toISOString(),
        last_result_at: null,
        current_stage: null,
        n_stages: resp.n_stages ?? null,
        stage_meta: resp.stage_meta ?? null,
        sh_stage_results: null,
      });
      setActiveTab("plan");
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const isRunning = progress?.status === "running";
  const isDone = progress?.status === "completed";
  const isFailed = progress?.status === "failed";
  const progressPct = pct(progress?.completed ?? 0, progress?.total ?? 0);

  const displayResults: RunResult[] =
    isDone && progress?.final_result?.ranked_results
      ? progress.final_result.ranked_results
      : (progress?.partial_results ?? []);

  return (
    <div className="page">
      <div style={{ marginBottom: 20 }}>
        <h1 className="page-title">Optimizer</h1>
        <p className="page-sub">
          Find the best parameter combination for your strategy. The full test plan is shown upfront
          and results stream in live as each combination completes.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16 }}>
        {/* ── Config panel ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div className="section-header">Run Config</div>

            <span className="label">Strategy</span>
            <select
              className="input"
              style={{ marginBottom: 12 }}
              value={strategyId}
              onChange={(e) => setStrategyId(e.target.value)}
              disabled={isRunning}
            >
              <option value="">Select a strategy…</option>
              {strategies.data?.strategies.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.underlying})</option>
              ))}
            </select>

            {selected && (
              <div style={{ background: "var(--bg-elevated)", borderRadius: 6, padding: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                  Underlying: <span style={{ color: "var(--accent-hi)", fontWeight: 700 }}>{selected.underlying}</span>
                </div>
                {Object.keys(paramRanges).length > 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.7 }}>
                    {Object.entries(paramRanges).map(([k, v]) => (
                      <div key={k}>
                        <span style={{ color: "var(--text)" }}>{k}</span>
                        {" — "}
                        <span style={{ color: "var(--yellow-hi)" }}>
                          [{(v as unknown[]).join(", ")}]
                        </span>
                        {" "}
                        <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                          ({(v as unknown[]).length} values)
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>No param_ranges defined</div>
                )}
              </div>
            )}

            <span className="label">Interval</span>
            <select
              className="input"
              style={{ marginBottom: 12 }}
              value={interval}
              onChange={(e) => setIntervalValue(e.target.value)}
              disabled={isRunning}
            >
              <option value="1m">1 minute</option>
              <option value="5m">5 minute</option>
              <option value="15m">15 minute</option>
              <option value="1h">1 hour</option>
              <option value="day">Daily</option>
            </select>

            <span className="label">Search Mode</span>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {(["grid", "random", "walk_forward", "successive_halving"] as const).map((v) => (
                <ModeButton
                  key={v}
                  value={v}
                  active={mode === v}
                  disabled={isRunning}
                  onClick={() => setMode(v)}
                />
              ))}
            </div>

            {mode === "random" && (
              <>
                <span className="label">Sample Size</span>
                <input
                  type="number" className="input" style={{ marginBottom: 12 }}
                  value={maxRandom}
                  onChange={(e) => setMaxRandom(parseInt(e.target.value) || 500)}
                  disabled={isRunning}
                />
              </>
            )}
            {mode === "walk_forward" && (
              <>
                <span className="label">Splits</span>
                <input
                  type="number" className="input" style={{ marginBottom: 12 }}
                  value={nSplits} min={2} max={10}
                  onChange={(e) => setNSplits(parseInt(e.target.value) || 5)}
                  disabled={isRunning}
                />
              </>
            )}
            {mode === "successive_halving" && (
              <>
                <span className="label">Pruning Factor (η)</span>
                <select
                  className="input" style={{ marginBottom: 8 }}
                  value={shEta}
                  onChange={(e) => setShEta(parseInt(e.target.value))}
                  disabled={isRunning}
                >
                  <option value={2}>2 — keep top 50% each stage</option>
                  <option value={3}>3 — keep top 33% each stage</option>
                  <option value={4}>4 — keep top 25% each stage</option>
                </select>
                <div style={{
                  fontSize: 10, color: "var(--text-muted)", marginBottom: 12,
                  lineHeight: 1.5, padding: "4px 6px",
                  background: "var(--bg-elevated)", borderRadius: 4,
                }}>
                  Stages: 10% → 33% → 100% of data
                  {selected && Object.keys(paramRanges).length > 0 && (
                    <span style={{ color: "var(--accent-hi)" }}>
                      {" "}· {gridSize} → {Math.floor(gridSize/shEta)} → {Math.max(1,Math.floor(gridSize/shEta/shEta))} combos
                    </span>
                  )}
                </div>
              </>
            )}

            {/* Combination count preview */}
            {selected && !isRunning && mode !== "successive_halving" && (
              <div style={{
                background: "rgba(37,99,235,.08)", border: "1px solid rgba(37,99,235,.2)",
                borderRadius: 6, padding: "8px 10px", marginBottom: 12, fontSize: 11,
              }}>
                <span style={{ color: "var(--text-muted)" }}>Grid size: </span>
                <span style={{ color: "var(--accent-hi)", fontWeight: 700 }}>
                  {mode === "random" ? Math.min(maxRandom, gridSize) : gridSize}
                </span>
                <span style={{ color: "var(--text-muted)" }}> combinations</span>
                {mode === "walk_forward" && (
                  <>
                    <span style={{ color: "var(--text-muted)" }}> × {nSplits} splits = </span>
                    <span style={{ color: "var(--accent-hi)", fontWeight: 700 }}>
                      {(mode === "random" ? Math.min(maxRandom, gridSize) : gridSize) * nSplits}
                    </span>
                    <span style={{ color: "var(--text-muted)" }}> total backtests</span>
                  </>
                )}
              </div>
            )}

            <button
              className="btn btn-primary"
              style={{ width: "100%", justifyContent: "center" }}
              disabled={!strategyId || submitting || isRunning}
              onClick={handleRun}
            >
              {submitting || isRunning
                ? <><span className="spinner" /> {isRunning ? "Optimizing…" : "Starting…"}</>
                : isDone ? "Run Again" : "Run Optimization"}
            </button>

            {submitError && (
              <p style={{ fontSize: 12, color: "var(--red-hi)", margin: "8px 0 0" }}>
                ✗ {submitError}
              </p>
            )}
          </div>

          {/* Status summary card */}
          {progress && (
            <div className="card" style={{ padding: 14 }}>
              {/* ── header row ── */}
              <div style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                marginBottom: 8,
              }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                  {isRunning ? "Running…" : isDone ? "Complete" : "Failed"}
                </span>
                <span style={{
                  fontSize: 11, padding: "2px 8px", borderRadius: 10,
                  background: isRunning ? "rgba(37,99,235,.15)" : isDone ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)",
                  color: isRunning ? "var(--accent-hi)" : isDone ? "var(--green-hi)" : "var(--red-hi)",
                  fontWeight: 600,
                }}>
                  {isRunning ? `${progressPct}%` : isDone ? "✓ done" : "✗ error"}
                </span>
              </div>

              <ProgressBar value={progressPct} />

              {/* ── counts ── */}
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)" }}>
                {progress.completed} / {progress.total} tested
                {progress.mode === "walk_forward" && progress.current_window !== null && (
                  <span> · window {progress.current_window} of {progress.n_windows}</span>
                )}
                {progress.mode === "successive_halving" && progress.current_stage !== null && (
                  <span style={{ color: "var(--accent-hi)", fontWeight: 600 }}>
                    {" · "}Stage {progress.current_stage} of {progress.n_stages}
                  </span>
                )}
              </div>

              {/* ── data period ── */}
              {(progress.date_from || progress.bar_count) && (
                <div style={{
                  marginTop: 8, padding: "6px 8px", borderRadius: 5,
                  background: "rgba(37,99,235,.07)", border: "1px solid rgba(37,99,235,.15)",
                  fontSize: 11,
                }}>
                  <span style={{ color: "var(--text-muted)" }}>Data period: </span>
                  <span style={{ color: "var(--accent-hi)", fontWeight: 600 }}>
                    {fmtDate(progress.date_from)} → {fmtDate(progress.date_to)}
                  </span>
                  {progress.bar_count && (
                    <span style={{ color: "var(--text-muted)" }}>
                      {" "}· {fmtBars(progress.bar_count)} bars
                    </span>
                  )}
                </div>
              )}

              {/* ── timing: avg per test + ETA ── */}
              {isRunning && progress.completed > 0 && progress.started_at && (
                <TimingRow
                  startedAt={progress.started_at}
                  lastResultAt={progress.last_result_at}
                  completed={progress.completed}
                  total={progress.total}
                />
              )}

              {/* ── current params ── */}
              {isRunning && progress.current_params && (
                <div style={{ marginTop: 8, fontSize: 11, background: "var(--bg-elevated)", borderRadius: 4, padding: "4px 8px" }}>
                  <span style={{ color: "var(--text-muted)" }}>Last tested: </span>
                  <ParamLabel params={progress.current_params} />
                </div>
              )}

              {isFailed && (
                <div style={{
                  marginTop: 8, padding: "8px 10px", borderRadius: 6, fontSize: 12,
                  background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)",
                  color: "var(--red-hi)", wordBreak: "break-word",
                }}>
                  ✗ {progress.error ?? "Unknown error — check server logs"}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Main results area ── */}
        <div>
          {!progress && (
            <div className="card" style={{ padding: 40, textAlign: "center" }}>
              <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
                Select a strategy and run optimization to see the full test plan and live results.
              </p>
            </div>
          )}

          {progress && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Tab bar */}
              <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)" }}>
                {(["plan", "live"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    style={{
                      padding: "8px 20px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                      border: "none", borderBottom: activeTab === tab ? "2px solid var(--accent-hi)" : "2px solid transparent",
                      background: "transparent",
                      color: activeTab === tab ? "var(--accent-hi)" : "var(--text-muted)",
                      marginBottom: -1,
                    }}
                  >
                    {tab === "plan"
                      ? `Plan (${progress.total} tests)`
                      : displayResults.length > 0
                        ? `Results (${displayResults.length}${isRunning ? " live" : ""})`
                        : "Results"}
                  </button>
                ))}
              </div>

              {/* Plan tab: full combination list */}
              {activeTab === "plan" && (
                <div className="card" style={{ padding: 16 }}>
                  {progress.mode === "successive_halving" ? (
                    <ShStagePlan
                      stageMeta={progress.stage_meta ?? []}
                      stageResults={progress.sh_stage_results ?? []}
                      currentStage={progress.current_stage}
                      isRunning={isRunning}
                    />
                  ) : progress.mode === "walk_forward" ? (
                    <>
                      <div className="section-header" style={{ marginBottom: 12 }}>
                        Walk-Forward Windows
                      </div>
                      <div style={{ display: "grid", gap: 8 }}>
                        {Array.from({ length: progress.n_windows ?? nSplits }, (_, i) => {
                          const wr = progress.window_results?.find((w) => w.window === i);
                          const isCurrent = progress.current_window === i + 1 && isRunning;
                          const isDoneWindow = !!wr && !wr.error;
                          return (
                            <div
                              key={i}
                              style={{
                                display: "flex", alignItems: "center", gap: 10,
                                padding: "8px 12px", borderRadius: 6,
                                background: isDoneWindow
                                  ? "rgba(34,197,94,.06)"
                                  : isCurrent ? "rgba(37,99,235,.08)" : "var(--bg-elevated)",
                                border: `1px solid ${isDoneWindow ? "rgba(34,197,94,.2)" : isCurrent ? "rgba(37,99,235,.2)" : "var(--border)"}`,
                              }}
                            >
                              <span style={{
                                width: 20, height: 20, borderRadius: "50%", display: "flex",
                                alignItems: "center", justifyContent: "center",
                                fontSize: 10, fontWeight: 700,
                                background: isDoneWindow ? "var(--green-hi)" : isCurrent ? "var(--accent-hi)" : "var(--border)",
                                color: isDoneWindow || isCurrent ? "#000" : "var(--text-muted)",
                                flexShrink: 0,
                              }}>
                                {isDoneWindow ? "✓" : isCurrent ? <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "transparent", borderTopColor: "#000" }} /> : i + 1}
                              </span>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                                  Window {i + 1}
                                </div>
                                {wr && !wr.error && (
                                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                                    IS: {wr.is_bars} bars · OOS: {wr.oos_bars} bars ·
                                    OOS Sharpe: <span style={{ color: (wr.oos_metrics?.sharpe ?? 0) > 0 ? "var(--green-hi)" : "var(--red-hi)" }}>
                                      {wr.oos_metrics?.sharpe?.toFixed(2)}
                                    </span>
                                    {" · "}Best: <ParamLabel params={wr.best_params} />
                                  </div>
                                )}
                                {wr?.error && (
                                  <div style={{ fontSize: 11, color: "var(--red-hi)", marginTop: 2 }}>{wr.error}</div>
                                )}
                                {!wr && isCurrent && (
                                  <div style={{ fontSize: 11, color: "var(--accent-hi)", marginTop: 2 }}>
                                    Testing {progress.completed % (progress.total / (progress.n_windows ?? 1)) | 0} combinations…
                                  </div>
                                )}
                                {!wr && !isCurrent && (
                                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Pending</div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="section-header" style={{ marginBottom: 8 }}>
                        All {progress.total} Parameter Combinations
                        {progress.all_combos.length < progress.total && (
                          <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400, marginLeft: 8 }}>
                            (showing first {progress.all_combos.length})
                          </span>
                        )}
                      </div>
                      <div style={{ maxHeight: 440, overflowY: "auto" }}>
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th>#</th>
                              {Object.keys(progress.all_combos[0] ?? {}).map((k) => (
                                <th key={k}>{k}</th>
                              ))}
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {progress.all_combos.map((combo, i) => {
                              const tested = i < (progress.completed ?? 0);
                              const isCurrent =
                                isRunning &&
                                progress.current_params &&
                                JSON.stringify(combo) === JSON.stringify(progress.current_params);
                              return (
                                <tr
                                  key={i}
                                  style={{
                                    background: isCurrent
                                      ? "rgba(37,99,235,.12)"
                                      : tested
                                        ? "rgba(34,197,94,.04)"
                                        : undefined,
                                  }}
                                >
                                  <td style={{ color: "var(--text-muted)" }}>{i + 1}</td>
                                  {Object.values(combo).map((v, j) => (
                                    <td key={j} className="mono">{String(v)}</td>
                                  ))}
                                  <td style={{ fontSize: 11 }}>
                                    {isCurrent ? (
                                      <span style={{ color: "var(--accent-hi)" }}>● testing</span>
                                    ) : tested ? (
                                      <span style={{ color: "var(--green-hi)" }}>✓</span>
                                    ) : (
                                      <span style={{ color: "var(--border)" }}>—</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Live results tab */}
              {activeTab === "live" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {/* Walk-forward summary when done */}
                  {isDone && progress.final_result?.avg_oos_sharpe !== undefined && (
                    <div className="card" style={{ padding: 16 }}>
                      <div className="section-header">Walk-Forward Summary</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                        {[
                          { label: "Avg OOS Sharpe", value: String(progress.final_result.avg_oos_sharpe) },
                          { label: "Robustness Score", value: `${progress.final_result.robustness_score}/100` },
                          { label: "Recommended Params", value: JSON.stringify(progress.final_result.recommended_params) },
                        ].map(({ label, value }) => (
                          <div key={label} className="card stat-card" style={{ border: "1px solid var(--yellow)44" }}>
                            <div className="stat-label">{label}</div>
                            <div className="mono" style={{ color: "var(--yellow-hi)", marginTop: 4, fontSize: 14, wordBreak: "break-all" }}>{value}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Ranked results table (live-updating) */}
                  {displayResults.length > 0 ? (
                    <div className="card" style={{ padding: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                        <div className="section-header" style={{ margin: 0 }}>
                          {isDone
                            ? `Final Rankings — top ${Math.min(displayResults.length, 20)} of ${displayResults.length}`
                            : `Live Rankings — ${displayResults.length} completed so far`}
                        </div>
                        {isRunning && (
                          <span style={{ fontSize: 11, color: "var(--accent-hi)", display: "flex", alignItems: "center", gap: 4 }}>
                            <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
                            updating live
                          </span>
                        )}
                      </div>
                      <div style={{ overflowX: "auto" }}>
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Sharpe</th>
                              <th>CAGR</th>
                              <th>Max DD</th>
                              <th>Win Rate</th>
                              <th>Trades</th>
                              <th>Parameters</th>
                            </tr>
                          </thead>
                          <tbody>
                            {displayResults.slice(0, 20).map((r, i) => (
                              <tr key={i}>
                                <td style={{ color: "var(--text-muted)" }}>{i + 1}</td>
                                <MetricCell value={r.metrics.sharpe ?? 0} metric="sharpe" />
                                <MetricCell value={r.metrics.cagr ?? 0} metric="cagr" />
                                <MetricCell value={r.metrics.max_drawdown ?? 0} metric="max_drawdown" />
                                <MetricCell value={r.metrics.win_rate ?? 0} metric="win_rate" />
                                <td className="mono">{r.metrics.total_trades}</td>
                                <td style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>
                                  {formatParams(r.params)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="card" style={{ padding: 30, textAlign: "center" }}>
                      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                        {isRunning ? "Results will appear here as combinations complete…" : "No valid results yet."}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
