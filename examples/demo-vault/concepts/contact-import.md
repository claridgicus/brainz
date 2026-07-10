---
id: contact-import
title: Contact Import
type: feature
product: acme-crm
tags: [contacts, ingestion]
status: active
relations:
  depends_on: [contact-model]
---

Bulk CSV/XLSX import of contacts with column mapping, dedupe preview, and
rollback. Files are parsed by the [[csv-parser]] service (streaming, max
500k rows) and written through the [[contact-model]] repository.

Import jobs are throttled per tenant under the [[rate-limiting]] constraint so
a large import cannot starve interactive traffic.

Example mapping config:

```json
{ "columns": { "Email": "email", "Full Name": "name" } }
```

Note: `[[this-is-code-not-a-link]]` inside code spans must not create edges.
