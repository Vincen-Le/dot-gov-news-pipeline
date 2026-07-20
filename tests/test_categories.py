from pipeline.shared.categories import CategoryEngine
from pipeline.shared.config import Config
from pipeline.shared.stub import StubModels
from tests.test_fakes_topics import _storyline
from tests.fakes import FakeStore

CFG = Config(database_url="x", cf_account_id="a", cf_api_token="t",
             topics_enabled=True)


def _store_with_seeds():
    store = FakeStore()
    store.categories["c-health"] = {
        "id": "c-health", "display_name": "Public Health", "origin": "seed"}
    store.categories["c-tax"] = {
        "id": "c-tax", "display_name": "Taxes & Revenue", "origin": "seed"}
    return store


def test_classify_assigns_one_seed_category():
    store = _store_with_seeds()
    _storyline(store, "s1", headline="CDC reports measles public health emergency")
    CategoryEngine(store, StubModels(), CFG).classify("s1")
    s = store.storylines["s1"]
    assert s["category_id"] == "c-health"
    assert s["category_method"] == "classified"


def test_classify_is_idempotent():
    store = _store_with_seeds()
    _storyline(store, "s1", headline="CDC reports measles public health emergency")
    engine = CategoryEngine(store, StubModels(), CFG)
    engine.classify("s1")

    class ExplodingModels(StubModels):
        def classify_category(self, storyline, categories):
            raise AssertionError("already categorized; must not re-call the LLM")

    CategoryEngine(store, ExplodingModels(), CFG).classify("s1")


def test_classifier_failure_leaves_category_null():
    class BrokenModels(StubModels):
        def classify_category(self, storyline, categories):
            raise RuntimeError("classifier boom")

    store = _store_with_seeds()
    _storyline(store, "s1")
    CategoryEngine(store, BrokenModels(), CFG).classify("s1")
    assert store.storylines["s1"]["category_id"] is None


def test_hallucinated_category_id_is_dropped():
    class HallucinatingModels(StubModels):
        def classify_category(self, storyline, categories):
            return {"category_id": "c-invented", "reason": "made up"}

    store = _store_with_seeds()
    _storyline(store, "s1")
    CategoryEngine(store, HallucinatingModels(), CFG).classify("s1")
    assert store.storylines["s1"]["category_id"] is None
