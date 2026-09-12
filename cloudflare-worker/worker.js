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

    try {
      const current = await getCurrentData(env);

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

      const selection = await parseSelection(request);
      const { newEntries, market } = selection.frequency === "monthly"
        ? await runMonthly(env, selection)
        : await runTrends(env, selection);

      const merged = dedupeAndSort([...newEntries, ...(current.json.entries || [])]).slice(0, MAX_ENTRIES);
      const balance = await fetchBalance(env).catch(() => current.json.balance ?? null);

      const output = {
        generated_at: new Date().toISOString(),
        market,
        keywords: KEYWORDS,
        balance,
        entries: merged,
      };

      await commitToGitHub(env, current.sha, output);

      return json(output, 200);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

async function parseSelection(request) {
  let body = {};
  try {
    body = await request.json();
  } catch (err) {
    body = {};
  }
  const frequency = ["daily", "weekly", "monthly"].includes(body.frequency) ? body.frequency : "monthly";
  // Only Indianapolis is reachable from the wizard right now (Boston is
  // blocked there like Miami) — default anything else back to it.
  const city = body.city === "Boston" ? "Boston" : "Indianapolis";
  const scope = body.scope === "neighborhood" ? "neighborhood" : "city";
  const neighborhood = scope === "neighborhood" && typeof body.neighborhood === "string" ? body.neighborhood.trim() : "";
  return { frequency, city, scope: neighborhood ? scope : "city", neighborhood };
}

// ---- monthly run: real absolute search volume, city/neighborhood-accurate ----

async function runMonthly(env, selection) {
  const { locationName, label } = monthlyLocation(selection);
  const results = await fetchSearchVolume(env, locationName);
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
    detail: `נבדקו ${KEYWORDS.length} מונחי מפתח מרכזיים מול נתוני חיפוש אמיתיים עבור ${bdi(label)} (הרצה חודשית). נמצאו ${signalsFound} מונחים בעלייה.${buildBreakdownHtml(breakdown)}`,
    region: label,
    tags: ["נתונים אמיתיים", "חודשי"],
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

async function fetchSearchVolume(env, locationName) {
  const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const res = await fetch("https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ keywords: KEYWORDS, location_name: locationName, language_name: LANGUAGE_NAME }]),
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
  const resolved = await fetchTrendsWithFallback(env, candidates, dateFrom, dateTo);
  const { dataPoints, isCityLevel, locationName } = resolved;
  let { label, precisionNote } = resolved;

  // City-level isn't supported by Trends at all (confirmed live, not just
  // documented), so this fires on essentially every run — it's the only
  // way to tell whether a state/country-level signal is actually
  // Indianapolis-driven before we'd otherwise have to label it generic.
  let verifiedTag = null;
  if (!isCityLevel && selection.city === "Indianapolis") {
    const dominant = await fetchDominantSubregion(env, locationName, dateFrom, dateTo);
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
    KEYWORDS.forEach((keyword, i) => {
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
      detail: `נבדקו ${KEYWORDS.length} מונחי מפתח מול מגמת החיפוש של היומיים האחרונים, ${bdi(precisionNote)}. נמצאו ${signalsFound} מונחים בעלייה.${buildBreakdownHtml(breakdown)}`,
      region: label,
      tags: scanTags,
    });
  } else {
    const thisWeek = dataPoints.slice(-7);
    const prevWeek = dataPoints.slice(-14, -7);
    KEYWORDS.forEach((keyword, i) => {
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
      detail: `נבדקו ${KEYWORDS.length} מונחי מפתח מול מגמת החיפוש של השבוע האחרון, ${bdi(precisionNote)}. נמצאו ${signalsFound} מונחים בעלייה.${buildBreakdownHtml(breakdown)}`,
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

async function fetchTrendsWithFallback(env, candidates, dateFrom, dateTo) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const dataPoints = await fetchTrends(env, candidate.locationName, dateFrom, dateTo);
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
async function fetchDominantSubregion(env, locationName, dateFrom, dateTo) {
  try {
    const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
    const res = await fetch("https://api.dataforseo.com/v3/keywords_data/google_trends/subregion_interests/live", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{
        keywords: KEYWORDS,
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

async function fetchTrends(env, locationName, dateFrom, dateTo) {
  const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const res = await fetch("https://api.dataforseo.com/v3/keywords_data/google_trends/explore/live", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{
      keywords: KEYWORDS,
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

function nowInMarket() {
  const now = new Date();
  const date = marketDateString(now);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: MARKET_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = map.hour === "24" ? "00" : map.hour;
  return { date, time: `${hour}:${map.minute}` };
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

function dedupeAndSort(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = `${e.date}|${e.time}|${e.title}|${e.region}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  out.sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
  return out;
}
