---
id: outbox-pattern
title: Transactional Outbox
type: pattern
product: acme-crm
tags: [architecture, messaging]
status: active
relations:
  related_to: [email-campaigns]
---

Writes that must trigger side effects (emails, webhooks) insert an event row
into an `outbox` table in the same Postgres transaction as the domain change.
A relay tails the outbox via logical replication (enabled by [[use-postgres]])
and publishes to the queue exactly once.

[[email-campaigns]] is the heaviest user: one campaign fan-out can enqueue
millions of sends without losing or duplicating any on worker restart.
