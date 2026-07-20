import numpy as np

from pipeline.shared.vectors import cosine, pack_fp16, running_mean, unpack_fp16


def test_fp16_roundtrip():
    v = [0.1, -0.5, 0.25, 1.0]
    out = unpack_fp16(pack_fp16(v))
    assert out.dtype == np.float32
    assert np.allclose(out, v, atol=1e-3)


def test_cosine():
    a = np.array([1.0, 0.0], dtype=np.float32)
    assert cosine(a, a) == 1.0
    assert cosine(a, np.array([0.0, 1.0], dtype=np.float32)) == 0.0
    assert cosine(a, np.zeros(2, dtype=np.float32)) == 0.0


def test_running_mean():
    m = running_mean(None, 0, np.array([2.0, 2.0]))
    assert np.allclose(m, [2.0, 2.0])
    m = running_mean(m, 1, np.array([4.0, 0.0]))
    assert np.allclose(m, [3.0, 1.0])


def test_cosine_clamped_to_unit_range():
    # fp16 roundtrips make self-similarity exceed 1.0 by float epsilon, which
    # violates the db's similarity <= 1.0 checks on near_dup attaches
    rng = np.random.default_rng(7)
    for _ in range(50):
        v = rng.normal(size=1024).astype(np.float32)
        v /= np.linalg.norm(v)
        u = unpack_fp16(pack_fp16(v))
        assert -1.0 <= cosine(u, u) <= 1.0
        assert -1.0 <= cosine(u, -u) <= 1.0
