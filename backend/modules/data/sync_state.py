"""In-memory sync progress tracker with cancellation support.

Provides a singleton `sync_tracker` used by the sync orchestrator and
polled by the frontend via GET /sync/status.
"""
from __future__ import annotations

import threading
from collections import deque
from datetime import datetime


class SyncTracker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._active = False
        self._mode: str = ""
        self._underlyings: list[str] = []
        self._intervals: list[str] = []
        self._steps_total = 0
        self._steps_done = 0
        self._current_underlying: str | None = None
        self._current_interval: str | None = None
        self._rows_inserted = 0
        self._started_at: str | None = None
        self._finished_at: str | None = None
        self._error: str | None = None
        self._log: deque[dict] = deque(maxlen=50)

    # ── lifecycle ─────────────────────────────────────────────────────

    def start(self, mode: str, underlyings: list[str], intervals: list[str]) -> None:
        with self._lock:
            self._cancel.clear()
            self._active = True
            self._mode = mode
            self._underlyings = list(underlyings)
            self._intervals = list(intervals)
            self._steps_total = len(underlyings) * len(intervals)
            self._steps_done = 0
            self._current_underlying = None
            self._current_interval = None
            self._rows_inserted = 0
            self._started_at = datetime.now().isoformat(timespec="seconds")
            self._finished_at = None
            self._error = None
            self._log.clear()
            self._log_msg("Sync started")

    def finish(self, *, error: str | None = None) -> None:
        with self._lock:
            self._active = False
            self._finished_at = datetime.now().isoformat(timespec="seconds")
            if self._cancel.is_set() and error is None:
                self._error = "Cancelled by user"
                self._log_msg("Sync cancelled")
            elif error:
                self._error = error
                self._log_msg(f"Sync failed: {error}")
            else:
                self._log_msg(
                    f"Sync complete — {self._rows_inserted:,} rows across "
                    f"{self._steps_done} step(s)"
                )

    # ── progress updates (called from sync/downloader) ────────────────

    def begin_step(self, underlying: str, interval: str) -> None:
        with self._lock:
            self._current_underlying = underlying
            self._current_interval = interval
            self._log_msg(f"Syncing {underlying} {interval}…")

    def complete_step(self, underlying: str, interval: str, rows: int) -> None:
        with self._lock:
            self._steps_done += 1
            self._rows_inserted += rows
            self._log_msg(f"{underlying} {interval}: {rows:,} rows inserted")

    def add_rows(self, count: int) -> None:
        with self._lock:
            self._rows_inserted += count

    # ── cancellation ──────────────────────────────────────────────────

    def cancel(self) -> bool:
        """Request cancellation. Returns True if a sync was running."""
        with self._lock:
            if not self._active:
                return False
            self._cancel.set()
            self._log_msg("Cancel requested — stopping after current chunk…")
            return True

    def is_cancelled(self) -> bool:
        return self._cancel.is_set()

    @property
    def is_active(self) -> bool:
        return self._active

    # ── snapshot for the status endpoint ──────────────────────────────

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "active": self._active,
                "mode": self._mode or None,
                "cancelled": self._cancel.is_set(),
                "started_at": self._started_at,
                "finished_at": self._finished_at,
                "error": self._error,
                "underlyings": self._underlyings,
                "intervals": self._intervals,
                "current_underlying": self._current_underlying,
                "current_interval": self._current_interval,
                "steps_total": self._steps_total,
                "steps_done": self._steps_done,
                "rows_inserted": self._rows_inserted,
                "log": list(self._log),
            }

    # ── internal ──────────────────────────────────────────────────────

    def _log_msg(self, msg: str) -> None:
        self._log.append({
            "ts": datetime.now().isoformat(timespec="seconds"),
            "msg": msg,
        })


sync_tracker = SyncTracker()
