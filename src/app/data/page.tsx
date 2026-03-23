"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

const ALL_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"];
const ALL_INTERVALS = [
  { value: "1m",  label: "1 min" },
  { value: "5m",  label: "5 min" },
  { value: "15m", label: "15 min" },
  { value: "day", label: "Daily" },
];

type IntervalData = { count: number; from: string; to: string } | null;
type StatusData = Record<string, {
  display_name: string;
  intervals: Record<string, IntervalData>;
  has_any: boolean;
}>;

type SyncMode = "range" | "full";

type SyncStatus = {
  active: boolean;
  mode: string | null;
  cancelled: boolean;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  underlyings: string[];
  intervals: string[];
  current_underlying: string | null;
  current_interval: string | null;
  steps_total: number;
  steps_done: number;
  rows_inserted: number;
  log: { ts: string; msg: string }[];
};

type InstrumentRow = {
  instrument_token: number;
  tradingsymbol: string;
  name: string | null;
  exchange: string;
  segment: string;
  instrument_type: string;
  strike: number | null;
  expiry: string | null;
  lot_size: number | null;
};

type InstrumentsListResponse = {
  total: number;
  items: InstrumentRow[];
  limit: number;
  offset: number;
};

function toggle<T>(arr: T[], val: T): T[] {
  return arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];
}

export default function DataPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [selectedU, setSelectedU] = useState(["NIFTY", "BANKNIFTY"]);
  const [selectedI, setSelectedI] = useState(["15m", "day"]);
  const [syncMode, setSyncMode] = useState<SyncMode>("range");
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [requestToken, setRequestToken] = useState("");
  const [instrumentSearch, setInstrumentSearch] = useState("");
  const [debouncedInstrumentQ, setDebouncedInstrumentQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedInstrumentQ(instrumentSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [instrumentSearch]);

  const auth = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api.get<{ authenticated: boolean }>("/api/data/auth/status"),
  });

  const loginUrl = useQuery({
    queryKey: ["login-url"],
    queryFn: () => api.get<{ login_url: string }>("/api/data/auth/login"),
    enabled: false,
  });

  const status = useQuery({
    queryKey: ["data-status"],
    queryFn: () => api.get<StatusData>("/api/data/status"),
    refetchInterval: 10_000,
  });

  const syncStatus = useQuery<SyncStatus>({
    queryKey: ["sync-status"],
    queryFn: () => api.get<SyncStatus>("/api/data/sync/status"),
    refetchInterval: (query) => query.state.data?.active ? 1500 : false,
  });

  const isSyncActive = syncStatus.data?.active ?? false;

  useEffect(() => {
    if (syncStatus.data && !syncStatus.data.active && syncStatus.data.finished_at) {
      qc.invalidateQueries({ queryKey: ["data-status"] });
    }
  }, [syncStatus.data?.active, syncStatus.data?.finished_at, qc]);

  const startSyncMutation = useMutation({
    mutationFn: () => {
      const endpoint = syncMode === "full" ? "/api/data/sync/full" : "/api/data/sync";
      const body = syncMode === "full"
        ? { underlyings: selectedU, intervals: selectedI }
        : { underlyings: selectedU, intervals: selectedI, from_date: fromDate };
      return api.post(endpoint, body);
    },
    onSuccess: () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ["sync-status"] }), 300);
    },
  });

  const cancelSyncMutation = useMutation({
    mutationFn: () => api.post("/api/data/sync/cancel"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sync-status"] }),
  });

  const callbackMutation = useMutation({
    mutationFn: (rt: string) => api.post("/api/data/auth/callback", { request_token: rt }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth-status"] });
      setRequestToken("");
    },
  });

  const instrumentsList = useQuery({
    queryKey: ["instruments-list", debouncedInstrumentQ],
    queryFn: () => {
      const q = encodeURIComponent(debouncedInstrumentQ);
      return api.get<InstrumentsListResponse>(
        `/api/data/instruments?limit=150&offset=0&q=${q}`,
      );
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.post<{ instruments_stored: number }>("/api/data/instruments/refresh"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instruments-list"] });
    },
  });

  const handleLogin = async () => {
    const data = await loginUrl.refetch();
    if (data.data?.login_url) window.open(data.data.login_url, "_blank");
  };

  const ss = syncStatus.data;
  const isSyncing = isSyncActive || startSyncMutation.isPending;

  return (
    <div className="page">
      <div style={{ marginBottom: 20 }}>
        <h1 className="page-title">Data Module</h1>
        <p className="page-sub">Authenticate with Kite, then sync historical data for your underlyings.</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 16 }}>
        {/* Left column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Kite Auth */}
          <div className="card" style={{ padding: 16 }}>
            <div className="section-header">Kite Authentication</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <span className={`dot ${auth.data?.authenticated ? "dot-green" : "dot-red"}`} />
              <span style={{ fontSize: 13, color: auth.data?.authenticated ? "var(--green-hi)" : "var(--red-hi)", fontWeight: 600 }}>
                {auth.data?.authenticated ? "Connected" : "Not connected"}
              </span>
            </div>
            {!auth.data?.authenticated ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <button className="btn btn-primary" style={{ width: "100%" }} onClick={handleLogin}>
                  Open Kite Login
                </button>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    className="input"
                    placeholder="Paste request_token after login"
                    value={requestToken}
                    onChange={(e) => setRequestToken(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn-success"
                    disabled={!requestToken || callbackMutation.isPending}
                    onClick={() => callbackMutation.mutate(requestToken)}
                  >
                    Go
                  </button>
                </div>
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
                  Or set <code style={{ color: "var(--accent-hi)" }}>KITE_REDIRECT_URL=http://localhost:8000/api/data/auth/callback</code> in your Kite app — the redirect will auth automatically.
                </p>
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                Session active. Use <strong style={{ color: "var(--text)" }}>F&amp;O instruments</strong> below to pull the latest contract list from Kite.
              </p>
            )}
          </div>

          {/* Sync config */}
          <div className="card" style={{ padding: 16 }}>
            <div className="section-header">Sync Configuration</div>

            {/* Mode toggle */}
            <span className="label">Sync Mode</span>
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {(["range", "full"] as SyncMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setSyncMode(m)}
                  style={{
                    flex: 1,
                    padding: "7px 0",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    border: `1px solid ${syncMode === m ? "var(--accent-hi)" : "var(--border)"}`,
                    background: syncMode === m ? "rgba(37,99,235,.22)" : "var(--bg-elevated)",
                    color: syncMode === m ? "var(--accent-hi)" : "var(--text-muted)",
                    cursor: "pointer",
                    transition: "all .15s",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  {m === "range" ? "Date Range" : "Full History"}
                </button>
              ))}
            </div>

            {syncMode === "full" && (
              <div style={{ marginBottom: 14, padding: "10px 12px", borderRadius: 6, background: "rgba(37,99,235,.08)", border: "1px solid rgba(37,99,235,.25)" }}>
                <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
                  <span style={{ color: "var(--accent-hi)", fontWeight: 700 }}>Full History mode</span> will walk backwards from your oldest stored candle until Kite returns no more data, then sync forward to today. This may take several minutes for intraday intervals.
                </p>
              </div>
            )}

            <span className="label">Underlyings</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {ALL_UNDERLYINGS.map((u) => {
                const on = selectedU.includes(u);
                return (
                  <button
                    key={u}
                    onClick={() => setSelectedU(toggle(selectedU, u))}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 700,
                      border: `1px solid ${on ? "var(--accent-hi)" : "var(--border)"}`,
                      background: on ? "rgba(37,99,235,.2)" : "var(--bg-elevated)",
                      color: on ? "var(--accent-hi)" : "var(--text-muted)",
                      cursor: "pointer",
                      transition: "all .15s",
                    }}
                  >
                    {u}
                  </button>
                );
              })}
            </div>

            <span className="label">Intervals</span>
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {ALL_INTERVALS.map(({ value, label }) => {
                const on = selectedI.includes(value);
                return (
                  <button
                    key={value}
                    onClick={() => setSelectedI(toggle(selectedI, value))}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 600,
                      border: `1px solid ${on ? "var(--green-hi)" : "var(--border)"}`,
                      background: on ? "rgba(5,150,105,.2)" : "var(--bg-elevated)",
                      color: on ? "var(--green-hi)" : "var(--text-muted)",
                      cursor: "pointer",
                      transition: "all .15s",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {syncMode === "range" && (
              <>
                <span className="label">From Date</span>
                <input
                  type="date"
                  className="input"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  style={{ marginBottom: 14 }}
                />
              </>
            )}

            <button
              className={`btn ${syncMode === "full" ? "btn-warning" : "btn-primary"}`}
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => startSyncMutation.mutate()}
              disabled={isSyncing || !auth.data?.authenticated || selectedU.length === 0 || selectedI.length === 0}
            >
              {startSyncMutation.isPending
                ? <><span className="spinner" /> Starting…</>
                : syncMode === "full"
                  ? `Sync All History — ${selectedU.join(", ")}`
                  : `Sync ${selectedU.join(", ")} — ${selectedI.join(", ")}`}
            </button>
            {!auth.data?.authenticated && (
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--yellow-hi)" }}>
                Connect to Kite first
              </p>
            )}
            {startSyncMutation.isError && (
              <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--red-hi)" }}>
                {(startSyncMutation.error as Error)?.message}
              </p>
            )}
          </div>

          {/* Sync progress panel */}
          {ss && (ss.active || ss.finished_at) && (
            <div className="card" style={{ padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div className="section-header" style={{ marginBottom: 0 }}>
                  Sync {ss.mode === "full" ? "Full History" : "Range"}
                </div>
                {ss.active && (
                  <button
                    className="btn btn-danger btn-sm"
                    style={{ fontSize: 11, padding: "4px 12px" }}
                    onClick={() => cancelSyncMutation.mutate()}
                    disabled={cancelSyncMutation.isPending || ss.cancelled}
                  >
                    {ss.cancelled ? "Stopping…" : "Cancel"}
                  </button>
                )}
              </div>

              {/* Progress bar */}
              {ss.steps_total > 0 && (
                <div style={{
                  height: 6, borderRadius: 3,
                  background: "var(--bg-elevated)",
                  overflow: "hidden",
                  marginBottom: 10,
                }}>
                  <div style={{
                    height: "100%", borderRadius: 3,
                    width: `${Math.round((ss.steps_done / ss.steps_total) * 100)}%`,
                    background: ss.error
                      ? "var(--red-hi)"
                      : ss.cancelled
                        ? "var(--yellow-hi)"
                        : ss.active
                          ? "var(--accent-hi)"
                          : "var(--green-hi)",
                    transition: "width .4s ease",
                  }} />
                </div>
              )}

              {/* Current step + counters */}
              <div style={{ display: "flex", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Step <strong style={{ color: "var(--text)" }}>{ss.steps_done}</strong> / {ss.steps_total}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Rows <strong style={{ color: "var(--green-hi)", fontFamily: "monospace" }}>{ss.rows_inserted.toLocaleString()}</strong>
                </div>
                {ss.active && ss.current_underlying && (
                  <div style={{ fontSize: 11 }}>
                    <span style={{ color: "var(--accent-hi)", fontWeight: 700 }}>
                      {ss.current_underlying} {ss.current_interval}
                    </span>
                    {ss.active && !ss.cancelled && <span className="spinner" style={{ marginLeft: 6, width: 10, height: 10 }} />}
                  </div>
                )}
              </div>

              {/* Status badge */}
              {!ss.active && ss.finished_at && (
                <div style={{
                  padding: "6px 10px", borderRadius: 6, marginBottom: 8, fontSize: 12, fontWeight: 600,
                  background: ss.error
                    ? "rgba(239,68,68,.12)"
                    : ss.cancelled
                      ? "rgba(234,179,8,.12)"
                      : "rgba(16,185,129,.12)",
                  color: ss.error ? "var(--red-hi)" : ss.cancelled ? "var(--yellow-hi)" : "var(--green-hi)",
                  border: `1px solid ${ss.error ? "rgba(239,68,68,.25)" : ss.cancelled ? "rgba(234,179,8,.25)" : "rgba(16,185,129,.25)"}`,
                }}>
                  {ss.error ? `Failed: ${ss.error}` : ss.cancelled ? "Cancelled by user" : `Complete — ${ss.rows_inserted.toLocaleString()} rows synced`}
                </div>
              )}

              {/* Log entries */}
              {ss.log.length > 0 && (
                <div style={{
                  maxHeight: 140, overflowY: "auto",
                  borderRadius: 6, border: "1px solid var(--border-dim)",
                  background: "var(--bg-elevated)", padding: 8,
                  fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  lineHeight: 1.7,
                }}>
                  {ss.log.map((entry, i) => (
                    <div key={i} style={{ color: "var(--text-muted)" }}>
                      <span style={{ color: "var(--text-dim)", marginRight: 6 }}>
                        {entry.ts.split("T")[1]}
                      </span>
                      {entry.msg}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* F&O instruments cache */}
          <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="section-header">F&amp;O instruments</div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Local cache from Kite. Refresh after new listings or rollovers. Search filters symbol, underlying name, or token.
            </p>
            <button
              className="btn btn-ghost btn-sm"
              style={{ width: "100%" }}
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending || !auth.data?.authenticated}
            >
              {refreshMutation.isPending ? "Refreshing from Kite…" : "Refresh from Kite"}
            </button>
            {!auth.data?.authenticated && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--yellow-hi)" }}>Connect Kite to refresh.</p>
            )}
            {refreshMutation.isSuccess && refreshMutation.data && (
              <p style={{ margin: 0, fontSize: 12, color: "var(--green-hi)" }}>
                ✓ Stored {refreshMutation.data.instruments_stored.toLocaleString()} contracts
              </p>
            )}
            {refreshMutation.isError && (
              <p style={{ margin: 0, fontSize: 12, color: "var(--red-hi)" }}>
                ✗ {(refreshMutation.error as Error)?.message}
              </p>
            )}

            <input
              type="search"
              className="input"
              placeholder="Search symbol, name, token…"
              value={instrumentSearch}
              onChange={(e) => setInstrumentSearch(e.target.value)}
              aria-label="Search instruments"
            />

            <div style={{ fontSize: 11, color: "var(--text-muted)", minHeight: 16 }}>
              {instrumentsList.isLoading && "Loading…"}
              {instrumentsList.data && (
                <>
                  {instrumentsList.data.total.toLocaleString()} match
                  {instrumentsList.data.total === 1 ? "" : "es"}
                  {instrumentsList.data.total > instrumentsList.data.items.length
                    ? ` · showing first ${instrumentsList.data.items.length}`
                    : ""}
                </>
              )}
            </div>

            <div
              style={{
                maxHeight: 280,
                overflowY: "auto",
                borderRadius: 6,
                border: "1px solid var(--border-dim)",
                background: "var(--bg-elevated)",
              }}
            >
              {instrumentsList.isError && (
                <div style={{ padding: 12, fontSize: 12, color: "var(--red-hi)" }}>
                  {(instrumentsList.error as Error)?.message}
                </div>
              )}
              {instrumentsList.data && instrumentsList.data.items.length === 0 && (
                <div style={{ padding: 14, fontSize: 12, color: "var(--text-muted)" }}>
                  {debouncedInstrumentQ
                    ? "No instruments match this search."
                    : "No instruments in the database yet. Connect Kite and click Refresh from Kite."}
                </div>
              )}
              {instrumentsList.data?.items.map((row) => (
                <div
                  key={`${row.instrument_token}-${row.tradingsymbol}`}
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border-dim)",
                    fontSize: 11,
                    lineHeight: 1.35,
                  }}
                >
                  <div style={{ fontWeight: 700, fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--accent-hi)" }}>
                    {row.tradingsymbol}
                  </div>
                  <div style={{ color: "var(--text-muted)" }}>
                    {row.name ?? "—"} · {row.segment} · {row.instrument_type}
                    {row.strike != null && row.strike > 0 ? ` · ${row.strike}` : ""}
                    {row.expiry ? ` · ${row.expiry}` : ""}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                    token {row.instrument_token} · {row.exchange} · lot {row.lot_size ?? "—"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right column: data status */}
        <div>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div className="section-header" style={{ marginBottom: 0 }}>Local Data Status</div>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Click any block to view chart</span>
            </div>
            {status.data ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {Object.entries(status.data).map(([underlying, info]) => (
                  <div
                    key={underlying}
                    style={{
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-dim)",
                      borderRadius: 8,
                      padding: 14,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <span className={`dot ${info.has_any ? "dot-green" : "dot-gray"}`} />
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{underlying}</span>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{info.display_name}</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                      {Object.entries(info.intervals).map(([ivLabel, ivData]) => (
                        <div
                          key={ivLabel}
                          onClick={() => ivData && router.push(`/data/${underlying}/${ivLabel}`)}
                          style={{
                            background: "var(--bg-card)",
                            border: `1px solid ${ivData ? "var(--green)44" : "var(--border-dim)"}`,
                            borderRadius: 6,
                            padding: "8px 10px",
                            cursor: ivData ? "pointer" : "default",
                            transition: "border-color .15s, background .15s",
                          }}
                          onMouseEnter={(e) => {
                            if (!ivData) return;
                            (e.currentTarget as HTMLElement).style.borderColor = "var(--green-hi)";
                            (e.currentTarget as HTMLElement).style.background = "rgba(5,150,105,.07)";
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.borderColor = ivData ? "var(--green)44" : "var(--border-dim)";
                            (e.currentTarget as HTMLElement).style.background = "var(--bg-card)";
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>{ivLabel}</span>
                            {ivData && <span style={{ fontSize: 9, color: "var(--green-hi)", opacity: 0.7 }}>↗</span>}
                          </div>
                          {ivData ? (
                            <>
                              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--green-hi)", fontFamily: "monospace" }}>
                                {ivData.count.toLocaleString()}
                              </div>
                              <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                                {ivData.from} →
                              </div>
                              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                                {ivData.to}
                              </div>
                            </>
                          ) : (
                            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Not synced</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", padding: 16 }}>
                <span className="spinner" />
                <span>Loading status…</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
