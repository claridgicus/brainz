---
id: repository-pattern
title: Repository Pattern
type: pattern
product: acme-crm
tags: [architecture, backend]
status: active
relations:
  related_to: [use-postgres]
---

All data access goes through typed repository classes — feature code never
writes raw SQL. Repositories own tenancy filters, `residency_region` checks
(per [[gdpr-data-residency]]), and query instrumentation.

```ts
// [[not-a-real-link]] — fenced code, must not create an edge
const repo = new ContactRepository(tenant);
const page = await repo.list({ segment: "newsletter" });
```

Used by [[contact-model]], [[contact-import]], and [[lead-scoring]].
