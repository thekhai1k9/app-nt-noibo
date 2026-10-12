from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from redis.exceptions import RedisError

from app.chat.service import ChatError
from app.config import get_settings
from app.logging_conf import setup_logging
from app.routers import admin_branches, admin_rooms, admin_users, auth, chat, health

DEFAULT_SECRET = "dev-secret-change-me"
ENV_EXAMPLE_SECRET = "change-me-to-a-long-random-string"
PLACEHOLDER_SECRETS = {DEFAULT_SECRET, ENV_EXAMPLE_SECRET}
MIN_SECRET_LENGTH = 32


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.app_env == "prod" and (
        settings.jwt_secret in PLACEHOLDER_SECRETS or len(settings.jwt_secret) < MIN_SECRET_LENGTH
    ):
        raise RuntimeError(
            f"JWT_SECRET must be a real secret of at least {MIN_SECRET_LENGTH} characters when APP_ENV=prod "
            "(generate one with: openssl rand -hex 32)"
        )
    yield


async def redis_unavailable(request: Request, exc: RedisError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": "service_unavailable"})


async def chat_error(request: Request, exc: ChatError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"detail": exc.code})


def create_app() -> FastAPI:
    settings = get_settings()
    setup_logging(settings.log_level)
    is_prod = settings.app_env == "prod"
    app = FastAPI(
        title="Kết Nối API",
        lifespan=lifespan,
        docs_url=None if is_prod else "/api/docs",
        openapi_url=None if is_prod else "/api/openapi.json",
    )
    app.add_exception_handler(RedisError, redis_unavailable)
    app.add_exception_handler(ChatError, chat_error)
    app.include_router(health.router, prefix="/api")
    app.include_router(auth.router, prefix="/api")
    app.include_router(admin_branches.router, prefix="/api")
    app.include_router(admin_users.router, prefix="/api")
    app.include_router(admin_rooms.router, prefix="/api")
    app.include_router(chat.router, prefix="/api")
    return app


app = create_app()
