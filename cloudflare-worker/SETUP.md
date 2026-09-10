# הקמת Cloudflare Worker — הרצת סוכן בלחיצת כפתור

מטרה: לחיצה על כפתור הרובוט 🤖 באתר תבצע חיפוש אמיתי מול DataForSEO, בלי לחשוף את הסיסמה שלך לאף מבקר באתר.

## שלב 1 — טוקן ב-GitHub

1. גלוש ל-https://github.com/settings/personal-access-tokens/new
2. שם: `garage-signal-worker`
3. **Repository access** → **Only select repositories** → `omeryuval`
4. **Permissions** → **Repository permissions** → **Contents** → **Read and write**
5. **Generate token** → שמור את הטוקן (מתחיל ב-`github_pat_...`) — מוצג פעם אחת בלבד

## שלב 2 — חשבון Cloudflare + Worker

1. https://dash.cloudflare.com/sign-up (חינמי)
2. **Workers & Pages** → **Create** → **Create Worker**
3. שם, למשל `garage-signal-agent` → **Deploy**
4. **Edit code** → מחק הכל, הדבק את התוכן של `cloudflare-worker/worker.js` מהריפו הזה
5. **Deploy** שוב

## שלב 3 — סודות ל-Worker

בעמוד ה-Worker → **Settings** → **Variables and Secrets** → **Add**:

| שם | ערך |
|---|---|
| `DATAFORSEO_LOGIN` | `omeryuval21@gmail.com` |
| `DATAFORSEO_PASSWORD` | הסיסמה מ-DataForSEO (מומלץ טרייה אחרי reset) |
| `GITHUB_TOKEN` | הטוקן משלב 1 |

**חשוב**: הסודות האלה נכנסים רק ב-Cloudflare, לא בצ'אט ולא בריפו.

## שלב 4 — חיבור לאתר

1. תעתיק את כתובת ה-Worker (נראית כמו `https://garage-signal-agent.XXXX.workers.dev`)
2. תשלח לי אותה — אני אעדכן שורה אחת ב-`agent-ops-log.html`:
   ```js
   const WORKER_URL = "https://REPLACE_WITH_YOUR_WORKER_URL.workers.dev";
   ```
3. אחרי זה, לחיצה על 🤖 באתר תריץ חיפוש אמיתי בפועל.

## הגנה מובנית שכבר קיימת בקוד

- **קירור של 30 דקות** — לחיצות חוזרות בטווח הזה לא יפנו שוב ל-DataForSEO (חוסך כסף מלחיצות בטעות/חוזרות).
- ה-Worker מוגבל ב-CORS לדומיין `omernyuval.github.io` בלבד.

## מה שעדיין קבוע בקוד (אפשר לשנות אחר כך)

- מיקום: בוסטון, MA (`agent-ops-log.html` ו-`scripts/fetch_trends.py` עדיין ממוקדים לשם)
- מילות מפתח: 5 המילים הקבועות ברשימת `KEYWORDS` בסקריפט הראשי
