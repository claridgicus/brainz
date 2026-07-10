---
id: lead-scoring
title: Lead Scoring
type: feature
product: acme-crm
tags: [sales, analytics]
status: draft
relations:
  depends_on: [contact-model, email-campaigns]
---

Assigns each [[lead]] a 0–100 score from engagement signals: email opens and
clicks (from [[email-campaigns]]), site visits, and firmographic fit.

Scores are recomputed nightly and on hot events. The scoring job reads via the
[[repository-pattern]] and never blocks the interactive API. Score history is
retained for 12 months to explain "why did this lead change tier?".
