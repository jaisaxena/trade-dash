import { create } from "zustand";

interface AppState {
  tradingMode: "paper" | "live";
  setTradingMode: (mode: "paper" | "live") => void;

  selectedStrategyId: string | null;
  setSelectedStrategy: (id: string | null) => void;

  kiteAuthenticated: boolean;
  setKiteAuthenticated: (v: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  tradingMode: "paper",
  setTradingMode: (mode) => set({ tradingMode: mode }),

  selectedStrategyId: null,
  setSelectedStrategy: (id) => set({ selectedStrategyId: id }),

  kiteAuthenticated: false,
  setKiteAuthenticated: (v) => set({ kiteAuthenticated: v }),
}));
