"""Black-Scholes option pricing and Greeks for simulating options P&L
when historical chain data is unavailable.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.stats import norm


@dataclass
class OptionPrice:
    premium: float
    delta: float
    gamma: float
    theta: float
    vega: float
    iv: float


def _d1(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if T <= 0 or sigma <= 0:
        return 0.0
    return (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))


def _d2(S: float, K: float, T: float, r: float, sigma: float) -> float:
    return _d1(S, K, T, r, sigma) - sigma * math.sqrt(T)


def bs_call(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if T <= 0:
        return max(S - K, 0)
    d1 = _d1(S, K, T, r, sigma)
    d2 = d1 - sigma * math.sqrt(T)
    return S * norm.cdf(d1) - K * math.exp(-r * T) * norm.cdf(d2)


def bs_put(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if T <= 0:
        return max(K - S, 0)
    d1 = _d1(S, K, T, r, sigma)
    d2 = d1 - sigma * math.sqrt(T)
    return K * math.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)


def price_option(
    spot: float,
    strike: float,
    tte_years: float,
    option_type: str = "CE",
    iv: float = 0.20,
    risk_free_rate: float = 0.07,
) -> OptionPrice:
    """Full option pricing with Greeks."""
    S, K, T, r, sigma = spot, strike, tte_years, risk_free_rate, iv

    if T <= 0:
        intrinsic = max(S - K, 0) if option_type == "CE" else max(K - S, 0)
        return OptionPrice(premium=intrinsic, delta=0, gamma=0, theta=0, vega=0, iv=iv)

    d1 = _d1(S, K, T, r, sigma)
    d2 = d1 - sigma * math.sqrt(T)
    sqrt_t = math.sqrt(T)

    if option_type == "CE":
        premium = bs_call(S, K, T, r, sigma)
        delta = norm.cdf(d1)
        theta = (
            -S * norm.pdf(d1) * sigma / (2 * sqrt_t)
            - r * K * math.exp(-r * T) * norm.cdf(d2)
        ) / 365
    else:
        premium = bs_put(S, K, T, r, sigma)
        delta = norm.cdf(d1) - 1
        theta = (
            -S * norm.pdf(d1) * sigma / (2 * sqrt_t)
            + r * K * math.exp(-r * T) * norm.cdf(-d2)
        ) / 365

    gamma = norm.pdf(d1) / (S * sigma * sqrt_t)
    vega = S * norm.pdf(d1) * sqrt_t / 100

    return OptionPrice(premium=premium, delta=delta, gamma=gamma, theta=theta, vega=vega, iv=iv)


def implied_vol(
    market_price: float,
    spot: float,
    strike: float,
    tte_years: float,
    option_type: str = "CE",
    risk_free_rate: float = 0.07,
    tol: float = 1e-6,
    max_iter: int = 100,
) -> float:
    """Newton-Raphson implied volatility solver."""
    sigma = 0.20
    price_fn = bs_call if option_type == "CE" else bs_put

    for _ in range(max_iter):
        price = price_fn(spot, strike, tte_years, risk_free_rate, sigma)
        d1 = _d1(spot, strike, tte_years, risk_free_rate, sigma)
        vega = spot * norm.pdf(d1) * math.sqrt(tte_years)

        if abs(vega) < 1e-12:
            break

        diff = price - market_price
        if abs(diff) < tol:
            return sigma

        sigma -= diff / vega
        sigma = max(sigma, 0.01)

    return sigma


def simulate_leg_pnl(
    spot_series: np.ndarray,
    strike: float,
    option_type: str,
    action: str,
    tte_start_years: float,
    iv: float = 0.20,
    lot_size: int = 1,
    lots: int = 1,
    risk_free_rate: float = 0.07,
    bars_per_day: int = 75,
) -> np.ndarray:
    """Simulate the P&L of a single option leg across a price series.
    Returns an array of cumulative P&L per bar."""
    n = len(spot_series)
    pnl = np.zeros(n)
    qty = lot_size * lots
    sign = 1 if action == "BUY" else -1

    entry_price = price_option(spot_series[0], strike, tte_start_years, option_type, iv, risk_free_rate).premium

    for i in range(n):
        tte = max(tte_start_years - (i / bars_per_day / 365), 0)
        current_price = price_option(spot_series[i], strike, tte, option_type, iv, risk_free_rate).premium
        pnl[i] = sign * (current_price - entry_price) * qty

    return pnl
