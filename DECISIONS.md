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
- **2026-09-27** — Built step 1 (read-only access) and step 2 (first proposal
  type) of the 2026-09-18 plan above:
  - "עדכון דפי אתר" is a live, working page in the dashboard: a preview of
    garage-door-site (blurred `og-image.png` behind a click-to-load gate,
    then the real live iframe), plus its current `<title>` and last commit
    info pulled from the public repo.
  - The first proposal type is exactly the one first sketched in the
    2026-09-18 entry, now concrete: reorder garage-door-site's 4 "jobs we do
    most" service cards (`<section class="features">`, matched by each
    card's `onclick="bookService('<key>')"`, keys: `emergency`/`springs`/
    `openers`/`install`) to lead with whichever tracked keyword is
    currently trending. Keyword→card map lives in `KEYWORD_CARD_MAP` in
    `cloudflare-worker/worker.js` (`garage door repair` itself has no
    single card, so it's deliberately left unmapped and never drives a
    proposal). Approval gate is real and working: `propose_site_update` is
    fully read-only (picks the trend, fetches garage-door-site's index.html,
    diffs card order, returns it — never writes), `approve_site_update` is
    the only action that ever writes to garage-door-site, and it only runs
    on an explicit "אשר ופרסם" click (with a confirm() dialog) in the
    dashboard.
  - Not yet confirmed: whether the Worker's `GITHUB_TOKEN` secret actually
    has write access to `garage-door-site` (it was only ever scoped for
    `omeryuval`) — the first real approval click will reveal this; if it
    fails, the token needs write access added to `omerNYuval/garage-door-site`
    too.

## How to update this file

When a decision is made in either project's session that the other side
should know about, append a dated bullet above, then commit and push. If
you're on the garage-door-site side and don't have this repo cloned, ask the
user to relay the update, or clone `omerNYuval/omeryuval` to add it directly.
