---
id: use-postgres
title: 'Decision: Use PostgreSQL'
type: decision
product: acme-crm
tags: [database, adr]
status: active
relations:
  supersedes: [use-mysql]
---

**Decision.** All persistent state lives in PostgreSQL 16 (managed, EU region).
One primary per region, read replicas for analytics.

**Why.** Row-level security for multi-tenancy, mature JSONB for the contact
activity timeline, and logical replication for the [[outbox-pattern]] relay.

**Consequences.** Feature code accesses data only via the
[[repository-pattern]]; region pinning satisfies [[gdpr-data-residency]].
This supersedes the earlier MySQL prototype.
