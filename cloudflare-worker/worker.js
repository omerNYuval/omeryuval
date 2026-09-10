const REPO = "omerNYuval/omeryuval";
const FILE_PATH = "data/trends.json";
const BRANCH = "main";

const MARKET_NAME = "Boston, MA";
const LOCATION_NAME = "Boston,Massachusetts,United States";
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json({ error: "Use POST" }, 405);
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

      const results = await fetchSearchVolume(env);
      const now = new Date();
      const runDate = now.toISOString().slice(0, 10);
      const runTime = now.toISOString().slice(11, 16);

      const newEntries = [];
      let signalsFound = 0;

      for (const row of results) {
        if (!row.keyword || row.search_volume == null) continue;
        const pct = trendPctChange(row.monthly_searches);
        if (pct !== null && pct >= RISE_THRESHOLD_PCT) {
          newEntries.push({
            date: runDate,
            time: runTime,
            type: "score",
            title: `עלייה בביקוש: ${row.keyword}`,
            detail: `נפח החיפוש למונח "${row.keyword}" עלה ב-${pct}% לעומת החודש הקודם באזור ${MARKET_NAME} (נפח נוכחי: כ-${row.search_volume} חיפושים בחודש).`,
            region: MARKET_NAME,
            tags: [`+${pct}%`, `${row.search_volume} חיפושים לחודש`],
          });
          signalsFound++;
        }
      }

      newEntries.push({
        date: runDate,
        time: runTime,
        type: "scan",
        title: "סריקת ביקוש הושלמה",
        detail: `נבדקו ${KEYWORDS.length} מונחי מפתח מרכזיים מול נתוני חיפוש אמיתיים עבור ${MARKET_NAME}. נמצאו ${signalsFound} מונחים בעלייה.`,
        region: MARKET_NAME,
        tags: ["נתונים אמיתיים"],
      });

      const merged = dedupeAndSort([...newEntries, ...(current.json.entries || [])]).slice(0, MAX_ENTRIES);

      const output = {
        generated_at: now.toISOString(),
        market: MARKET_NAME,
        keywords: KEYWORDS,
        entries: merged,
      };

      await commitToGitHub(env, current.sha, output);

      return json(output, 200);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

async function fetchSearchVolume(env) {
  const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const res = await fetch("https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ keywords: KEYWORDS, location_name: LOCATION_NAME, language_name: LANGUAGE_NAME }]),
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
