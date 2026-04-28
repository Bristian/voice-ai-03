"""Vehicle — public-facing subset of the `vehicles` table.

Mirrors shared/contracts/vehicle.schema.json.
Does not include internal fields like `id`, `embedding`, `created_at`, `updated_at`.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class Status(str, Enum):
    AVAILABLE = "available"
    SOLD = "sold"
    HOLD = "hold"


class Condition(str, Enum):
    NEW = "new"
    USED = "used"
    CPO = "cpo"


class Vehicle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vin: str = Field(min_length=17, max_length=17)
    make: str
    model: str
    year: int = Field(ge=1900, le=2100)
    trim: str | None = None
    color_ext: str | None = None
    color_int: str | None = None
    mileage: int | None = Field(default=None, ge=0)
    price: float = Field(ge=0)
    condition: Condition | None = None
    transmission: str | None = None
    fuel_type: str | None = None
    body_style: str | None = None
    features: list[str] = Field(default_factory=list)
    status: Status
    description: str | None = None
