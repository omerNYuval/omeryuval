const REPO = "omerNYuval/omeryuval";
const FILE_PATH = "data/trends.json";
const BRANCH = "main";

const LANGUAGE_NAME = "English";
const KEYWORDS = [
  "garage door repair",
  "garage door spring repair",
  "garage door opener repair",
  "garage door won't open",
  "garage door off track",
];
const RISE_THRESHOLD_PCT = 15;
const COOLDOWN_MINUTES = 30;
const MAX_ENTRIES = 300;
const ALLOWED_ORIGIN = "https://omernyuval.github.io";

// Data-management actions (archive/restore/permanently delete an entry) are
// lightweight GitHub-only writes — they never call DataForSEO, so they skip
// the cooldown/billing path entirely rather than being folded into a "run".
const ARCHIVE_ACTIONS = ["archive", "archive_bulk", "restore", "restore_bulk", "delete"];

// All "day" boundaries (what counts as "yesterday", the run's date/time
// stamp, the Trends request window) are computed in the target market's
// own local time, not UTC/server time — otherwise a US day boundary can
// be off by a day depending on when the bot happens to run.
const MARKET_TIMEZONE = "America/Indiana/Indianapolis";

// Google Trends only buckets data into one-point-per-day once the
// requested date range exceeds ~7 days; shorter ranges come back hourly.
// These lookbacks stay safely past that boundary.
const DAILY_LOOKBACK_DAYS = 10;
const WEEKLY_LOOKBACK_DAYS = 16;

const STATE_BY_CITY = {
  Indianapolis: { name: "Indiana", label: "אינדיאנה" },
  Boston: { name: "Massachusetts", label: "מסצ'וסטס" },
};
const CITY_LABEL = {
  Indianapolis: "Indianapolis, IN",
  Boston: "Boston, MA",
};

// Wraps embedded Latin/numeric text in a bidi-isolate so it doesn't
// scramble the surrounding Hebrew sentence's punctuation/word order.
// dir="ltr" is required (not just isolation) because purely numeric/symbol
// text (e.g. "+39%") has no strong-direction character of its own, so a
// plain isolate falls back to the ambient RTL direction and still flips.
function bdi(text) {
  return `<bdi dir="ltr">${text}</bdi>`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method === "GET") {
      try {
        const balance = await fetchBalance(env);
        return json({ balance }, 200);
      } catch (err) {
        return json({ error: String(err && err.message ? err.message : err) }, 500);
      }
    }

    if (request.method !== "POST") {
      return json({ error: "Use GET or POST" }, 405);
    }

    let body = {};
    try {
      body = await request.json();
    } catch (err) {
      body = {};
    }

    try {
      const current = await getCurrentData(env);

      if (ARCHIVE_ACTIONS.includes(body.action)) {
        const output = applyArchiveAction(current.json, body);
        await commitToGitHub(env, current.sha, output);
        return json(output, 200);
      }

      // Free and DataForSEO-only for the read (id_list doesn't touch the
      // balance) -- matches each of DataForSEO's own billed tasks back to
      // the specific scan entry it belongs to by timestamp, so cost stops
      // being a single lump sum and shows up per row too.
      if (body.action === "backfill_costs") {
        const tasks = await fetchAllTasks(env);
        const output = backfillEntryCosts(current.json, tasks);
        const totalSpend = Math.round(tasks.reduce((sum, t) => sum + t.cost, 0) * 10000) / 10000;
        output.totalSpendUsd = totalSpend;
        const changed =
          JSON.stringify(output.entries) !== JSON.stringify(current.json.entries || []) ||
          output.totalSpendUsd !== current.json.totalSpendUsd;
        if (changed) {
          await commitToGitHub(env, current.sha, output);
        }
        return json({ ...(changed ? output : current.json), totalSpend }, 200);
      }

      if (current.json.generated_at) {
        const minutesSince = (Date.now() - new Date(current.json.generated_at).getTime()) / 60000;
        if (minutesSince < COOLDOWN_MINUTES) {
          return json({
            skipped: true,
            minutes_since_last_run: Math.round(minutesSince),
            cooldown_minutes: COOLDOWN_MINUTES,
            data: current.json,
          }, 200);
        }
      }

      const selection = parseSelection(body);
      const { newEntries, market } = selection.frequency === "monthly"
        ? await runMonthly(env, selection)
        : await runTrends(env, selection);

      const balance = await fetchBalance(env).catch(() => current.json.balance ?? null);
      const runCost = attachRunCost(newEntries, current.json.balance, balance);

      const merged = dedupeAndSort([...newEntries, ...(current.json.entries || [])]).slice(0, MAX_ENTRIES);

      // Stored and incremented here (like balance) instead of fetched live
      // from DataForSEO on every page view -- "רענן" in לוגים still exists
      // to reconcile against the authoritative id_list total when wanted,
      // but normal viewing just reads this straight out of the file.
      const prevTotalSpend = typeof current.json.totalSpendUsd === "number" ? current.json.totalSpendUsd : 0;
      const totalSpendUsd = Math.round((prevTotalSpend + (runCost || 0)) * 10000) / 10000;

      const output = {
        generated_at: new Date().toISOString(),
        market,
        keywords: KEYWORDS,
        balance,
        totalSpendUsd,
        entries: merged,
        archived_entries: current.json.archived_entries || [],
      };

      await commitToGitHub(env, current.sha, output);

      return json(output, 200);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

// ---- data management: archive/restore/permanently-delete an entry ----
//
// Entries have no stored id, so they're addressed by the same composite key
// dedupeAndSort already uses to tell entries apart (date+time+title+region
// is unique within the feed). Archived entries live in their own array in
// the same trends.json file — no extra file, no extra commit machinery.

function entryKey(e) {
  return `${e.date}|${e.time}|${e.title}|${e.region}`;
}

// The DataForSEO balance is fetched both before (current.json.balance, from
// the last commit) and after (balance, just now) every real run, so the
// run's actual dollar cost is simply the difference -- no separate
// cost-tracking API call needed. A negative diff (e.g. the account was
// topped up between the two reads) is left untagged rather than shown as
// a nonsensical negative cost.
function attachRunCost(newEntries, balanceBefore, balanceAfter) {
  if (typeof balanceBefore !== "number" || typeof balanceAfter !== "number") return null;
  const cost = balanceBefore - balanceAfter;
  if (cost < 0) return null;
  const scanEntry = newEntries.find((e) => e.type === "scan");
  if (!scanEntry) return null;
  // costUsd is enough on its own -- it's only rendered as a badge in the
  // לוגים panel, so it shouldn't also show up as a tag on every card the
  // entry appears on elsewhere in the feed.
  scanEntry.costUsd = Math.round(cost * 10000) / 10000;
  return scanEntry.costUsd;
}

// Matches DataForSEO's own billed tasks (from id_list) back to the scan
// entry that caused them. This is the authoritative source of truth for
// cost, so it always overwrites whatever costUsd an entry already has --
// including one set by attachRunCost's real-time balance-diff, which can
// be wrong if any other DataForSEO usage (a run that errored out after
// consuming balance but before committing, manual testing, etc.) happened
// in between two successfully-committed runs and got lumped into the
// wrong entry. Each entry only stores a market-local date+time at minute
// granularity (not the task's own id), so matching is by proximity: a task
// counts as belonging to an entry if it was posted on the same market-local
// date and within a few minutes of the entry's recorded time -- safe here
// because runs are always well over the 30-minute cooldown apart. A run can
// involve more than one billed call (location-fallback attempts, the
// subregion check), so every task within the window is claimed and summed,
// not just the single closest one. An entry with no matching task keeps
// whatever costUsd it already had (id_list only covers the last ~6 months).
const COST_MATCH_WINDOW_MINUTES = 5;

function backfillEntryCosts(data, tasks) {
  const entries = Array.isArray(data.entries) ? data.entries.map((e) => ({ ...e })) : [];
  if (!tasks.length) return { ...data, entries };

  const claimed = new Set();
  for (const entry of entries) {
    if (entry.type !== "scan") continue;
    const entryMinutes = timeStringToMinutes(entry.time);
    const matches = [];
    tasks.forEach((t, i) => {
      if (claimed.has(i) || !t.postedAt) return;
      if (marketDateString(t.postedAt) !== entry.date) return;
      const diff = Math.abs(timeStringToMinutes(marketTimeString(t.postedAt)) - entryMinutes);
      if (diff <= COST_MATCH_WINDOW_MINUTES) matches.push({ index: i, diff });
    });
    if (!matches.length) continue;
    let cost = 0;
    for (const m of matches) {
      claimed.add(m.index);
      cost += tasks[m.index].cost;
    }
    entry.costUsd = Math.round(cost * 10000) / 10000;
  }
  return { ...data, entries };
}

function timeStringToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function applyArchiveAction(data, body) {
  const entries = Array.isArray(data.entries) ? [...data.entries] : [];
  const archived = Array.isArray(data.archived_entries) ? [...data.archived_entries] : [];

  if (body.action === "archive" || body.action === "archive_bulk") {
    const keys = new Set(
      body.action === "archive_bulk"
        ? (Array.isArray(body.entryKeys) ? body.entryKeys : [])
        : [body.entryKey]
    );
    const remaining = [];
    for (const e of entries) {
      if (keys.has(entryKey(e))) {
        archived.unshift({ ...e, archived_at: new Date().toISOString() });
      } else {
        remaining.push(e);
      }
    }
    return { ...data, entries: remaining, archived_entries: archived };
  }

  if (body.action === "restore" || body.action === "restore_bulk") {
    const keys = new Set(
      body.action === "restore_bulk"
        ? (Array.isArray(body.entryKeys) ? body.entryKeys : [])
        : [body.entryKey]
    );
    const remainingArchived = [];
    for (const e of archived) {
      if (keys.has(entryKey(e))) {
        const { archived_at, ...rest } = e;
        entries.push(rest);
      } else {
        remainingArchived.push(e);
      }
    }
    if (body.action === "restore" && remainingArchived.length === archived.length) {
      throw new Error("Archived entry not found");
    }
    return { ...data, entries: dedupeAndSort(entries), archived_entries: remainingArchived };
  }

  if (body.action === "delete") {
    const idx = archived.findIndex((e) => entryKey(e) === body.entryKey);
    if (idx === -1) throw new Error("Archived entry not found");
    archived.splice(idx, 1);
    return { ...data, archived_entries: archived };
  }

  throw new Error("Unknown archive action");
}

function parseSelection(body) {
  const frequency = ["daily", "weekly", "monthly"].includes(body.frequency) ? body.frequency : "monthly";
  // Only Indianapolis is reachable from the wizard right now (Boston is
  // blocked there like Miami) — default anything else back to it.
  const city = body.city === "Boston" ? "Boston" : "Indianapolis";
  const scope = body.scope === "neighborhood" ? "neighborhood" : "city";
  const neighborhood = scope === "neighborhood" && typeof body.neighborhood === "string" ? body.neighborhood.trim() : "";
  // Only accept keywords from the known catalog (never arbitrary client input,
  // since that goes straight into a billed DataForSEO request) and fall back
  // to the full catalog if nothing valid was selected.
  const requestedKeywords = Array.isArray(body.keywords) ? body.keywords.filter((k) => KEYWORDS.includes(k)) : [];
  const keywords = requestedKeywords.length ? requestedKeywords : KEYWORDS;
  return { frequency, city, scope: neighborhood ? scope : "city", neighborhood, keywords };
}

// ---- monthly run: real absolute search volume, city/neighborhood-accurate ----

async function runMonthly(env, selection) {
  const { locationName, label } = monthlyLocation(selection);
  const results = await fetchSearchVolume(env, locationName, selection.keywords);
  const { date, time } = nowInMarket();

  const newEntries = [];
  const breakdown = [];
  let signalsFound = 0;

  for (const row of results) {
    if (!row.keyword || row.search_volume == null) continue;
    const pct = trendPctChange(row.monthly_searches);
    breakdown.push({
      keyword: row.keyword,
      valueLabel: `${row.search_volume} חיפושים לחודש`,
      pctLabel: pct !== null ? `${pct >= 0 ? "+" : ""}${pct}%` : "אין נתון להשוואה",
    });
    if (pct !== null && pct >= RISE_THRESHOLD_PCT) {
      newEntries.push({
        date,
        time,
        type: "score",
        title: `עלייה בביקוש: ${bdi(row.keyword)}`,
        detail: `נפח החיפוש למונח ${bdi(`"${row.keyword}"`)} עלה ב-${bdi(pct + "%")} לעומת החודש הקודם באזור ${bdi(label)} (נפח נוכחי: כ-${bdi(row.search_volume)} חיפושים בחודש).`,
        region: label,
        tags: [`+${pct}%`, `${row.search_volume} חיפושים לחודש`],
      });
      signalsFound++;
    }
  }

  newEntries.push({
    date,
    time,
    type: "scan",
    title: "סריקת ביקוש הושלמה",
    detail: `נבדקו ${selection.keywords.length} מונחי מפתח מרכזיים מול נתוני חיפוש אמיתיים עבור ${bdi(label)} (הרצה חודשית). נמצאו ${signalsFound} מונחים בעלייה.${buildBreakdownHtml(breakdown)}`,
    region: label,
    tags: ["חודשי"],
  });

  return { newEntries, market: label };
}

// Renders every checked keyword's actual figure (not just the ones that
// crossed the rise threshold) so a "0 rising" scan still shows real data
// instead of reading as an empty/failed run.
function buildBreakdownHtml(rows) {
  if (!rows.length) return "";
  const items = rows
    .map((r) => `<li>${bdi(r.keyword)}: ${bdi(r.valueLabel)} (${bdi(r.pctLabel)})</li>`)
    .join("");
  return `<div class="scan-breakdown-label">פירוט מלא לפי מונח:</div><ul class="scan-breakdown">${items}</ul>`;
}

function monthlyLocation(selection) {
  const state = STATE_BY_CITY[selection.city].name;
  if (selection.scope === "neighborhood" && selection.neighborhood) {
    return {
      locationName: `${selection.neighborhood},${state},United States`,
      label: `${selection.neighborhood}, ${CITY_LABEL[selection.city]}`,
    };
  }
  return {
    locationName: `${selection.city},${state},United States`,
    label: CITY_LABEL[selection.city],
  };
}

async function fetchSearchVolume(env, locationName, keywords) {
  const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const res = await fetch("https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ keywords, location_name: locationName, language_name: LANGUAGE_NAME }]),
  });
  if (!res.ok) throw new Error(`DataForSEO HTTP error: ${res.status}`);
  const data = await res.json();
  if (data.status_code !== 20000) throw new Error(`DataForSEO error: ${data.status_message}`);
  const task = data.tasks && data.tasks[0];
  if (!task || task.status_code !== 20000) {
    throw new Error(`DataForSEO task error: ${task ? task.status_message : "no task"}`);
  }
  return task.result || [];
}

function trendPctChange(monthlySearches) {
  if (!monthlySearches) return null;
  const points = monthlySearches
    .filter((m) => m.search_volume != null)
    .sort((a, b) => a.year - b.year || a.month - b.month);
  if (points.length < 2) return null;
  const prev = points[points.length - 2];
  const curr = points[points.length - 1];
  if (!prev.search_volume) return null;
  return Math.round(((curr.search_volume - prev.search_volume) / prev.search_volume) * 100);
}

// ---- daily/weekly run: real recent trend, via DataForSEO/Google Trends ----
//
// Google Trends has no city-level option for its interest-over-time series
// (only "interest by subregion", a single snapshot, not a day-by-day
// series) — the finest it supports here is Country. So we try the most
// specific location DataForSEO will accept for this endpoint, and fall
// back to broader geography only if it's rejected, always being honest in
// the resulting entry about which precision level actually got used.

async function runTrends(env, selection) {
  const isDaily = selection.frequency === "daily";
  const lookbackDays = isDaily ? DAILY_LOOKBACK_DAYS : WEEKLY_LOOKBACK_DAYS;
  const { dateFrom, dateTo } = trendsDateRange(lookbackDays);

  const candidates = trendsLocationCandidates(selection);
  const resolved = await fetchTrendsWithFallback(env, candidates, dateFrom, dateTo, selection.keywords);
  const { dataPoints, isCityLevel, locationName } = resolved;
  let { label, precisionNote } = resolved;

  // City-level isn't supported by Trends at all (confirmed live, not just
  // documented), so this fires on essentially every run — it's the only
  // way to tell whether a state/country-level signal is actually
  // Indianapolis-driven before we'd otherwise have to label it generic.
  let verifiedTag = null;
  if (!isCityLevel && selection.city === "Indianapolis") {
    const dominant = await fetchDominantSubregion(env, locationName, dateFrom, dateTo, selection.keywords);
    if (dominant && dominant.toLowerCase().includes("indianapolis")) {
      label = CITY_LABEL.Indianapolis;
      precisionNote = `${precisionNote} — זוהה כמגיע בעיקר מאזור אינדיאנפוליס`;
      verifiedTag = "אומת: אינדיאנפוליס";
    } else if (dominant) {
      precisionNote = `${precisionNote}, אזור מוביל בפועל: ${dominant}`;
    }
  }

  const { date, time } = nowInMarket();
  const newEntries = [];
  let signalsFound = 0;

  const breakdown = [];

  if (isDaily) {
    const curr = dataPoints[dataPoints.length - 1];
    const prev = dataPoints[dataPoints.length - 2];
    selection.keywords.forEach((keyword, i) => {
      const pct = pctChange(valueAt(prev, i), valueAt(curr, i));
      breakdown.push({
        keyword,
        valueLabel: `מדד ${valueAt(curr, i) ?? "–"}/100`,
        pctLabel: pct !== null ? `${pct >= 0 ? "+" : ""}${pct}%` : "אין נתון להשוואה",
      });
      if (pct !== null && pct >= RISE_THRESHOLD_PCT) {
        const tags = [`+${pct}%`, "יומי", precisionNote];
        if (verifiedTag) tags.push(verifiedTag);
        newEntries.push({
          date,
          time,
          type: "score",
          title: `עלייה במגמת חיפוש: ${bdi(keyword)}`,
          detail: `מדד העניין במונח ${bdi(`"${keyword}"`)} עלה ב-${bdi(pct + "%")} מהיום שלפני, ${bdi(precisionNote)} (מדד יחסי, לא נפח חיפושים מוחלט: ${bdi(valueAt(curr, i))}/100).`,
          region: label,
          tags,
        });
        signalsFound++;
      }
    });
    const scanTags = ["הרצה יומית", precisionNote];
    if (verifiedTag) scanTags.push(verifiedTag);
    newEntries.push({
      date,
      time,
      type: "scan",
      title: "סריקת מגמה יומית הושלמה",
      detail: `נבדקו ${selection.keywords.length} מונחי מפתח מול מגמת החיפוש של היומיים האחרונים, ${bdi(precisionNote)}. נמצאו ${signalsFound} מונחים בעלייה.${buildBreakdownHtml(breakdown)}`,
      region: label,
      tags: scanTags,
    });
  } else {
    const thisWeek = dataPoints.slice(-7);
    const prevWeek = dataPoints.slice(-14, -7);
    selection.keywords.forEach((keyword, i) => {
      const currAvg = avgValue(thisWeek, i);
      const prevAvg = avgValue(prevWeek, i);
      const pct = pctChange(prevAvg, currAvg);
      breakdown.push({
        keyword,
        valueLabel: `מדד ממוצע ${currAvg != null ? Math.round(currAvg) : "–"}/100`,
        pctLabel: pct !== null ? `${pct >= 0 ? "+" : ""}${pct}%` : "אין נתון להשוואה",
      });
      if (pct !== null && pct >= RISE_THRESHOLD_PCT) {
        const tags = [`+${pct}%`, "שבועי", precisionNote];
        if (verifiedTag) tags.push(verifiedTag);
        newEntries.push({
          date,
          time,
          type: "score",
          title: `עלייה במגמת חיפוש: ${bdi(keyword)}`,
          detail: `מדד העניין הממוצע במונח ${bdi(`"${keyword}"`)} עלה ב-${bdi(pct + "%")} לעומת השבוע הקודם, ${bdi(precisionNote)} (מדד יחסי ממוצע: ${bdi(Math.round(currAvg))}/100).`,
          region: label,
          tags,
        });
        signalsFound++;
      }
    });
    const scanTags = ["הרצה שבועית", precisionNote];
    if (verifiedTag) scanTags.push(verifiedTag);
    newEntries.push({
      date,
      time,
      type: "scan",
      title: "סריקת מגמה שבועית הושלמה",
      detail: `נבדקו ${selection.keywords.length} מונחי מפתח מול מגמת החיפוש של השבוע האחרון, ${bdi(precisionNote)}. נמצאו ${signalsFound} מונחים בעלייה.${buildBreakdownHtml(breakdown)}`,
      region: label,
      tags: scanTags,
    });
  }

  return { newEntries, market: label };
}

function trendsLocationCandidates(selection) {
  const state = STATE_BY_CITY[selection.city];
  const cityLabel = CITY_LABEL[selection.city];
  const candidates = [];

  if (selection.scope === "neighborhood" && selection.neighborhood) {
    candidates.push({
      locationName: `${selection.neighborhood},${state.name},United States`,
      label: `${selection.neighborhood}, ${cityLabel}`,
      precisionNote: "ברמת שכונה",
    });
  }
  candidates.push({
    locationName: `${selection.city},${state.name},United States`,
    label: cityLabel,
    precisionNote: "ברמת עיר",
  });
  candidates.push({
    locationName: `${state.name},United States`,
    label: `מדינת ${state.label}`,
    precisionNote: "ברמת מדינה (לא ספציפי לעיר)",
  });
  candidates.push({
    locationName: "United States",
    label: 'ארה"ב (ארצי)',
    precisionNote: "ברמה ארצית (לא ספציפי לעיר/מדינה)",
  });
  return candidates;
}

async function fetchTrendsWithFallback(env, candidates, dateFrom, dateTo, keywords) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const dataPoints = await fetchTrends(env, candidate.locationName, dateFrom, dateTo, keywords);
      if (dataPoints && dataPoints.length >= 2) {
        return {
          dataPoints,
          label: candidate.label,
          precisionNote: candidate.precisionNote,
          locationName: candidate.locationName,
          isCityLevel: candidate.precisionNote === "ברמת עיר" || candidate.precisionNote === "ברמת שכונה",
        };
      }
      lastError = new Error(`DataForSEO Trends: not enough data points for ${candidate.locationName}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("DataForSEO Trends: no location candidate succeeded");
}

// When Trends only resolved at state/country level (its city-level ceiling
// means this happens on every real run), this asks a separate, cheap
// endpoint which subregion of that broader area is actually driving the
// interest — so we can honestly upgrade the entry to "Indianapolis" only
// when the data itself points there, instead of always guessing broad.
async function fetchDominantSubregion(env, locationName, dateFrom, dateTo, keywords) {
  try {
    const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
    const res = await fetch("https://api.dataforseo.com/v3/keywords_data/google_trends/subregion_interests/live", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{
        keywords,
        location_name: locationName,
        date_from: dateFrom,
        date_to: dateTo,
        type: "web",
      }]),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status_code !== 20000) return null;
    const task = data.tasks && data.tasks[0];
    if (!task || task.status_code !== 20000) return null;
    const result = task.result && task.result[0];
    const items = (result && result.items) || [];
    // The exact response field names for this endpoint aren't published,
    // so this scans defensively for the first ranked subregion's name
    // rather than assuming a specific field/shape.
    for (const item of items) {
      const list = item.data || item.subregions || item.values || [];
      if (Array.isArray(list) && list.length) {
        const name = subregionName(list[0]);
        if (name) return name;
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

function subregionName(entry) {
  if (!entry || typeof entry !== "object") return null;
  for (const key of ["geo_name", "location_name", "region_name", "name"]) {
    if (typeof entry[key] === "string" && entry[key]) return entry[key];
  }
  return null;
}

async function fetchTrends(env, locationName, dateFrom, dateTo, keywords) {
  const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const res = await fetch("https://api.dataforseo.com/v3/keywords_data/google_trends/explore/live", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{
      keywords,
      location_name: locationName,
      language_code: "en",
      date_from: dateFrom,
      date_to: dateTo,
      type: "web",
      item_types: ["google_trends_graph"],
    }]),
  });
  if (!res.ok) throw new Error(`DataForSEO Trends HTTP error: ${res.status}`);
  const data = await res.json();
  if (data.status_code !== 20000) throw new Error(`DataForSEO Trends error: ${data.status_message}`);
  const task = data.tasks && data.tasks[0];
  if (!task || task.status_code !== 20000) {
    throw new Error(`DataForSEO Trends task error: ${task ? task.status_message : "no task"} (location: ${locationName})`);
  }
  const result = task.result && task.result[0];
  const items = (result && result.items) || [];
  const graph = items.find((it) => it.type === "google_trends_graph");
  return (graph && graph.data) || [];
}

function valueAt(point, index) {
  return point && Array.isArray(point.values) ? point.values[index] : null;
}

function avgValue(points, index) {
  const vals = points.map((p) => valueAt(p, index)).filter((v) => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function pctChange(prev, curr) {
  if (prev == null || curr == null || !prev) return null;
  return Math.round(((curr - prev) / prev) * 100);
}

// ---- market-local date/time helpers ----

function marketDateString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function marketTimeString(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: MARKET_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = map.hour === "24" ? "00" : map.hour;
  return `${hour}:${map.minute}`;
}

function nowInMarket() {
  const now = new Date();
  return { date: marketDateString(now), time: marketTimeString(now) };
}

function shiftDate(yyyyMmDd, deltaDays) {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function trendsDateRange(totalDays) {
  const yesterday = shiftDate(marketDateString(new Date()), -1);
  const dateFrom = shiftDate(yesterday, -(totalDays - 1));
  return { dateFrom, dateTo: yesterday };
}

// ---- shared plumbing (CORS, GitHub commit, balance, dedupe) ----

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function getCurrentData(env) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "garage-signal-worker",
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) {
    return { json: {}, sha: null };
  }
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
  const data = await res.json();
  const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ""))));
  return { json: JSON.parse(content), sha: data.sha };
}

async function commitToGitHub(env, sha, output) {
  const body = {
    message: "Update search demand data (manual run via dashboard)",
    content: btoa(unescape(encodeURIComponent(JSON.stringify(output, null, 2)))),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "garage-signal-worker",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub write failed: ${res.status} ${text}`);
  }
}

async function fetchBalance(env) {
  const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const res = await fetch("https://api.dataforseo.com/v3/appendix/user_data", {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`DataForSEO HTTP error: ${res.status}`);
  const data = await res.json();
  const task = data.tasks && data.tasks[0];
  const result = task && task.result && task.result[0];
  return result && result.money ? result.money.balance : null;
}

// keywords_data/id_list lists every task ever run on this account across
// all of its endpoints (search volume, trends, subregion interests) and
// doesn't deduct from the balance to call it -- it's the one place we can
// get a fully authoritative "total ever spent" figure, since individual
// runs only started carrying their own cost going forward (see
// attachRunCost). Defensive about the exact per-item shape: any item
// without a numeric cost field is just skipped rather than failing the
// whole request.
async function fetchAllTasks(env) {
  const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  // id_list only accepts a datetime_from/datetime_to range within the last
  // 6 months (confirmed live: an older datetime_from is rejected as an
  // "Invalid Field") -- fine here since this account's whole history is
  // recent, but it does mean anything older than 6 months would silently
  // drop out of the total.
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6, sixMonthsAgo.getUTCDate() + 1);
  const formatDatetime = (d) => d.toISOString().replace("T", " ").slice(0, 19) + " +00:00";
  const datetimeFrom = formatDatetime(sixMonthsAgo);
  const datetimeTo = formatDatetime(now);
  const limit = 1000;
  let offset = 0;
  const tasks = [];

  for (let page = 0; page < 20; page++) {
    const res = await fetch("https://api.dataforseo.com/v3/keywords_data/id_list", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ datetime_from: datetimeFrom, datetime_to: datetimeTo, limit, offset }]),
    });
    if (!res.ok) throw new Error(`DataForSEO id_list HTTP error: ${res.status}`);
    const data = await res.json();
    if (data.status_code !== 20000) throw new Error(`DataForSEO id_list error: ${data.status_message}`);
    const task = data.tasks && data.tasks[0];
    if (!task || task.status_code !== 20000) {
      throw new Error(`DataForSEO id_list task error: ${task ? task.status_message : "no task"}`);
    }
    const items = task.result || [];
    for (const item of items) {
      if (typeof item.cost !== "number") continue;
      tasks.push({ cost: item.cost, postedAt: parseDataForSeoDatetime(item.datetime_posted) });
    }
    if (items.length < limit) break;
    offset += limit;
  }

  return tasks;
}

// DataForSEO's own datetime format ("2026-09-13 09:00:12 +00:00") isn't
// directly ISO-8601 (space instead of "T", another space before the
// offset) -- this turns it into something Date can parse.
function parseDataForSeoDatetime(str) {
  if (typeof str !== "string") return null;
  const iso = str.replace(" ", "T").replace(" ", "");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function dedupeAndSort(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = entryKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  out.sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
  return out;
}
