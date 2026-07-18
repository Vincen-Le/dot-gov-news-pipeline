from pipeline.cache import CachedModels, DecisionCache
from pipeline.stub import StubModels


class CountingModels:
    def __init__(self):
        self.calls = 0

    def adjudicate_same_event(self, a, b, context):
        self.calls += 1
        return True, f"call-{self.calls}"

    def enrich(self, title, summary):
        return "enriched"


def test_cache_roundtrip(tmp_path):
    cache = DecisionCache(str(tmp_path / "sub" / "d.sqlite"))
    assert cache.get("k") is None
    cache.put("k", False, "why")
    assert cache.get("k") == (False, "why")


def test_cached_models_memoizes_by_content(tmp_path):
    inner = CountingModels()
    models = CachedModels(inner, DecisionCache(str(tmp_path / "d.sqlite")), "test-model")
    a = {"title": "A", "summary": "s", "entities": ["x"]}
    b = {"title": "B", "summary": "t", "entities": ["y"]}

    first = models.adjudicate_same_event(a, b, "ctx")
    second = models.adjudicate_same_event(a, b, "ctx")
    assert first == second == (True, "call-1")
    assert inner.calls == 1
    assert (models.hits, models.misses) == (1, 1)

    models.adjudicate_same_event(a, b, "other ctx")   # different content -> miss
    assert inner.calls == 2


def test_cache_survives_reopen_and_ignores_ids(tmp_path):
    path = str(tmp_path / "d.sqlite")
    inner = CountingModels()
    CachedModels(inner, DecisionCache(path), "m").adjudicate_same_event(
        {"title": "A", "entities": []}, {"title": "B", "entities": []}, "c")
    # new process, new wrapper, same content -> hit
    models2 = CachedModels(CountingModels(), DecisionCache(path), "m")
    same, reason = models2.adjudicate_same_event(
        {"title": "A", "entities": []}, {"title": "B", "entities": []}, "c")
    assert reason == "call-1" and models2.hits == 1


def test_delegates_other_methods(tmp_path):
    models = CachedModels(CountingModels(), DecisionCache(str(tmp_path / "d.sqlite")), "m")
    assert models.enrich("t", None) == "enriched"


def test_database_url_defaults_local(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "a")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "t")
    from pipeline.config import load_config
    assert load_config().database_url == "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def test_cached_models_memoizes_theme_adjudication(tmp_path):
    class CountingStub(StubModels):
        calls = 0

        def adjudicate_theme(self, storyline, candidates):
            CountingStub.calls += 1
            return super().adjudicate_theme(storyline, candidates)

    cache = DecisionCache(str(tmp_path / "d.sqlite"))
    models = CachedModels(CountingStub(), cache, "tag")
    args = ({"headline": "FDA recalls Valsatrex", "summary": ""},
            [{"id": "t-1", "display_name": "FDA recalls",
              "headlines": [], "similarity": 0.7}])
    first = models.adjudicate_theme(*args)
    second = models.adjudicate_theme(*args)
    assert first == second
    assert CountingStub.calls == 1
    assert models.hits == 1


def test_cached_models_never_caches_theme_errors(tmp_path):
    class FailingStub(StubModels):
        calls = 0

        def adjudicate_theme(self, storyline, candidates):
            FailingStub.calls += 1
            return {"theme_id": None, "updated_name": None,
                    "reason": "adjudicator_error: boom"}

    cache = DecisionCache(str(tmp_path / "d.sqlite"))
    models = CachedModels(FailingStub(), cache, "tag")
    models.adjudicate_theme({"headline": "x", "summary": ""}, [])
    models.adjudicate_theme({"headline": "x", "summary": ""}, [])
    assert FailingStub.calls == 2
