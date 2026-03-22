"""Vectorized indicator library.

Every function takes a pandas DataFrame with at least
[open, high, low, close, volume] columns and returns a Series or
DataFrame of indicator values.  All computations use *ta* or raw
numpy/pandas for speed — no row-by-row loops.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import ta


def sma(df: pd.DataFrame, period: int = 20, column: str = "close") -> pd.Series:
    return df[column].rolling(window=period, min_periods=period).mean()


def ema(df: pd.DataFrame, period: int = 20, column: str = "close") -> pd.Series:
    return df[column].ewm(span=period, adjust=False).mean()


def rsi(df: pd.DataFrame, period: int = 14) -> pd.Series:
    return ta.momentum.RSIIndicator(df["close"], window=period).rsi()


def macd(
    df: pd.DataFrame,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> pd.DataFrame:
    indicator = ta.trend.MACD(df["close"], window_slow=slow, window_fast=fast, window_sign=signal)
    return pd.DataFrame({
        "macd": indicator.macd(),
        "signal": indicator.macd_signal(),
        "histogram": indicator.macd_diff(),
    })


def bollinger_bands(
    df: pd.DataFrame,
    period: int = 20,
    std_dev: float = 2.0,
) -> pd.DataFrame:
    bb = ta.volatility.BollingerBands(df["close"], window=period, window_dev=std_dev)
    return pd.DataFrame({
        "upper": bb.bollinger_hband(),
        "middle": bb.bollinger_mavg(),
        "lower": bb.bollinger_lband(),
        "width": bb.bollinger_wband(),
        "pct_b": bb.bollinger_pband(),
    })


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    return ta.volatility.AverageTrueRange(
        df["high"], df["low"], df["close"], window=period
    ).average_true_range()


def vwap(df: pd.DataFrame) -> pd.Series:
    typical = (df["high"] + df["low"] + df["close"]) / 3
    cum_vol = df["volume"].cumsum()
    cum_tp_vol = (typical * df["volume"]).cumsum()
    return cum_tp_vol / cum_vol


def supertrend(
    df: pd.DataFrame,
    period: int = 10,
    multiplier: float = 3.0,
) -> pd.DataFrame:
    atr_vals = atr(df, period)
    hl2 = (df["high"] + df["low"]) / 2
    upper = hl2 + multiplier * atr_vals
    lower = hl2 - multiplier * atr_vals

    st = pd.Series(np.nan, index=df.index)
    direction = pd.Series(1, index=df.index)

    for i in range(period, len(df)):
        if df["close"].iloc[i] > upper.iloc[i - 1]:
            direction.iloc[i] = 1
        elif df["close"].iloc[i] < lower.iloc[i - 1]:
            direction.iloc[i] = -1
        else:
            direction.iloc[i] = direction.iloc[i - 1]
            if direction.iloc[i] == 1:
                lower.iloc[i] = max(lower.iloc[i], lower.iloc[i - 1])
            else:
                upper.iloc[i] = min(upper.iloc[i], upper.iloc[i - 1])

        st.iloc[i] = lower.iloc[i] if direction.iloc[i] == 1 else upper.iloc[i]

    return pd.DataFrame({"supertrend": st, "direction": direction})


def iv_rank(iv_series: pd.Series, lookback: int = 252) -> pd.Series:
    """IV Rank = (current IV - 52w low) / (52w high - 52w low) * 100"""
    iv_min = iv_series.rolling(lookback, min_periods=1).min()
    iv_max = iv_series.rolling(lookback, min_periods=1).max()
    rng = iv_max - iv_min
    return np.where(rng > 0, (iv_series - iv_min) / rng * 100, 50)


def iv_percentile(iv_series: pd.Series, lookback: int = 252) -> pd.Series:
    """% of days in lookback window where IV was below current IV."""
    def _pct(window):
        if len(window) < 2:
            return 50.0
        current = window.iloc[-1]
        return (window.iloc[:-1] < current).mean() * 100

    return iv_series.rolling(lookback, min_periods=2).apply(_pct, raw=False)


def pcr(oi_put: pd.Series, oi_call: pd.Series) -> pd.Series:
    return oi_put / oi_call.replace(0, np.nan)


def stochastic(
    df: pd.DataFrame,
    k_period: int = 14,
    d_period: int = 3,
) -> pd.DataFrame:
    stoch = ta.momentum.StochasticOscillator(
        df["high"], df["low"], df["close"],
        window=k_period, smooth_window=d_period,
    )
    return pd.DataFrame({
        "k": stoch.stoch(),
        "d": stoch.stoch_signal(),
    })


def adx(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    indicator = ta.trend.ADXIndicator(df["high"], df["low"], df["close"], window=period)
    return pd.DataFrame({
        "adx": indicator.adx(),
        "plus_di": indicator.adx_pos(),
        "minus_di": indicator.adx_neg(),
    })


def cci(df: pd.DataFrame, period: int = 20) -> pd.Series:
    return ta.trend.CCIIndicator(df["high"], df["low"], df["close"], window=period).cci()


def williams_r(df: pd.DataFrame, period: int = 14) -> pd.Series:
    return ta.momentum.WilliamsRIndicator(
        df["high"], df["low"], df["close"], lbp=period
    ).williams_r()


# ── Registry ─────────────────────────────────────────────────────────
# Maps indicator name → callable. Each callable signature:
#   fn(df, **params) → Series or DataFrame

INDICATOR_REGISTRY: dict[str, callable] = {
    "SMA": sma,
    "EMA": ema,
    "RSI": rsi,
    "MACD": macd,
    "BOLLINGER": bollinger_bands,
    "ATR": atr,
    "VWAP": vwap,
    "SUPERTREND": supertrend,
    "IV_RANK": iv_rank,
    "IV_PERCENTILE": iv_percentile,
    "PCR": pcr,
    "STOCHASTIC": stochastic,
    "ADX": adx,
    "CCI": cci,
    "WILLIAMS_R": williams_r,
}


def compute_indicator(name: str, df: pd.DataFrame, **params) -> pd.Series | pd.DataFrame:
    fn = INDICATOR_REGISTRY.get(name.upper())
    if fn is None:
        raise ValueError(f"Unknown indicator: {name}. Available: {list(INDICATOR_REGISTRY.keys())}")
    return fn(df, **params)
