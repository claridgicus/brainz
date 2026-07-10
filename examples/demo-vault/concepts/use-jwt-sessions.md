---
id: use-jwt-sessions
title: 'Decision: JWT Sessions'
type: decision
product: acme-crm
tags: [auth, adr]
status: active
relations:
  part_of: [auth-system]
---

**Decision.** Sessions are short-lived (15 min) JWTs with rotating refresh
tokens stored server-side; access tokens are validated statelessly at the
gateway.

**Why.** Horizontal scaling without a session store lookup on every request.

**Consequences.** Token revocation is eventual (≤ 15 min); sensitive actions
in the [[auth-system]] re-verify credentials. Refresh tokens live in Postgres
per [[use-postgres]] and are rate-limited per [[rate-limiting]].
