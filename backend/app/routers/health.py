from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.redis_client import get_redis

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(session: AsyncSession = Depends(get_session), redis=Depends(get_redis)) -> dict:
    try:
        await session.execute(text("SELECT 1"))
        await redis.ping()
    except Exception:
        raise HTTPException(status_code=503, detail="unhealthy")
    return {"status": "ok"}
