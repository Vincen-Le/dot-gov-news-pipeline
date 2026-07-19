import json

import pytest

from pipeline.judge import VECTORS, build_judge_prompt, judge_vector, parse_judge_output

RUBRIC = "Per non-anchor episode: related y/n."
FILES = {"chain-verdicts.csv": ["storyline_id", "episode_id", "related", "attach_method", "reason"]}


def test_prompt_is_blinded_and_carries_rubric_and_format():
    system, user = build_judge_prompt(RUBRIC, FILES, '{"chains": []}')
    assert RUBRIC in system
    assert "chain-verdicts.csv" in system
    assert "storyline_id,episode_id,related,attach_method,reason" in system
    assert user == '{"chains": []}'


def test_parse_judge_output_multi_file():
    text = (
        "Here are the verdicts.\n"
        "FILE: a.csv\n```csv\nid,verdict\n1,y\n```\n"
        "FILE: b.csv\n```\nid,fits\n2,n\n```\n"
    )
    files = parse_judge_output(text)
    assert files == {"a.csv": "id,verdict\n1,y", "b.csv": "id,fits\n2,n"}


def test_judge_vector_validates_headers():
    def fake_complete(system, user):
        return "FILE: chain-verdicts.csv\n```csv\nstoryline_id,episode_id,related,attach_method,reason\ns1,e2,y,event_key,ok\n```"

    out = judge_vector(fake_complete, RUBRIC, FILES, "{}")
    assert out["chain-verdicts.csv"].splitlines()[1] == "s1,e2,y,event_key,ok"


def test_judge_vector_rejects_wrong_header():
    def fake_complete(system, user):
        return "FILE: chain-verdicts.csv\n```csv\nwrong,header\n1,2\n```"

    with pytest.raises(ValueError, match="header"):
        judge_vector(fake_complete, RUBRIC, FILES, "{}")


def test_judge_vector_rejects_missing_file():
    with pytest.raises(ValueError, match="missing"):
        judge_vector(lambda s, u: "no files here", RUBRIC, FILES, "{}")


def test_judge_vector_rejects_omitted_artifact_case():
    files = {
        "chain-verdicts.csv": ["storyline_id", "episode_id", "related",
                                "attach_method", "reason"],
        "chain-summary.csv": ["storyline_id", "endpoints_related",
                              "chain_verdict", "reason"],
    }
    artifact = json.dumps({"chains": [{
        "storyline": {"storyline_id": "s1"},
        "episodes": [{"episode_id": "e1"}, {"episode_id": "e2"}],
    }]})

    def incomplete(system, user):
        return (
            "FILE: chain-verdicts.csv\n```csv\n"
            "storyline_id,episode_id,related,attach_method,reason\n```\n"
            "FILE: chain-summary.csv\n```csv\n"
            "storyline_id,endpoints_related,chain_verdict,reason\n"
            "s1,y,coherent,ok\n```"
        )

    with pytest.raises(ValueError, match="missing=.*e2"):
        judge_vector(incomplete, RUBRIC, files, artifact, vector="v1")


def test_judge_vector_rejects_invalid_categorical_verdict():
    artifact = json.dumps({"merge_candidates": [{
        "theme_a": {"theme_id": "t1"},
        "theme_b": {"theme_id": "t2"},
    }]})

    def invalid(system, user):
        return (
            "FILE: granularity-merge-verdicts.csv\n```csv\n"
            "theme_a_id,theme_b_id,should_merge,reason\n"
            "t1,t2,maybe,uncertain\n```"
        )

    with pytest.raises(ValueError, match="invalid should_merge"):
        judge_vector(
            invalid,
            "rubric",
            VECTORS["v4"]["files"],
            artifact,
            vector="v4",
        )


def test_v3_judge_accepts_blank_theme_id_for_unthemed_storyline():
    artifact = json.dumps({"category_storyline_pairs": [{
        "storyline": {"storyline_id": "s1"},
        "theme_id": "",
        "filed_category": "Drug Safety",
    }]})

    def complete(system, user):
        return (
            "FILE: category-verdicts.csv\n```csv\n"
            "storyline_id,theme_id,filed_category,verdict,"
            "suggested_category,reason\n"
            "s1,,Drug Safety,correct,,best option\n```"
        )

    out = judge_vector(
        complete,
        "rubric",
        VECTORS["v3"]["files"],
        artifact,
        vector="v3",
    )
    assert "s1,,Drug Safety,correct" in out["category-verdicts.csv"]


def test_v5_judge_requires_top_stats_and_all_sample_tokens():
    files = VECTORS["v5"]["files"]
    artifact = json.dumps({
        "top_entity_stats": [{"entity": "fda"}],
        "sampled_entries": [{
            "entry_id": "n1", "entities": ["valsatrex"],
            "event_keys": ["DOC-123"],
        }],
    })

    def complete(system, user):
        return (
            "FILE: entity-stats-verdicts.csv\n```csv\nentity,valid,reason\n"
            "fda,y,specific\n```\n"
            "FILE: entity-verdicts.csv\n```csv\nentry_id,kind,token,valid,reason\n"
            "n1,entity,valsatrex,y,specific\n"
            "n1,event_key,DOC-123,y,identifier\n```\n"
            "FILE: entity-misses.csv\n```csv\nentry_id,missed_entity\n```"
        )

    out = judge_vector(complete, "rubric", files, artifact, vector="v5")
    assert "fda,y,specific" in out["entity-stats-verdicts.csv"]
