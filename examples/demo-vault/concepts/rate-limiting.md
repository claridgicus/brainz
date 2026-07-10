---
id: rate-limiting
title: Tenant Rate Limiting
type: constraint
product: acme-crm
tags: [reliability, backend]
status: active
relations:
  constrains: [contact-import, use-jwt-sessions]
---

Every tenant-scoped API and background job is throttled: 100 req/s interactive,
10 concurrent background jobs per tenant. Protects shared Postgres capacity
(see [[use-postgres]]) and keeps one noisy tenant from degrading others.

Bulk features such as [[contact-import]] must checkpoint and resume rather
than retry whole jobs when throttled.
