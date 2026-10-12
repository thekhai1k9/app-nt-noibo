from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://messaging:messaging@localhost:5432/messaging"
    redis_url: str = "redis://localhost:6379/0"
    jwt_secret: str = "dev-secret-change-me"
    app_env: str = "dev"
    access_token_minutes: int = 15
    refresh_token_days: int = 14
    cookie_secure: bool = True
    cookie_samesite: Literal["lax", "strict"] = "lax"
    login_max_attempts: int = 5
    login_window_seconds: int = 300
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
