"""Typed, hashable contracts for reproducible ranking experiments.

The database remains the v1 formula source of truth. These types define the
immutable boundary around it: an experiment freezes its resolved dials and a
rank row freezes every formula input and returned term. Future incompatible
input or term shapes require a new :class:`RankSystemContract`.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import date, datetime, timezone
from enum import Enum
from typing import Any, Mapping
from uuid import UUID


def _canonicalize(value: Any) -> Any:
    """Return a JSON-compatible value with deterministic ordering.

    Hashes are provenance receipts, not object serialization. Unsupported
    objects fail closed instead of silently falling back to ``repr``.
    """

    if is_dataclass(value) and not isinstance(value, type):
        return _canonicalize(asdict(value))
    if isinstance(value, Enum):
        return _canonicalize(value.value)
    if isinstance(value, Mapping):
        return {
            str(key): _canonicalize(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_canonicalize(item) for item in value]
    if isinstance(value, (set, frozenset)):
        canonical_items = [_canonicalize(item) for item in value]
        return sorted(
            canonical_items,
            key=lambda item: json.dumps(
                item, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ),
        )
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("canonical datetimes must be timezone-aware")
        normalized = value.astimezone(timezone.utc)
        return normalized.isoformat(timespec="microseconds").replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("canonical JSON does not permit non-finite floats")
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"unsupported canonical JSON value: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    """Serialize a value into the sole canonical JSON representation."""

    return json.dumps(
        _canonicalize(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def canonical_hash(value: Any) -> str:
    """Return a versioned SHA-256 receipt for canonical JSON."""

    payload = canonical_json(value).encode("utf-8")
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


@dataclass(frozen=True)
class RankSystemContract:
    """Semantic ranking contract; dials belong to experiments, not here."""

    formula_key: str
    input_schema_version: int
    term_schema_version: int
    rubric_version: int
    rubric_semantics_key: str
    ordered_term_keys: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.input_schema_version < 1 or self.term_schema_version < 1:
            raise ValueError("rank schema versions must be positive")
        if self.rubric_version < 1:
            raise ValueError("rubric_version must be positive")
        if not self.formula_key or not self.rubric_semantics_key:
            raise ValueError("formula and rubric semantics keys are required")
        if len(set(self.ordered_term_keys)) != len(self.ordered_term_keys):
            raise ValueError("rank term keys must be unique")

    @property
    def contract_hash(self) -> str:
        return canonical_hash(self)


RANK_SYSTEM_V1 = RankSystemContract(
    formula_key="compute_rank_key_v1",
    input_schema_version=1,
    term_schema_version=1,
    rubric_version=1,
    rubric_semantics_key="newsworthiness_boolean_v1",
    ordered_term_keys=(
        "rubric_points",
        "agency_term",
        "feed_term",
        "source_term",
        "freshness_term",
    ),
)


@dataclass(frozen=True)
class RankExperimentConfig:
    """All v1 dials that may vary without changing formula semantics."""

    tau_seconds: float
    publisher_weight_version: int
    rubric_weights: Mapping[str, float]
    unjudged_prior_fraction: float = 0.5
    agency_coefficient: float = 0.5
    feed_coefficient: float = 0.5
    publisher_weights: Mapping[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not math.isfinite(self.tau_seconds) or self.tau_seconds <= 0:
            raise ValueError("tau_seconds must be finite and positive")
        if self.publisher_weight_version < 1:
            raise ValueError("publisher_weight_version must be positive")
        if not 0 <= self.unjudged_prior_fraction <= 1:
            raise ValueError("unjudged_prior_fraction must be between zero and one")
        for name, value in self.rubric_weights.items():
            if not name or not math.isfinite(float(value)):
                raise ValueError("rubric weights must have names and finite values")
        for name, value in self.publisher_weights.items():
            if (
                not name
                or not math.isfinite(float(value))
                or float(value) < 1.0
            ):
                raise ValueError(
                    "publisher weights must have names and finite values >= 1"
                )

    @property
    def config_hash(self) -> str:
        return canonical_hash(self)


@dataclass(frozen=True)
class RankInputV1:
    """Frozen values substituted into the v1 formula for one card."""

    rubric: Mapping[str, bool | int] | None
    rubric_version: int | None
    distinct_agencies: int
    distinct_feeds: int
    source_weight_max: float
    newest_entry_at: datetime
    freshness_cutoff_at: datetime
    tau_seconds: float
    publisher_weight_version: int = 1
    input_schema_version: int = 1

    def __post_init__(self) -> None:
        if self.rubric is not None and (self.rubric_version or 0) < 1:
            raise ValueError("judged rank inputs require a positive rubric version")
        if self.distinct_agencies < 0 or self.distinct_feeds < 0:
            raise ValueError("rank input counts cannot be negative")
        if not math.isfinite(self.source_weight_max) or self.source_weight_max < 0:
            raise ValueError("source_weight_max must be finite and nonnegative")
        if not math.isfinite(self.tau_seconds) or self.tau_seconds <= 0:
            raise ValueError("tau_seconds must be finite and positive")
        if self.publisher_weight_version < 1 or self.input_schema_version != 1:
            raise ValueError("v1 rank inputs require positive publisher weights and schema 1")
        if self.newest_entry_at.tzinfo is None or self.freshness_cutoff_at.tzinfo is None:
            raise ValueError("rank input timestamps must be timezone-aware")

    @property
    def input_hash(self) -> str:
        return canonical_hash(self)


@dataclass(frozen=True)
class RankTermsV1:
    rubric_points: float
    prior_used: bool
    agency_term: float
    feed_term: float
    source_term: float
    freshness_term: float

    def __post_init__(self) -> None:
        for key, value in asdict(self).items():
            if key != "prior_used" and not math.isfinite(float(value)):
                raise ValueError(f"{key} must be finite")

    @property
    def rank_key(self) -> float:
        return (
            self.rubric_points
            + self.agency_term
            + self.feed_term
            + self.source_term
            + self.freshness_term
        )

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> RankTermsV1:
        return cls(
            rubric_points=float(value["rubric_points"]),
            prior_used=bool(value["prior_used"]),
            agency_term=float(value["agency_term"]),
            feed_term=float(value["feed_term"]),
            source_term=float(value["source_term"]),
            freshness_term=float(value["freshness_term"]),
        )


def compute_rank_terms_v1(
    rank_input: RankInputV1,
    config: RankExperimentConfig,
) -> RankTermsV1:
    """Evaluate v1 without consulting mutable database state or wall time."""

    if rank_input.rubric is None:
        rubric_points = (
            config.unjudged_prior_fraction
            * sum(float(weight) for weight in config.rubric_weights.values())
        )
        prior_used = True
    else:
        rubric_points = sum(
            float(weight)
            for criterion, weight in config.rubric_weights.items()
            if rank_input.rubric.get(criterion) in (True, 1)
        )
        prior_used = False

    cutoff = min(rank_input.newest_entry_at, rank_input.freshness_cutoff_at)
    return RankTermsV1(
        rubric_points=rubric_points,
        prior_used=prior_used,
        agency_term=(
            config.agency_coefficient * math.log1p(rank_input.distinct_agencies)
        ),
        feed_term=config.feed_coefficient * math.log1p(rank_input.distinct_feeds),
        source_term=math.log(max(rank_input.source_weight_max, 0.001)),
        freshness_term=cutoff.timestamp() / rank_input.tau_seconds,
    )
