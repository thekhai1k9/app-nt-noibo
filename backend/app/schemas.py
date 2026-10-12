from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=256)


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    must_change_password: bool


class ChangePasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=8, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    full_name: str
    branch_id: int
    role: str
    is_active: bool
    must_change_password: bool
    last_login_at: datetime | None


class BranchIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=100)
    code: str = Field(min_length=1, max_length=10)
    address: str = Field(default="", max_length=200)


class BranchUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=100)
    code: str | None = Field(default=None, min_length=1, max_length=10)
    address: str | None = Field(default=None, max_length=200)


class BranchOut(BaseModel):
    id: int
    name: str
    code: str
    address: str
    user_count: int


class UserCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    username: str = Field(pattern=r"^[a-z0-9._-]{3,50}$")
    full_name: str = Field(min_length=1, max_length=100)
    branch_id: int
    role: Literal["admin", "member"] = "member"

    @field_validator("username", mode="before")
    @classmethod
    def _lowercase_username(cls, value):
        return value.strip().lower() if isinstance(value, str) else value


class UserUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    full_name: str | None = Field(default=None, min_length=1, max_length=100)
    branch_id: int | None = None
    role: Literal["admin", "member"] | None = None
    is_active: bool | None = None


class UserCreated(UserOut):
    temp_password: str


class ResetPasswordOut(BaseModel):
    temp_password: str
