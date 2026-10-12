from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import get_settings
from app.logging_conf import setup_logging
from app.routers import admin_branches, auth, health

DEFAULT_SECRET = "dev-secret-change-me"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.app_env == "prod" and settings.jwt_secret == DEFAULT_SECRET:
        raise RuntimeError("JWT_SECRET must be set when APP_ENV=prod")
    yield


def create_app() -> FastAPI:
    setup_logging(get_settings().log_level)
    app = FastAPI(
        title="Kết Nối API",
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.include_router(health.router, prefix="/api")
    app.include_router(auth.router, prefix="/api")
    app.include_router(admin_branches.router, prefix="/api")
    return app


app = create_app()
