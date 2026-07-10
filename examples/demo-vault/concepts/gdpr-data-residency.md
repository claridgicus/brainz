---
id: gdpr-data-residency
title: GDPR Data Residency
type: constraint
product: acme-crm
tags: [compliance, gdpr]
status: active
relations:
  constrains: [contact-model, email-campaigns, auth-system]
---

EU customer personal data must be stored and processed inside the EU. This is
contractual for all Enterprise tenants and applies to primary storage, backups,
and analytics replicas.

Practical rules:

- Every personal-data table carries a `residency_region` column (see
  [[contact-model]]).
- New services must deploy to `eu-central-1` before serving EU tenants.
- [[email-campaigns]] tracking pixels resolve to EU endpoints for EU
  recipients.
