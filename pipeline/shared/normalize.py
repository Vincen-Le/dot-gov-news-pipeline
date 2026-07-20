from __future__ import annotations

import hashlib
import re
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Tracking params only — semantic query params are preserved (spec caution:
# feed canonicalization must respect path/query semantics).
_TRACKING = {"gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "igshid", "_ga"}


def canonicalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    host = parts.hostname.lower() if parts.hostname else ""
    port = parts.port
    if port and not ((scheme == "https" and port == 443) or (scheme == "http" and port == 80)):
        host = f"{host}:{port}"
    path = parts.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    query_pairs = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in _TRACKING
    ]
    query = urlencode(sorted(query_pairs))
    return urlunsplit((scheme, host, path, query, ""))


def _norm_text(text: str | None) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    return re.sub(r"\s+", " ", text).strip().casefold()


def content_hash(title: str | None, summary: str | None) -> str:
    payload = _norm_text(title) + "\n" + _norm_text(summary)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
