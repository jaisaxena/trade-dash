"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { createChart, CandlestickSeries, HistogramSeries, type IChartApi } from "lightweight-charts";
import { api } from "@/lib/api";

const INTERVAL_LABELS: Record<string, string> = {
  "1m": "1 Minute", "5m": "5 Minute", "15m": "15 Minute", "day": "Daily",
};

const PERIODS = [
  { label: "1W",  days: 7 },
  { label: "1M",  days: 30 },
  { label: "3M",  days: 90 },
  { label: "6M",  days: 180 },
  { label: "1Y",  days: 365 },
  { label: "3Y",  days: 1095 },
  { label: "MAX", days: 0 },
];

type Candle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function toUnix(ts: string): number {
  return Math.floor(new Date(ts).getTime() / 1000);
}

function dateStr(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

export default function CandlestickPage() {
  const params = useParams<{ underlying: string; interval: string }>();
  const router = useRouter();
  const underlying = (params.underlying ?? "").toUpperCase();
  const interval   = params.interval ?? "day";

  const [period, setPeriod] = useState("1Y");
  const selectedPeriod = PERIODS.find((p) => p.label === period)!;

  const fromDate = selectedPeriod.days > 0 ? dateStr(selectedPeriod.days) : undefined;
  const limit    = selectedPeriod.days === 0 ? 10000 : undefined;

  const candlesQuery = useQuery({
    queryKey: ["candles", underlying, interval, fromDate, limit],
    queryFn: () => {
      const params = new URLSearchParams({ underlying, interval });
      if (fromDate) params.set("from_date", fromDate);
      if (limit)    params.set("limit", String(limit));
      return api.get<{ count: number; candles: Candle[] }>(`/api/data/candles?${params}`);
    },
    enabled: !!underlying && !!interval,
  });

  const chartRef  = useRef<HTMLDivElement>(null);
  const chart     = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candleSer = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const volSer    = useRef<any>(null);

  // Init chart once on mount
  useEffect(() => {
    if (!chartRef.current) return;

    const c = createChart(chartRef.current, {
      width:  chartRef.current.clientWidth,
      height: 480,
      layout: {
        background: { color: "transparent" },
        textColor: "#4d6b8a",
      },
      grid: {
        vertLines: { color: "#1a284033" },
        horzLines: { color: "#1a284033" },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.05, bottom: 0.25 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    });

    candleSer.current = c.addSeries(CandlestickSeries, {
      upColor:         "#10b981",
      downColor:       "#ef4444",
      borderUpColor:   "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor:     "#10b981",
      wickDownColor:   "#ef4444",
    });

    volSer.current = c.addSeries(HistogramSeries, {
      color:        "#2563eb55",
      priceFormat:  { type: "volume" },
      priceScaleId: "vol",
    });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chart.current = c;

    const onResize = () => chartRef.current && c.applyOptions({ width: chartRef.current.clientWidth });
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      c.remove();
      chart.current    = null;
      candleSer.current = null;
      volSer.current    = null;
    };
  }, []);

  // Feed data whenever query resolves
  useEffect(() => {
    const candles = candlesQuery.data?.candles;
    if (!candles?.length || !candleSer.current || !volSer.current) return;

    const sorted = [...candles].sort((a, b) => toUnix(a.timestamp) - toUnix(b.timestamp));

    candleSer.current.setData(
      sorted.map((c) => ({
        time:  toUnix(c.timestamp) as unknown as string,
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
      }))
    );

    volSer.current.setData(
      sorted.map((c) => ({
        time:  toUnix(c.timestamp) as unknown as string,
        value: c.volume,
        color: c.close >= c.open ? "#10b98155" : "#ef444455",
      }))
    );

    chart.current?.timeScale().fitContent();
  }, [candlesQuery.data]);

  const candles = candlesQuery.data?.candles ?? [];
  const totalCount = candlesQuery.data?.count ?? 0;
  const first = candles.at(0);
  const last  = candles.at(-1);

  const change    = first && last ? last.close - first.close : null;
  const changePct = first && last && first.close !== 0 ? ((last.close - first.close) / first.close) * 100 : null;

  return (
    <div className="page">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => router.push("/data")}
          style={{ padding: "5px 12px", fontSize: 12 }}
        >
          ← Back
        </button>
        <div>
          <h1 className="page-title" style={{ marginBottom: 2 }}>
            {underlying}
            <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-muted)", marginLeft: 10 }}>
              {INTERVAL_LABELS[interval] ?? interval}
            </span>
          </h1>
          <p className="page-sub" style={{ margin: 0 }}>
            {totalCount.toLocaleString()} candles locally
            {first && <> · from {first.timestamp.slice(0, 10)}</>}
            {last  && <> → {last.timestamp.slice(0, 10)}</>}
          </p>
        </div>

        {/* Stats */}
        {last && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 20, alignItems: "center" }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Last Close</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace" }}>
                ₹{last.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </div>
            </div>
            {change !== null && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Period Change</div>
                <div style={{
                  fontSize: 14,
                  fontWeight: 700,
                  fontFamily: "monospace",
                  color: change >= 0 ? "var(--green-hi)" : "var(--red-hi)",
                }}>
                  {change >= 0 ? "+" : ""}{changePct?.toFixed(2)}%
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Chart card */}
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        {/* Period selector */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
          {PERIODS.map((p) => (
            <button
              key={p.label}
              onClick={() => setPeriod(p.label)}
              style={{
                padding: "4px 12px",
                borderRadius: 5,
                fontSize: 12,
                fontWeight: 700,
                border: `1px solid ${period === p.label ? "var(--accent-hi)" : "var(--border-dim)"}`,
                background: period === p.label ? "rgba(37,99,235,.2)" : "transparent",
                color: period === p.label ? "var(--accent-hi)" : "var(--text-muted)",
                cursor: "pointer",
                transition: "all .12s",
              }}
            >
              {p.label}
            </button>
          ))}

          {candlesQuery.isFetching && (
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
              <span className="spinner" /> Loading…
            </span>
          )}
        </div>

        {/* Chart container */}
        <div ref={chartRef} style={{ borderRadius: 6, overflow: "hidden" }} />

        {/* Error / empty states */}
        {candlesQuery.isError && (
          <div style={{ padding: 32, textAlign: "center", color: "var(--red-hi)" }}>
            Failed to load candle data. Is the backend running?
          </div>
        )}
        {candlesQuery.isSuccess && candles.length === 0 && (
          <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
            No data for this period. Try a larger period or sync more data.
          </div>
        )}
      </div>

      {/* OHLCV summary table (last 10 candles) */}
      {candles.length > 0 && (
        <div className="card" style={{ padding: 16 }}>
          <div className="section-header">Recent Candles</div>
          <table className="tbl" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Open</th>
                <th>High</th>
                <th>Low</th>
                <th>Close</th>
                <th>Volume</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {[...candles].reverse().slice(0, 15).map((c) => {
                const chg = c.close - c.open;
                const chgPct = c.open !== 0 ? (chg / c.open) * 100 : 0;
                return (
                  <tr key={c.timestamp}>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{c.timestamp.replace("T", " ").slice(0, 19)}</td>
                    <td style={{ fontFamily: "monospace" }}>{c.open.toFixed(2)}</td>
                    <td style={{ fontFamily: "monospace", color: "var(--green-hi)" }}>{c.high.toFixed(2)}</td>
                    <td style={{ fontFamily: "monospace", color: "var(--red-hi)" }}>{c.low.toFixed(2)}</td>
                    <td style={{ fontFamily: "monospace", fontWeight: 700 }}>{c.close.toFixed(2)}</td>
                    <td style={{ fontFamily: "monospace", color: "var(--text-muted)" }}>{c.volume.toLocaleString()}</td>
                    <td style={{
                      fontFamily: "monospace",
                      color: chg >= 0 ? "var(--green-hi)" : "var(--red-hi)",
                      fontWeight: 600,
                    }}>
                      {chg >= 0 ? "+" : ""}{chgPct.toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
