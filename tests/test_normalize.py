from pipeline.shared.normalize import canonicalize_url, content_hash


def test_strips_tracking_and_fragment():
    u = "https://WWW.FDA.gov/news/recall?utm_source=x&utm_medium=y&id=42#section"
    assert canonicalize_url(u) == "https://www.fda.gov/news/recall?id=42"


def test_sorts_query_and_strips_default_port():
    u = "https://fda.gov:443/a?b=2&a=1"
    assert canonicalize_url(u) == "https://fda.gov/a?a=1&b=2"


def test_strips_trailing_slash_on_path_only():
    assert canonicalize_url("https://fda.gov/news/") == "https://fda.gov/news"
    assert canonicalize_url("https://fda.gov/") == "https://fda.gov/"


def test_preserves_semantic_query_params():
    u = "https://regulations.gov/docket?D=EPA-HQ-2026-0001"
    assert "D=EPA-HQ-2026-0001" in canonicalize_url(u)


def test_content_hash_normalization_invariant():
    a = content_hash("FDA  Recalls Valsatrex", "Contamination   found.")
    b = content_hash("fda recalls valsatrex", "contamination found.")
    assert a == b
    assert len(a) == 64 and all(c in "0123456789abcdef" for c in a)


def test_content_hash_differs_on_content():
    assert content_hash("A", "x") != content_hash("B", "x")
    assert content_hash(None, None) == content_hash("", "")
