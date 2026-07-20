from pipeline.ranking.opinions import NeighborVerdict, derive_position_opinion


def test_no_neighbors_is_insufficient():
    assert derive_position_opinion(1, 1, [])["status"] == "insufficient_neighbors"


def test_swap_inconsistency_never_invents_a_position():
    opinion = derive_position_opinion(2, 3, [NeighborVerdict(1, None)])
    assert opinion == {
        "status": "inconsistent",
        "direction": "uncertain",
        "suggested_category_position": None,
        "position_delta": None,
    }


def test_exact_upward_destination_stops_at_better_neighbor():
    opinion = derive_position_opinion(
        4,
        6,
        [NeighborVerdict(3, True), NeighborVerdict(2, True),
         NeighborVerdict(1, False), NeighborVerdict(5, True)],
    )
    assert opinion["status"] == "available"
    assert opinion["direction"] == "up"
    assert opinion["suggested_category_position"] == 2
    assert opinion["position_delta"] == -2


def test_window_exhaustion_is_a_bound_not_an_exact_destination():
    opinion = derive_position_opinion(
        5, 10, [NeighborVerdict(4, True), NeighborVerdict(3, True)]
    )
    assert opinion["status"] == "bounded"
    assert opinion["suggested_category_position"] is None
    assert opinion["position_delta"] == -2


def test_supported_current_position_is_stay():
    opinion = derive_position_opinion(
        2, 3, [NeighborVerdict(1, False), NeighborVerdict(3, True)]
    )
    assert opinion["direction"] == "stay"
    assert opinion["suggested_category_position"] == 2
