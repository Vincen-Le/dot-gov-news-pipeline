from pipeline.extraction import EXTRACTOR_VERSION, extract


def test_version_frozen():
    assert EXTRACTOR_VERSION == 1


def test_drug_recall_headline():
    entities, keys = extract(
        "FDA Announces Recall of Valsatrex Blood Pressure Medication",
        "Sundexo Pharmaceuticals initiated the recall after contamination was found.",
    )
    assert "valsatrex" in entities
    assert "sundexo" in entities
    # agency + boilerplate + common-english filtered
    for banned in ("fda", "announces", "recall", "blood", "pressure", "medication"):
        assert banned not in entities
    assert keys == []


def test_event_keys_extracted():
    entities, keys = extract(
        "EPA Proposes Rule on Emissions",
        "Comments accepted under docket EPA-HQ-OAR-2026-0143. See 40 CFR 60. "
        "Related advisory CVE-2026-12345 and FR document 2026-11234.",
    )
    assert "epa-hq-oar-2026-0143" in keys
    assert "cve-2026-12345" in keys
    assert "2026-11234" in keys
    assert "40 cfr 60" in keys


def test_all_caps_title_yields_inconclusive_not_noise():
    entities, _ = extract("FDA ANNOUNCES NATIONWIDE RECALL", None)
    assert entities == []  # empty = inconclusive; never vetoes (spec: precision over recall)


def test_sentence_initial_singleton_excluded():
    entities, _ = extract("Yesterday the agency acted", "Valsatrex was named.")
    assert "yesterday" not in entities
    assert "valsatrex" in entities


def test_dollar_amounts_captured():
    entities, _ = extract("HHS Awards Grant", "The department awarded $4.5 million to states.")
    assert "$4.5 million" in entities


def test_deterministic_and_sorted():
    a = extract("FDA Recalls Valsatrex", "Sundexo Pharmaceuticals recall.")
    b = extract("FDA Recalls Valsatrex", "Sundexo Pharmaceuticals recall.")
    assert a == b
    assert a[0] == sorted(a[0])
