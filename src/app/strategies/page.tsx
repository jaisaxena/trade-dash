"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

type Action = "BUY" | "SELL";
type OType  = "CE" | "PE";
type Strike = "ATM-5"|"ATM-4"|"ATM-3"|"ATM-2"|"ATM-1"|"ATM+0"|"ATM+1"|"ATM+2"|"ATM+3"|"ATM+4"|"ATM+5";
type Direction = "long" | "short";

interface Leg { action: Action; option_type: OType; strike: Strike; lots: number }

type Operator = "<" | ">" | "<=" | ">=" | "==" | "crossover" | "crossunder";

interface IndicatorVar {
  name: string;       // user-defined, e.g. "fast_ema"
  indicator: string;  // type, e.g. "EMA"
  params: Record<string, number>;
}

interface Entry {
  indicator: string;           // var name OR raw indicator type (legacy)
  params: Record<string, number>;
  condition: Operator;
  value: number;
  compare_indicator?: string | null;  // var name OR raw indicator type (legacy)
  compare_params?: Record<string, number>;
  direction: Direction;
  indicator_alias?: string;   // legacy alias field — kept for backward compat
  compare_alias?: string;     // legacy alias field — kept for backward compat
}
interface Exit  { type: string; value?: number | string }

interface Recipe {
  name: string;
  underlying: string;
  expiry_offset: string;
  long_structure: { legs: Leg[] };
  short_structure: { legs: Leg[] };
  indicator_vars: IndicatorVar[];
  entry_conditions: Entry[];
  exit_indicator_conditions: Entry[];   // indicator-based directional exits
  exit_conditions: Exit[];
  param_ranges: Record<string, number[]>;
}

const INDICATORS: Record<string, { params: Record<string, number>; defaultCondition: Operator; defaultValue: number }> = {
  // ── Raw price / volume ─────────────────────────────────────────────
  CLOSE:      { params: {},                                             defaultCondition: ">",  defaultValue: 0 },
  OPEN:       { params: {},                                             defaultCondition: ">",  defaultValue: 0 },
  HIGH:       { params: {},                                             defaultCondition: ">",  defaultValue: 0 },
  LOW:        { params: {},                                             defaultCondition: ">",  defaultValue: 0 },
  VOLUME:     { params: {},                                             defaultCondition: ">",  defaultValue: 500000 },
  // ── Technical indicators ───────────────────────────────────────────
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
  long_structure: {
    legs: [{ action: "BUY", option_type: "CE", strike: "ATM+0", lots: 1 }],
  },
  short_structure: {
    legs: [{ action: "BUY", option_type: "PE", strike: "ATM+0", lots: 1 }],
  },
  indicator_vars: [],
  entry_conditions: [
    { indicator: "RSI", params: { period: 14 }, condition: "<", value: 30, direction: "long" },
  ],
  exit_indicator_conditions: [],
  exit_conditions: [
    { type: "target_pct", value: 50 },
    { type: "stop_pct",   value: 30 },
    { type: "time_exit",  value: "15:15" },
    { type: "direction_change" },
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

function LegTable({
  legs,
  onUpdate,
  onRemove,
  onAdd,
}: {
  legs: Leg[];
  onUpdate: (i: number, patch: Partial<Leg>) => void;
  onRemove: (i: number) => void;
  onAdd: () => void;
}) {
  return (
    <>
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
          {legs.map((leg, i) => (
            <tr key={i}>
              <td>
                <select className="input" style={{ padding: "5px 8px" }} value={leg.action} onChange={(e) => onUpdate(i, { action: e.target.value as Action })}>
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                </select>
              </td>
              <td>
                <select className="input" style={{ padding: "5px 8px" }} value={leg.option_type} onChange={(e) => onUpdate(i, { option_type: e.target.value as OType })}>
                  <option value="CE">CE (Call)</option>
                  <option value="PE">PE (Put)</option>
                </select>
              </td>
              <td>
                <select className="input" style={{ padding: "5px 8px", fontFamily: "monospace" }} value={leg.strike} onChange={(e) => onUpdate(i, { strike: e.target.value as Strike })}>
                  {["ATM-5","ATM-4","ATM-3","ATM-2","ATM-1","ATM+0","ATM+1","ATM+2","ATM+3","ATM+4","ATM+5"].map((s) => <option key={s}>{s}</option>)}
                </select>
              </td>
              <td>
                <input type="number" min={1} className="input" style={{ padding: "5px 8px", width: 60 }} value={leg.lots} onChange={(e) => onUpdate(i, { lots: parseInt(e.target.value) || 1 })} />
              </td>
              <td>
                {legs.length > 1 && (
                  <button className="btn btn-ghost btn-sm" style={{ color: "var(--red-hi)" }} onClick={() => onRemove(i)}>✕</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-ghost btn-sm" onClick={onAdd}>+ Add Leg</button>
    </>
  );
}

export default function StrategiesPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get("edit");

  const [recipe, setRecipe] = useState<Recipe>(DEFAULT_RECIPE);
  const [showJson, setShowJson] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const update = (patch: Partial<Recipe>) => setRecipe((r) => ({ ...r, ...patch }));

  const loadStrategy = useCallback(async (id: string) => {
    setEditLoading(true);
    setEditError(null);
    try {
      const data = await api.get<{ strategy: Recipe & { id: string } }>(`/api/vault/strategies/${id}`);
      const s = data.strategy;
      setRecipe({
        name: s.name,
        underlying: s.underlying,
        expiry_offset: s.expiry_offset,
        long_structure: s.long_structure,
        short_structure: s.short_structure,
        indicator_vars: s.indicator_vars ?? [],
        entry_conditions: s.entry_conditions,
        exit_indicator_conditions: s.exit_indicator_conditions ?? [],
        exit_conditions: s.exit_conditions,
        param_ranges: s.param_ranges ?? {},
      });
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : "Failed to load strategy");
    } finally {
      setEditLoading(false);
    }
  }, []);

  useEffect(() => {
    if (editId) loadStrategy(editId);
  }, [editId, loadStrategy]);

  // Long legs
  const addLongLeg = () =>
    update({ long_structure: { legs: [...recipe.long_structure.legs, { action: "BUY", option_type: "CE", strike: "ATM+0", lots: 1 }] } });
  const removeLongLeg = (i: number) =>
    update({ long_structure: { legs: recipe.long_structure.legs.filter((_, j) => j !== i) } });
  const updateLongLeg = (i: number, patch: Partial<Leg>) => {
    const legs = recipe.long_structure.legs.map((l, j) => j === i ? { ...l, ...patch } : l);
    update({ long_structure: { legs } });
  };

  // Short legs
  const addShortLeg = () =>
    update({ short_structure: { legs: [...recipe.short_structure.legs, { action: "BUY", option_type: "PE", strike: "ATM+0", lots: 1 }] } });
  const removeShortLeg = (i: number) =>
    update({ short_structure: { legs: recipe.short_structure.legs.filter((_, j) => j !== i) } });
  const updateShortLeg = (i: number, patch: Partial<Leg>) => {
    const legs = recipe.short_structure.legs.map((l, j) => j === i ? { ...l, ...patch } : l);
    update({ short_structure: { legs } });
  };

  // Indicator variables
  const vars = recipe.indicator_vars || [];
  const useVars = vars.length > 0;

  const addVar = () => {
    const ind = "EMA";
    update({ indicator_vars: [...vars, { name: "", indicator: ind, params: { ...INDICATORS[ind].params } }] });
  };
  const updateVar = (i: number, patch: Partial<IndicatorVar>) => {
    update({ indicator_vars: vars.map((v, j) => j === i ? { ...v, ...patch } : v) });
  };
  const removeVar = (i: number) => {
    update({ indicator_vars: vars.filter((_, j) => j !== i) });
  };
  const changeVarIndicator = (i: number, ind: string) => {
    const def = INDICATORS[ind];
    if (!def) return;
    updateVar(i, { indicator: ind, params: { ...def.params } });
  };

  // Entry conditions
  const addEntry = () => {
    if (useVars && vars[0]) {
      // Default to first defined variable
      const v = vars[0];
      const def = INDICATORS[v.indicator];
      update({ entry_conditions: [...recipe.entry_conditions, {
        indicator: v.name, params: { ...v.params },
        condition: def?.defaultCondition ?? "<", value: def?.defaultValue ?? 0,
        direction: "long",
      }] });
    } else {
      const ind = "RSI";
      const def = INDICATORS[ind];
      update({ entry_conditions: [...recipe.entry_conditions, {
        indicator: ind, params: { ...def.params },
        condition: def.defaultCondition, value: def.defaultValue, direction: "long",
      }] });
    }
  };
  const removeEntry = (i: number) => update({ entry_conditions: recipe.entry_conditions.filter((_, j) => j !== i) });
  const updateEntry = (i: number, patch: Partial<Entry>) => {
    const conds = recipe.entry_conditions.map((c, j) => j === i ? { ...c, ...patch } : c);
    update({ entry_conditions: conds });
  };

  const changeIndicator = (i: number, val: string) => {
    const varDef = vars.find(v => v.name === val);
    if (varDef) {
      const def = INDICATORS[varDef.indicator];
      updateEntry(i, {
        indicator: val, params: { ...varDef.params },
        condition: def?.defaultCondition ?? "<", value: def?.defaultValue ?? 0,
        compare_indicator: null, compare_params: {},
      });
    } else {
      const def = INDICATORS[val];
      if (!def) return;
      updateEntry(i, { indicator: val, params: { ...def.params }, condition: def.defaultCondition, value: def.defaultValue, compare_indicator: null, compare_params: {} });
    }
  };

  const changeCompareIndicator = (i: number, val: string) => {
    if (!val) {
      updateEntry(i, { compare_indicator: null, compare_params: {} });
      return;
    }
    const varDef = vars.find(v => v.name === val);
    if (varDef) {
      updateEntry(i, { compare_indicator: val, compare_params: { ...varDef.params } });
    } else {
      const def = INDICATORS[val];
      updateEntry(i, { compare_indicator: val, compare_params: def ? { ...def.params } : {} });
    }
  };

  // Exit indicator conditions (same structure as entry, but direction means "exit long/short")
  const addExitCond = () => {
    if (useVars && vars[0]) {
      const v = vars[0];
      const def = INDICATORS[v.indicator];
      update({ exit_indicator_conditions: [...(recipe.exit_indicator_conditions || []), {
        indicator: v.name, params: { ...v.params },
        condition: def?.defaultCondition ?? "<", value: def?.defaultValue ?? 0,
        direction: "long",
      }] });
    } else {
      const ind = "RSI";
      const def = INDICATORS[ind];
      update({ exit_indicator_conditions: [...(recipe.exit_indicator_conditions || []), {
        indicator: ind, params: { ...def.params },
        condition: def.defaultCondition, value: def.defaultValue, direction: "long",
      }] });
    }
  };
  const removeExitCond = (i: number) =>
    update({ exit_indicator_conditions: (recipe.exit_indicator_conditions || []).filter((_, j) => j !== i) });
  const updateExitCond = (i: number, patch: Partial<Entry>) => {
    update({ exit_indicator_conditions: (recipe.exit_indicator_conditions || []).map((c, j) => j === i ? { ...c, ...patch } : c) });
  };
  const changeExitIndicator = (i: number, val: string) => {
    const varDef = vars.find(v => v.name === val);
    if (varDef) {
      const def = INDICATORS[varDef.indicator];
      updateExitCond(i, { indicator: val, params: { ...varDef.params }, condition: def?.defaultCondition ?? "<", value: def?.defaultValue ?? 0, compare_indicator: null, compare_params: {} });
    } else {
      const def = INDICATORS[val];
      if (!def) return;
      updateExitCond(i, { indicator: val, params: { ...def.params }, condition: def.defaultCondition, value: def.defaultValue, compare_indicator: null, compare_params: {} });
    }
  };
  const changeExitCompareIndicator = (i: number, val: string) => {
    if (!val) { updateExitCond(i, { compare_indicator: null, compare_params: {} }); return; }
    const varDef = vars.find(v => v.name === val);
    if (varDef) {
      updateExitCond(i, { compare_indicator: val, compare_params: { ...varDef.params } });
    } else {
      const def = INDICATORS[val];
      updateExitCond(i, { compare_indicator: val, compare_params: def ? { ...def.params } : {} });
    }
  };

  // Direction change exit toggle
  const hasDirectionChangeExit = recipe.exit_conditions.some((e) => e.type === "direction_change");
  const toggleDirectionChangeExit = () => {
    if (hasDirectionChangeExit) {
      update({ exit_conditions: recipe.exit_conditions.filter((e) => e.type !== "direction_change") });
    } else {
      update({ exit_conditions: [...recipe.exit_conditions, { type: "direction_change" }] });
    }
  };

  // Param-range key helpers — prefer named variables, fall back to legacy aliases / raw types.
  const availableRangeKeys = (): string[] => {
    const keys = new Set<string>();
    if (useVars) {
      vars.forEach((v) => {
        Object.keys(INDICATORS[v.indicator]?.params ?? {}).forEach((p) =>
          keys.add(`${v.name}.${p}`)
        );
      });
    } else {
      recipe.entry_conditions.forEach((cond) => {
        const mk = cond.indicator_alias || cond.indicator;
        Object.keys(INDICATORS[cond.indicator]?.params ?? {}).forEach((p) => keys.add(`${mk}.${p}`));
        if (cond.compare_indicator) {
          const ck = cond.compare_alias || `compare_${cond.compare_indicator}`;
          Object.keys(INDICATORS[cond.compare_indicator]?.params ?? {}).forEach((p) => keys.add(`${ck}.${p}`));
        }
      });
    }
    return [...keys];
  };

  const autoFillRanges = () => {
    const ranges: Record<string, number[]> = {};
    if (useVars) {
      vars.forEach((v) => {
        const sugg = PARAM_RANGE_SUGGESTIONS[v.indicator] || {};
        Object.entries(sugg).forEach(([param, vals]) => { ranges[`${v.name}.${param}`] = vals; });
      });
    } else {
      recipe.entry_conditions.forEach((cond) => {
        const mk = cond.indicator_alias || cond.indicator;
        Object.entries(PARAM_RANGE_SUGGESTIONS[cond.indicator] || {}).forEach(([p, v]) => { ranges[`${mk}.${p}`] = v; });
        if (cond.compare_indicator && (cond.condition === "crossover" || cond.condition === "crossunder")) {
          const ck = cond.compare_alias || `compare_${cond.compare_indicator}`;
          Object.entries(PARAM_RANGE_SUGGESTIONS[cond.compare_indicator] || {}).forEach(([p, v]) => { ranges[`${ck}.${p}`] = v; });
        }
      });
    }
    update({ param_ranges: ranges });
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      editId
        ? api.patch(`/api/vault/strategies/${editId}`, recipe)
        : api.post("/api/vault/strategies", recipe),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["strategies"] });
      if (editId) {
        alert("✓ Strategy updated");
        router.push("/vault");
      } else {
        alert("✓ Strategy saved to vault");
      }
    },
  });

  const isValid = recipe.name.trim().length > 0
    && (recipe.long_structure.legs.length > 0 || recipe.short_structure.legs.length > 0)
    && recipe.entry_conditions.length > 0;

  if (editLoading) {
    return (
      <div className="page">
        <h1 className="page-title">Loading strategy…</h1>
      </div>
    );
  }

  if (editError) {
    return (
      <div className="page">
        <h1 className="page-title">Error</h1>
        <p style={{ color: "var(--red-hi)" }}>{editError}</p>
        <a href="/vault" className="btn btn-ghost" style={{ marginTop: 12, textDecoration: "none" }}>← Back to Vault</a>
      </div>
    );
  }

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 className="page-title">{editId ? "Edit Strategy" : "Strategy Builder"}</h1>
          <p className="page-sub">
            {editId
              ? <>Editing <strong>{recipe.name || "…"}</strong> — modify fields and save.</>
              : "Build your option strategy recipe — define directional legs, indicators, and exit rules."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {editId && (
            <a href="/vault" className="btn btn-ghost btn-sm" style={{ textDecoration: "none" }}>← Cancel</a>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setShowJson(!showJson)}>
            {showJson ? "Form View" : "JSON View"}
          </button>
          <button className="btn btn-success" disabled={!isValid || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? "Saving…" : editId ? "Update Strategy" : "Save to Vault"}
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
                <input className="input" placeholder="e.g. Directional RSI Strategy" value={recipe.name} onChange={(e) => update({ name: e.target.value })} />
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

          {/* Long & Short Legs side-by-side */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="card" style={{ padding: 16 }}>
              <SectionHeader title="Long Legs" />
              <p style={{ fontSize: 11, color: "var(--green-hi)", marginBottom: 8, fontWeight: 600 }}>Executed when signal = LONG</p>
              <LegTable legs={recipe.long_structure.legs} onUpdate={updateLongLeg} onRemove={removeLongLeg} onAdd={addLongLeg} />
            </div>
            <div className="card" style={{ padding: 16 }}>
              <SectionHeader title="Short Legs" />
              <p style={{ fontSize: 11, color: "var(--red-hi)", marginBottom: 8, fontWeight: 600 }}>Executed when signal = SHORT</p>
              <LegTable legs={recipe.short_structure.legs} onUpdate={updateShortLeg} onRemove={removeShortLeg} onAdd={addShortLeg} />
            </div>
          </div>

          {/* Indicator Variables */}
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionHeader title="Indicator Variables" />
              <button className="btn btn-ghost btn-sm" onClick={addVar}>+ Add Variable</button>
            </div>
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
              Name each indicator instance once here (e.g. <code style={{ color: "var(--accent-hi)" }}>fast_ema</code>,{" "}
              <code style={{ color: "var(--accent-hi)" }}>slow_ema</code>), then reference them by name in conditions below.
              The optimizer uses these names as param keys — <code style={{ color: "var(--accent-hi)" }}>fast_ema.period</code> and{" "}
              <code style={{ color: "var(--accent-hi)" }}>slow_ema.period</code> are fully independent.
            </p>
            {vars.length === 0 && (
              <p style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
                No variables defined — entry conditions use raw indicator types (legacy mode).
              </p>
            )}
            {vars.map((v, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 8 }}>
                <div>
                  <span className="label">Name</span>
                  <input
                    className="input mono"
                    style={{ width: 150 }}
                    placeholder="e.g. fast_ema"
                    value={v.name}
                    onChange={(e) => updateVar(i, { name: e.target.value })}
                  />
                </div>
                <div>
                  <span className="label">Type</span>
                  <select className="input" style={{ width: 120 }} value={v.indicator} onChange={(e) => changeVarIndicator(i, e.target.value)}>
                    {Object.keys(INDICATORS).map((k) => <option key={k}>{k}</option>)}
                  </select>
                </div>
                {Object.entries(v.params).map(([param, val]) => (
                  <div key={param}>
                    <span className="label">{param}</span>
                    <input
                      type="number"
                      className="input"
                      style={{ width: 70 }}
                      value={val}
                      onChange={(e) => updateVar(i, { params: { ...v.params, [param]: parseFloat(e.target.value) || 0 } })}
                    />
                  </div>
                ))}
                <button className="btn btn-ghost btn-sm" style={{ color: "var(--red-hi)", marginBottom: 0 }} onClick={() => removeVar(i)}>✕</button>
              </div>
            ))}
          </div>

          {/* Entry conditions */}
          <div className="card" style={{ padding: 16 }}>
            <SectionHeader title="Entry Conditions" />
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
              All conditions tagged LONG must be true for a LONG signal. Same for SHORT. If neither fires, signal is NEUTRAL (hold).
            </p>
            {recipe.entry_conditions.map((cond, i) => {
              // Resolve which var (if any) is currently selected for each side
              const selectedVar    = useVars ? vars.find(v => v.name === cond.indicator) : undefined;
              const selectedCmpVar = useVars ? vars.find(v => v.name === cond.compare_indicator) : undefined;

              return (
              <div key={i} style={{
                background: "var(--bg-elevated)",
                border: `1px solid ${cond.direction === "long" ? "rgba(5,150,105,.3)" : "rgba(220,38,38,.3)"}`,
                borderRadius: 6, padding: 12, marginBottom: 8,
              }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                  {/* Direction toggle */}
                  <div>
                    <span className="label">Direction</span>
                    <div style={{ display: "flex", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 5, padding: 2, gap: 2 }}>
                      {(["long", "short"] as const).map((d) => (
                        <button key={d} onClick={() => updateEntry(i, { direction: d })} style={{
                          padding: "3px 12px", borderRadius: 3, fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none",
                          background: cond.direction === d ? (d === "long" ? "rgba(5,150,105,.25)" : "rgba(220,38,38,.25)") : "transparent",
                          color: cond.direction === d ? (d === "long" ? "var(--green-hi)" : "var(--red-hi)") : "var(--text-muted)",
                          textTransform: "uppercase",
                        }}>{d}</button>
                      ))}
                    </div>
                  </div>

                  {/* Main indicator */}
                  <div>
                    <span className="label">Indicator</span>
                    {useVars ? (
                      <>
                        <select className="input" style={{ width: 150 }} value={cond.indicator} onChange={(e) => changeIndicator(i, e.target.value)}>
                          <option value="">— pick variable —</option>
                          {vars.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                        </select>
                        {selectedVar && (
                          <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", marginTop: 2 }}>
                            {selectedVar.indicator} · {Object.entries(selectedVar.params).map(([k, v]) => `${k}:${v}`).join(", ")}
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <select className="input" style={{ width: 130 }} value={cond.indicator} onChange={(e) => changeIndicator(i, e.target.value)}>
                          {Object.keys(INDICATORS).map((k) => <option key={k}>{k}</option>)}
                        </select>
                        {Object.entries(cond.params).map(([param, val]) => (
                          <div key={param} style={{ display: "inline-block", marginLeft: 8 }}>
                            <span className="label">{param}</span>
                            <input type="number" className="input" style={{ width: 70 }} value={val}
                              onChange={(e) => updateEntry(i, { params: { ...cond.params, [param]: parseFloat(e.target.value) || 0 } })} />
                          </div>
                        ))}
                      </>
                    )}
                  </div>

                  {/* Condition operator */}
                  <div>
                    <span className="label">Condition</span>
                    <select className="input" style={{ width: 120 }} value={cond.condition} onChange={(e) => updateEntry(i, { condition: e.target.value as Operator })}>
                      {["<", ">", "<=", ">=", "==", "crossover", "crossunder"].map((op) => <option key={op}>{op}</option>)}
                    </select>
                  </div>

                  {/* RHS — compare indicator or scalar value, available for all operators */}
                  <div>
                    <span className="label">vs</span>
                    {useVars ? (
                      <>
                        <select className="input" style={{ width: 150 }} value={cond.compare_indicator ?? ""} onChange={(e) => changeCompareIndicator(i, e.target.value)}>
                          <option value="">Fixed value</option>
                          {vars.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                        </select>
                        {selectedCmpVar && (
                          <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", marginTop: 2 }}>
                            {selectedCmpVar.indicator} · {Object.entries(selectedCmpVar.params).map(([k, v]) => `${k}:${v}`).join(", ")}
                          </div>
                        )}
                        {!cond.compare_indicator && (
                          <div style={{ display: "inline-block", marginLeft: 8 }}>
                            <input type="number" className="input" style={{ width: 80 }} value={cond.value} onChange={(e) => updateEntry(i, { value: parseFloat(e.target.value) })} />
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <select className="input" style={{ width: 130 }} value={cond.compare_indicator ?? ""} onChange={(e) => changeCompareIndicator(i, e.target.value)}>
                          <option value="">Fixed value</option>
                          {Object.keys(INDICATORS).map((k) => <option key={k}>{k}</option>)}
                        </select>
                        {cond.compare_indicator
                          ? Object.entries(cond.compare_params ?? {}).map(([param, val]) => (
                              <div key={param} style={{ display: "inline-block", marginLeft: 8 }}>
                                <span className="label">{param}</span>
                                <input type="number" className="input" style={{ width: 70 }} value={val}
                                  onChange={(e) => updateEntry(i, { compare_params: { ...cond.compare_params, [param]: parseFloat(e.target.value) || 0 } })} />
                              </div>
                            ))
                          : (
                              <div style={{ display: "inline-block", marginLeft: 8 }}>
                                <input type="number" className="input" style={{ width: 80 }} value={cond.value} onChange={(e) => updateEntry(i, { value: parseFloat(e.target.value) })} />
                              </div>
                            )
                        }
                      </>
                    )}
                  </div>

                  <button className="btn btn-ghost btn-sm" style={{ color: "var(--red-hi)", marginBottom: 0 }} onClick={() => removeEntry(i)}>✕</button>
                </div>
              </div>
              );
            })}
            <button className="btn btn-ghost btn-sm" onClick={addEntry}>+ Add Condition</button>
          </div>

          {/* Exit rules (rule-based) */}
          <div className="card" style={{ padding: 16 }}>
            <SectionHeader title="Exit Rules" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
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
              <Field label="Trailing Stop %">
                <input type="number" className="input"
                  placeholder="disabled"
                  value={recipe.exit_conditions.find((e) => e.type === "trailing_stop_pct")?.value ?? ""}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (isNaN(val) || val <= 0) {
                      update({ exit_conditions: recipe.exit_conditions.filter((c) => c.type !== "trailing_stop_pct") });
                    } else {
                      const has = recipe.exit_conditions.some((c) => c.type === "trailing_stop_pct");
                      update({ exit_conditions: has
                        ? recipe.exit_conditions.map((c) => c.type === "trailing_stop_pct" ? { ...c, value: val } : c)
                        : [...recipe.exit_conditions, { type: "trailing_stop_pct", value: val }],
                      });
                    }
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
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
              <input type="checkbox" checked={hasDirectionChangeExit} onChange={toggleDirectionChangeExit}
                style={{ accentColor: "var(--accent)" }} />
              Exit on direction reversal (auto-reverse)
            </label>
          </div>

          {/* Exit Conditions (indicator-based, directional) */}
          <div className="card" style={{ padding: 16 }}>
            <SectionHeader title="Exit Conditions (Indicator)" />
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
              Indicator conditions that close a position independently of the entry signal.
              <strong style={{ color: "var(--green-hi)" }}> Long Exit</strong> conditions close a long position.
              <strong style={{ color: "var(--red-hi)" }}> Short Exit</strong> conditions close a short position.
              All conditions within a direction are AND-combined.
            </p>
            {(recipe.exit_indicator_conditions || []).map((cond, i) => {
              const selectedVar    = useVars ? vars.find(v => v.name === cond.indicator) : undefined;
              const selectedCmpVar = useVars ? vars.find(v => v.name === cond.compare_indicator) : undefined;
              return (
              <div key={i} style={{
                background: "var(--bg-elevated)",
                border: `1px solid ${cond.direction === "long" ? "rgba(5,150,105,.3)" : "rgba(220,38,38,.3)"}`,
                borderRadius: 6, padding: 12, marginBottom: 8,
              }}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                  {/* Direction toggle — labels differ from entry */}
                  <div>
                    <span className="label">Exits</span>
                    <div style={{ display: "flex", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 5, padding: 2, gap: 2 }}>
                      {(["long", "short"] as const).map((d) => (
                        <button key={d} onClick={() => updateExitCond(i, { direction: d })} style={{
                          padding: "3px 10px", borderRadius: 3, fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none",
                          background: cond.direction === d ? (d === "long" ? "rgba(5,150,105,.25)" : "rgba(220,38,38,.25)") : "transparent",
                          color: cond.direction === d ? (d === "long" ? "var(--green-hi)" : "var(--red-hi)") : "var(--text-muted)",
                          textTransform: "uppercase", whiteSpace: "nowrap",
                        }}>{d === "long" ? "Long" : "Short"}</button>
                      ))}
                    </div>
                  </div>

                  {/* Indicator */}
                  <div>
                    <span className="label">Indicator</span>
                    {useVars ? (
                      <>
                        <select className="input" style={{ width: 150 }} value={cond.indicator} onChange={(e) => changeExitIndicator(i, e.target.value)}>
                          <option value="">— pick variable —</option>
                          {vars.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                        </select>
                        {selectedVar && (
                          <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", marginTop: 2 }}>
                            {selectedVar.indicator} · {Object.entries(selectedVar.params).map(([k, v]) => `${k}:${v}`).join(", ")}
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <select className="input" style={{ width: 130 }} value={cond.indicator} onChange={(e) => changeExitIndicator(i, e.target.value)}>
                          {Object.keys(INDICATORS).map((k) => <option key={k}>{k}</option>)}
                        </select>
                        {Object.entries(cond.params).map(([param, val]) => (
                          <div key={param} style={{ display: "inline-block", marginLeft: 8 }}>
                            <span className="label">{param}</span>
                            <input type="number" className="input" style={{ width: 70 }} value={val}
                              onChange={(e) => updateExitCond(i, { params: { ...cond.params, [param]: parseFloat(e.target.value) || 0 } })} />
                          </div>
                        ))}
                      </>
                    )}
                  </div>

                  {/* Condition */}
                  <div>
                    <span className="label">Condition</span>
                    <select className="input" style={{ width: 120 }} value={cond.condition} onChange={(e) => updateExitCond(i, { condition: e.target.value as Operator })}>
                      {["<", ">", "<=", ">=", "==", "crossover", "crossunder"].map((op) => <option key={op}>{op}</option>)}
                    </select>
                  </div>

                  {/* RHS — compare indicator or scalar value, available for all operators */}
                  <div>
                    <span className="label">vs</span>
                    {useVars ? (
                      <>
                        <select className="input" style={{ width: 150 }} value={cond.compare_indicator ?? ""} onChange={(e) => changeExitCompareIndicator(i, e.target.value)}>
                          <option value="">Fixed value</option>
                          {vars.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                        </select>
                        {selectedCmpVar && (
                          <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", marginTop: 2 }}>
                            {selectedCmpVar.indicator} · {Object.entries(selectedCmpVar.params).map(([k, v]) => `${k}:${v}`).join(", ")}
                          </div>
                        )}
                        {!cond.compare_indicator && (
                          <div style={{ display: "inline-block", marginLeft: 8 }}>
                            <input type="number" className="input" style={{ width: 80 }} value={cond.value} onChange={(e) => updateExitCond(i, { value: parseFloat(e.target.value) })} />
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <select className="input" style={{ width: 130 }} value={cond.compare_indicator ?? ""} onChange={(e) => changeExitCompareIndicator(i, e.target.value)}>
                          <option value="">Fixed value</option>
                          {Object.keys(INDICATORS).map((k) => <option key={k}>{k}</option>)}
                        </select>
                        {cond.compare_indicator
                          ? Object.entries(cond.compare_params ?? {}).map(([param, val]) => (
                              <div key={param} style={{ display: "inline-block", marginLeft: 8 }}>
                                <span className="label">{param}</span>
                                <input type="number" className="input" style={{ width: 70 }} value={val}
                                  onChange={(e) => updateExitCond(i, { compare_params: { ...cond.compare_params, [param]: parseFloat(e.target.value) || 0 } })} />
                              </div>
                            ))
                          : (
                              <div style={{ display: "inline-block", marginLeft: 8 }}>
                                <input type="number" className="input" style={{ width: 80 }} value={cond.value} onChange={(e) => updateExitCond(i, { value: parseFloat(e.target.value) })} />
                              </div>
                            )
                        }
                      </>
                    )}
                  </div>

                  <button className="btn btn-ghost btn-sm" style={{ color: "var(--red-hi)", marginBottom: 0 }} onClick={() => removeExitCond(i)}>✕</button>
                </div>
              </div>
              );
            })}
            <button className="btn btn-ghost btn-sm" onClick={addExitCond}>+ Add Exit Condition</button>
          </div>

          {/* Param ranges */}
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div className="section-header" style={{ marginBottom: 0 }}>Parameter Ranges (for Optimizer)</div>
              <button className="btn btn-ghost btn-sm" onClick={autoFillRanges}>Auto-fill from indicators</button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
              {useVars
                ? <>Keys are auto-derived from your named variables — e.g.{" "}
                    <span style={{ fontFamily: "monospace", color: "var(--accent-hi)" }}>fast_ema.period</span> and{" "}
                    <span style={{ fontFamily: "monospace", color: "var(--accent-hi)" }}>slow_ema.period</span> are fully independent.</>
                : <>Define which parameter values the optimizer should try.
                    Add variables above to name each indicator instance for cleaner crossover optimization.</>
              }
            </p>
            {Object.entries(recipe.param_ranges).map(([key, vals]) => (
              <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <input
                  className="input mono"
                  style={{ width: 210, flexShrink: 0, fontFamily: "monospace", fontSize: 12, color: "var(--accent-hi)" }}
                  value={key}
                  onChange={(e) => {
                    const newKey = e.target.value;
                    const { [key]: oldVals, ...rest } = recipe.param_ranges;
                    update({ param_ranges: { ...rest, [newKey]: oldVals } });
                  }}
                />
                <input
                  className="input"
                  placeholder="comma-separated: 5, 10, 20, 30"
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
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              {availableRangeKeys()
                .filter((k) => !(k in recipe.param_ranges))
                .map((k) => (
                  <button key={k} className="btn btn-ghost btn-sm"
                    style={{ fontFamily: "monospace", fontSize: 11 }}
                    onClick={() => update({ param_ranges: { ...recipe.param_ranges, [k]: [] } })}>
                    + {k}
                  </button>
                ))}
              {availableRangeKeys().filter((k) => !(k in recipe.param_ranges)).length === 0 && (
                <button className="btn btn-ghost btn-sm" onClick={() =>
                  update({ param_ranges: { ...recipe.param_ranges, "NEW_PARAM.field": [] } })
                }>+ Add Range</button>
              )}
            </div>
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
