"""Config — load and validate environment variables.

Uses pydantic-settings so all env vars are validated at startup.
If any required var is missing, the app refuses to start with a clear error.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server
    port: int = 8000

    # OpenAI
    openai_api_key: str

    # Database — Railway auto-injects as DATABASE_URL
    database_url: str

    # Redis — Railway auto-injects as REDIS_URL
    redis_url: str = "redis://localhost:6379/0"

    # Internal API auth (empty = disabled, for curl testing)
    internal_api_secret: str = ""

    # Human-transfer phone number (E.164)
    transfer_phone: str = "+15551234567"

    # ── Model configuration ──
    # These are intentionally configurable via env but have sane defaults.
    # Change them if OpenAI releases better/cheaper models.
    intent_model: str = "gpt-4o-mini"
    synthesis_model: str = "gpt-4o-mini"
    embedding_model: str = "text-embedding-3-small"
    embedding_dims: int = 1536

    # ── RAG tuning ──
    rag_top_k: int = 5
    rag_rerank_top: int = 3
    rag_hallucination_threshold: float = 0.20  # cosine-based score (no reranker); below = ungrounded

    # ── SQL agent ──
    sql_max_results: int = 5
    sql_cache_ttl_seconds: int = 300  # 5 minutes

    # ── Redis TTLs ──
    session_ttl_seconds: int = 7200  # 2 hours
    embed_cache_ttl_seconds: int = 3600  # 1 hour

    @property
    def auth_enabled(self) -> bool:
        return len(self.internal_api_secret) > 0


def get_settings() -> Settings:
    """Singleton-ish settings loader. Called once at startup."""
    return Settings()  # type: ignore[call-arg]
