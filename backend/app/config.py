from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://messaging:messaging@localhost:5432/messaging"
    redis_url: str = "redis://localhost:6379/0"
    jwt_secret: str = "dev-secret-change-me"
    app_env: Literal["dev", "test", "prod"] = "dev"
    access_token_minutes: int = 15
    refresh_token_days: int = 14
    cookie_secure: bool = True
    cookie_samesite: Literal["lax", "strict"] = "lax"
    login_max_attempts: int = 5
    login_window_seconds: int = 300
    ws_rate_limit_messages: int = 20
    ws_rate_limit_seconds: int = 10
    ws_auth_timeout_seconds: float = 5.0
    ws_typing_interval_seconds: float = Field(2.0, gt=0)
    ws_reconcile_seconds: float = Field(30.0, gt=0)
    presence_ttl_seconds: float = Field(45.0, gt=0)
    presence_sweep_seconds: float = Field(15.0, gt=0)
    presence_announce_timeout_seconds: float = Field(10.0, gt=0)
    presence_offline_grace_seconds: float = Field(5.0, ge=0)
    room_archive_retention_days: int = Field(3, gt=0)
    room_purge_interval_seconds: float = Field(3600, gt=0)
    max_owned_groups: int = Field(20, gt=0)
    max_group_members: int = Field(200, gt=0)
    bus_channel_prefix: str = "kn"
    max_message_length: int = 4000
    log_level: str = "INFO"


    @model_validator(mode="after")
    def _ttl_exceeds_sweep(self):
        if self.presence_ttl_seconds < 2 * self.presence_sweep_seconds:
            raise ValueError("PRESENCE_TTL_SECONDS must be at least 2 x PRESENCE_SWEEP_SECONDS")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
