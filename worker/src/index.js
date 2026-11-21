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
   POST /lookup/up   (key, or the phone's upload key: Authorization: Upload …) one image or video (the body itself, or
                  form fields "file"): saved in R2 (bucket nrgfm-lookup); the artist and title in it are read by Gemini
   GET  /lookup      (key)  the saved images and videos, newest first, each with a link (src) that works for two days
   GET  /lookup/img  (that link: ?id=&e=&s=) one image or video (videos: in parts, as the browser asks)
   POST /lookup/set  (key)  {id, done}, {id, lines} (corrected by hand: [{t, e}]) or {id, final} (the search typed together)
   POST /lookup/read (key, or the upload key)  {id}: read the lines of text in it (answers when done)
   POST /lookup/del  (key)  {id}: deleted for good (the image too). Everything marked done is deleted every night (cron)
   POST /lookup/key  (key)  a new upload key for the phone (the old one stops working); shown once
   "key": the site's GitHub key (Authorization: Bearer …), accepted when it can write to the nrgfm repository. */
const REPO = "nrgproduct/nrgfm";
const ORIGINS = ["https://nrgproduct.github.io", "http://localhost:8765", "http://127.0.0.1:8765"];
const YEAR = 365 * 86400;
const SESSION = 12 * 3600;  // a password login lasts 12 hours
const LEVEL2 = new Set(["", "edit", "tag"]); // what a level-2 login may save: new tracks, edits, tag changes
const LOOKUP_MAX = 6 * 1024 ** 3; // Lookup stays under 6 GB (R2's free plan: 10 GB, shared with the backups, which use well under 1 GB)
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
let models = null, goodModel = null; // (the model that answered last is asked first)
async function geminiModels(env) {
  if (models) return models;
  const r = await fetch(GEMINI + "models?pageSize=200", { headers: { "x-goog-api-key": env.GEMINI_KEY } });
  if (!r.ok) throw new Error("Gemini answered " + r.status);
  const names = ((await r.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.split("/").pop()).filter((n) => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(n));
  if (!names.length) throw new Error("no Gemini Flash model for this key");
  // the "lite" models first: reading text is easy for them and they answer in a second or two (the newest Flash models
  // were overloaded or took minutes on the free key, Nov 2026); newest first within each
  const ver = (n) => parseFloat(n.match(/\d+(\.\d+)?/)[0]), lite = (n) => (n.endsWith("-lite") ? 0 : 1);
  return (models = [...new Set(names)].sort((a, b) => lite(a) - lite(b) || ver(b) - ver(a)));
}
const READ_PROMPT = `This is a screenshot, a screen recording or a photo someone took to remember a song: usually an Instagram post
or reel, or a screen playing YouTube, Spotify, SoundCloud, Shazam or similar.
Write down every line of text in it, exactly as written (same spelling, same script, no translating), each line on its own,
from top to bottom. A line is one line as it appears on screen: do not join lines and do not split one. Keep everything that
could help find a song: song and audio lines (on Instagram the line with a music note, "Artist · Title"), video and post
titles, account and channel names, captions, comments, text on the picture itself.
Leave out the phone's and app's own interface: the clock, battery, signal, buttons and tabs (Like, Comment, Share, Send,
Follow, Reply, Subscribe, Home, Search and so on), and numbers of likes, views and followers.
In a video, give every different line seen anywhere in it, each once.
Answer JSON only: {"lines": ["...", "..."]} ("lines" is empty when there is no text).`;
const step = (id, t0, what) => console.log(`lookup ${id}: ${what} after ${Date.now() - t0} ms`);
async function readImage(env, id) {
  const now = () => Math.floor(Date.now() / 1000), t0 = Date.now();
  const wait = (ms) => ({ signal: AbortSignal.timeout(ms) });
  try {
    if (!env.GEMINI_KEY) throw new Error("no Gemini key on the server");
    const obj = await env.SHOTS.get(id);
    if (!obj) throw new Error("image not found");
    const size = obj.size, type = await typeOf(env, id, obj), isVid = type.startsWith("video/");
    // the image goes to Gemini's file store as it is (turning it into text here would use more of the Worker's CPU time than the free plan gives)
    const start = await fetch(GEMINI.replace("/v1beta/", "/upload/v1beta/files"), { method: "POST", ...wait(15000), headers: { "x-goog-api-key": env.GEMINI_KEY,
      "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": type, "Content-Type": "application/json" }, body: JSON.stringify({ file: { display_name: "nrgfm-lookup-" + id } }) });
    const to = start.ok && start.headers.get("x-goog-upload-url");
    step(id, t0, "upload started " + start.status);
    if (!to) throw new Error("Gemini didn't take the image (" + start.status + ")");
    const up = await fetch(to, { method: "POST", ...wait(60000), headers: { "Content-Length": String(size), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: obj.body });
    step(id, t0, "uploaded " + up.status);
    let file = up.ok ? (await up.json()).file : null;
    if (!file || !file.uri) throw new Error("Gemini didn't take it (" + up.status + ")");
    for (let k = 0; file.state === "PROCESSING" && k < 20; k++) { // a video is looked through first (about a second per few seconds of video)
      await new Promise((r) => setTimeout(r, 2000));
      const f = await fetch(GEMINI + file.name, { headers: { "x-goog-api-key": env.GEMINI_KEY }, ...wait(10000) });
      if (f.ok) file = await f.json();
    }
    if (file.state === "PROCESSING") throw new Error("the video took too long to read: try Read again");
    if (file.state === "FAILED") throw new Error("Gemini couldn't open it");
    let last = null;
    const list = await geminiModels(env), order = goodModel && list.includes(goodModel) ? [goodModel, ...list.filter((m) => m !== goodModel)] : list;
    for (const m of order) {
      let r;
      try {
        r = await fetch(GEMINI + `models/${m}:generateContent`, { method: "POST", ...wait(isVid ? 90000 : 40000), headers: { "x-goog-api-key": env.GEMINI_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ file_data: { mime_type: type, file_uri: file.uri } }, { text: READ_PROMPT }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json",
            responseSchema: { type: "OBJECT", properties: { lines: { type: "ARRAY", items: { type: "STRING" } } }, required: ["lines"] } } }) });
      } catch (e) { step(id, t0, m + " didn't answer"); last = "Gemini took too long: try Read again"; continue; } // (overloaded: the next one)
      step(id, t0, m + " answered " + r.status);
      if (!r.ok) { last = "Gemini answered " + r.status; if (r.status === 429 || r.status >= 500 || r.status === 404 || r.status === 400) continue; break; }
      const d = await r.json();
      const text = ((d.candidates || [])[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
      let a; try { a = JSON.parse(text.slice(Math.min(...["{", "["].map((c) => (text.indexOf(c) < 0 ? 1e9 : text.indexOf(c))))) .replace(/[^\]}]*$/, "")); } catch { last = "Gemini's answer couldn't be read"; continue; }
      const raw = Array.isArray(a) ? a : Array.isArray(a.lines) ? a.lines : [];
      const lines = raw.map((x) => String(x && typeof x === "object" ? x.text || x.line || "" : x || "").replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean).slice(0, 80);
      goodModel = m;
      await env.DB.prepare("UPDATE lookup SET lines = ?2, read_ts = ?3, read_err = NULL WHERE id = ?1").bind(id, JSON.stringify(lines.map((t) => ({ t }))), now()).run();
      return { ok: true };
    }
    throw new Error(last || "no answer");
  } catch (e) {
    const msg = e && e.name === "TimeoutError" ? "Gemini took too long: try Read again" : String(e && e.message || e).slice(0, 200);
    step(id, t0, "failed: " + msg);
    await env.DB.prepare("UPDATE lookup SET read_ts = ?2, read_err = ?3 WHERE id = ?1").bind(id, now(), msg).run();
    return { error: msg };
  }
}
const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/x-m4v": "m4v", "video/webm": "webm" };
const MAX_IMAGE = 25 * 1024 ** 2, MAX_VIDEO = 95 * 1024 ** 2; // (Cloudflare takes at most 100 MB in one request)
function sniff(b) { // the type from the first bytes (the phone may send none)
  const tag = String.fromCharCode(...b.slice(4, 12));
  return b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x89 && b[1] === 0x50 ? "image/png"
    : /ftyp(heic|heix|mif1|heif)/.test(tag) ? "image/heic" : /ftypqt/.test(tag) ? "video/quicktime" : /ftyp/.test(tag) ? "video/mp4" : null;
}
async function saveImages(req, env, ctx, src) {
  const used = (await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM lookup").first()).n;
  const store = async (type, size, body) => {
    if (!TYPES[type]) return { error: "not an image or a video", status: 415 };
    if (!size) return { error: "empty", status: 400 };
    if (size > (type.startsWith("video/") ? MAX_VIDEO : MAX_IMAGE)) return { error: type.startsWith("video/") ? "video too big (95 MB at most)" : "image too big (25 MB at most)", status: 413 };
    if (used + size > LOOKUP_MAX) return { error: "Lookup is full (6 GB): delete some first", status: 507 };
    const id = Date.now().toString(36) + "-" + rand(4) + "." + TYPES[type];
    await env.SHOTS.put(id, body, { httpMetadata: { contentType: type } });
    await env.DB.prepare("INSERT INTO lookup (id, ts, type, size, src) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, Math.floor(Date.now() / 1000), type, size, src).run();
    return { id };
  };
  const ct = (req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const len = +req.headers.get("Content-Length") || 0;
  if (ct === "multipart/form-data") { // (several images in one request)
    const f = await req.formData(), ids = [];
    for (const v of f.getAll("file")) {
      if (!v || typeof v !== "object") continue;
      const buf = await v.arrayBuffer(), type = TYPES[(v.type || "").toLowerCase()] ? v.type.toLowerCase() : sniff(new Uint8Array(buf.slice(0, 12)));
      const r = await store(type, buf.byteLength, buf);
      if (r.error) return r;
      ids.push(r.id);
    }
    return { ids };
  }
  if (TYPES[ct] && len) { // the type and size are known: straight into R2 (a video never sits in the Worker's memory)
    if (len > (ct.startsWith("video/") ? MAX_VIDEO : MAX_IMAGE)) return store(ct, len, null);
    const r = await store(ct, len, req.body);
    return r.error ? r : { ids: [r.id] };
  }
  if (len > MAX_IMAGE) { // a big file without its type: into R2 first, then its first bytes say what it is
    if (len > MAX_VIDEO) return { error: "video too big (95 MB at most)", status: 413 };
    if (used + len > LOOKUP_MAX) return { error: "Lookup is full (6 GB): delete some first", status: 507 };
    const id = Date.now().toString(36) + "-" + rand(4);
    await env.SHOTS.put(id, req.body);
    const head = await env.SHOTS.get(id, { range: { offset: 0, length: 12 } });
    const type = head ? sniff(new Uint8Array(await head.arrayBuffer())) : null;
    if (!type) { await env.SHOTS.delete(id); return { error: "not an image or a video", status: 415 }; }
    await env.DB.prepare("INSERT INTO lookup (id, ts, type, size, src) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, Math.floor(Date.now() / 1000), type, len, src).run();
    return { ids: [id] };
  }
  const buf = await req.arrayBuffer();
  const r = await store(TYPES[ct] ? ct : sniff(new Uint8Array(buf.slice(0, 12))), buf.byteLength, buf);
  return r.error ? r : { ids: [r.id] };
}
async function typeOf(env, id, obj) {
  const t = obj.httpMetadata && obj.httpMetadata.contentType;
  if (TYPES[t]) return t;
  const row = await env.DB.prepare("SELECT type FROM lookup WHERE id = ?1").bind(id).first();
  return (row && row.type) || "image/jpeg";
}
/* links to the images that work for two days (an <img> or <video> can't send the key) */
async function linkSecret(env) {
  let row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'linksecret'").first();
  if (!row) { await env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('linksecret', ?1)").bind(rand(32)).run(); row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'linksecret'").first(); }
  return row.v;
}
const linkSig = async (secret, id, e) => (await sha(secret + "|" + id + "|" + e)).slice(0, 32);
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
        let r; // (409: another change reached GitHub at the same moment: tried again)
        for (let k = 0; k < 5; k++) {
          if (k) await new Promise((ok) => setTimeout(ok, 700 * k + Math.random() * 500));
          const name = `${Date.now()}${kind ? "-" + kind : ""}.json`;
          r = await fetch(`https://api.github.com/repos/${REPO}/contents/inbox/${name}`, { method: "PUT",
            headers: { Authorization: `Bearer ${env.GH_WRITE}`, "User-Agent": "nrgfm-activity", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
            body: JSON.stringify({ message: (kind ? kind[0].toUpperCase() + kind.slice(1) : "Add") + " track (password login)", content: b64(text) }) });
          if (r.status !== 409) break;
        }
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
      if (path === "/lookup/img" && env.SHOTS) { // (by link: see GET /lookup)
        const id = url.searchParams.get("id") || "", e = +url.searchParams.get("e") || 0, sig = url.searchParams.get("s") || "";
        if (!/^[\w.-]+$/.test(id) || e < Date.now() / 1000 || sig !== (await linkSig(await linkSecret(env), id, e))) return json(req, { error: "link expired" }, 403);
        const obj = await env.SHOTS.get(id, { range: req.headers });
        if (!obj) return json(req, { error: "not found" }, 404);
        const h = { "Content-Type": await typeOf(env, id, obj), "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=172800", ...cors(req) };
        if (obj.range && req.headers.has("Range")) {
          const off = obj.range.offset ?? (obj.range.suffix != null ? obj.size - obj.range.suffix : 0);
          const n = obj.range.length ?? (obj.range.suffix != null ? obj.range.suffix : obj.size - off);
          return new Response(obj.body, { status: 206, headers: { ...h, "Content-Range": `bytes ${off}-${off + n - 1}/${obj.size}`, "Content-Length": String(n) } });
        }
        return new Response(obj.body, { headers: { ...h, "Content-Length": String(obj.size) } });
      }
      const upKey = async () => { const a = req.headers.get("Authorization") || "", k = a.replace(/^Upload\s+/i, "").trim(), row = /^Upload\s+/i.test(a) && k ? await env.DB.prepare("SELECT v FROM settings WHERE k = 'upkey'").first() : null;
        return !!row && row.v === (await sha(k)); };
      if (path === "/lookup/read" && req.method === "POST" && env.SHOTS && (await upKey())) {
        const p = await req.json().catch(() => ({})), id = str(p.id, 80);
        return id ? json(req, await readImage(env, id)) : json(req, { error: "id?" }, 400);
      }
      if (!(await isOwner(req))) return json(req, { error: "key needed" }, 401);
      if (path.startsWith("/lookup")) {
        if (!env.SHOTS) return json(req, { error: "no image storage on the server yet" }, 503);
        if (path === "/lookup" && req.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM lookup ORDER BY ts DESC LIMIT 2000").all();
          const used = (await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM lookup").first()).n;
          const key = await env.DB.prepare("SELECT 1 FROM settings WHERE k = 'upkey'").first();
          const secret = await linkSecret(env), e = (Math.floor(Date.now() / 86400000) + 2) * 86400; // (the same link all day, so the browser keeps the images)
          const items = await Promise.all(results.map(async (r) => ({ ...r, from: r.src, songs: r.songs ? JSON.parse(r.songs) : null, lines: r.lines ? JSON.parse(r.lines) : null,
            src: `${url.origin}/lookup/img?id=${encodeURIComponent(r.id)}&e=${e}&s=${await linkSig(secret, r.id, e)}` })));
          return json(req, { items, used, max: LOOKUP_MAX, phoneKey: !!key, reads: !!env.GEMINI_KEY });
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
          if (Array.isArray(p.lines)) await env.DB.prepare("UPDATE lookup SET lines = ?2 WHERE id = ?1").bind(id, JSON.stringify(p.lines.slice(0, 80)
            .map((x) => ({ t: String((x && x.t) || "").slice(0, 300), ...(x && typeof x.e === "string" ? { e: x.e.slice(0, 300) } : {}) })))).run();
          if (typeof p.final === "string") await env.DB.prepare("UPDATE lookup SET final = ?2 WHERE id = ?1").bind(id, p.final.slice(0, 500)).run();
          return json(req, { ok: true });
        }
        if (path === "/lookup/read") return json(req, await readImage(env, id)); // (the answer waits until it's read: up to a minute or two for a video)
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
        const up = await env.DB.prepare("SELECT 1 FROM settings WHERE k = 'upkey'").first();
        return json(req, { level2: results.some((r) => r.k === "pw2"), level3: results.some((r) => r.k === "pw3"), phoneKey: !!up });
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
    // Lookup: what's in Done is deleted every night (the images too)
    if (env.SHOTS) {
      const { results } = await env.DB.prepare("SELECT id FROM lookup WHERE done > 0").all();
      for (const r of results) { await env.SHOTS.delete(r.id); await env.DB.prepare("DELETE FROM lookup WHERE id = ?1").bind(r.id).run(); }
    }
  },
};
