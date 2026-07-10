---
id: contact-model
title: Contact Data Model
type: concept
product: acme-crm
tags: [data-model, backend]
status: active
relations:
  related_to: [lead]
---

A **contact** is a person record: name, emails, phone numbers, company,
consent flags, and a free-form activity timeline. Contacts are stored in
Postgres (per [[use-postgres]]) with per-tenant row-level security.

Every contact carries a `residency_region` column so [[gdpr-data-residency]]
can be enforced at the storage layer. Access goes through the
[[repository-pattern]] — no raw SQL in feature code.
