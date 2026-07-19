from pipeline.extraction import EXTRACTOR_VERSION, extract


def test_version_frozen():
    # v2: cfr citations dropped, case numbers context-anchored
    assert EXTRACTOR_VERSION == 2


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
    assert not any("cfr" in k for k in keys)  # v2: authority citations != events


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


def test_generic_capitalized_junk_filtered():
    entities, _ = extract(
        "NASA Knows: What Is Mass Distribution?",
        "This article explains. Learn more here.",
    )
    for banned in ("knows", "what", "this", "here", "mass", "distribution"):
        assert banned not in entities


def test_nav_blob_summary_skipped():
    # state.gov-style summaries lead with punctuation-less navigation text;
    # entity extraction must not harvest it
    nav = ("About Administrative Areas Bureaus Countries Directories Offices "
           "Press Releases Travel Visas Business Education Culture " * 3)
    entities, _ = extract("Secretary Meets With Foreign Minister Kestrel", nav)
    assert "bureaus" not in entities
    assert "directories" not in entities
    assert "kestrel" in entities


def test_cfr_citations_are_not_event_keys():
    _, keys = extract("Fire restrictions increase in Southeast Utah parks",
                      "Under 36 CFR 261.50, superintendents prohibit campfires.")
    assert keys == []


def test_bare_release_numbering_is_not_an_event_key():
    _, keys = extract("Employment Cost Index News Release",
                      "USDL No. 23-01 covers the June quarter.")
    assert not any("23-01" in k for k in keys)


def test_docket_case_numbers_still_extracted():
    _, keys = extract("Court ruling in visa case",
                      "The order in Case No. 23-104 was affirmed.")
    assert any("23-104" in k for k in keys)
