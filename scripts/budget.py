"""The Gemini budget: what this month's Gemini use has cost, kept in the Activity server's database (D1, table
gemini_usage) so the GitHub jobs and the Activity server (Lookup) count against the same numbers.

The month is Google's billing month (it resets on the 1st, Pacific time). Every request is checked before it is
sent (the worst it could cost must still fit) and counted after (from what Gemini reports it used). When the
database can't be reached nothing is sent: no count, no Gemini.

Limits (environment, with these defaults):
  GEMINI_SEARCH_LIMIT   4500  Google searches a month (Google gives 5,000 free on Gemini 3 and newer)
  GEMINI_SEARCH_DAY     1000  Google searches a day (Google's own cap is 1,500)
  GEMINI_COST_LIMIT     0.80  US dollars a month for everything (tokens, plus any search over the free 5,000);
                              under the 1 euro spend cap set in Google AI Studio, which reacts only after ~10 minutes
Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the same secrets the Activity server's deploy uses)."""
import json, os, time, urllib.request

SEARCH_LIMIT = int(os.environ.get("GEMINI_SEARCH_LIMIT", "") or 4500)
SEARCH_DAY = int(os.environ.get("GEMINI_SEARCH_DAY", "") or 1000)
COST_LIMIT = float(os.environ.get("GEMINI_COST_LIMIT", "") or 4.50)  # dollars a month (Google's own cap: 1 euro a month)
# dollars in all, ever: the 5 euros paid in advance are used, and nothing more (counted on the high side, so a little
# of the 5 euros is left over rather than the card being charged)
TOTAL_LIMIT = float(os.environ.get("GEMINI_TOTAL_LIMIT", "") or 4.50)
FREE_SEARCHES = 5000
SEARCH_PRICE = 14 / 1000  # dollars per search over the free ones

# dollars per million tokens (input, output; thinking counts as output). Kept on the high side on purpose: the
# Flash price is the one from January 2027 (until then it is half), and an unknown model counts as an expensive one.
PRICES = [("flash-lite", 0.30, 2.50), ("flash", 1.50, 7.50)]
UNKNOWN_PRICE = (4.00, 20.00)

TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
_db = None


def price(model):
    for key, i, o in PRICES:
        if model.endswith(key):
            return i, o
    return UNKNOWN_PRICE


def month():
    p = time.gmtime(time.time() - 8 * 3600)  # (Pacific time, near enough)
    return time.strftime("%Y-%m", p), time.strftime("%Y-%m-%d", p)


def _cf(path, body=None):
    req = urllib.request.Request("https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
                                 method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    if not d.get("success"):
        raise RuntimeError("Cloudflare: " + json.dumps(d.get("errors"))[:300])
    return d["result"]


def _sql(sql, params=()):
    global _db
    if not TOKEN or not ACCOUNT:
        raise RuntimeError("no Cloudflare token: the Gemini budget can't be checked")
    if _db is None:
        dbs = _cf("/d1/database?name=nrgfm-activity")
        if not dbs:
            raise RuntimeError("the database nrgfm-activity wasn't found")
        _db = dbs[0]["uuid"]
    res = _cf(f"/d1/database/{_db}/query", {"sql": sql, "params": list(params)})
    return res[0].get("results", []) if res else []


def now():
    """This month's numbers: searches, searches today, cost in dollars, requests."""
    m, d = month()
    _sql("CREATE TABLE IF NOT EXISTS gemini_usage (month TEXT PRIMARY KEY, searches INTEGER DEFAULT 0, micro INTEGER DEFAULT 0, "
         "requests INTEGER DEFAULT 0, day TEXT, day_searches INTEGER DEFAULT 0)")
    rows = _sql("SELECT * FROM gemini_usage WHERE month = ?", (m,))
    r = rows[0] if rows else {}
    total = _sql("SELECT COALESCE(SUM(micro), 0) AS t FROM gemini_usage")[0]["t"]
    return {"searches": r.get("searches") or 0, "day_searches": (r.get("day_searches") or 0) if r.get("day") == d else 0,
            "cost": (r.get("micro") or 0) / 1e6, "requests": r.get("requests") or 0, "total": total / 1e6}


def search_cost(before, n):
    """What n more searches cost, given how many there were this month (the first 5,000 are free)."""
    return max(0, before + n - max(FREE_SEARCHES, before)) * SEARCH_PRICE


def allowed(model, in_tokens, max_out, max_searches):
    """Whether a request may be sent: the worst it could cost must still fit this month's (and today's) limits.
    Returns (True, "") or (False, why)."""
    u = now()
    pi, po = price(model)
    worst = (in_tokens * pi + max_out * po) / 1e6 + search_cost(u["searches"], max_searches)
    if max_searches and u["searches"] + max_searches > SEARCH_LIMIT:
        return False, f"this month's Google searches would pass {SEARCH_LIMIT} ({u['searches']} so far)"
    if max_searches and u["day_searches"] + max_searches > SEARCH_DAY:
        return False, f"today's Google searches would pass {SEARCH_DAY} ({u['day_searches']} so far)"
    if u["cost"] + worst > COST_LIMIT:
        return False, f"this month's Gemini cost would pass ${COST_LIMIT:.2f} (${u['cost']:.3f} so far)"
    if u["total"] + worst > TOTAL_LIMIT:
        return False, f"the money paid in advance is used up (${u['total']:.3f} of ${TOTAL_LIMIT:.2f}): Gemini stays off"
    return True, ""


def add(model, in_tokens, out_tokens, searches):
    """Count a request that was sent (an answer, or one that may have been made but not received: then the worst case)."""
    m, d = month()
    u = now()
    pi, po = price(model)
    cost = (in_tokens * pi + out_tokens * po) / 1e6 + search_cost(u["searches"], searches)
    micro = int(round(cost * 1e6)) + 1
    _sql("INSERT INTO gemini_usage (month, searches, micro, requests, day, day_searches) VALUES (?, ?, ?, 1, ?, ?) "
         "ON CONFLICT(month) DO UPDATE SET searches = searches + excluded.searches, micro = micro + excluded.micro, "
         "requests = requests + 1, day_searches = CASE WHEN day = excluded.day THEN day_searches + excluded.day_searches "
         "ELSE excluded.day_searches END, day = excluded.day", (m, searches, micro, d, searches))
    return cost


def used(d):
    """(input tokens, output tokens, searches) from a Gemini answer."""
    u = d.get("usageMetadata") or {}
    inp = (u.get("promptTokenCount") or 0) + (u.get("toolUsePromptTokenCount") or 0)
    out = (u.get("candidatesTokenCount") or 0) + (u.get("thoughtsTokenCount") or 0)
    s = sum(len([q for q in ((c.get("groundingMetadata") or {}).get("webSearchQueries") or []) if q]) for c in d.get("candidates", []))
    return inp, out, s
