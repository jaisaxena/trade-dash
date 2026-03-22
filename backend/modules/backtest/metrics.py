"""Performance metrics calculator for backtest results."""

from __future__ import annotations

import numpy as np
import pandas as pd


def sharpe_ratio(returns: pd.Series, risk_free_rate: float = 0.07, periods: int = 252) -> float:
    if returns.std() == 0:
        return 0.0
    excess = returns - risk_free_rate / periods
    return float(np.sqrt(periods) * excess.mean() / excess.std())


def sortino_ratio(returns: pd.Series, risk_free_rate: float = 0.07, periods: int = 252) -> float:
    excess = returns - risk_free_rate / periods
    downside = returns[returns < 0]
    if len(downside) == 0 or downside.std() == 0:
        return 0.0
    return float(np.sqrt(periods) * excess.mean() / downside.std())


def max_drawdown(equity_curve: pd.Series) -> float:
    if equity_curve.empty:
        return 0.0
    peak = equity_curve.cummax()
    dd = (equity_curve - peak) / peak
    return float(dd.min())


def cagr(equity_curve: pd.Series, periods_per_year: int = 252) -> float:
    if len(equity_curve) < 2 or equity_curve.iloc[0] <= 0:
        return 0.0
    total_return = equity_curve.iloc[-1] / equity_curve.iloc[0]
    n_years = len(equity_curve) / periods_per_year
    if n_years <= 0:
        return 0.0
    return float(total_return ** (1 / n_years) - 1)


def calmar_ratio(equity_curve: pd.Series, periods_per_year: int = 252) -> float:
    mdd = abs(max_drawdown(equity_curve))
    if mdd == 0:
        return 0.0
    return cagr(equity_curve, periods_per_year) / mdd


def win_rate(trade_pnls: list[float]) -> float:
    if not trade_pnls:
        return 0.0
    winners = sum(1 for p in trade_pnls if p > 0)
    return winners / len(trade_pnls)


def profit_factor(trade_pnls: list[float]) -> float:
    gross_profit = sum(p for p in trade_pnls if p > 0)
    gross_loss = abs(sum(p for p in trade_pnls if p < 0))
    if gross_loss == 0:
        return 99.99 if gross_profit > 0 else 0.0
    return gross_profit / gross_loss


def avg_trade(trade_pnls: list[float]) -> float:
    return float(np.mean(trade_pnls)) if trade_pnls else 0.0


def max_consecutive_losses(trade_pnls: list[float]) -> int:
    max_streak = 0
    current = 0
    for p in trade_pnls:
        if p < 0:
            current += 1
            max_streak = max(max_streak, current)
        else:
            current = 0
    return max_streak


def compute_all_metrics(
    equity_curve: pd.Series,
    trade_pnls: list[float],
    periods_per_year: int = 252,
    risk_free_rate: float = 0.07,
) -> dict:
    returns = equity_curve.pct_change().dropna()
    return {
        "sharpe": round(sharpe_ratio(returns, risk_free_rate, periods_per_year), 4),
        "sortino": round(sortino_ratio(returns, risk_free_rate, periods_per_year), 4),
        "cagr": round(cagr(equity_curve, periods_per_year), 4),
        "max_drawdown": round(max_drawdown(equity_curve), 4),
        "calmar": round(calmar_ratio(equity_curve, periods_per_year), 4),
        "win_rate": round(win_rate(trade_pnls), 4),
        "profit_factor": round(profit_factor(trade_pnls), 4),
        "total_trades": len(trade_pnls),
        "avg_trade": round(avg_trade(trade_pnls), 2),
        "max_consecutive_losses": max_consecutive_losses(trade_pnls),
        "total_pnl": round(sum(trade_pnls), 2),
    }
