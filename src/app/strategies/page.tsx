"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

type Action = "BUY" | "SELL";
type OType  = "CE" | "PE";
type Strike = "ATM-5"|"ATM-4"|"ATM-3"|"ATM-2"|"ATM-1"|"ATM+0"|"ATM+1"|"ATM+2"|"ATM+3"|"ATM+4"|"ATM+5";

interface Leg { action: Action; option_type: OType; strike: Strike; lots: number }

type Operator = "<" | ">" | "<=" | ">=" | "==" | "crossover" | "crossunder";
interface Entry { indicator: string; params: Record<string, number>; condition: Operator; value: number }
interface Exit  { type: string; value: number | string }

interface Recipe {
  name: string;
  underlying: string;
  expiry_offset: string;
  structure: { legs: Leg[] };
  entry_conditions: Entry[];
  exit_conditions: Exit[];
  param_ranges: Record<string, number[]>;
}

const INDICATORS: Record<string, { params: Record<string, number>; defaultCondition: Operator; defaultValue: number }> = {
  RSI:        { params: { period: 14 },                                 defaultCondition: "<",  defaultValue: 30 },
  SMA:        { params: { period: 20 },                                 defaultCondition: "crossover", defaultValue: 0 },
  EMA:        { params: { period: 20 },                                 defaultCondition: "crossover", defaultValue: 0 },
  MACD:       { params: { fast: 12, slow: 26, signal: 9 },              defaultCondition: "crossover", defaultValue: 0 },
  BOLLINGER:  { params: { period: 20, std_dev: 2 },                     defaultCondition: "<",  defaultValue: 20 },
  ATR:        { params: { period: 14 },                                 defaultCondition: ">",  defaultValue: 50 },
  VWAP:       { params: {},                                             defaultCondition: ">",  defaultValue: 0 },
  SUPERTREND: { params: { period: 10, multiplier: 3 },                  defaultCondition: "==", defaultValue: 1 },
  ADX:        { params: { period: 14 },                                 defaultCondition: ">",  defaultValue: 25 },
  STOCHASTIC: { params: { k_period: 14, d_period: 3 },                  defaultCondition: "<",  defaultValue: 20 },
  CCI:        { params: { period: 20 },                                 defaultCondition: "<",  defaultValue: -100 },
  WILLIAMS_R: { params: { period: 14 },                                 defaultCondition: "<",  defaultValue: -80 },
};

const PARAM_RANGE_SUGGESTIONS: Record<string, Record<string, number[]>> = {
  RSI:        { period: [7, 9, 14, 21] },
  SMA:        { period: [9, 20, 50, 100] },
  EMA:        { period: [9, 20, 50, 100] },
  MACD:       { fast: [9, 12, 15], slow: [21, 26, 30], signal: [7, 9, 12] },
  BOLLINGER:  { period: [14, 20, 25], std_dev: [1.5, 2, 2.5] },
  ADX:        { period: [10, 14, 20] },
  STOCHASTIC: { k_period: [9, 14, 21] },
};

const DEFAULT_RECIPE: Recipe = {
  name: "",
  underlying: "NIFTY",
  expiry_offset: "weekly_current",
  structure: {
    legs: [{ action: "BUY", option_type: "CE", strike: "ATM+0", lots: 1 }],
  },
  entry_conditions: [
    { indicator: "RSI", params: { period: 14 }, condition: "<", value: 30 },
  ],
  exit_conditions: [
    { type: "target_pct", value: 50 },
    { type: "stop_pct",   value: 30 },
    { type: "time_exit",  value: "15:15" },
  ],
  param_ranges: { "RSI.period": [7, 9, 14, 21] },
};

function SectionHeader({ title }: { title: string }) {
  return <div className="section-header">{title}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

export default function StrategiesPage() {
  const qc = useQueryClient();
  const [recipe, setRecipe] = useState<Recipe>(DEFAULT_RECIPE);
  const [showJson, setShowJson] = useState(false);

  const update = (patch: Partial<Recipe>) => setRecipe((r) => ({ ...r, ...patch }));

  // Legs
  const addLeg = () =>
    update({ structure: { legs: [...recipe.structure.legs, { action: "BUY", option_type: "CE", strike: "ATM+0", lots: 1 }] } });
  const removeLeg = (i: number) =>
    update({ structure: { legs: recipe.structure.legs.filter((_, j) => j !== i) } });
  const updateLeg = (i: number, patch: Partial<Leg>) => {
    const legs = recipe.structure.legs.map((l, j) => j === i ? { ...l, ...patch } : l);
    update({ structure: { legs } });
  };

  // Entry conditions
  const addEntry = () => {
    const ind = "RSI";
    const def = INDICATORS[ind];
    const newCond: Entry = { indicator: ind, params: { ...def.params }, condition: def.defaultCondition, value: def.defaultValue };
    update({ entry_conditions: [...recipe.entry_conditions, newCond] });
  };
  const removeEntry = (i: number) => update({ entry_conditions: recipe.entry_conditions.filter((_, j) => j !== i) });
  const updateEntry = (i: number, patch: Partial<Entry>) => {
    const conds = recipe.entry_conditions.map((c, j) => j === i ? { ...c, ...patch } : c);
    update({ entry_conditions: conds });
  };
  const changeIndicator = (i: number, ind: string) => {
    const def = INDICATORS[ind];
    if (!def) return;
    updateEntry(i, { indicator: ind, params: { ...def.params }, condition: def.defaultCondition, value: def.defaultValue });
  };

  // Param ranges — auto-suggest based on entry conditions
  const autoFillRanges = () => {
    const ranges: Record<string, number[]> = {};
    recipe.entry_conditions.forEach((cond) => {
      const sugg = PARAM_RANGE_SUGGESTIONS[cond.indicator] || {};
      Object.entries(sugg).forEach(([param, vals]) => {
        ranges[`${cond.indicator}.${param}`] = vals;
      });
    });
    update({ param_ranges: ranges });
  };

  const saveMutation = useMutation({
    mutationFn: () => api.post("/api/vault/strategies", recipe),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["strategies"] });
      alert("✓ Strategy saved to vault");
    },
  });

  const isValid = recipe.name.trim().length > 0 && recipe.structure.legs.length > 0 && recipe.entry_conditions.length > 0;

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Strategy Builder</h1>
          <p className="page-sub">Build your option strategy recipe — define legs, indicators, and exit rules.</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowJson(!showJson)}>
            {showJson ? "Form View" : "JSON View"}
          </button>
          <button className="btn btn-success" disabled={!isValid || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            Save to Vault
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: showJson ? "1fr 1fr" : "1fr", gap: 16 }}>
        {/* Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Basic */}
          <div className="card" style={{ padding: 16 }}>
            <SectionHeader title="Basic Info" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <Field label="Strategy Name">
                <input className="input" placeholder="e.g. Bull Call Spread RSI" value={recipe.name} onChange={(e) => update({ name: e.target.value })} />
              </Field>
              <Field label="Underlying">
                <select className="input" value={recipe.underlying} onChange={(e) => update({ underlying: e.target.value })}>
                  {["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"].map((u) => <option key={u}>{u}</option>)}
                </select>
              </Field>
              <Field label="Expiry">
                <select className="input" value={recipe.expiry_offset} onChange={(e) => update({ expiry_offset: e.target.value })}>
                  <option value="weekly_current">Weekly Current</option>
                  <option value="weekly_next">Weekly Next</option>
                  <option value="monthly_current">Monthly Current</option>
                  <option value="monthly_next">Monthly Next</option>
                </select>
              </Field>
            </div>
          </div>

          {/* Option Structure */}
          <div className="card" style={{ padding: 16 }}>
            <SectionHeader title="Option Legs" />
            <table className="tbl" style={{ marginBottom: 10 }}>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Type</th>
                  <th>Strike</th>
                  <th>Lots</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recipe.structure.legs.map((leg, i) => (
                  <tr key={i}>
                    <td>
                      <select className="input" style={{ padding: "5px 8px" }} value={leg.action} onChange={(e) => updateLeg(i, { action: e.target.value as Action })}>
                        <option value="BUY">BUY</option>
                        <option value="SELL">SELL</option>
                      </select>
                    </td>
                    <td>
                      <select className="input" style={{ padding: "5px 8px" }} value={leg.option_type} onChange={(e) => updateLeg(i, { option_type: e.target.value as OType })}>
                        <option value="CE">CE (Call)</option>
                        <option value="PE">PE (Put)</option>
                      </select>
                    </td>
                    <td>
                      <select className="input" style={{ padding: "5px 8px", fontFamily: "monospace" }} value={leg.strike} onChange={(e) => updateLeg(i, { strike: e.target.value as Strike })}>
                        {["ATM-5","ATM-4","ATM-3","ATM-2","ATM-1","ATM+0","ATM+1","ATM+2","ATM+3","ATM+4","ATM+5"].map((s) => <option key={s}>{s}</option>)}
                      </select>
                    </td>
                    <td>
                      <input type="number" min={1} className="input" style={{ padding: "5px 8px", width: 60 }} value={leg.lots} onChange={(e) => updateLeg(i, { lots: parseInt(e.target.value) || 1 })} />
                    </td>
                    <td>
                      {recipe.structure.legs.length > 1 && (
                        <button className="btn btn-ghost btn-sm" style={{ color: "var(--red-hi)" }} onClick={() => removeLeg(i)}>✕</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-ghost btn-sm" onClick={addLeg}>+ Add Leg</button>
          </div>

          {/* Entry conditions */}
          <div className="card" style={{ padding: 16 }}>
            <SectionHeader title="Entry Conditions (ALL must be true)" />
            {recipe.entry_conditions.map((cond, i) => {
              const def = INDICATORS[cond.indicator] || { params: {} };
              return (
                <div key={i} style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-dim)", borderRadius: 6, padding: 12, marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <div>
                      <span className="label">Indicator</span>
                      <select className="input" style={{ width: 130 }} value={cond.indicator} onChange={(e) => changeIndicator(i, e.target.value)}>
                        {Object.keys(INDICATORS).map((k) => <option key={k}>{k}</option>)}
                      </select>
                    </div>
                    {Object.entries(cond.params).map(([param, val]) => (
                      <div key={param}>
                        <span className="label">{param}</span>
                        <input type="number" className="input" style={{ width: 70 }} value={val} onChange={(e) => updateEntry(i, { params: { ...cond.params, [param]: parseFloat(e.target.value) || 0 } })} />
                      </div>
                    ))}
                    <div>
                      <span className="label">Condition</span>
                      <select className="input" style={{ width: 120 }} value={cond.condition} onChange={(e) => updateEntry(i, { condition: e.target.value as Operator })}>
                        {["<", ">", "<=", ">=", "==", "crossover", "crossunder"].map((op) => <option key={op}>{op}</option>)}
                      </select>
                    </div>
                    {cond.condition !== "crossover" && cond.condition !== "crossunder" && (
                      <div>
                        <span className="label">Value</span>
                        <input type="number" className="input" style={{ width: 80 }} value={cond.value} onChange={(e) => updateEntry(i, { value: parseFloat(e.target.value) })} />
                      </div>
                    )}
                    <button className="btn btn-ghost btn-sm" style={{ color: "var(--red-hi)", marginBottom: 0 }} onClick={() => removeEntry(i)}>✕</button>
                  </div>
                </div>
              );
            })}
            <button className="btn btn-ghost btn-sm" onClick={addEntry}>+ Add Condition</button>
          </div>

          {/* Exit conditions */}
          <div className="card" style={{ padding: 16 }}>
            <SectionHeader title="Exit Rules" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              <Field label="Target % (profit)">
                <input type="number" className="input" value={recipe.exit_conditions.find((e) => e.type === "target_pct")?.value ?? 50}
                  onChange={(e) => {
                    const ec = recipe.exit_conditions.map((c) => c.type === "target_pct" ? { ...c, value: parseFloat(e.target.value) } : c);
                    update({ exit_conditions: ec });
                  }} />
              </Field>
              <Field label="Stop Loss %">
                <input type="number" className="input" value={recipe.exit_conditions.find((e) => e.type === "stop_pct")?.value ?? 30}
                  onChange={(e) => {
                    const ec = recipe.exit_conditions.map((c) => c.type === "stop_pct" ? { ...c, value: parseFloat(e.target.value) } : c);
                    update({ exit_conditions: ec });
                  }} />
              </Field>
              <Field label="Time Exit (IST)">
                <input type="time" className="input" value={String(recipe.exit_conditions.find((e) => e.type === "time_exit")?.value ?? "15:15")}
                  onChange={(e) => {
                    const ec = recipe.exit_conditions.map((c) => c.type === "time_exit" ? { ...c, value: e.target.value } : c);
                    update({ exit_conditions: ec });
                  }} />
              </Field>
            </div>
          </div>

          {/* Param ranges */}
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div className="section-header" style={{ marginBottom: 0 }}>Parameter Ranges (for Optimizer)</div>
              <button className="btn btn-ghost btn-sm" onClick={autoFillRanges}>Auto-fill from indicators</button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
              Define which parameter values the optimizer should try. Leave empty to use fixed params.
            </p>
            {Object.entries(recipe.param_ranges).map(([key, vals]) => (
              <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--accent-hi)", width: 180, flexShrink: 0 }}>{key}</span>
                <input
                  className="input"
                  placeholder="comma-separated values: 7, 9, 14, 21"
                  value={vals.join(", ")}
                  onChange={(e) => {
                    const nums = e.target.value.split(",").map((v) => parseFloat(v.trim())).filter((n) => !isNaN(n));
                    update({ param_ranges: { ...recipe.param_ranges, [key]: nums } });
                  }}
                />
                <button className="btn btn-ghost btn-sm" style={{ color: "var(--red-hi)", flexShrink: 0 }} onClick={() => {
                  const { [key]: _, ...rest } = recipe.param_ranges;
                  update({ param_ranges: rest });
                }}>✕</button>
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" onClick={() => {
              const key = `NEW_PARAM.field`;
              update({ param_ranges: { ...recipe.param_ranges, [key]: [] } });
            }}>+ Add Range</button>
          </div>
        </div>

        {/* JSON preview */}
        {showJson && (
          <div className="card" style={{ padding: 16 }}>
            <div className="section-header">Recipe JSON Preview</div>
            <pre style={{
              fontFamily: "monospace",
              fontSize: 12,
              color: "var(--text-muted)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-dim)",
              borderRadius: 6,
              padding: 12,
              overflow: "auto",
              maxHeight: "calc(100vh - 200px)",
              whiteSpace: "pre-wrap",
              margin: 0,
            }}>
              {JSON.stringify(recipe, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
