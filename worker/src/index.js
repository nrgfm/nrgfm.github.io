/* nrgfm play log.
   POST /play     (anyone visiting the site) one play, sent after 10 seconds of playing and updated as it goes on
   GET  /days     (key)  the days with plays and how many, in the viewer's time zone (?tz=minutes east of UTC, ?who=)
   GET  /plays    (key)  the plays of one day (?day=YYYY-MM-DD&tz=&who=), or of some tracks (?urls=a|b|c)
   GET  /periods  (key)  the months (?group=month), years (year) or all time (all) with plays, and how many (?min= seconds)
   GET  /top      (key)  the tracks played most in one of them (?group=&p=2026-10&min=&who=)
   GET  /devices  (key)  every device/guest that played
   POST /name     (key)  give a device a name {who, name}
   POST /login    (anyone) {password, who}: level 2 or 3 for 12 hours → {token, level, exp}. 5 wrong passwords in an hour lock
                  the logins for an hour. Every login, wrong password and refusal is kept (GET /logins)
   POST /logout   {token}
   POST /inbox    (level 2 token, Authorization: Session …) {item, kind}: adds, edits and tag changes, saved to the
                  repository's inbox/ with the key in the secret GH_WRITE (a level-2 browser never sees a GitHub key)
   POST /passwords (key)  {level2, level3}: set (or "" to turn off) the passwords
   GET  /passwords (key)  which are set
   GET  /logins   (key)  the logins (?days=)
   POST /lookup/up   (key, or the phone's upload key: Authorization: Upload …) one image (the body itself, or form
                  fields "file"): saved in R2 (bucket nrgfm-lookup); the artist and title in it are read by Gemini
   GET  /lookup      (key)  the saved images, newest first
   GET  /lookup/img  (key)  one image (?id=)
   POST /lookup/set  (key)  {id, done} or {id, songs} (corrected by hand)
   POST /lookup/read (key)  {id}: read it again
   POST /lookup/del  (key)  {id}: deleted for good (the image too)
   POST /lookup/key  (key)  a new upload key for the phone (the old one stops working); shown once
   "key": the site's GitHub key (Authorization: Bearer …), accepted when it can write to the nrgfm repository. */
const REPO = "nrgproduct/nrgfm";
const ORIGINS = ["https://nrgproduct.github.io", "http://localhost:8765", "http://127.0.0.1:8765"];
const YEAR = 365 * 86400;
const SESSION = 12 * 3600;  // a password login lasts 12 hours
const LEVEL2 = new Set(["", "edit", "tag"]); // what a level-2 login may save: new tracks, edits, tag changes
const LOOKUP_MAX = 2 * 1024 ** 3; // the Lookup images stay under 2 GB (R2's free plan: 10 GB, shared with the backups)
const okKeys = new Map(); // key hash -> time it was checked (checked again after 10 minutes)

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400", Vary: "Origin" };
}
const json = (req, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(req) } });
const str = (v, n = 300) => (typeof v === "string" ? v.slice(0, n) : null);
const int = (v) => (Number.isFinite(+v) && v !== null && v !== "" ? Math.max(0, Math.round(+v)) : null);

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function isOwner(req) {
  const key = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!key) return false;
  const h = await sha(key), t = okKeys.get(h);
  if (t && Date.now() - t < 600000) return true;
  const r = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "nrgfm-activity", Accept: "application/vnd.github+json" } });
  if (!r.ok) return false;
  const d = await r.json();
  if (!(d.permissions && d.permissions.push)) return false;
  okKeys.set(h, Date.now());
  return true;
}


async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const b = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 }, k, 256);
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const rand = (n = 32) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");
async function session(req, env) {
  const t = (req.headers.get("Authorization") || "").replace(/^Session\s+/i, "").trim();
  if (!t) return null;
  const row = await env.DB.prepare("SELECT level, who, exp FROM sessions WHERE h = ?1").bind(await sha(t)).first();
  return row && row.exp > Math.floor(Date.now() / 1000) ? row : null;
}
/* Lookup: read the songs in a screenshot or photo with Gemini (the repository's GEMINI_API_KEY, as the Worker secret GEMINI_KEY) */
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/";
let models = null;
async function geminiModels(env) {
  if (models) return models;
  const r = await fetch(GEMINI + "models?pageSize=200", { headers: { "x-goog-api-key": env.GEMINI_KEY } });
  if (!r.ok) throw new Error("Gemini answered " + r.status);
  const names = ((await r.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.split("/").pop()).filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n));
  if (!names.length) throw new Error("no Gemini Flash model for this key");
  return (models = [...new Set(names)].sort((a, b) => parseFloat(b.match(/\d+(\.\d+)?/)[0]) - parseFloat(a.match(/\d+(\.\d+)?/)[0])));
}
const READ_PROMPT = `This is a screenshot or a photo someone took to remember a song: usually an Instagram post or reel, or a
screen playing YouTube, Spotify, SoundCloud, Shazam or similar. Find every song shown in it.
On Instagram the song is the line with a music note under the account name or at the bottom, written "Artist · Title"
(it scrolls, so it may be cut off: give what is visible). "Original audio" / "Originalton" means the account's own sound:
then give the account name as the artist and leave the title empty. On YouTube the video title usually holds artist and title.
Only give what can be read in the image; do not guess a song from the picture alone.
Answer JSON only: {"songs": [{"artist": "...", "title": "..."}], "text": "other words in the image that would help find it (account name, caption words), at most 120 characters"}
"songs" is empty when there is no song in it.`;
async function readImage(env, id) {
  const now = () => Math.floor(Date.now() / 1000);
  try {
    if (!env.GEMINI_KEY) throw new Error("no Gemini key on the server");
    const obj = await env.SHOTS.get(id);
    if (!obj) throw new Error("image not found");
    const buf = await obj.arrayBuffer(), type = (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg";
    // the image goes to Gemini's file store as it is (turning it into text here would use more of the Worker's CPU time than the free plan gives)
    const start = await fetch(GEMINI.replace("/v1beta/", "/upload/v1beta/files"), { method: "POST", headers: { "x-goog-api-key": env.GEMINI_KEY,
      "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(buf.byteLength),
      "X-Goog-Upload-Header-Content-Type": type, "Content-Type": "application/json" }, body: JSON.stringify({ file: { display_name: "nrgfm-lookup-" + id } }) });
    const to = start.ok && start.headers.get("x-goog-upload-url");
    if (!to) throw new Error("Gemini didn't take the image (" + start.status + ")");
    const up = await fetch(to, { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: buf });
    const file = up.ok ? (await up.json()).file : null;
    if (!file || !file.uri) throw new Error("Gemini didn't take the image (" + up.status + ")");
    let last = null;
    for (const m of await geminiModels(env)) {
      const r = await fetch(GEMINI + `models/${m}:generateContent`, { method: "POST", headers: { "x-goog-api-key": env.GEMINI_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ file_data: { mime_type: type, file_uri: file.uri } }, { text: READ_PROMPT }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" } }) });
      if (!r.ok) { last = "Gemini answered " + r.status; if (r.status === 429 || r.status >= 500 || r.status === 404) continue; break; }
      const d = await r.json();
      const text = ((d.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("");
      const a = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      const songs = (Array.isArray(a.songs) ? a.songs : []).slice(0, 10)
        .map((x) => ({ artist: String(x.artist || "").trim().slice(0, 200), title: String(x.title || "").trim().slice(0, 200) })).filter((x) => x.artist || x.title);
      await env.DB.prepare("UPDATE lookup SET songs = ?2, text = ?3, read_ts = ?4, read_err = NULL WHERE id = ?1")
        .bind(id, JSON.stringify(songs), String(a.text || "").slice(0, 200), now()).run();
      return;
    }
    throw new Error(last || "no answer");
  } catch (e) {
    await env.DB.prepare("UPDATE lookup SET read_ts = ?2, read_err = ?3 WHERE id = ?1").bind(id, now(), String(e && e.message || e).slice(0, 200)).run();
  }
}
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif", "image/webp": "webp", "image/gif": "gif" };
async function saveImages(req, env, ctx, src) {
  const files = [];
  const ct = (req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (ct === "multipart/form-data") {
    const f = await req.formData();
    for (const v of f.getAll("file")) if (v && typeof v === "object") files.push({ type: (v.type || "").toLowerCase(), buf: await v.arrayBuffer() });
  } else files.push({ type: ct, buf: await req.arrayBuffer() });
  const used = (await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM lookup").first()).n;
  let total = used;
  const ids = [];
  for (const f of files) {
    let type = f.type;
    if (!IMAGE_TYPES[type]) { // (the phone may send no type: look at the first bytes)
      const b = new Uint8Array(f.buf.slice(0, 12));
      type = b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x89 && b[1] === 0x50 ? "image/png"
        : String.fromCharCode(...b.slice(4, 12)).match(/ftyp(heic|heix|mif1|heif)/) ? "image/heic" : null;
    }
    if (!type) return { error: "not an image", status: 415 };
    if (!f.buf.byteLength || f.buf.byteLength > 25 * 1024 ** 2) return { error: "image too big (25 MB at most)", status: 413 };
    if (total + f.buf.byteLength > LOOKUP_MAX) return { error: "Lookup is full (2 GB): delete some images first", status: 507 };
    total += f.buf.byteLength;
    const id = Date.now().toString(36) + "-" + rand(4) + "." + IMAGE_TYPES[type];
    await env.SHOTS.put(id, f.buf, { httpMetadata: { contentType: type } });
    await env.DB.prepare("INSERT INTO lookup (id, ts, type, size, src) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, Math.floor(Date.now() / 1000), type, f.buf.byteLength, src).run();
    ctx.waitUntil(readImage(env, id));
    ids.push(id);
  }
  return { ids };
}
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/play" && req.method === "POST") {
        const p = await req.json().catch(() => ({}));
        const id = str(p.id, 64), who = str(p.who, 64);
        if (!id || !who || !/^[\w-]+$/.test(id + who)) return json(req, { error: "bad play" }, 400);
        const sec = int(p.sec), now = Math.floor(Date.now() / 1000);
        if (sec !== null && sec < 10) return json(req, { ok: false }); // shorter than 10 seconds: not a play
        const ts = Math.min(now, int(p.ts) || now), cf = req.cf || {};
        const city = cf.city || null, country = cf.country || null;
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO plays (id, ts, who, url, tid, title, sec, dur, city, country) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET sec = MAX(COALESCE(plays.sec, 0), COALESCE(excluded.sec, 0)), dur = COALESCE(excluded.dur, plays.dur)`)
            .bind(id, ts, who, str(p.url, 500), str(p.tid, 80), str(p.title, 300), sec, int(p.dur), city, country),
          env.DB.prepare(`INSERT INTO devices (who, name, owner, city, country, first, last) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?5)
            ON CONFLICT(who) DO UPDATE SET owner = MAX(devices.owner, excluded.owner), city = COALESCE(excluded.city, devices.city),
            country = COALESCE(excluded.country, devices.country), last = excluded.last`)
            .bind(who, p.owner ? 1 : 0, city, country, now),
        ]);
        return json(req, { ok: true });
      }
      if (path === "/login" && req.method === "POST") {
        const p = await req.json().catch(() => ({}));
        const now = Math.floor(Date.now() / 1000), cf = req.cf || {}, who = str(p.who, 64);
        const log = (level, ok) => env.DB.prepare("INSERT INTO logins (ts, who, level, ok, city, country) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
          .bind(now, who, level, ok, cf.city || null, cf.country || null).run();
        const bad = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(ts) AS last FROM logins WHERE ok = 0 AND ts > ?1").bind(now - 3600).first();
        if (bad.n >= 5) { await log(null, -1); return json(req, { error: "locked", until: bad.last + 3600 }, 429); }
        const pw = str(p.password, 200) || "";
        const rows = (await env.DB.prepare("SELECT k, v FROM settings WHERE k IN ('pw2', 'pw3')").all()).results;
        let level = null;
        for (const r of rows) { const [salt, h] = (r.v || "").split(":"); if (salt && h && pw && (await pbkdf2(pw, salt)) === h) level = r.k === "pw2" ? 2 : 3; }
        if (!level) { await log(null, 0); return json(req, { error: "wrong" }, 401); }
        const token = rand(), exp = now + SESSION;
        await env.DB.batch([
          env.DB.prepare("INSERT INTO sessions (h, level, who, exp) VALUES (?1, ?2, ?3, ?4)").bind(await sha(token), level, who, exp),
          env.DB.prepare("DELETE FROM sessions WHERE exp < ?1").bind(now),
        ]);
        await log(level, 1);
        return json(req, { token, level, exp });
      }
      if (path === "/logout" && req.method === "POST") {
        const p = await req.json().catch(() => ({}));
        const t = str(p.token, 100);
        if (t) {
          const h = await sha(t), row = await env.DB.prepare("SELECT level, who FROM sessions WHERE h = ?1").bind(h).first();
          if (row) {
            const cf = req.cf || {};
            await env.DB.batch([env.DB.prepare("DELETE FROM sessions WHERE h = ?1").bind(h),
              env.DB.prepare("INSERT INTO logins (ts, who, level, ok, city, country) VALUES (?1, ?2, ?3, 2, ?4, ?5)").bind(Math.floor(Date.now() / 1000), row.who, row.level, cf.city || null, cf.country || null)]);
          }
        }
        return json(req, { ok: true });
      }
      if (path === "/inbox" && req.method === "POST") {
        const s = await session(req, env);
        if (!s || s.level !== 2) return json(req, { error: "login needed" }, 401);
        if (!env.GH_WRITE) return json(req, { error: "no GitHub key on the server (secret NRGFM_WRITE_TOKEN)" }, 503);
        const p = await req.json().catch(() => ({}));
        const kind = typeof p.kind === "string" ? p.kind : "", item = p.item;
        if (!item || typeof item !== "object" || !LEVEL2.has(kind) || !LEVEL2.has(item.action || "")) return json(req, { error: "not allowed with this login" }, 403);
        if ((item.action || "") !== kind) return json(req, { error: "not allowed with this login" }, 403);
        const text = JSON.stringify({ ...item, via: "password" }, null, 2) + "\n";
        if (text.length > 20000) return json(req, { error: "too big" }, 413);
        const name = `${Date.now()}${kind ? "-" + kind : ""}.json`;
        const r = await fetch(`https://api.github.com/repos/${REPO}/contents/inbox/${name}`, { method: "PUT",
          headers: { Authorization: `Bearer ${env.GH_WRITE}`, "User-Agent": "nrgfm-activity", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: (kind ? kind[0].toUpperCase() + kind.slice(1) : "Add") + " track (password login)", content: b64(text) }) });
        return r.ok ? json(req, { ok: true }) : json(req, { error: "GitHub answered " + r.status }, 502);
      }
      if (path === "/lookup/up" && req.method === "POST") { // (before the key check: the phone uses its own upload key)
        const auth = req.headers.get("Authorization") || "";
        let src = "upload";
        if (/^Upload\s+/i.test(auth)) {
          const k = auth.replace(/^Upload\s+/i, "").trim(), row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'upkey'").first();
          if (!k || !row || row.v !== (await sha(k))) return json(req, { error: "wrong upload key" }, 401);
          src = "phone";
        } else if (!(await isOwner(req))) return json(req, { error: "key needed" }, 401);
        if (!env.SHOTS) return json(req, { error: "no image storage on the server yet" }, 503);
        const r = await saveImages(req, env, ctx, src);
        return r.error ? json(req, { error: r.error }, r.status) : json(req, { ok: true, ids: r.ids });
      }
      if (!(await isOwner(req))) return json(req, { error: "key needed" }, 401);
      if (path.startsWith("/lookup")) {
        if (!env.SHOTS) return json(req, { error: "no image storage on the server yet" }, 503);
        if (path === "/lookup" && req.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM lookup ORDER BY ts DESC LIMIT 2000").all();
          const used = (await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM lookup").first()).n;
          const key = await env.DB.prepare("SELECT 1 FROM settings WHERE k = 'upkey'").first();
          return json(req, { items: results.map((r) => ({ ...r, songs: r.songs ? JSON.parse(r.songs) : null })), used, max: LOOKUP_MAX, phoneKey: !!key, reads: !!env.GEMINI_KEY });
        }
        if (path === "/lookup/img") {
          const id = url.searchParams.get("id") || "", obj = /^[\w.-]+$/.test(id) ? await env.SHOTS.get(id) : null;
          if (!obj) return json(req, { error: "not found" }, 404);
          return new Response(obj.body, { headers: { "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", ...cors(req) } });
        }
        if (req.method !== "POST") return json(req, { error: "not found" }, 404);
        if (path === "/lookup/key") {
          const k = rand(24);
          await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('upkey', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(await sha(k)).run();
          return json(req, { key: k });
        }
        const p = await req.json().catch(() => ({}));
        const id = str(p.id, 80);
        if (!id || !(await env.DB.prepare("SELECT 1 FROM lookup WHERE id = ?1").bind(id).first())) return json(req, { error: "not found" }, 404);
        if (path === "/lookup/set") {
          if (typeof p.done === "boolean") await env.DB.prepare("UPDATE lookup SET done = ?2 WHERE id = ?1").bind(id, p.done ? Math.floor(Date.now() / 1000) : 0).run();
          if (Array.isArray(p.songs)) await env.DB.prepare("UPDATE lookup SET songs = ?2 WHERE id = ?1").bind(id, JSON.stringify(p.songs.slice(0, 10)
            .map((x) => ({ artist: String((x && x.artist) || "").slice(0, 200), title: String((x && x.title) || "").slice(0, 200) })).filter((x) => x.artist || x.title))).run();
          return json(req, { ok: true });
        }
        if (path === "/lookup/read") {
          await env.DB.prepare("UPDATE lookup SET read_ts = NULL, read_err = NULL WHERE id = ?1").bind(id).run();
          ctx.waitUntil(readImage(env, id));
          return json(req, { ok: true });
        }
        if (path === "/lookup/del") {
          await env.SHOTS.delete(id);
          await env.DB.prepare("DELETE FROM lookup WHERE id = ?1").bind(id).run();
          return json(req, { ok: true });
        }
        return json(req, { error: "not found" }, 404);
      }
      if (path === "/passwords") {
        if (req.method === "POST") {
          const p = await req.json().catch(() => ({}));
          for (const [k, lv] of [["pw2", "level2"], ["pw3", "level3"]]) {
            if (typeof p[lv] !== "string") continue;
            const pw = p[lv].slice(0, 200);
            if (!pw) await env.DB.prepare("DELETE FROM settings WHERE k = ?1").bind(k).run();
            else { const salt = rand(16); await env.DB.prepare("INSERT INTO settings (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, salt + ":" + (await pbkdf2(pw, salt))).run(); }
            await env.DB.prepare("DELETE FROM sessions WHERE level = ?1").bind(k === "pw2" ? 2 : 3).run(); // a new password logs everyone at that level out
          }
          return json(req, { ok: true });
        }
        const { results } = await env.DB.prepare("SELECT k FROM settings WHERE k IN ('pw2', 'pw3')").all();
        return json(req, { level2: results.some((r) => r.k === "pw2"), level3: results.some((r) => r.k === "pw3") });
      }
      if (path === "/logins") {
        const days = Math.max(1, Math.min(400, Math.round(+url.searchParams.get("days") || 365)));
        const { results } = await env.DB.prepare(`SELECT l.*, d.name FROM logins l LEFT JOIN devices d ON d.who = l.who WHERE l.ts > ?1 ORDER BY l.ts DESC LIMIT 2000`)
          .bind(Math.floor(Date.now() / 1000) - days * 86400).all();
        return json(req, results);
      }
      const tz = Math.max(-840, Math.min(840, Math.round(+url.searchParams.get("tz") || 0))) * 60; // the viewer's offset from UTC
      const who = url.searchParams.get("who");
      const since = Math.floor(Date.now() / 1000) - YEAR;
      if (path === "/days") {
        const m0 = Math.max(0, Math.min(600, Math.round(+url.searchParams.get("min") || 0)));
        const { results } = await env.DB.prepare(`SELECT date(ts + ?1, 'unixepoch') AS day, COUNT(*) AS n FROM plays
          WHERE ts > ?2 AND (?3 IS NULL OR who = ?3) AND (sec IS NULL OR sec >= ?4) GROUP BY day ORDER BY day DESC`).bind(tz, since, who, m0).all();
        return json(req, results);
      }
      if (path === "/plays") {
        const urls = (url.searchParams.get("urls") || "").split("|").filter(Boolean).slice(0, 300);
        if (urls.length) {
          const q = urls.map((_, k) => "?" + (k + 3)).join(",");
          const { results } = await env.DB.prepare(`SELECT * FROM plays WHERE ts > ?1 AND (?2 IS NULL OR who = ?2) AND url IN (${q}) ORDER BY ts DESC LIMIT 2000`)
            .bind(since, who, ...urls).all();
          return json(req, results);
        }
        const day = url.searchParams.get("day") || "";
        if (!/^\d{4}-\d\d-\d\d$/.test(day)) return json(req, { error: "day?" }, 400);
        const start = Math.floor(Date.parse(day + "T00:00:00Z") / 1000) - tz;
        const { results } = await env.DB.prepare(`SELECT * FROM plays WHERE ts >= ?1 AND ts < ?2 AND (?3 IS NULL OR who = ?3) ORDER BY ts DESC`)
          .bind(start, start + 86400, who).all();
        return json(req, results);
      }
      // most played: the months (or years) with plays, and the tracks played most in one of them
      const minSec = Math.max(0, Math.min(600, Math.round(+url.searchParams.get("min") || 0)));
      const group = url.searchParams.get("group") === "year" ? "%Y" : url.searchParams.get("group") === "all" ? "all" : "%Y-%m";
      const per = group === "all" ? "'all'" : `strftime('${group}', ts + ?1, 'unixepoch')`;
      if (path === "/periods") {
        const { results } = await env.DB.prepare(`SELECT ${per} AS p, COUNT(*) AS n FROM plays
          WHERE ts > ?2 AND (?3 IS NULL OR who = ?3) AND (sec IS NULL OR sec >= ?4) GROUP BY p ORDER BY p DESC`).bind(tz, since, who, minSec).all();
        return json(req, results);
      }
      if (path === "/top") {
        const pp = url.searchParams.get("p") || "all";
        const { results } = await env.DB.prepare(`SELECT url, MAX(tid) AS tid, MAX(title) AS title, COUNT(*) AS n, SUM(COALESCE(sec, 0)) AS sec, MAX(ts) AS last FROM plays
          WHERE ts > ?2 AND (?3 IS NULL OR who = ?3) AND (sec IS NULL OR sec >= ?4) AND ${per} = ?5
          GROUP BY url ORDER BY n DESC, last DESC LIMIT 200`).bind(tz, since, who, minSec, pp).all();
        return json(req, results);
      }
      if (path === "/devices") {
        const { results } = await env.DB.prepare(`SELECT d.*, (SELECT COUNT(*) FROM plays p WHERE p.who = d.who AND p.ts > ?1) AS n FROM devices d ORDER BY d.last DESC`).bind(since).all();
        return json(req, results);
      }
      if (path === "/name" && req.method === "POST") {
        const p = await req.json().catch(() => ({}));
        const w = str(p.who, 64), name = (str(p.name, 40) || "").trim();
        if (!w) return json(req, { error: "who?" }, 400);
        await env.DB.prepare(`INSERT INTO devices (who, name, owner, first, last) VALUES (?1, ?2, 1, ?3, ?3)
          ON CONFLICT(who) DO UPDATE SET name = excluded.name, owner = 1`).bind(w, name || null, Math.floor(Date.now() / 1000)).run();
        return json(req, { ok: true });
      }
      return json(req, { error: "not found" }, 404);
    } catch (e) {
      return json(req, { error: String(e && e.message || e).slice(0, 200) }, 500);
    }
  },
  async scheduled(event, env) { // keep one year
    const cut = Math.floor(Date.now() / 1000) - YEAR;
    await env.DB.prepare("DELETE FROM plays WHERE ts < ?1").bind(cut).run();
    await env.DB.prepare("DELETE FROM devices WHERE last < ?1").bind(cut).run();
    await env.DB.prepare("DELETE FROM logins WHERE ts < ?1").bind(cut).run();
    await env.DB.prepare("DELETE FROM sessions WHERE exp < ?1").bind(Math.floor(Date.now() / 1000)).run();
  },
};
