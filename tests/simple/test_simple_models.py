from pipeline.shared.cache import CachedModels, DecisionCache
from pipeline.shared.stub import StubModels
from pipeline.simple.storyline_linking.prompts import build_link_prompt
from pipeline.simple.theme_clustering.prompts import build_theme_prompt

ENTRY = {"title": "FTC sues Acme Corp over merger", "enriched_text":
         "FTC filed an antitrust suit against Acme Corp on 2025-07-02.",
         "published_at": "2025-07-02T12:00:00Z", "entity_set": ["ftc", "acme"],
         "content_hash": "abc123"}
CAND = {"headline": "FTC sues Acme Corp over merger", "summary":
        "FTC filed suit against Acme.", "newest_entry_at": "2025-07-01T12:00:00Z",
        "gap_hours": 24.0, "shared_entities": ["ftc", "acme"], "episode_count": 1}
UNRELATED = {"headline": "NASA launches lunar probe", "summary": "NASA probe.",
             "newest_entry_at": "2025-06-01T00:00:00Z", "gap_hours": 700.0,
             "shared_entities": [], "episode_count": 2}


def test_link_prompt_states_facts():
    system, user = build_link_prompt(ENTRY, [CAND, UNRELATED])
    assert "24.0" in user and "ftc" in user      # gap + shared entities explicit
    assert '"match"' in system and "-1" in system  # none-option instructed


def test_stub_link_matches_on_token_overlap():
    stub = StubModels()
    verdict = stub.link_storyline(ENTRY, [UNRELATED, CAND])
    assert verdict["match"] == 1
    assert verdict["same_development"] is True
    assert stub.link_storyline(ENTRY, [UNRELATED])["match"] is None


def test_stub_induce_theme_deterministic():
    stub = StubModels()
    out = stub.induce_theme([{"headline": "FTC enforcement one"},
                             {"headline": "FTC enforcement two"}])
    assert out["theme"] is True and out["name"]
    assert out == stub.induce_theme([{"headline": "FTC enforcement one"},
                                     {"headline": "FTC enforcement two"}])


def test_cached_link_storyline_memoizes(tmp_path):
    cache = DecisionCache(str(tmp_path / "d.sqlite"))
    cached = CachedModels(StubModels(), cache, model_tag="stub")
    first = cached.link_storyline(ENTRY, [CAND])
    again = cached.link_storyline(ENTRY, [CAND])
    assert first == again
    assert cached.hits == 1 and cached.misses == 1
