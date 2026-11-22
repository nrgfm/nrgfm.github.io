"""Gemini decides the suggested release, year and genres for each track (runs on GitHub Actions, in batches).

For tracks where MusicBrainz, Discogs or the YouTube/Vimeo/SoundCloud description found something, Gemini
weighs those findings (they are often wrong matches: a cover, a remix, another song with the same name) and
picks the original release, its year and the genres. For tracks where nothing was found, Gemini looks the
track up itself with Google Search.

Writes data/ai.json, keyed by link (everything in it comes from Gemini; the site doesn't say so anywhere):
  {"rl": "release", "y": 1984, "g": ["genre", ...], "md": ["mood word", ...], "how": "sources" | "search", "conf": "high|medium|low",
   "m": model, "in": fingerprint of what it was given (a track is asked again when that changes)}
(entries with "how": "research" were looked up by hand by Claude with web research; they are kept and never asked again)
and data/gemini-status.json (whether it ran, how many, or why it stopped).

The site uses these in place of the other sources' suggestions; a release you set by hand still wins.
Needs the repository secret GEMINI_API_KEY. Usage: python3 scripts/gemini.py [max_tracks] [max_minutes]"""
import hashlib, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 400
MINUTES = float(sys.argv[2]) if len(sys.argv) > 2 else 50
KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_MODEL", "").strip()
API = "https://generativelanguage.googleapis.com/v1beta/"
VERSION = 3  # 3: no limit on genres and mood words; 2: also mood words, from the title, description and YouTube comments (everything is asked again once)
PER_CALL = {"bandcamp": 8, "sources": 50, "search": 5, "better": 5}  # tracks per request
# the most each answer may be (tokens, thinking included): keeps every request's worst case known, so the budget
# check before it is real
MAX_OUT = {"bandcamp": 6000, "sources": 12000, "search": 6000, "better": 6000}
# Google searches one request may make at most, as counted before sending it (Gemini usually makes one or two a track)
MAX_SEARCHES = {"bandcamp": 40, "sources": 0, "search": 25, "better": 25}
ESCALATE = int(os.environ.get("GEMINI_ESCALATE", "") or 40)  # tracks asked again with the better model, at most, per run
MAX_REQUESTS = int(os.environ.get("GEMINI_MAX_REQUESTS", "") or 150)  # requests per run, at most
PAUSE = 4  # seconds between requests
START = time.time()
import budget  # noqa: E402  (scripts/budget.py: this month's Gemini use, shared with the Activity server)


def call(path, body=None, timeout=180):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "x-goog-api-key": KEY})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def why(e):
    """Google's reason for a failed request (the key itself is never printed)."""
    try:
        return f"HTTP {e.code} " + json.load(e).get("error", {}).get("message", "")[:900]
    except Exception:  # noqa: BLE001
        return f"HTTP {getattr(e, 'code', '')}"


def pick_models():
    """Two lists, newest first: the Flash-Lite models (quick and cheap: every track is asked with these first) and
    the Flash models (better at weighing sources: a track the first answer wasn't sure about is asked again with
    one). Gemini 2.5 and older are left out (retired for this key). GEMINI_MODEL, when set, is used for both."""
    if MODEL:
        return [MODEL], [MODEL]
    names = []
    page = ""
    while True:
        d = call("models?pageSize=200" + (f"&pageToken={page}" if page else ""), timeout=60)
        for m in d.get("models", []):
            n = m["name"].split("/")[-1]
            v = re.fullmatch(r"gemini-(\d+(?:\.\d+)?)-flash(-lite)?", n)
            if v and float(v.group(1)) >= 3 and "generateContent" in m.get("supportedGenerationMethods", []):
                names.append(n)
        page = d.get("nextPageToken")
        if not page:
            break
    ver = lambda n: -float(re.search(r"\d+(\.\d+)?", n).group())  # noqa: E731
    lite = sorted({n for n in names if n.endswith("-lite")}, key=ver)
    full = sorted({n for n in names if not n.endswith("-lite")}, key=ver)
    if not lite and not full:
        raise SystemExit("no Gemini Flash model available for this key")
    return lite or full, full or lite


def title_of(tr, meta):
    m = meta.get(tr["url"], {})
    return tr.get("title") or m.get("title") or m.get("wb_title") or ""


def facts(tr, meta, extra, desc):
    """What Gemini is told about one track."""
    u, m, x = tr["url"], meta.get(tr["url"], {}), extra.get(tr["url"], {})
    f = {"title": title_of(tr, meta), "uploader": x.get("by") or m.get("author_name") or m.get("wb_author") or "",
         "uploaded": x.get("up") or "", "site": tr.get("platform", "")}
    if tr.get("platform") == "bandcamp" or "bandcamp.com" in u:
        f["url"] = u
    tags = [t for t in (tr.get("tags") or {}) if t not in ("flagged", "broken link", "plays on youtube only")] if isinstance(tr.get("tags"), dict) else list(tr.get("tags") or [])
    if tags:
        f["group_tags"] = tags
    # the title as written by the group and the link's own title, when they differ (a year in either is a hint)
    fetched = m.get("title") or m.get("wb_title") or ""
    if tr.get("title") and fetched and fetched.strip().lower() != tr["title"].strip().lower():
        f["link_title"] = fetched
    if tr.get("year") is not None:  # set by hand in the group's edit card: these are right
        f["group_year"] = tr["year"] or "none"
    if tr.get("release") is not None:
        f["group_release"] = tr["release"]
    if tr.get("genres") is not None:
        f["group_genres"] = tr["genres"]
    found = {}
    if x.get("rl"):
        found["releases"] = x["rl"][:8]
    if x.get("y"):
        found["years"] = [x["y"]] + [y for y in (x.get("ys") or []) if y != x["y"]][:6]
    if x.get("g"):
        found["genres"] = x["g"]
    if found:
        found["from"] = x.get("src") or ""
        f["found"] = found
    d = (desc.get(u) or "").strip()
    if d:
        f["description"] = d[:700]
    return f


YTKEY = os.environ.get("YT_API_KEY", "").strip()


def yt_comments(video_id):
    """The top comments of a YouTube video (by relevance, short): what listeners call it ("dreamy", "pure 90s rave")."""
    if not YTKEY or not video_id:
        return []
    q = urllib.parse.urlencode({"part": "snippet", "videoId": video_id, "maxResults": 15, "order": "relevance",
                                "textFormat": "plainText", "key": YTKEY})
    try:
        with urllib.request.urlopen("https://www.googleapis.com/youtube/v3/commentThreads?" + q, timeout=20) as r:
            d = json.load(r)
    except Exception:  # noqa: BLE001  (comments switched off, quota, …)
        return []
    out = []
    for it in d.get("items", []):
        t = ((it.get("snippet") or {}).get("topLevelComment") or {}).get("snippet", {}).get("textDisplay", "")
        t = re.sub(r"\s+", " ", t).strip()
        if t:
            out.append(t[:200])
    return out[:10]


def has_sources(f):
    """MusicBrainz or Discogs found something; otherwise Gemini searches the web itself (with the description)."""
    return bool(f.get("found"))


PROMPT = """You help a music-sharing group catalogue the tracks people posted (mostly YouTube links).
For each track below, decide:
- "rl": the name of the ORIGINAL release (album, single or EP) the recording first came out on, or "" if unknown
- "y": the year that release first came out (a number), or null if unknown. The original, not a reissue,
  remaster, compilation or upload year. A remix or edit counts from when that remix or edit came out.
- "g": every genre and style that fits (no limit), lowercase, most fitting first (prefer names from this list when one fits: {vocab})
- "md": every lowercase word that fits the mood or sound (no limit), like "soft", "floating", "romantic", "melancholic",
  "hypnotic", "euphoric", "dark", "warm", "lo-fi".
  For both, use genre words and descriptions found in the title, the description and the listeners' "comments" when
  they fit, and your own knowledge of the track.
- "ar": the artist as credited on that release (e.g. "Röyksopp", "Daft Punk feat. Romanthony"); for music from a
  game, film, anime or TV series the composer. "" if unknown
- "co": the country the artist (or composer) is from, as a two-letter code ("GB", "JP", "US"), or "" if unknown
- "about": one or two plain sentences on what the track is when that isn't obvious from the title, e.g.
  'The track "Mintche" is background music from the Tales of Eternia Original Sound Version (OSV), composed by
  Motoi Sakuraba.' Otherwise "".
- "conf": "high", "medium" or "low": how sure you are.
{how}
Answer with JSON only, no other text: an array with one object per track, in the same order, each
{{"i": <the track's number>, "rl": ..., "y": ..., "g": [...], "md": [...], "ar": ..., "co": ..., "about": ..., "conf": ...}}.

Tracks:
{tracks}"""
HOW_BETTER = """
A quicker model already answered for these tracks but wasn't sure ("first_answer"). Check it: search for what is
missing or doubtful and correct it; keep what is right. Say "high" only when a source confirms it."""
HOW = {
    "sources": """Use the "found" data (from MusicBrainz, Discogs and the video description) and your own knowledge.
The found data is often a wrong match: another song with the same name, a cover, a later compilation.
Ignore what doesn't fit the title and uploader. Don't guess: leave a field empty when you aren't fairly sure.
"group_year", "group_release" and "group_genres", when given, were set by hand by the group and are right: keep them.
A year written in "title" or "link_title" is a strong hint (it can also be a remaster's year).""",
    "search": """MusicBrainz and Discogs found nothing about these tracks. Read the video description when there is one,
and look each track up with Google Search. Search for EVERY track, at least once each, before answering: never
answer from memory alone (memory gets album names and years wrong while sounding sure). search "discogs <the title>" and read the first 3 or 4 results (the
Discogs page of the release usually says it all), then search the title by itself (Discogs, MusicBrainz, Bandcamp, Wikipedia, VGMdb, the
artist's pages are good sources). Many are not ordinary releases: music from a video game, film, anime or TV series
(then add genres like "video game music" or "soundtrack", give the year of the game or film, the composer as "ar",
and say in "about" where it is from), a DJ mix, a live recording, a home-made upload.
Don't guess: leave a field empty when you can't find it.
"group_year", "group_release" and "group_genres", when given, were set by hand by the group and are right: keep them.""",
    "bandcamp": """These are Bandcamp links ("url"). Open each page (Bandcamp often blocks scripts, so read it with the URL
tool; if that fails, find the same page with Google Search). A Bandcamp page has the release's "tags" at the bottom
(genres, moods and places), an "about" text that often names more genres, the line "released <date>", the artist
("by <artist>") and the album cover. Use all of the tags: genres go in "g", mood or sound words in "md", a place
tells the country ("co"). Also give, for these tracks only:
  "tags": every tag listed on the page, exactly as written (lowercase),
  "rd": the release date from the "released ..." line as "YYYY-MM-DD" (and "y" its year), or "" if not shown,
  "cover": the address of the album cover image (the og:image, like "https://f4.bcbits.com/img/a1234567890_10.jpg"),
           exactly as it is on the page, or "" if you can't see it. Never make one up,
  "lt": the title of the track or album as written on the page, "la": the artist ("by ...") as written.
"group_year", "group_release" and "group_genres", when given, were set by hand by the group and are right: keep them.""",
}


class Stop(Exception):
    """Nothing more this run (Google refuses, keeps failing, or this run's limit is reached)."""


class Budget(Exception):
    """This month's (or today's) Gemini limit would be passed: stop for this run."""


def ask(model, how, batch, vocab):
    tracks = "\n".join(json.dumps({"i": k, **f}, ensure_ascii=False) for k, (_, f) in enumerate(batch))
    kind = "search" if how == "better" else how
    text = PROMPT.format(vocab=", ".join(vocab), how=HOW[kind] + (HOW_BETTER if how == "better" else ""), tracks=tracks)
    body = {"contents": [{"role": "user", "parts": [{"text": text}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": MAX_OUT[how]}}
    if how == "sources":  # (weighing what was found needs little thinking; a search needs the model's own judgement:
        body["generationConfig"]["thinkingConfig"] = {"thinkingLevel": "low"}  # with "low" it answered from memory instead of searching)
    if kind == "search":
        body["tools"] = [{"google_search": {}}]
    elif how == "bandcamp":
        body["tools"] = [{"url_context": {}}, {"google_search": {}}]
    else:
        body["generationConfig"]["responseMimeType"] = "application/json"
    # the worst this request could cost must still fit this month's budget (a Bandcamp page read counts as input:
    # up to 30,000 tokens a page)
    est_in = len(text) // 3 + (30000 * len(batch) if how == "bandcamp" else 0) + 2000
    ok, reason = budget.allowed(model, est_in, MAX_OUT[how], MAX_SEARCHES[how])
    if not ok:
        raise Budget(reason)
    try:
        try:
            d = call(f"models/{model}:generateContent", body)
        except urllib.error.HTTPError as e:
            if e.code != 400 or "thinking" not in why(e).lower():
                raise
            del body["generationConfig"]["thinkingConfig"]  # (a model that doesn't take the thinking setting)
            d = call(f"models/{model}:generateContent", body)
    except urllib.error.HTTPError:
        raise  # (Google refused it: not made, not billed)
    except Exception:
        budget.add(model, est_in, MAX_OUT[how], MAX_SEARCHES[how])  # sent, answer lost (timeout): counted as the worst case
        raise
    inp, out, searches = budget.used(d)
    budget.add(model, inp, out, searches)
    ask.searches = searches
    text = "".join(p.get("text", "") for c in d.get("candidates", [])[:1] for p in c.get("content", {}).get("parts", []) if not p.get("thought"))
    s, e = text.find("["), text.rfind("]")
    if s < 0 or e < s:
        raise ValueError("no JSON in the answer: " + text[:200])
    return json.loads(text[s:e + 1])


def clean_answer(a):
    y = a.get("y")
    try:
        y = int(str(y)[:4]) if y else None
    except ValueError:
        y = None
    if y and not 1900 <= y <= time.gmtime().tm_year:
        y = None
    g = [re.sub(r"\s+", " ", str(x)).strip().lower() for x in (a.get("g") or []) if str(x).strip()]
    md = [re.sub(r"\s+", " ", str(x)).strip().lower() for x in (a.get("md") or []) if str(x).strip()]  # mood words
    rl = str(a.get("rl") or "").strip()[:200]
    conf = a.get("conf") if a.get("conf") in ("high", "medium", "low") else "low"
    ar = str(a.get("ar") or "").strip()[:200]
    co = str(a.get("co") or "").strip().upper()[:2]
    about = str(a.get("about") or "").strip()[:400]
    out = {"rl": rl, "y": y, "g": g, "md": md, "ar": ar, "co": co if re.fullmatch(r"[A-Z]{2}", co) else "", "about": about, "conf": conf}
    # Bandcamp pages only: the page's tags, release date, cover, title and artist
    tags = [re.sub(r"\s+", " ", str(x)).strip().lower() for x in (a.get("tags") or []) if str(x).strip()]
    if tags:
        out["tags"] = list(dict.fromkeys(tags))
    rd = str(a.get("rd") or "").strip()
    if re.fullmatch(r"\d{4}-\d\d-\d\d", rd):
        out["rd"] = rd
    for k in ("lt", "la"):
        v = str(a.get(k) or "").strip()[:200]
        if v:
            out[k] = v
    cover = str(a.get("cover") or "").strip()
    if cover and image_ok(cover):
        out["cover"] = cover
    return out


def image_ok(u):
    """A cover address from Gemini is kept only when it is a Bandcamp image that really exists."""
    if not re.fullmatch(r"https://f\d\.bcbits\.com/img/[\w.]+\.(jpg|png)", u):
        return False
    try:
        req = urllib.request.Request(u, method="HEAD", headers={"User-Agent": "Mozilla/5.0 (nrgfm archive)"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status == 200 and r.headers.get("Content-Type", "").startswith("image/")
    except Exception:  # noqa: BLE001
        return False


def main():
    tracks = json.load(open(os.path.join(DATA, "tracks.json"), encoding="utf-8"))
    meta = json.load(open(os.path.join(DATA, "meta.json"), encoding="utf-8"))
    extra = json.load(open(os.path.join(DATA, "extra.json"), encoding="utf-8"))
    dp = os.path.join(DATA, "descriptions.json")
    desc = json.load(open(dp, encoding="utf-8")) if os.path.exists(dp) else {}
    ai_p = os.path.join(DATA, "ai.json")
    ai = json.load(open(ai_p, encoding="utf-8")) if os.path.exists(ai_p) else {}
    status = {"date": time.strftime("%Y-%m-%d %H:%M", time.gmtime()), "asked": 0, "done": len(ai)}

    def save():
        json.dump(ai, open(ai_p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        status["done"] = len(ai)
        json.dump(status, open(os.path.join(DATA, "gemini-status.json"), "w", encoding="utf-8"), indent=1)

    if not KEY:
        status["state"] = "off (no GEMINI_API_KEY secret)"
        return save()

    # the genres already in use, most used first: Gemini picks from these when one fits
    count = {}
    for x in extra.values():
        for g in x.get("gm") or x.get("g") or []:
            count[g] = count.get(g, 0) + 1
    vocab = [g for g, _ in sorted(count.items(), key=lambda kv: -kv[1])][:250]

    yt_of = {tr["url"]: tr.get("yt") for th in tracks["threads"] for tr in th["tracks"]}
    ts_of = {}  # when each link was added (newest first among the ones never asked)
    for th in tracks["threads"]:
        for tr in th["tracks"]:
            ts_of[tr["url"]] = max(ts_of.get(tr["url"], 0), tr.get("ts") or 0)
    todo = {"bandcamp": [], "sources": [], "search": []}
    facts_of = {}
    seen = set()
    for th in tracks["threads"]:
        for tr in th["tracks"]:
            u = tr["url"]
            if not u or u in seen or meta.get(u, {}).get("dead") and not title_of(tr, meta):
                continue
            seen.add(u)
            f = facts(tr, meta, extra, desc)
            if not f["title"]:
                continue
            fp = hashlib.sha1(json.dumps(f, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:10]
            if ai.get(u, {}).get("in") == fp and ai[u].get("v") == VERSION:
                continue
            facts_of[u] = (f, fp)
            if ai.get(u, {}).get("how") == "research":  # looked up by hand (Claude, with web research): never asked again
                continue
            todo["bandcamp" if f.get("url") else "sources" if has_sources(f) else "search"].append((u, f, fp))
    # tracks listed in data/gemini-priority.json are asked first (e.g. the unsorted pile being sorted again)
    pp = os.path.join(DATA, "gemini-priority.json")
    first = set(json.load(open(pp, encoding="utf-8"))) if os.path.exists(pp) else set()
    for how in todo:
        todo[how].sort(key=lambda item: (item[0] not in first, item[0] in ai, -ts_of.get(item[0], 0)))  # then tracks never asked before, newest first
    print("to ask:", len(todo["sources"]), "with sources,", len(todo["search"]), "to look up,", len(todo["bandcamp"]), "Bandcamp pages")

    try:
        lite, better = pick_models()
    except urllib.error.HTTPError as e:
        status["state"] = "error: " + why(e)
        return save()
    print("first:", lite, "better:", better)
    try:
        u0 = budget.now()
    except Exception as e:  # noqa: BLE001  (no budget, no Gemini)
        status["state"] = "stopped: the budget can't be checked (" + str(e)[:200] + ")"
        return save()
    print(f"this month so far: {u0['searches']} searches, ${u0['cost']:.3f}, {u0['requests']} requests")
    status["month"] = {"searches": u0["searches"], "cost": round(u0["cost"], 3)}

    rank = {"low": 0, "medium": 1, "high": 2}
    state = {"left": MAX, "requests": 0, "fails": 0, "escalated": 0}
    status["state"] = "ok"

    def run(how, batch, models, fps):
        """Ask one batch, with the first model that isn't overloaded. Returns the answers, or None (skipped).
        Raises Budget (stop the run) and Stop (Google refuses: stop the run)."""
        if state["requests"] >= MAX_REQUESTS or time.time() - START > MINUTES * 60:
            raise Stop("this run's limit (requests or time) reached: continues next run")
        for u, f in batch:  # the listeners' comments (only for the tracks being asked now; not part of the fingerprint)
            if "comments" not in f:
                c = yt_comments(yt_of.get(u))
                if c:
                    f["comments"] = c
        for attempt in range(6):  # overloaded (503) or a per-minute limit: wait and try again, then the next model
            model = models[min(attempt // 2, len(models) - 1)]
            state["requests"] += 1
            try:
                answers = ask(model, how, batch, vocab)
                status["model"] = model
                state["fails"] = 0
                return answers, model
            except Budget:
                raise
            except urllib.error.HTTPError as e:
                w = why(e)
                if e.code in (401, 402, 403) or (e.code == 429 and "quota" in w.lower() and attempt >= 1):
                    raise Stop("Google refused: " + w)  # key, billing or the spend cap: nothing more this run
                if how == "bandcamp" and e.code == 400:
                    raise Stop("Bandcamp pages skipped: " + w)
                if e.code not in (429, 500, 503, 504):
                    print("skipped a batch:", w)
                    break
                print(model, "busy:", w[:120], "- waiting")
                time.sleep(20 * (attempt + 1))
            except Exception as e:  # noqa: BLE001  (a timeout, or an answer that couldn't be read)
                print("skipped a batch:", type(e).__name__, str(e)[:200])
                break
        state["fails"] += 1
        if state["fails"] >= 3:
            raise Stop("Gemini keeps failing: stopped for this run")
        return None, None

    # 1. every track not answered yet (newest first), then the ones asked again because what is known changed: with
    #    the quick model. Tracks never asked come before anything asked again.
    passes = [(how, [x for x in todo[how] if x[0] not in ai]) for how in ("bandcamp", "sources", "search")] + \
             [(how, [x for x in todo[how] if x[0] in ai]) for how in ("bandcamp", "sources", "search")]
    try:
        for how, items in passes:
            for i in range(0, len(items), PER_CALL[how]):
                if state["left"] <= 0:
                    raise Stop("asked as many as this run may")
                chunk = items[i:i + PER_CALL[how]]
                batch = [(u, f) for u, f, _ in chunk]
                answers, model = run(how, batch, lite, None)
                if answers is None:
                    if how == "bandcamp":
                        break
                    continue
                # a lookup that didn't search Google is from memory: never more than "low" (it gets asked again with the
                # better model); memory alone was confidently wrong ("Gilgamesh" given as "Soft Airs")
                guessed = how == "search" and getattr(ask, "searches", 0) < max(1, len(batch) // 3)
                for a in answers if isinstance(answers, list) else []:
                    k = a.get("i") if isinstance(a, dict) else None
                    if isinstance(k, int) and 0 <= k < len(batch):
                        u = batch[k][0]
                        x = clean_answer(a)
                        if guessed:
                            x["conf"] = "low"
                        ai[u] = {**x, "how": how, "m": model, "in": chunk[k][2], "v": VERSION}
                status["asked"] += len(batch)
                state["left"] -= len(batch)
                print(how, status["asked"], "asked")
                save()
                time.sleep(PAUSE)
        # 2. what the quick model wasn't sure about ("low"), newest first: once more with the better model, searching
        #    Google. Each track at most once (until what is known about it changes).
        unsure = [u for u, x in ai.items() if x.get("conf") == "low" and x.get("v") == VERSION and u in facts_of
                  and x.get("how") != "research" and not x.get("esc") and x.get("in") == facts_of[u][1]
                  and x.get("m", "").endswith("-lite") and better[0] != x.get("m")]
        unsure.sort(key=lambda u: -ts_of.get(u, 0))
        unsure = unsure[:ESCALATE]
        if unsure:
            print(len(unsure), "unsure answers: asking", better[0])
        for i in range(0, len(unsure), PER_CALL["better"]):
            if state["left"] <= 0:
                raise Stop("asked as many as this run may")
            us = unsure[i:i + PER_CALL["better"]]
            batch = [(u, {**facts_of[u][0], "first_answer": {k: ai[u].get(k) for k in ("rl", "y", "g", "ar", "co", "about")}}) for u in us]
            answers, model = run("better", batch, better, None)
            for u in us:  # (asked once: never again, whatever the answer)
                ai[u]["esc"] = model or "failed"
            if answers is None:
                continue
            for a in answers if isinstance(answers, list) else []:
                k = a.get("i") if isinstance(a, dict) else None
                if isinstance(k, int) and 0 <= k < len(batch):
                    u, new = batch[k][0], clean_answer(a)
                    if rank[new["conf"]] >= rank[ai[u].get("conf", "low")]:  # (kept only when at least as sure)
                        ai[u] = {**new, "how": "better", "m": model, "in": facts_of[u][1], "v": VERSION, "esc": model}
            state["escalated"] += len(us)
            state["left"] -= len(us)
            save()
            time.sleep(PAUSE)
    except Budget as e:
        status["state"] = "stopped for this month: " + str(e)
        print(status["state"])
    except Stop as e:
        status["state"] = "ok (" + str(e) + ")"
        print(status["state"])
    try:
        u1 = budget.now()
        status["month"] = {"searches": u1["searches"], "cost": round(u1["cost"], 3)}
        print(f"this month now: {u1['searches']} searches, ${u1['cost']:.3f}, {u1['requests']} requests; escalated {state['escalated']}")
    except Exception:  # noqa: BLE001
        pass
    save()

if __name__ == "__main__":
    main()
