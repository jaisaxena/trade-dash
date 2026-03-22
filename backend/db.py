import duckdb
from config import settings

_conn: duckdb.DuckDBPyConnection | None = None


def get_conn() -> duckdb.DuckDBPyConnection:
    global _conn
    if _conn is None:
        _conn = duckdb.connect(str(settings.DUCKDB_PATH))
        _bootstrap(_conn)
    return _conn


def _bootstrap(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS instruments (
            instrument_token INTEGER,
            exchange_token INTEGER,
            tradingsymbol VARCHAR,
            name VARCHAR,
            exchange VARCHAR,
            segment VARCHAR,
            instrument_type VARCHAR,
            strike FLOAT,
            expiry DATE,
            lot_size INTEGER,
            tick_size FLOAT,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS kite_session (
            id INTEGER PRIMARY KEY,
            access_token VARCHAR NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS candles (
            instrument_token INTEGER,
            timestamp TIMESTAMP,
            interval VARCHAR,
            open FLOAT,
            high FLOAT,
            low FLOAT,
            close FLOAT,
            volume BIGINT,
            oi BIGINT DEFAULT 0
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS option_chains (
            underlying VARCHAR,
            timestamp TIMESTAMP,
            expiry DATE,
            strike FLOAT,
            option_type VARCHAR,
            ltp FLOAT,
            bid FLOAT,
            ask FLOAT,
            oi BIGINT,
            volume BIGINT,
            iv FLOAT,
            delta FLOAT,
            gamma FLOAT,
            theta FLOAT,
            vega FLOAT
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS strategy_index (
            id VARCHAR PRIMARY KEY,
            name VARCHAR,
            version INTEGER,
            underlying VARCHAR,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_frozen BOOLEAN DEFAULT FALSE,
            file_path VARCHAR,
            last_backtest_id VARCHAR,
            last_backtest_sharpe FLOAT,
            last_backtest_cagr FLOAT,
            last_backtest_max_dd FLOAT
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS backtest_results (
            id VARCHAR PRIMARY KEY,
            strategy_id VARCHAR,
            strategy_version INTEGER,
            run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            params_json VARCHAR,
            sharpe FLOAT,
            cagr FLOAT,
            max_drawdown FLOAT,
            win_rate FLOAT,
            total_trades INTEGER,
            profit_factor FLOAT,
            calmar FLOAT,
            equity_curve_json VARCHAR,
            trade_log_json VARCHAR
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS optimization_runs (
            id VARCHAR PRIMARY KEY,
            strategy_id VARCHAR,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP,
            status VARCHAR DEFAULT 'running',
            mode VARCHAR DEFAULT 'grid',
            interval VARCHAR DEFAULT '15m',
            total_combinations INTEGER,
            completed_combinations INTEGER DEFAULT 0,
            best_params_json VARCHAR,
            best_sharpe FLOAT,
            results_json VARCHAR
        )
    """)
    # Non-destructive migrations for existing databases
    for col, typedef in [("mode", "VARCHAR DEFAULT 'grid'"), ("interval", "VARCHAR DEFAULT '15m'")]:
        try:
            conn.execute(f"ALTER TABLE optimization_runs ADD COLUMN {col} {typedef}")
        except Exception:
            pass

    conn.execute("""
        CREATE TABLE IF NOT EXISTS paper_trades (
            id VARCHAR PRIMARY KEY,
            strategy_id VARCHAR,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            tradingsymbol VARCHAR,
            transaction_type VARCHAR,
            quantity INTEGER,
            price FLOAT,
            pnl FLOAT,
            status VARCHAR
        )
    """)

    # Indexes for fast queries
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_candles_token_ts
        ON candles (instrument_token, interval, timestamp)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_instruments_symbol
        ON instruments (tradingsymbol)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_option_chains_underlying
        ON option_chains (underlying, expiry, strike, option_type, timestamp)
    """)
