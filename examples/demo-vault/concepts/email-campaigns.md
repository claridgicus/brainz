---
id: email-campaigns
title: Email Campaigns
type: feature
product: acme-crm
tags: [email, marketing]
status: active
relations:
  depends_on: [contact-model]
---

Segmented bulk email with templates, scheduling, and per-recipient tracking.
Sends are queued through the [[outbox-pattern]] so a campaign survives worker
crashes without duplicate delivery.

Recipient lists are built from [[contact-model]] segments and honour consent
flags — a hard requirement of [[gdpr-data-residency]]. Unsubscribes update the
contact record synchronously.

Campaign KPIs feed [[lead-scoring]] and roll up into [[mrr]] attribution
reports.
