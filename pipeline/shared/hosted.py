"""Hosted Supabase identifiers for read-only corpus access.

config/hosted.json is committed (publishable key + project URL are safe to
expose); env vars override it for forks or key rotation.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

_PLACEHOLDER_PREFIX = "REPLACE_"
_DEFAULT_PATH = Path(__file__).resolve().parents[2] / "config" / "hosted.json"


def load_hosted(path: Path | None = None) -> tuple[str, str]:
    data = json.loads((path or _DEFAULT_PATH).read_text())
    url = os.environ.get("SUPABASE_URL") or data["supabaseUrl"]
    key = os.environ.get("SUPABASE_PUBLISHABLE_KEY") or data["publishableKey"]
    if key.startswith(_PLACEHOLDER_PREFIX):
        raise RuntimeError(
            "publishable key not configured: set SUPABASE_PUBLISHABLE_KEY or "
            "fill config/hosted.json (see docs/infrastructure/access.md)")
    return url, key
