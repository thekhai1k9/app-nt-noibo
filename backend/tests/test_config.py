import pytest
from pydantic import ValidationError

from app.config import Settings


def test_ws_reconcile_seconds_must_be_positive():
    with pytest.raises(ValidationError):
        Settings(ws_reconcile_seconds=0)
    with pytest.raises(ValidationError):
        Settings(ws_reconcile_seconds=-1)
    assert Settings(ws_reconcile_seconds=0.3).ws_reconcile_seconds == 0.3


def test_room_archive_settings_must_be_positive():
    for field in ("room_archive_retention_days", "room_purge_interval_seconds"):
        with pytest.raises(ValidationError):
            Settings(**{field: 0})
        with pytest.raises(ValidationError):
            Settings(**{field: -1})
    s = Settings()
    assert (s.room_archive_retention_days, s.room_purge_interval_seconds) == (3, 3600)
