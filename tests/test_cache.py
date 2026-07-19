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


def test_cached_models_memoizes_theme_naming(tmp_path):
    class CountingStub(StubModels):
        calls = 0

        def name_theme(self, storyline):
            CountingStub.calls += 1
            return super().name_theme(storyline)

    cache = DecisionCache(str(tmp_path / "d.sqlite"))
    models = CachedModels(CountingStub(), cache, "tag")
    storyline = {"headline": "FDA recalls Valsatrex", "summary": ""}
    first = models.name_theme(storyline)
    second = models.name_theme(storyline)
    assert first == second == "FDA recalls Valsatrex"
    assert CountingStub.calls == 1
    assert models.hits == 1


def test_cached_models_never_caches_namer_failures(tmp_path):
    class FailingStub(StubModels):
        calls = 0

        def name_theme(self, storyline):
            FailingStub.calls += 1
            raise RuntimeError("namer boom")

    cache = DecisionCache(str(tmp_path / "d.sqlite"))
    models = CachedModels(FailingStub(), cache, "tag")
    for _ in range(2):
        try:
            models.name_theme({"headline": "x", "summary": ""})
        except RuntimeError:
            pass
    assert FailingStub.calls == 2


def test_cached_models_memoizes_category_classification(tmp_path):
    class CountingStub(StubModels):
        calls = 0

        def classify_category(self, theme_name, storyline, categories):
            CountingStub.calls += 1
            return super().classify_category(theme_name, storyline, categories)

    cache = DecisionCache(str(tmp_path / "d.sqlite"))
    models = CachedModels(CountingStub(), cache, "tag")
    args = ("FDA drug recalls", {"headline": "FDA recalls Valsatrex", "summary": ""},
            [{"id": "c-1", "display_name": "Drug Safety", "origin": "seed"}])
    first = models.classify_category(*args)
    second = models.classify_category(*args)
    assert first == second
    assert CountingStub.calls == 1
    assert models.hits == 1
