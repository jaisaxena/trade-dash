from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from db import get_conn
from modules.data.router import router as data_router
from modules.strategy.router import router as strategy_router
from modules.optimizer.router import router as optimizer_router
from modules.backtest.router import router as backtest_router
from modules.vault.router import router as vault_router
from modules.trading.router import router as trading_router

app = FastAPI(title="Trade Dash API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(data_router, prefix="/api/data", tags=["data"])
app.include_router(strategy_router, prefix="/api/strategy", tags=["strategy"])
app.include_router(optimizer_router, prefix="/api/optimizer", tags=["optimizer"])
app.include_router(backtest_router, prefix="/api/backtest", tags=["backtest"])
app.include_router(vault_router, prefix="/api/vault", tags=["vault"])
app.include_router(trading_router, prefix="/api/trading", tags=["trading"])


@app.on_event("startup")
async def startup():
    get_conn()


@app.get("/api/health")
async def health():
    return {"status": "ok"}
