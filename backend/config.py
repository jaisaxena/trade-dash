from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


_ROOT = Path(__file__).resolve().parent


class Settings(BaseSettings):
    KITE_API_KEY: str = ""
    KITE_API_SECRET: str = ""
    KITE_REDIRECT_URL: str = "http://localhost:8000/api/data/auth/callback"

    STORAGE_DIR: Path = _ROOT / "storage"
    DUCKDB_PATH: Path = _ROOT / "storage" / "market_data.duckdb"
    STRATEGIES_DIR: Path = _ROOT / "storage" / "strategies"

    CORS_ORIGINS: list[str] = ["http://localhost:3000"]
    # Shown on Kite OAuth success page ("Continue to dashboard")
    FRONTEND_URL: str = "http://localhost:3000"

    # .env then .env.local when present (later entries override; same idea as Next.js)
    _env_files = [p for p in (_ROOT / ".env", _ROOT / ".env.local") if p.exists()]
    model_config = SettingsConfigDict(
        **(
            {"env_file": tuple(str(p) for p in _env_files), "env_file_encoding": "utf-8"}
            if _env_files
            else {}
        ),
        extra="ignore",
    )


settings = Settings()
settings.STORAGE_DIR.mkdir(parents=True, exist_ok=True)
settings.STRATEGIES_DIR.mkdir(parents=True, exist_ok=True)
