# Article overview v2 writer contract

Write a plain-language synthesis of one historical event-card snapshot for an
average U.S. resident. The snapshot may be an overview or an episode; in both
cases, describe the storyline only as it was knowable at that card's cutoff.
The reader chose a category and then clicked this storyline; make the practical
reason for that choice clear without inventing stakes that the supplied
sources do not support.

## Time boundary

Treat `inputBasis.card.newestEntryAt` as a hard knowledge cutoff. Use only the
sources in `inputBasis.sources`, which are the reviewed sources available to
that card at that point in the storyline. Never add a later outcome, later
number, hindsight, or outside fact—even if it is now well known. Describe
pending actions and uncertainty in the state they were in at the cutoff.

## Editorial shape

1. `summary.text` gives readable context and explains why this category and
   storyline could matter to a person. It may use several short sentences when
   needed; prioritize comprehension over an artificial sentence target.
2. `keyPoints` contains two to five distinct themes, ordered by likely public
   importance. Each point gets one or two complete sentences.
3. Select only themes the sources actually support. Useful candidates include
   what changed, who may be affected, practical consequences, public actions or
   deadlines, what happens next, and what remained uncertain at the cutoff.
   Do not force every candidate into every overview.
4. Translate agency and legal language into familiar words. Keep a technical
   term only when it changes the meaning, and explain it in context.
5. Cut ceremony, repeated background, agency self-description, quotes that add
   no information, and process details with no public consequence.

The summary is 25–160 words. Each key point is 12–80 words and one or two
sentences. The full synthesis is 60–380 words. Two strong points are better
than three repetitive ones.

## Evidence

Every summary and key point includes the exact supporting `newsEntryId` values
in `sourceEntryIds`. Collectively, the sections must cite every source supplied
for the card. Do not resolve contradictions silently; state the limited or
conflicting evidence in plain language.

## Output

Write one JSON file named `article-overview.v2.json`:

```json
{
  "schemaVersion": "article-overview.v2",
  "eventCardId": "<task eventCardId>",
  "inputHash": "<task inputHash>",
  "sourceCutoffAt": "<inputBasis.card.newestEntryAt, exactly>",
  "sourceEntryIds": ["<every source newsEntryId, exactly once>"],
  "articleOverview": {
    "summary": {
      "text": "<plain-language synthesis and practical relevance>",
      "sourceEntryIds": ["<supporting source IDs>"]
    },
    "keyPoints": [
      {
        "text": "<one or two sentences about one distinct theme>",
        "sourceEntryIds": ["<supporting source IDs>"]
      }
    ]
  },
  "enrichmentVersion": 2,
  "promptVersion": 2,
  "promptHash": "<SHA-256 of this writer contract>",
  "model": "<writer model name>",
  "generatedAt": "<ISO-8601 timestamp>"
}
```
