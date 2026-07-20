from datetime import datetime, timedelta, timezone

import numpy as np

from pipeline.simple.index import StorylineIndex

T0 = datetime(2025, 7, 1, tzinfo=timezone.utc)
VX = np.array([1.0, 0.0], dtype=np.float32)
VY = np.array([0.0, 1.0], dtype=np.float32)
VMID = np.array([0.8, 0.6], dtype=np.float32)


def test_top_candidates_max_member_cosine():
    idx = StorylineIndex()
    idx.register("s1", "e1", VX, {"ftc"}, T0)
    idx.register("s2", "e2", VY, {"nasa"}, T0)
    # drifted member added to s1: retrieval must use MAX member sim, not centroid
    idx.add_member("s1", VMID, {"acme"}, T0 + timedelta(hours=1))
    ranked = idx.top_candidates(VMID, k=2, floor=0.0)
    assert [s.id for s, _ in ranked] == ["s1", "s2"]
    assert ranked[0][1] == 1.0                      # exact member match, not centroid


def test_floor_and_k():
    idx = StorylineIndex()
    idx.register("s1", "e1", VX, set(), T0)
    idx.register("s2", "e2", VY, set(), T0)
    assert idx.top_candidates(VX, k=2, floor=0.5) == [
        (idx.all()[0], 1.0)]                        # s2 below floor
    assert len(idx.top_candidates(VMID, k=1, floor=0.0)) == 1


def test_floor_boundary_is_inclusive():
    idx = StorylineIndex()
    idx.register("s1", "e1", VX, set(), T0)
    # sim(VX, VX) == 1.0 == floor exactly -> candidate is included (>=, not >)
    assert idx.top_candidates(VX, k=1, floor=1.0) == [(idx.all()[0], 1.0)]


def test_tie_break_is_insertion_order():
    idx = StorylineIndex()
    idx.register("s1", "e1", VX, set(), T0)
    idx.register("s2", "e2", VX, set(), T0)
    ranked = idx.top_candidates(VX, k=2, floor=0.0)
    assert [s.id for s, _ in ranked] == ["s1", "s2"]


def test_burst_rule_and_due_closes():
    idx = StorylineIndex()
    s = idx.register("s1", "e1", VX, set(), T0)
    assert idx.episode_active(s, T0 + timedelta(hours=47), gap_hours=48.0)
    assert not idx.episode_active(s, T0 + timedelta(hours=49), gap_hours=48.0)
    assert idx.due_closes(T0 + timedelta(hours=49), gap_hours=48.0) == [s]
    idx.mark_closed("s1")
    assert idx.due_closes(T0 + timedelta(hours=49), gap_hours=48.0) == []
    assert s.open_episode_id is None


def test_gap_boundary_is_still_active():
    idx = StorylineIndex()
    s = idx.register("s1", "e1", VX, set(), T0)
    # t - newest == exactly gap_hours -> episode still active (<=, not <)
    assert idx.episode_active(s, T0 + timedelta(hours=48), gap_hours=48.0)
    assert idx.due_closes(T0 + timedelta(hours=48), gap_hours=48.0) == []


def test_new_episode_resets_open_state():
    idx = StorylineIndex()
    idx.register("s1", "e1", VX, {"a"}, T0)
    idx.mark_closed("s1")
    idx.new_episode("s1", "e2", VY, {"b"}, T0 + timedelta(days=3))
    s = idx.all()[0]
    assert s.open_episode_id == "e2" and s.episode_count == 2
    assert s.entities == {"a", "b"} and len(s.member_vecs) == 2


def test_restore_rebuilds_a_dormant_retrievable_storyline():
    index = StorylineIndex()
    t = datetime(2025, 7, 18, tzinfo=timezone.utc)
    story = index.restore("s1", member_vecs=[VX, VY], entities={"fda"},
                          newest_entry_at=t, episode_count=2)
    # retrievable by max member cosine
    top = index.top_candidates(VX, k=3, floor=0.5)
    assert [(s.id, round(sim, 3)) for s, sim in top] == [("s1", 1.0)]
    # dormant: no open episode, so a same-story article opens a new one
    assert story.open_episode_id is None
    assert not index.episode_active(story, t + timedelta(hours=1), 48)
    assert story.episode_count == 2
    assert story.newest_entry_at == t
    # centroid is the running mean of the restored members
    assert np.allclose(story.centroid, np.mean(np.stack([VX, VY]), axis=0))
