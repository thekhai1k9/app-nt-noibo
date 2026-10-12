import pytest
from pydantic import ValidationError

from app.config import Settings


def test_ws_reconcile_seconds_must_be_positive():
    with pytest.raises(ValidationError):
        Settings(ws_reconcile_seconds=0)
    with pytest.raises(ValidationError):
        Settings(ws_reconcile_seconds=-1)
    assert Settings(ws_reconcile_seconds=0.3).ws_reconcile_seconds == 0.3
