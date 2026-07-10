---
id: auth-system
title: Auth System
type: concept
product: acme-crm
tags: [auth, backend]
status: active
relations:
  depends_on: [use-jwt-sessions]
  constrains: []
---

The auth system handles signup, login, session issuance, and permission checks
for every Acme CRM request. Sessions are stateless JWTs (see
[[use-jwt-sessions|the JWT decision]]) validated at the API gateway.

Personal data captured at signup is subject to [[gdpr-data-residency]], so all
auth records live in the EU Postgres cluster chosen in [[use-postgres]].

Roles: `admin`, `manager`, `rep`. A [[lead]] record is only visible to reps in
the owning team unless a manager grants org-wide read.
