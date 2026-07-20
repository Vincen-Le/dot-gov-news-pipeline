from __future__ import annotations

import numpy as np


def pack_fp16(vec: list[float] | np.ndarray) -> bytes:
    return np.asarray(vec, dtype=np.float16).tobytes()


def unpack_fp16(raw: bytes) -> np.ndarray:
    return np.frombuffer(raw, dtype=np.float16).astype(np.float32)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    # clamp: fp16 roundtrips push self-similarity past 1.0 by epsilon, which
    # violates the db's [-1, 1] similarity check constraints
    return float(min(1.0, max(-1.0, np.dot(a, b) / (na * nb))))


def running_mean(current: np.ndarray | None, count: int, new: np.ndarray) -> np.ndarray:
    if current is None or count == 0:
        return np.asarray(new, dtype=np.float32)
    return (current * count + new) / (count + 1)
