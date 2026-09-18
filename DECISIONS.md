# Shared decisions log — omeryuval agent ↔ garage-door-site

Single source of truth for decisions that affect both projects. Each session
(this repo, or garage-door-site) should check this file when starting related
work, and append new entries here (git push) after significant decisions —
don't rely on chat memory alone, since the two projects run in separate
environments with no shared session memory.

## Projects

- **omeryuval** (this repo) — internal agent dashboard. Scans search-trend
  data per region for garage-door-repair keywords (`scripts/fetch_trends.py`
  → `data/trends.json`, shown in `agent-ops-log.html`). Access: owner + partner
  only. Stays a plain unbranded GitHub Pages site — no domain needed.
- **garage-door-site** (github.com/omerNYuval/garage-door-site) — the public
  client-facing landing page, will need a real commercial domain eventually
  since it's what's shown to customers via Google.

## Decisions so far

- **2026-09-18** — Long-term goal: the agent detects a significant, sustained
  search-trend spike (not single-scan noise) and updates garage-door-site's
  `index.html` content accordingly, then commits + pushes directly via a
  GitHub-token-holding script (not a live API between the two static sites —
  GitHub Pages has no server to call).
- **2026-09-18** — Full automation is the end goal, but NOT from day one.
  Start with a proposal/approval step: the agent surfaces a proposed edit in
  this dashboard's existing "SOON" section ("אתר משני" → "עדכון דפי אתר"),
  a human approves, only then does the push happen. Remove the approval gate
  once proven reliable over time.
- **2026-09-18** — Business owner (the client) will eventually get a
  restricted/partial view of this dashboard, not full access.

## How to update this file

When a decision is made in either project's session that the other side
should know about, append a dated bullet above, then commit and push. If
you're on the garage-door-site side and don't have this repo cloned, ask the
user to relay the update, or clone `omerNYuval/omeryuval` to add it directly.
