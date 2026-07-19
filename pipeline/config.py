from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Config:
    database_url: str
    cf_account_id: str
    cf_api_token: str
    embedding_model: str = "@cf/baai/bge-m3"
    enricher_model: str = "@cf/meta/llama-3.1-8b-instruct-fast"
    adjudicator_model: str = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    judge_model: str = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    near_dup_threshold: float = 0.90        # calibrate on real corpus (design amendment 5)
    cluster_join_threshold: float = 0.78    # ditto
    storyline_sim_floor: float = 0.60
    ambient_ema_ceiling: float = 3.0        # daily_ema at/above this = ambient entity; never merge on it
    episode_dormancy_hours: float = 4.0
    dedupe_window_hours: float = 72.0
    enrichment_enabled: bool = True
    enricher_version: int = 1
    rubric_version: int = 1
    prompt_version: int = 1
    tau_seconds: float = 124_600.0
    topics_enabled: bool = False
    theme_sim_floor: float = 0.55
    theme_knn_k: int = 5
    theme_promotion_min_storylines: int = 4
    theme_promotion_min_active_days: int = 3
    theme_promotion_cohesion_floor: float = 0.55
    theme_promotion_cluster_floor: float = 0.60
    theme_demotion_cohesion_floor: float = 0.40
    theme_sweep_interval_hours: float = 24.0
    publisher_weight_version: int = 1
    audit_model: str = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    rank_audit_top_k: int = 30
    rank_audit_window: int = 3
    rank_audit_facets: str = "global,category"


def _f(key: str, default: float) -> float:
    return float(os.environ.get(key, default))


def _b(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    return default if raw is None else raw.strip().lower() in ("1", "true", "yes")


def load_config() -> Config:
    load_dotenv()
    return Config(
        database_url=os.environ.get(
            "DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"),
        cf_account_id=os.environ["CLOUDFLARE_ACCOUNT_ID"],
        cf_api_token=os.environ["CLOUDFLARE_API_TOKEN"],
        embedding_model=os.environ.get("EMBEDDING_MODEL", Config.embedding_model),
        enricher_model=os.environ.get("ENRICHER_MODEL", Config.enricher_model),
        adjudicator_model=os.environ.get("ADJUDICATOR_MODEL", Config.adjudicator_model),
        judge_model=os.environ.get("JUDGE_MODEL", Config.judge_model),
        near_dup_threshold=_f("NEAR_DUP_THRESHOLD", Config.near_dup_threshold),
        cluster_join_threshold=_f("CLUSTER_JOIN_THRESHOLD", Config.cluster_join_threshold),
        storyline_sim_floor=_f("STORYLINE_SIM_FLOOR", Config.storyline_sim_floor),
        ambient_ema_ceiling=_f("AMBIENT_EMA_CEILING", Config.ambient_ema_ceiling),
        episode_dormancy_hours=_f("EPISODE_DORMANCY_HOURS", Config.episode_dormancy_hours),
        dedupe_window_hours=_f("DEDUPE_WINDOW_HOURS", Config.dedupe_window_hours),
        enrichment_enabled=_b("ENRICHMENT_ENABLED", Config.enrichment_enabled),
        enricher_version=int(os.environ.get("ENRICHER_VERSION", Config.enricher_version)),
        rubric_version=int(os.environ.get("RUBRIC_VERSION", Config.rubric_version)),
        prompt_version=int(os.environ.get("PROMPT_VERSION", Config.prompt_version)),
        tau_seconds=_f("TAU_SECONDS", Config.tau_seconds),
        topics_enabled=_b("TOPICS_ENABLED", Config.topics_enabled),
        theme_sim_floor=_f("THEME_SIM_FLOOR", Config.theme_sim_floor),
        theme_knn_k=int(os.environ.get("THEME_KNN_K", Config.theme_knn_k)),
        theme_promotion_min_storylines=int(os.environ.get(
            "THEME_PROMOTION_MIN_STORYLINES",
            Config.theme_promotion_min_storylines)),
        theme_promotion_min_active_days=int(os.environ.get(
            "THEME_PROMOTION_MIN_ACTIVE_DAYS",
            Config.theme_promotion_min_active_days)),
        theme_promotion_cohesion_floor=_f(
            "THEME_PROMOTION_COHESION_FLOOR",
            Config.theme_promotion_cohesion_floor),
        theme_promotion_cluster_floor=_f(
            "THEME_PROMOTION_CLUSTER_FLOOR",
            Config.theme_promotion_cluster_floor),
        theme_demotion_cohesion_floor=_f(
            "THEME_DEMOTION_COHESION_FLOOR",
            Config.theme_demotion_cohesion_floor),
        theme_sweep_interval_hours=_f(
            "THEME_SWEEP_INTERVAL_HOURS", Config.theme_sweep_interval_hours),
        publisher_weight_version=int(os.environ.get(
            "PUBLISHER_WEIGHT_VERSION", Config.publisher_weight_version)),
        audit_model=os.environ.get("AUDIT_MODEL", Config.audit_model),
        rank_audit_top_k=int(os.environ.get("RANK_AUDIT_TOP_K", Config.rank_audit_top_k)),
        rank_audit_window=int(os.environ.get("RANK_AUDIT_WINDOW", Config.rank_audit_window)),
        rank_audit_facets=os.environ.get("RANK_AUDIT_FACETS", Config.rank_audit_facets),
    )
