# Fast follow ups

- **Attach-time card refresh (newsfeed latency).** Episodes should get an
  event card immediately and the storyline overview should update on every
  attach — not at episode close. Today a development landing in an open
  episode is invisible for up to 48h (`SPINE_EPISODE_GAP_HOURS`); only
  brand-new storylines surface instantly (birth overview). Production shape:
  mint card versions at attach time (write-once versioning already allows
  it), or split — deterministic rank/`newest_entry_at` bump synchronous, LLM
  compression async. Keep close-time cards as the immutable checkpoint for
  golden/eval. Bonus: erases the stale-rank_key gap for open episodes.

- **Per-entry latency architecture for the real-time pipeline.** Production
  processes entry-by-entry, so every stage is serial latency: enrich →
  embed → extract → link judge → (new storyline) birth card + category
  classify. The replay batches category classification at end-of-run for
  slice throughput (safe: the classifier reads only the storyline's own
  card + the category list; nothing mid-run consumes categories) — but the
  production stream pays that call inline unless redesigned. Directions to
  evaluate: parallelize the independent LLM calls within one entry
  (category never gates linking — fire alongside), async card/overview
  generation behind the attach, smaller adjudicator model (A/B via harness:
  `ADJUDICATOR_MODEL=@cf/meta/llama-3.1-8b-instruct-fast`), selective JSON
  mode (constrained decoding measured 2-3× slower per call; keep where
  parse failures hurt, e.g. compressor). Observed Workers AI p90 stragglers
  ~2min — 60s timeout + retry now in (`pipeline/ai.py`).
