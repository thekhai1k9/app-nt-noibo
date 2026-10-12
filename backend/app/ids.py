"""Kiểu id có cận chặn, dùng chung cho mọi router: id ngoài khoảng của cột Postgres phải là 422, không phải 500."""

from typing import Annotated

from fastapi import Path, Query
from pydantic import Field

MAX_INT32 = 2**31 - 1  # rooms/users/branches dùng cột INTEGER
MAX_INT64 = 2**63 - 1  # messages dùng cột BIGINT

# Trường trong body JSON
RoomId = Annotated[int, Field(ge=1, le=MAX_INT32)]
UserId = Annotated[int, Field(ge=1, le=MAX_INT32)]
BranchId = Annotated[int, Field(ge=1, le=MAX_INT32)]
MessageId = Annotated[int, Field(ge=1, le=MAX_INT64)]

# Tham số trên path
RoomIdPath = Annotated[int, Path(ge=1, le=MAX_INT32)]
UserIdPath = Annotated[int, Path(ge=1, le=MAX_INT32)]
BranchIdPath = Annotated[int, Path(ge=1, le=MAX_INT32)]
MessageIdPath = Annotated[int, Path(ge=1, le=MAX_INT64)]

# Tham số query (tuỳ chọn)
BranchIdQuery = Annotated[int | None, Query(ge=1, le=MAX_INT32)]
MessageIdQuery = Annotated[int | None, Query(ge=1, le=MAX_INT64)]
