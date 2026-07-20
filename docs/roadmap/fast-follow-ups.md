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
  ~2min — 60s timeout + retry now in (`pipeline/shared/ai.py`).

- **Fanout-then-ordered-replay pipeline (Vincent's optimization strategy).**
  Split the per-entry work into what needs order and what doesn't. Entries
  enqueue with their `published_at`; a worker pool fans out the expensive
  order-independent LLM calls in parallel — enrich, embed, category — and
  feeds the finished entries into a priority queue keyed on `published_at`;
  the replay/clustering stage then consumes the queue strictly in order.
  Ordering stays deterministic while all prep runs at pool concurrency, and
  the ordered stage is cheap — candidate retrieval is just matmul over
  member embeddings. Remaining in-loop LLM cost: the link judge (only fires
  when candidates clear the floor) and close-time card compression — both
  candidates for the async-card / smaller-model levers above. Note: category
  moves from per-storyline-at-birth to per-entry prep in this design — needs
  a storyline-level reconcile rule (e.g. majority of member entries).
