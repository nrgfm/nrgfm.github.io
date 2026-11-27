"use strict";
const REPO = "nrgfm/nrgfm.github.io";
const PAGE = 40;

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false || k === "title") continue; // no hover hints on this site
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : String(k));
  // typing fields: no autofill (on an iPhone, fewer password/card/address buttons above the keyboard)
  if ((tag === "input" || tag === "textarea") && !("autocomplete" in attrs)) n.setAttribute("autocomplete", "off");
  return n;
};

let threads = [], meta = {}, extra = {}, shown = [], rendered = 0, query = "";
let playing = null; // playing = {thread, index}

/* ---------- data helpers ---------- */
const fold = (s) => (s || "").toLowerCase()
  .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a").replace(/ß/g, "ss")
  .normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC") // (NFC again: Korean and Japanese letters stay whole)
  .replace(/['’‘`´ʼ]/g, "") // apostrophes don't count: "dont" finds "don't", "rocknroll" "rock'n'roll"
  .replace(/&/g, " and ") // "&" and "and" are the same
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim(); // letters of every script are kept (Japanese, Korean, Chinese, Greek…)

const PLATFORM = { youtube: "Youtube", soundcloud: "Soundcloud", bandcamp: "Bandcamp", vimeo: "Vimeo", mixcloud: "Mixcloud", spotify: "Spotify" };

const BAD_TITLES = new Set(["client challenge", "just a moment...", "attention required!"]);
// Readable fallback from a Bandcamp link: artist.bandcamp.com/album/some-title -> "Some Title – artist"
function slugTitle(t) {
  if (t.platform !== "bandcamp") return "";
  try {
    const u = new URL(t.url), artist = u.hostname.split(".")[0];
    const slug = u.pathname.split("/").filter(Boolean).pop() || "";
    const name = decodeURIComponent(slug).replace(/-\d+$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return name ? `${name} – ${artist}` : artist;
  } catch { return ""; }
}

/* "Randy Newman - Topic" -> "Randy Newman", "KTTunstallVEVO" -> "KT Tunstall".
   Only for YouTube's automatic artist channels and VEVO; labels ("...RecordingsVEVO") are skipped. */
function channelArtist(author) {
  if (!author) return "";
  let a = "";
  if (/\s-\sTopic$/i.test(author)) a = author.replace(/\s-\sTopic$/i, "");
  else if (/VEVO$/.test(author)) a = author.replace(/VEVO$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  a = a.trim();
  if (!a || /various artists|records|recordings|music$/i.test(a)) return "";
  return a;
}
/* "Emotions · Mariah Carey" -> "Mariah Carey – Emotions"; a trailing year stays at the end:
   "Suimasen · Blonde Redhead (1998)" -> "Blonde Redhead – Suimasen (1998)" */
function flipDotTitle(title) {
  const parts = title.split(" · ");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return title;
  const m = parts[1].trim().match(/^(.*?)\s*(\(\d{4}\))?$/);
  const artist = m[1], year = m[2] ? " " + m[2] : "";
  return `${artist} – ${parts[0].trim()}${year}`;
}
const HAS_ARTIST_SEP = /\s[-–—]\s|\S[-–—]\s|\s[-–—]\S/;

function info(t) {
  if (!t.url) return { title: t.title || "Untitled", author: "", thumb: "", dead: false, noEmbed: false, recovered: false, archive: "", untitled: !t.title, nolink: true }; // (added without a link)
  const m = meta[t.url] || {};
  const recovered = !!(m.dead && m.wb_title);
  const fetched = BAD_TITLES.has((m.title || "").toLowerCase()) ? "" : m.title;
  const channel = (m.author_name && t.platform !== "bandcamp" ? m.author_name : "") || m.wb_author || "";
  const artist = channelArtist(channel);
  let title = t.title || fetched || m.wb_title || slugTitle(t) || (m.dead ? "Unavailable" : `${PLATFORM[t.platform] || "Link"} track`);
  // link-only tracks from artist channels: put the artist in front of YouTube's bare song title
  if (!t.title && artist && (fetched || m.wb_title) && !HAS_ARTIST_SEP.test(title) && !title.toLowerCase().includes(artist.toLowerCase())) title = `${artist} – ${title}`;
  title = flipDotTitle(title);
  const author = artist || channel;
  let thumb = m.thumbnail_url || (extra[t.url] || {}).cover || ""; // (the Bandcamp cover the lookup found, when the page itself couldn't be read)
  if (t.yt) thumb = `https://i.ytimg.com/vi/${t.yt}/mqdefault.jpg`;
  // video exists but can't play on other sites: its owner blocks it, or YouTube does (age restriction: the player here
  // reported it and the track got the tag "plays on youtube only")
  let noEmbed = m.status === 401 || !!(t.tags && t.tags[YT_ONLY]) || !!t._ytOnly;
  const alt = (m.dead || noEmbed) && altSource(t); // the main link is gone: the alternative link plays (and gives the picture)
  if (alt) {
    const am = meta[alt.url] || {};
    thumb = alt.yt ? `https://i.ytimg.com/vi/${alt.yt}/mqdefault.jpg` : am.thumbnail_url || thumb;
    if (!t.title && !fetched && !m.wb_title && am.title) title = flipDotTitle(am.title);
    return { title, author, thumb, dead: false, noEmbed: false, recovered, archive: "", untitled: !t.title && !m.title && !am.title, alt: true };
  }
  return { title: noEmbed && !t.title && !m.title ? "Plays on Youtube only" : title, author, thumb, dead: !!m.dead && !noEmbed, noEmbed, recovered, archive: m.wb_url || "", untitled: !t.title && !m.title };
}

/* What search looks in, field by field (the filters next to the result count switch fields off) */
// in order of importance: a match in an earlier field ranks a result higher
const FIELDS = [["title", "Titles"], ["notes", "Notes"], ["tags", "Tags"], ["release", "Releases"], ["year", "Year"], ["genres", "Genres"], ["uploader", "Meta"]];
function haystack(t) {
  if (t._hay == null) {
    const m = meta[t.url] || {}, x = extra[t.url] || {};
    // words start after a space: matching is by word start. Each two neighbouring words also once written together,
    // so "hiphop" finds "hip-hop" and "hip hop", "citypop" "city pop"
    const j = (a) => { const f = fold(a.filter(Boolean).join(" ")), w = f.split(" ");
      let out = " " + f;
      for (let k = 0; k + 1 < w.length; k++) if (w[k] && w[k + 1] && w[k].length + w[k + 1].length <= 24) out += " " + w[k] + w[k + 1];
      return out; };
    const named = t.title || m.title || m.wb_title;
    t._f = {
      title: j([t.title, m.title, m.wb_title, named ? "" : slugTitle(t), named ? info(t).title : ""]), // the link's words only when there is no title; and the title as shown (with the artist put in front)
      notes: level() <= 2 ? j([t.notes]) : "", // (notes are searched from level 2 up)
      tags: j(shownTags(t)),
      genres: j(x.g || []),
      year: j([x.y, decadeOf(x.y)]),
      release: j(t.release || x.rl || []),
      uploader: j([m.author_name, channelArtist(m.author_name), m.wb_author, x.by, ...countryList(x.co)]),
    };
    // each title on its own (for ranking: a title that is just the words searched comes first)
    t._titles = [t.title, m.title, m.wb_title, info(t).title].filter(Boolean).map((s) => [fold(s), fold(s.split(/\s[-–—]\s/).pop())]); // (also the title as shown)
    t._hay = Object.values(t._f).join(" ");
  }
  return t._hay;
}
const fieldsOf = (t) => (haystack(t), t._f);
let searchOff = new Set(); // filters switched off for this search only
/* a word you type matches the start of a word ("sear" finds "Search", not "Research") */
const has = (field, w) => field.includes(" " + w);
const matches = (tr, terms, off = searchOff) => { const f = fieldsOf(tr); return terms.every((w) => FIELDS.some(([k]) => !off.has(k) && has(f[k], w))); };
/* how well a track matches: the first field (in order of importance) holding all the words, else any of them */
function matchRank(tr, terms) {
  const f = fieldsOf(tr), on = FIELDS.filter(([k]) => !searchOff.has(k));
  const all = on.findIndex(([k]) => terms.every((w) => has(f[k], w)));
  if (all > -1) return all + (on[all][0] === "title" ? titleCloseness(tr, terms) : 0);
  const any = on.findIndex(([k]) => terms.some((w) => has(f[k], w)));
  return any > -1 ? any + 0.5 : 99;
}
/* how well, in 3 steps, before anything else is weighed: the words as whole words (or the title exactly) 0; at a word's
   start or spread out 1; only found by joining two words ("mew" in "me why") 2 */
const fit = (rank) => { const f = rank - Math.floor(rank); return f < 0.2 ? 0 : f < 0.45 ? 1 : 2; };
/* among titles holding all the words: the song title being exactly the words searched (0), the whole title being them,
   the words together in that order (0.1), in that order at a word start (0.2), anywhere (0.3); shorter titles first within each */
function titleCloseness(tr, terms) {
  const q = terms.join(" ");
  let best = 0.49;
  for (const [whole, song] of tr._titles || []) {
    const extra = Math.min(0.09, Math.max(0, whole.split(" ").length - terms.length) * 0.003);
    const h = " " + whole + " ";
    const v = song === q || whole === q ? 0 : h.includes(" " + q + " ") ? 0.1 + extra : h.includes(" " + q) ? 0.2 + extra
      : terms.every((w) => has(" " + whole, w)) ? 0.3 + extra : 0.49;
    best = Math.min(best, v);
  }
  return best;
}
let byNewest = false; // "Best match" each time
let resultList = false; // search: the found tracks as one list (as in Archive) instead of in their posts ("6 results" switches)

const fmtDate = (d) => {
  const [y, mo] = d.split("-");
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+mo - 1]} ${y}`;
};

/* ---------- tags: every tag is also shown as a thread (a playlist) ---------- */
const normTag = (g) => (g || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
const isBase = (t) => t.kind !== "tag";
function activity(t) {
  if (t.kind === "tag") return t.last;
  if (t.pos_ts) return t.pos_ts; // the main post's date was set by hand
  return t.ts || 0; // the date the main track was posted (new replies don't move a thread)
}
function makeTagThreads() {
  const by = new Map();
  for (const t of threads) {
    if (!isBase(t)) continue;
    for (const tr of t.tracks) for (const [g, ts] of Object.entries(tr.tags || {})) {
      if (HIDDEN_TAGS.has(g)) continue;
      if (!by.has(g)) by.set(g, []);
      by.get(g).push({ tr, ts });
    }
  }
  return [...by].map(([g, list]) => {
    list.sort((a, b) => b.ts - a.ts || b.tr.ts - a.tr.ts); // the most recently tagged first
    return { id: "tag-" + fold(g).replace(/ /g, "-"), name: g, kind: "tag", ts: list[list.length - 1].ts, last: list[0].ts, tracks: list.map((x) => x.tr) };
  });
}
function tagCounts() { // tag -> how many tracks have it
  const n = new Map();
  for (const t of threads) if (isBase(t)) for (const tr of t.tracks) for (const g of shownTags(tr)) n.set(g, (n.get(g) || 0) + 1);
  return n;
}
function allTags() {
  const n = new Map();
  for (const t of threads) if (isBase(t)) for (const tr of t.tracks) for (const g of shownTags(tr)) n.set(g, (n.get(g) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}
function sortThreads() {
  threads.sort((a, b) => activity(b) - activity(a));
}
/* after a change: rebuild the tag threads and update the ones on screen without moving the page */
function refreshTags() {
  const fresh = makeTagThreads(), byId = new Map(fresh.map((t) => [t.id, t]));
  const old = threads.filter((t) => !isBase(t));
  threads = threads.filter(isBase);
  for (const t of old) {
    const node = document.getElementById("th-" + t.id);
    const nt = byId.get(t.id);
    if (!nt) { if (node) node.remove(); shown = shown.filter((x) => x.t !== t); continue; }
    if (playing && playing.thread === t) playing.thread = nt;
    shown.forEach((x) => { if (x.t === t) x.t = nt; });
    if (node) { const fresh = threadNode({ t: nt, hits: null }); node.replaceWith(fresh); if (expanded.has(nt.id)) requestAnimationFrame(() => fitList(fresh, true)); } // an expanded box stays expanded (and in place)
  }
  for (const t of fresh) {
    if (old.some((o) => o.id === t.id)) { threads.push(t); continue; }
    threads.unshift(t); // a new tag shows up at the top (of the Tags page)
    if (!$("#q").value.trim() && view === "tagsold") {
      const node = threadNode({ t, hits: null });
      $("#threads").prepend(node);
      shown.unshift({ t, hits: null }); rendered++;
    }
  }
  if (tagsView() && !$("#q").value.trim()) { const y = scroller() === window ? scrollY : document.body.scrollTop; renderTagsPage(); pageScrollTo(y); }
  // Mixes and Genres: re-draw the playlists on screen
  if ((view === "mixes" || view === "genres") && !$("#q").value.trim()) {
    const items = new Map(viewItems().map((t) => [t.id, t]));
    shown.forEach((x) => {
      const nt = items.get(x.t.id), node = document.getElementById("th-" + x.t.id);
      if (playing && playing.thread === x.t && nt) playing.thread = nt;
      if (nt) { x.t = nt; if (node) node.replaceWith(threadNode({ t: nt, hits: null })); } else if (node) node.remove();
    });
  }
  markPlaying();
}

/* ---------- search ---------- */
/* where you were before a search: Esc or × brings you back there (not to the post in the address) */
let preSearch = null;
function saveSpot() {
  const top = headerBottom(), row = [...document.querySelectorAll("#threads [data-k]")].find((r) => r.offsetParent && r.getBoundingClientRect().bottom > top + 4);
  preSearch = { view, k: row ? row.dataset.k : null, top: row ? row.getBoundingClientRect().top : 0, y: scroller() === window ? scrollY : document.body.scrollTop };
}
function runSearch() {
  if (!query && fold($("#q").value)) saveSpot(); // (a search starts here)
  query = fold($("#q").value);
  document.body.classList.toggle("q-on", !!query); // (search results: thumbnails at the original size)
  try { drawBrowse(); } catch {} // (the side list of opened posts; not yet there while the page starts)
  fixedRows.clear(); scrollOn.clear(); keptHeight.clear(); expanded.clear(); activeId = null;
  const terms = query.split(" ").filter(Boolean);
  $("#viewHead").hidden = true;
  if (!terms.length) {
    searchOff.clear(); byNewest = false; resultList = false; // leaving search: the next one starts fresh
    shown = viewItems().map((t) => ({ t, hits: null }));
    $("#resultInfo").hidden = true;
    drawThreadsSort();
    drawViewHead();
  } else {
    shown = [];
    const used = new Set(), none = new Set(), perField = new Map(); // tracks found (also) through each part
    for (const t of threads) {
      if (t.kind === "tag") continue; // tags are searched on the tracks themselves
      const hits = new Set();
      let rank = 99;
      const forced = dupFilter && dupFilter.q === query ? dupFilter.ids : null;
      t.tracks.forEach((tr, i) => {
        if (forced) { if (forced.has(tr.id)) { hits.add(i); rank = 0; } return; }
        if (!matches(tr, terms, none)) return;
        const f = fieldsOf(tr);
        for (const [k] of FIELDS) if (terms.some((w) => has(f[k], w))) used.add(k); // which filters are worth showing
        if (matches(tr, terms)) {
          hits.add(i); rank = Math.min(rank, matchRank(tr, terms));
        }
        for (const [k] of FIELDS) if (terms.some((w) => has(f[k], w))) perField.set(k, (perField.get(k) || 0) + 1); // (also for parts switched off)
      });
      if (hits.size) shown.push({ t, hits, rank, tagged: [...hits].some((i) => userTagged(t.tracks[i])), main: hits.has(0) });
    }
    // best matches first: by where the words were found (title, then notes, tags…); within each, a found track with tags
    // of its own first (whoever is looking), then one that is the main track of its post, then the closest match, then
    // the newest; or simply newest first
    shown.sort((x, y) => (byNewest ? 0 : Math.floor(x.rank) - Math.floor(y.rank) || fit(x.rank) - fit(y.rank) || y.tagged - x.tagged || y.main - x.main || x.rank - y.rank) || activity(y.t) - activity(x.t));
    const tagHits = shown.filter((s) => s.tag).length, trackThreads = shown.length - tagHits;
    if (resultList) { // one item per found track, best first by the same rules (where found, tags, main track, closeness), or newest
      const flat = [];
      for (const s of shown) for (const i of s.hits) { const tr = s.t.tracks[i]; flat.push({ t: s.t, hits: new Set([i]), one: i, rank: forcedRank(s, tr, terms), tagged: userTagged(tr), main: i === 0 }); }
      flat.sort((x, y) => (byNewest ? 0 : Math.floor(x.rank) - Math.floor(y.rank) || fit(x.rank) - fit(y.rank) || y.tagged - x.tagged || y.main - x.main || x.rank - y.rank) || (y.t.tracks[y.one].ts || 0) - (x.t.tracks[x.one].ts || 0));
      shown = flat;
    }
    const n = shown.reduce((a, s) => a + (s.hits ? s.hits.size : 0), 0);
    const parts = [];
    if (tagHits) parts.push(`${tagHits} ${tagHits === 1 ? "tag" : "tags"}`);
    if (n) parts.push(`${n} ${n === 1 ? "track" : "tracks"} in ${trackThreads} ${trackThreads === 1 ? "thread" : "threads"}`);
    $("#resultInfo").hidden = false;
    $("#resultInfo").replaceChildren(
      n ? el("button", { class: "result-n" + (resultList ? " on" : ""), "aria-pressed": String(resultList), onclick: () => { resultList = !resultList; runSearch(); } }, `${n} ${n === 1 ? "result" : "results"}`)
        : el("span", { class: "result-n" }, `Nothing matches “${$("#q").value.trim()}”.`),
      el("button", { class: "sf sf-order", "aria-pressed": String(byNewest), onclick: () => { byNewest = !byNewest; runSearch(); } },
        el("span", { class: "sort-label" }, "Sort: "), el("span", { class: "sort-val" }, byNewest ? "Newest first" : "Best match"), " ▾"),
      el("span", { class: "search-fields" }, FIELDS.filter(([k]) => used.has(k) || searchOff.has(k)).map(([k, name]) => el("button", {
        class: "sf" + (searchOff.has(k) ? " off" : ""), "aria-pressed": String(!searchOff.has(k)),
        onclick: () => { searchOff.has(k) ? searchOff.delete(k) : searchOff.add(k); runSearch(); } }, name,
        el("span", { class: "gi-n" }, perField.get(k) || 0)))));
    requestAnimationFrame(placeFilters);
  }
  rendered = 0;
  $("#threads").replaceChildren();
  if (terms.length) pageScrollTo(0); // results start at the top, wherever you were in the feed
  renderMore(terms.length ? 12 : PAGE); // search: the first results right away, more as you scroll
  if (!terms.length && view === "activity") renderActivity();
  if (!terms.length && view === "lookup") renderLookup();
  if (!terms.length && tagsView()) renderTagsPage(); else hideTagPanel();
  if (terms.length || view !== "history") hideHistPanel();
}

/* computer: the search line stays one line: the count, the filters after it, Sort on the right. Too many filters
   for the room: smaller, in two rows centred on the line (the line keeps its height) */
function placeFilters() {
  const info = $("#resultInfo"), f = info.querySelector(".search-fields");
  if (!f || info.hidden) return;
  f.querySelectorAll(".sf, .gi-n").forEach((x) => x.style.removeProperty("font-size"));
  f.style.maxWidth = ""; f.style.left = ""; info.classList.remove("two-rows");
  if (phone()) return;
  const n = info.querySelector(".result-n").getBoundingClientRect(), o = info.querySelector(".sf-order").getBoundingClientRect();
  const room = o.left - n.right - 36;
  if (f.getBoundingClientRect().width <= room) return;
  info.classList.add("two-rows");
  f.style.left = n.right - info.getBoundingClientRect().left + 18 + "px"; f.style.maxWidth = room + "px";
  f.querySelectorAll(".sf, .gi-n").forEach((x) => x.style.setProperty("font-size", "12px", "important"));
}
addEventListener("resize", placeFilters);
/* Search results: rest the pointer on a found track for a moment and a small note says where the words
   were found ("Title", "Uploader: …"). 0.6 s: long enough not to pop up while just moving past. */
const whyBox = el("div", { class: "why", hidden: true });
document.body.append(whyBox);
let whyTimer = 0, whyRow = null, whyXY = [0, 0];
document.addEventListener("mousemove", (e) => {
  whyXY = [e.clientX, e.clientY];
  const title = e.target.closest && e.target.closest(".tr-title, .t-title"); // only over the highlighted title itself
  const row = title && title.closest(".thread.searching .track.hit, .thread.searching .head-row.hit, .result-item .track.hit");
  if (row === whyRow) return;
  whyRow = row; clearTimeout(whyTimer); whyBox.hidden = true;
  if (row) whyTimer = setTimeout(() => showWhy(row), 600);
}, { passive: true });
addEventListener("scroll", () => { whyBox.hidden = true; }, { passive: true, capture: true });
function showWhy(row) {
  const [id, i] = row.dataset.k.split(":"), t = threads.find((x) => x.id === id), tr = t && t.tracks[+i];
  if (!tr) return;
  const terms = query.split(" ").filter(Boolean), f = fieldsOf(tr), m = meta[tr.url] || {}, x = extra[tr.url] || {};
  const joined = (s) => { const f = fold(s), w = f.split(" "); let out = " " + f; for (let k = 0; k + 1 < w.length; k++) out += " " + w[k] + w[k + 1]; return out; };
  const hit = (s) => s != null && terms.some((w) => has(joined(String(s)), w)); // (as the search found it: also "mew" in "me why")
  const pick = (list) => { const l = list.filter(Boolean); const h = l.filter(hit); return (h.length ? h : l).join(", "); }; // (never an empty line)
  const cut = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const note = () => { // the part of the notes around the first word found
    const n = tr.notes || "", k = Math.max(0, fold(n).indexOf(terms.find((w) => fold(n).includes(w)) || "") - 20);
    return (k ? "…" : "") + cut(n.slice(k), 70);
  };
  const say = {
    title: () => "Title: " + ([tr.title, m.title, m.wb_title].filter(Boolean).find(hit) || info(tr).title),
    notes: () => "Notes: " + note(),
    tags: () => "Tags: " + pick(shownTags(tr)),
    genres: () => "Genres: " + pick(x.g || []),
    year: () => "Year: " + x.y + " (" + decadeOf(x.y) + ")",
    release: () => "Release: " + cut(pick([].concat(tr.release || x.rl || []))),
    uploader: () => { const c = countryList(x.co).find(hit); return c && ![m.author_name, m.wb_author, x.by].filter(Boolean).some(hit) ? "Country: " + c : "Uploader: " + ([m.author_name, m.wb_author, x.by].filter(Boolean).find(hit) || m.author_name || x.by); },
  };
  const lines = FIELDS.filter(([k]) => !searchOff.has(k) && terms.some((w) => has(f[k], w))).map(([k]) => say[k]());
  if (!lines.length) return;
  whyBox.replaceChildren(...lines.map((l) => el("div", {}, l)));
  whyBox.hidden = false;
  const r = whyBox.getBoundingClientRect();
  whyBox.style.left = Math.min(whyXY[0] + 14, innerWidth - r.width - 8) + "px";
  whyBox.style.top = Math.min(whyXY[1] + 18, innerHeight - r.height - 8) + "px";
}

/* ---------- pages: Threads, Tags, Mixes, Genres, History (and Random) ----------
   The logo opens the menu. Search always looks through everything; clearing it returns to the page you were on. */
let view = "threads";
const VIEW_NAMES = { threads: "Threads", tags: "Tags", mixes: "Mixes", genres: "Genres", history: "History", activity: "Activity", lookup: "Lookup", tagged: "Archive", genreboxes: "Genres (one box each)", tagsold: "Tags (Oct 2026)", tagsrows: "Tags (Nov 2026)", tag: "Tag", threadsold: "Threads (Oct 2026)" };
const HASH_OF = { tagged: "archive" }, VIEW_OF = { archive: "tagged" }; // (Archive's address is #/archive; the old #/tagged still opens it)
/* tags offered for what's typed, best fit first: the name exactly, then names starting with it (the shorter, with fewer
   words, first: "atmospheric" before "atmospheric jungle"), then names with a word starting with it; then the most used */
const tagFit = (g, q) => { const f = fold(g); return f === q ? 0 : f.startsWith(q) ? 1 + f.split(" ").length / 10 + f.length / 1000 : 3; };
const byTagFit = (q, n = (g) => 0) => (a, b) => tagFit(a, q) - tagFit(b, q) || n(b) - n(a);
const slug = (g) => fold(g).replace(/ /g, "-");
const newestFirst = (a, b) => b.ts - a.ts;
function viewItems() {
  if (view === "tagsold") return threads.filter((t) => t.kind === "tag").sort((a, b) => b.last - a.last); // (#/tagsold: the Tags page as it was in Oct 2026, kept as a backup)
  if (tagsView()) return []; // drawn by renderTagsPage
  if (view === "tag") { const t = !tagVisible(tagPageName || "") ? null : tagThreadOf(tagPageName); /* (a tag's page: only when its tag is seen at this level) */ if (t) expanded.add(t.id); return t ? [tagPlaylist(t)] : []; } // (opened out: all its tracks)
  if (view === "mixes") return mixThreads();
  if (view === "genres") return gSel.length ? [genreMix()] : []; // no playlist until a genre is picked
  if (view === "genreboxes") return genreThreads(); // the earlier Genres page (#/genreboxes), kept as a backup
  if (view === "history") return historyMonths();
  if (view === "activity" || view === "lookup") return []; // drawn by renderActivity / renderLookup
  if (view === "tagged" && archiveShuffle) return shuffleParts();
  if (view === "tagged") return threads.filter((t) => isBase(t) && t.tracks.some(userTagged));
  if (view === "threads" && byAddOn()) return threads.filter(isBase).sort((a, b) => lastAdded(b) - lastAdded(a));
  return threads.filter(isBase);
}
/* Threads, the other order (Sort in the menu, left of uBlock, on Threads only): the posts a track was added to most recently first */
let threadsByAdd = (() => { try { return localStorage.getItem("nrgfm-threads-order") === "added"; } catch { return false; } })();
const byAddOn = () => threadsByAdd && level() <= 3; // (logged out: always by date)
const lastAdded = (t) => Math.max(activity(t), ...t.tracks.map((tr) => tr.ts || 0));
/* Threads (laptop): − / + in the menu between Random and Sort: the thumbnails' size in 3 steps (2 the biggest, 0 the original) */
const SIZE_KEYS = { threads: "nrgfm-th-size2", tagged: "nrgfm-ar-size" }; // (Threads and Archive each keep their own; the middle step is the default)
const readSize = (k) => { try { const v = localStorage.getItem(k); return v === null ? 1 : Math.max(0, Math.min(2, +v || 0)); } catch { return 1; } };
const sizes = { threads: readSize(SIZE_KEYS.threads), tagged: readSize(SIZE_KEYS.tagged) };
function applyThSize() {
  let lv4 = false; try { lv4 = level() > 3; } catch {} // (without a password: always the middle size; at the very start the level isn't known yet)
  for (const k of [0, 1, 2]) {
    document.body.classList.toggle("th-s" + k, (lv4 ? 1 : sizes.threads) === k);
    document.body.classList.toggle("ar-s" + k, (lv4 ? 1 : sizes.tagged) === k);
  }
}
applyThSize();
function drawMenuSize() {
  let box = $("#menuSize");
  const step = (d) => {
    const v = view === "tagged" ? "tagged" : "threads";
    // keep the same tracks in view: the first row showing below the header stays where it is
    const top = headerBottom(), rows = [...document.querySelectorAll("#threads .thread-head, #threads .track")];
    const anchor = rows.find((r) => r.getBoundingClientRect().bottom > top + 4), was = anchor ? anchor.getBoundingClientRect().top : 0;
    keepMenuUntil = Date.now() + 600; sizes[v] = Math.max(0, Math.min(2, sizes[v] + d));
    try { localStorage.setItem(SIZE_KEYS[v], String(sizes[v])); } catch {}
    applyThSize(); drawMenuSize();
    if (anchor && anchor.isConnected) pageScrollBy(anchor.getBoundingClientRect().top - was);
  };
  if (!box) {
    box = el("span", { id: "menuSize", class: "menu-size" },
      el("button", { type: "button", class: "when-link", "aria-label": "Smaller thumbnails", onclick: () => step(-1) }, "−"),
      el("button", { type: "button", class: "when-link", "aria-label": "Bigger thumbnails", onclick: () => step(1) }, "+"));
  }
  const sort = $("#threadsSort"); // right before Sort
  if (sort && box.nextElementSibling !== sort) sort.before(box); else if (!sort && !box.isConnected) $('#menu [data-view="ublock"]').before(box);
  box.hidden = (view !== "threads" && view !== "tagged") || phone() || level() > 3;
  const cur = sizes[view === "tagged" ? "tagged" : "threads"];
  box.children[0].disabled = cur <= 0; box.children[1].disabled = cur >= 2;
}
function drawThreadsSort() { // (the same button on Archive: Date posted or Shuffle)
  let b = $("#threadsSort");
  if (!b) {
    b = el("button", { id: "threadsSort", class: "sf sf-order menu-sort", onclick: () => {
      if (view === "tagged") { archiveShuffle = archiveShuffle ? null : shuffledArchive(); runSearch(); pageScrollTo(0); return; }
      if (view === "tags") { tagsByLatest = !tagsByLatest; tp.active = null; runSearch(); pageScrollTo(0); return; }
      threadsByAdd = !threadsByAdd; try { localStorage.setItem("nrgfm-threads-order", threadsByAdd ? "added" : "posted"); } catch {}
      if (view === "threads" && !$("#q").value.trim()) { runSearch(); pageScrollTo(0); } else drawThreadsSort();
    } });
    $('#menu [data-view="ublock"]').before(b);
  }
  b.hidden = (view !== "threads" && view !== "tagged" && view !== "tags") || level() > 3;
  const on = view === "tagged" ? !!archiveShuffle : view === "tags" ? tagsByLatest : threadsByAdd;
  b.setAttribute("aria-pressed", String(on));
  b.replaceChildren(el("span", { class: "sort-label" }, "Sort: "), el("span", { class: "sort-val" },
    view === "tagged" ? (on ? "Shuffle" : "Date posted") : view === "tags" ? (on ? "Latest added" : "Alphabetical") : on ? "Latest added" : "Date posted"), " ▾");
  drawMenuSize();
}
/* Archive shuffled: every track with a tag of its own, in random order, as one playlist (playing one: autoplay on,
   on through the shuffled list). Shown in small parts so the page stays quick. */
let archiveShuffle = null;
let tagsByLatest = false; // Tags: A–Z (always, when Tags is opened from the menu), or the tags tracks were added to most recently first
const SHUF_PART = 5; // (40 parts at a time: 200 tracks, like an ordinary Archive page)
function shuffledArchive() {
  const all = [];
  for (const t of threads) if (isBase(t)) for (const tr of t.tracks) if (userTagged(tr)) all.push(tr);
  for (let k = all.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [all[k], all[j]] = [all[j], all[k]]; }
  return { id: "archive-shuffle", kind: "tag", name: "", shuffle: true, tracks: all, last: 0 };
}
function shuffleParts() {
  const parts = [];
  for (let k = 0; k < archiveShuffle.tracks.length; k += SHUF_PART) parts.push({ id: "shuf-" + k, kind: "shufpart", from: k, to: Math.min(k + SHUF_PART, archiveShuffle.tracks.length), tracks: [] });
  return parts;
}
function shufflePartNode(p) {
  const t = archiveShuffle, rows = [];
  for (let i = p.from; i < p.to; i++) rows.push(trackRow(t, t.tracks[i], i, null));
  return el("li", { class: "thread tagged-thread tg-shuffle", id: "th-" + p.id }, el("ol", { class: "tracks tg-tracks" }, rows));
}

const baseTracks = () => threads.filter(isBase).flatMap((t) => t.tracks);
const playlist = (id, name, tracks, note) => ({ id, name, note, kind: "tag", tracks, last: Math.max(0, ...tracks.map((x) => x.ts)) });
/* Mixes: every track ticked as a mix ("mix" tag). First all of them, then one box per other tag the mixes
   have (a mix tagged "techno" shows up under techno too), the biggest groups first. */
function mixThreads() {
  const mixes = baseTracks().filter((tr) => tr.tags && tr.tags.mix).sort(newestFirst);
  if (!mixes.length) return [];
  const by = new Map();
  for (const tr of mixes) for (const g of Object.keys(tr.tags)) if (g !== "mix") (by.get(g) || by.set(g, []).get(g)).push(tr);
  return [playlist("mix-all", "all mixes", mixes),
    ...[...by].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([g, list]) => playlist("mix-" + slug(g), g, list))];
}
/* Genres: the suggested genres found by the lookups (MusicBrainz, Discogs, descriptions), one playlist each,
   the biggest first; genres with fewer than 3 tracks are left out. */
const GENRE_MIN = 3;
function genreThreads() {
  const by = new Map();
  for (const tr of baseTracks()) for (const g of (extra[tr.url] || {}).g || []) (by.get(g) || by.set(g, []).get(g)).push(tr);
  return [...by].filter(([, l]) => l.length >= GENRE_MIN)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([g, list]) => playlist("genre-" + slug(g), g, [...new Set(list)].sort(newestFirst)));
}
/* ---------- Genres: mix genres into one playlist ----------
   Pick a genre and the playlist is every track with it; the genres left to pick are only those the playlist's
   tracks also have, each with the number of tracks you would get by adding it. Remove a genre and it widens
   again. Each new mix is shuffled; "Date added" puts the newest first. The choice is kept in the address. */
let gSel = [], gOrder = "shuffle", gMix = null, gIndex = null;
/* the same genre spelled differently counts once (drum n bass = drum and bass, synth-pop = synth pop);
   micro genres stay as they are. Your own tags count as genres here too. */
const SAME_GENRE = { "drum n bass": "drum and bass", "drum & bass": "drum and bass", "drum'n'bass": "drum and bass", "drumnbass": "drum and bass",
  "dnb": "drum and bass", "d&b": "drum and bass", "d n b": "drum and bass", "rock n roll": "rock and roll", "rock & roll": "rock and roll",
  "rock'n'roll": "rock and roll", "rock 'n' roll": "rock and roll", "hiphop": "hip hop", "r'n'b": "r&b", "rnb": "r&b", "lofi": "lo fi",
  "dub step": "dubstep", "synthpop": "synth pop", "italodisco": "italo disco", "triphop": "trip hop", "kpop": "k pop", "jpop": "j pop", "electropop": "electro pop" };
const sameGenre = (g) => { g = g.trim().toLowerCase().replace(/\s+/g, " "); g = SAME_GENRE[g] || g; g = g.replace(/\s*-\s*/g, " "); return SAME_GENRE[g] || g; };
const NOT_GENRES = new Set(["broken link", "plays on youtube only"]); // housekeeping tags
/* the decade of the earliest release year found: 1984 → "80s", 2004 → "2000s", 2014 → "2010s" */
const decadeOf = (y) => { y = +y; if (!y) return ""; const d = Math.floor(y / 10) * 10; return d >= 1920 && d < 2000 ? String(d).slice(2) + "s" : d + "s"; };
// a track's genres for the Genres page: the suggested ones, its tags, its decade and the artist's country
const genresOf = (tr) => { const x = extra[tr.url] || {}; return [...new Set([...(x.gm || (x.g || []).map(sameGenre)), ...shownTags(tr).filter((g) => !NOT_GENRES.has(g)), decadeOf(x.y), ...countryList(x.co).map((c) => c.toLowerCase())].filter(Boolean))]; };
function genreIndexAll() {
  if (gIndex) return gIndex;
  gIndex = new Map();
  for (const tr of baseTracks()) for (const g of genresOf(tr)) (gIndex.get(g) || gIndex.set(g, new Set()).get(g)).add(tr);
  return gIndex;
}
function genreTracks(sel) {
  if (!sel.length) return [];
  const idx = genreIndexAll(), sets = sel.map((g) => idx.get(g) || new Set()).sort((a, b) => a.size - b.size);
  return [...sets[0]].filter((tr) => sets.every((st) => st.has(tr)));
}
function genreCounts() { // genre -> tracks you would get by adding it
  const idx = genreIndexAll(), out = new Map();
  if (!gSel.length) { for (const [g, st] of idx) out.set(g, st.size); }
  else for (const tr of genreTracks(gSel)) for (const g of genresOf(tr)) if (!gSel.includes(g)) out.set(g, (out.get(g) || 0) + 1);
  return [...out].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
function genreMix(fresh) {
  if (gMix && !fresh) return gMix;
  const tracks = genreTracks(gSel);
  if (gOrder === "date") tracks.sort((a, b) => b.ts - a.ts);
  else for (let i = tracks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tracks[i], tracks[j]] = [tracks[j], tracks[i]]; }
  gMix = { id: "genre-mix", kind: "tag", mix: true, name: gSel.join(" + "), tracks, last: 0 };
  return gMix;
}
function setGenres(sel) {
  gSel = sel;
  history.replaceState(null, "", "#/genres" + (gSel.length ? "?g=" + gSel.map(encodeURIComponent).join(",") : ""));
  const t = genreMix(true), node = document.getElementById("th-genre-mix");
  shown = gSel.length ? [{ t, hits: null }] : [];
  if (!gSel.length) { if (node) node.remove(); rendered = 0; }
  else if (node) node.replaceWith(genreMixNode(t));
  else { $("#threads").replaceChildren(genreMixNode(t)); rendered = 1; }
  if (playing && playing.thread.mix) markPlaying();
  const old = $("#viewHead .gm-picker"); if (old) old.replaceWith(genrePicker(true));
}
function genrePicker(keepFocus) {
  const counts = genreCounts();
  const input = el("input", { type: "text", class: "tag-input", placeholder: gSel.length ? "" : "Combine multiple genres into a playlist", autocomplete: "off", spellcheck: "false", "aria-label": "Add genre" });
  const chips = el("span", { class: "tag-chips-in" }, gSel.map((g) => el("button", { type: "button", class: "tag-chip in",
    onmousedown: (e) => e.preventDefault(), onclick: () => setGenres(gSel.filter((x) => x !== g)) }, g, el("span", { class: "x", "aria-hidden": "true" }, " ×"))));
  const field = el("span", { class: "tag-field", onmousedown: (e) => { if (e.target === field || e.target === chips) { e.preventDefault(); input.focus(); } } }, chips, input);
  const drop = el("div", { class: "tag-drop", hidden: true });
  let opts = [], active = 0;
  const drawDrop = () => {
    const q = fold(input.value);
    opts = q ? counts.filter(([g]) => fold(g).split(" ").some((w) => w.startsWith(q)) || fold(g).startsWith(q)).sort((a, b) => tagFit(a[0], q) - tagFit(b[0], q)).slice(0, 8) : []; // (stable: the most used first among equals)
    active = 0;
    drop.replaceChildren(el("ul", { class: "drop-list" }, opts.map(([g, n], k) => el("li", { class: k === active ? "on" : "",
      onmousedown: (e) => { e.preventDefault(); setGenres([...gSel, g]); } }, g, el("span", { class: "gi-n" }, n)))));
    drop.hidden = !opts.length;
  };
  input.addEventListener("input", drawDrop);
  input.addEventListener("blur", () => setTimeout(() => (drop.hidden = true), 100));
  input.addEventListener("keydown", (e) => {
    const items = [...drop.querySelectorAll("li")];
    if (e.key === "Enter") { e.preventDefault(); if (opts[active]) setGenres([...gSel, opts[active][0]]); if (phone()) setTimeout(() => document.activeElement.blur(), 50); }
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      items.forEach((li, k) => li.classList.toggle("on", k === active));
    } else if (e.key === "Backspace" && !input.value && gSel.length) setGenres(gSel.slice(0, -1));
    else if (e.key === "Escape") { e.stopPropagation(); if (!drop.hidden) drop.hidden = true; else { setGenres([]); } }
  });
  const pool = el("div", { class: "gm-pool genre-index" },
    counts.length ? counts.flatMap(([g, n]) => [el("button", { class: "when-link", onclick: () => setGenres([...gSel, g]) }, g, el("span", { class: "gi-n" }, n)), " "])
      : el("span", { class: "hint" }, "No other genres in this mix."));
  const moreArrow = el("span", { class: "gm-more", hidden: true, "aria-hidden": "true" });
  moreArrow.innerHTML = '<svg viewBox="0 0 16 10"><path d="M2 2l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  pool.addEventListener("scroll", () => (moreArrow.hidden = pool.scrollTop + pool.clientHeight >= pool.scrollHeight - 4), { passive: true });
  const clear = el("button", { type: "button", class: "btn ghost square gm-clear", "aria-label": "Clear", hidden: !gSel.length || null, onclick: () => setGenres([]) });
  clear.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  const box = el("div", { class: "gm-picker" + (gSel.length ? " picked" : "") }, el("span", { class: "tag-box gm-field" }, field, clear, drop),
    el("div", { class: "gm-pool-wrap" }, pool, moreArrow));
  // (phone: no keyboard popping up again; and never taken from the search bar or another field the person is in)
  const busy = () => { const a = document.activeElement; return a && a.matches("input, textarea") && !a.closest(".gm-picker"); };
  if (keepFocus && !phone() && !busy()) requestAnimationFrame(() => { if (!busy()) input.focus(); });
  requestAnimationFrame(() => (field.scrollLeft = field.scrollWidth)); // the last genre picked stays in view
  requestAnimationFrame(() => fitMix());
  return box;
}
function genreMixNode(t) {
  const n = t.tracks.length, BATCH = 60;
  let drawn = Math.min(n, BATCH);
  const list = el("ol", { class: "tag-list scroll-list gm-list", "data-total": n },
    n ? t.tracks.slice(0, drawn).map((tr, i) => trackRow(t, tr, i, null))
      : el("li", { class: "gm-empty hint" }, gSel.length ? "No tracks have all of these genres." : "Pick a genre above to start a playlist."));
  list.addEventListener("scroll", () => {
    if (drawn >= n || list.scrollTop + list.clientHeight < list.scrollHeight - 500) return;
    const more = t.tracks.slice(drawn, drawn + BATCH).map((tr, k) => trackRow(t, tr, drawn + k, null));
    drawn += more.length; list.append(...more); markPlaying();
  }, { passive: true });
  list.addEventListener("scroll", () => updateListPos(list.closest(".thread")), { passive: true }); // "3 of 8" follows the scrolling
  // only the playlist is redrawn (the genre field above is left alone); Date added pressed again goes back to shuffled
  const order = (o, label) => el("button", { class: "more-toggle" + (o === "date" && gOrder === o ? " on" : ""), onclick: () => {
    gOrder = o === "date" && gOrder === "date" ? "shuffle" : o;
    const mix = genreMix(true), old = document.getElementById("th-genre-mix");
    shown = [{ t: mix, hits: null }];
    if (old) old.replaceWith(genreMixNode(mix));
    if (playing && playing.thread.mix) markPlaying();
  } }, label);
  const node = el("li", { class: "thread tag-thread framed genre-mix", id: "th-" + t.id },
    el("div", { class: "tag-frame" },
      el("div", { class: "tag-side" },
        el("div", { class: "tag-label" },
          el("span", { class: "gm-names" }, gSel.map((g) => el("span", { class: "gm-name" }, "+ " + g))),
          el("span", { class: "tag-count gm-n" }, `${n} ${n === 1 ? "track" : "tracks"}`)),
        el("div", { class: "gm-order" }, n > 1 ? el("span", { class: "more-pos" }, `1 of ${n}`) : null, order("shuffle", "Shuffle"), order("date", "Date added"))),
      list));
  requestAnimationFrame(() => { fitMix(node); fitNames(node); updateFade(list); });
  return node;
}
/* each "+ genre" line scaled to fill the width: short names big, long ones small */
/* a genre name too long for the side of the playlist box gets smaller until it fits on one line */
function fitNames(node) {
  node.querySelectorAll(".gm-name").forEach((n) => {
    n.style.fontSize = "";
    const w = n.parentElement.clientWidth, nat = n.scrollWidth, base = parseFloat(getComputedStyle(n).fontSize);
    if (nat > w) n.style.fontSize = Math.max(9, Math.floor(base * w / nat * 10) / 10) + "px";
  });
}
/* the playlist box reaches down to the bottom of the window (or the player) and no further */
/* Genres layout: the genres to pick and the playlist share the window. The playlist gets at least half of it
   (or just what its tracks need); when the genres don't fit above it, they scroll in their own box with a small
   arrow showing there is more. The page itself doesn't scroll. */
/* how much of the bottom of the window the player covers over the content column: the video floats beside the
   content on wide screens, so only the bar counts there */
function dockH() {
  const d = $("#dock"); if (d.hidden) return 0;
  const m = $("main").getBoundingClientRect(), media = d.querySelector("#media").getBoundingClientRect();
  if (media.height && media.left > m.left + m.width / 2) return d.querySelector(".bar").getBoundingClientRect().height;
  return d.getBoundingClientRect().height;
}
function fitMix(node = document.getElementById("th-genre-mix")) {
  const pool = $("#viewHead .gm-pool"), list = node && node.querySelector(".gm-list");
  if (!pool) return;
  const dock = dockH();
  pool.style.height = ""; pool.parentElement.classList.remove("scrolls");
  const avail = innerHeight - dock - (pool.getBoundingClientRect().top + pageY()) - 12; // from the top of the genres to the bottom
  if (!list) { pool.parentElement.querySelector(".gm-more").hidden = true; return; }
  list.style.height = "";
  const frame = node.getBoundingClientRect().height - list.getBoundingClientRect().height; // the box around the list
  const gap = node.getBoundingClientRect().top - pool.getBoundingClientRect().bottom;
  const poolNeed = pool.scrollHeight, row = 56; // a fixed row height, so the box is always in the same place
  // the box has one size: half the window plus two tracks (on a phone it reaches down to the bottom)
  const fixed = Math.min(avail - 60 - gap, avail / 2 + 2 * row);
  const listH = phone() ? Math.max(fixed, avail - poolNeed - gap) : fixed;
  const poolH = phone() ? Math.min(poolNeed, avail - listH - gap) : avail - listH - gap; // computer: the genres area keeps its height, so the box stays put
  pool.style.height = phone() && poolH >= poolNeed ? "" : Math.max(60, poolH) + "px";
  if (poolH < poolNeed) pool.parentElement.classList.add("scrolls");
  pool.parentElement.querySelector(".gm-more").hidden = !(poolH < poolNeed) || pool.scrollTop + pool.clientHeight >= pool.scrollHeight - 4;
  const below = node.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom; // the box's edge under the list
  const room = innerHeight - dock - (list.getBoundingClientRect().top + pageY()) - below - 12;
  // the top stays put; the box is only as tall as its tracks need (up to its full size)
  list.style.height = Math.max(phone() ? 120 : 60, Math.min(phone() ? room : Math.min(listH - frame, room), list.scrollHeight)) + "px";
  const over = (INNER_SCROLL ? document.body.scrollHeight : document.documentElement.scrollHeight) - innerHeight;
  if (over > 0) list.style.height = Math.max(120, list.getBoundingClientRect().height - over) + "px"; // the page itself doesn't scroll
}
addEventListener("resize", () => fitMix());
/* boxes with more tracks above or below fade out at that edge (Genres playlist: only at the bottom) */
function updateFade(list) {
  if (!list) return;
  let up, down;
  if (list.classList.contains("scroll-list")) {
    up = list.scrollTop > 2 && !list.classList.contains("gm-list");
    down = list.scrollTop + list.clientHeight < list.scrollHeight - 2;
  } else { // a search result showing a few tracks of its thread
    const th = list.closest(".thread"), ks = [...list.querySelectorAll(":scope > li.track")].map((r) => +r.dataset.k.split(":").pop());
    const n = th ? shown.find((x) => "th-" + x.t.id === th.id)?.t.tracks.length || 0 : 0;
    const first = list.classList.contains("tag-list") ? 0 : 1; // a tag playlist has no main track above its list
    up = ks.length && ks[0] > first; down = ks.length && ks[ks.length - 1] < n - 1;
  }
  list.classList.toggle("fade-up", !!up); list.classList.toggle("fade-down", !!down);
}
document.addEventListener("scroll", (e) => { if (e.target.classList && e.target.classList.contains("scroll-list")) updateFade(e.target); }, { passive: true, capture: true });
const fadeAll = () => { document.querySelectorAll("#threads .scroll-list, #threads .thread.searching .tracks, #threads .tag-thread .tag-list, #threads .thread.long > .tracks").forEach(updateFade); placeMidPos(); };
function placeMidPos() {
  document.querySelectorAll("#threads .thread .mid-pos").forEach((p) => {
    const th = p.closest(".thread"), list = th.querySelector(".tracks");
    if (!list) return;
    const mid = list.getBoundingClientRect().top + list.getBoundingClientRect().height / 2 - th.getBoundingClientRect().top;
    p.style.top = mid - p.offsetHeight / 2 + "px";
  });
}
addEventListener("resize", placeMidPos);

/* History: every thread by the month it was posted, newest first, as short rows */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const postDate = (t) => t.tracks[0].shown_date || t.tracks[0].date || "";
function historyMonths() {
  const by = new Map();
  for (const t of threads.filter(isBase)) { const m = postDate(t).slice(0, 7); if (m) (by.get(m) || by.set(m, []).get(m)).push(t); }
  return [...by].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([m, list]) => ({
    id: "m-" + m, kind: "month", month: m, threads: list.sort((a, b) => (postDate(a) < postDate(b) ? 1 : -1)) }));
}
/* History thumbnails: always on; − and + change their size (remembered) */
const THUMB_SIZES = [[32, 18], [44, 25], [56, 32], [72, 40], [96, 54]];
let thumbSize = (() => { try { const v = +localStorage.getItem("nrgfm-thumb-size"); return Number.isFinite(v) && localStorage.getItem("nrgfm-thumb-size") !== null ? v : 1; } catch { return 1; } })();
function setThumbSize() {
  const [w, h] = THUMB_SIZES[thumbSize] || THUMB_SIZES[1];
  document.documentElement.style.setProperty("--mini-w", w + "px"); document.documentElement.style.setProperty("--mini-h", h + "px");
  try { localStorage.setItem("nrgfm-thumb-size", thumbSize); } catch {}
}
setThumbSize();
document.body.classList.add("hist-thumbs-on");
/* History: hovering a post with tracks under it shows them in the side space (as on Tags: only the list) */
const histPanel = el("aside", { class: "tag-panel hist-panel", hidden: true });
document.body.append(histPanel);
let histHoverT = 0, histTh = null;
function hideHistPanel() { histPanel.hidden = true; histTh = null; document.querySelectorAll(".month-row.on").forEach((r) => r.classList.remove("on")); }
function showHistPanel(th, row) {
  if (phone() || innerWidth < 966 || view !== "history" || $("#q").value.trim() || !th || th.tracks.length < 2) { hideHistPanel(); return; }
  histTh = th;
  document.querySelectorAll(".month-row.on").forEach((r) => r.classList.remove("on"));
  if (row) row.classList.add("on");
  const now = playing && playing.thread.tracks[playing.index];
  histPanel.replaceChildren(el("div", { class: "tp-p-list" }, th.tracks.map((tr, k) => { const x = info(tr); // (the main track first, in the colour of a tag's name)
    return el("button", { class: "side-row" + (k === 0 ? " side-main" : "") + (now === tr ? " playing" : "") + (x.dead ? " dead" : ""), onclick: (e) => { if (quickClick(e, th, tr)) return; play(th, k); showHistPanel(th); } },
      img(x.thumb, "side-thumb"), el("span", { class: "side-name" }, x.title)); })));
  histPanel.hidden = false;
  placeSidePanel(histPanel);
}
/* Threads (level 1, laptop): the posts opened by their date, newest on top, in the side space. A bookmarked post
   stays at the top (above the others, the newest bookmark first) until its bookmark is taken off. Kept on this device. */
const browsePanel = el("aside", { class: "tag-panel hist-panel browse-panel", hidden: true });
document.body.append(browsePanel);
const BROWSE_KEY = "nrgfm-browse", BROWSE_MAX = 300;
let browse = { seen: [], marks: [] }; // seen: post ids, newest first; marks: bookmarked post ids, newest first
try { const b = JSON.parse(localStorage.getItem(BROWSE_KEY) || "null"); if (b && Array.isArray(b.seen)) browse = { seen: b.seen, marks: Array.isArray(b.marks) ? b.marks : [] }; } catch {}
const saveBrowse = () => { try { localStorage.setItem(BROWSE_KEY, JSON.stringify(browse)); } catch {} };
function browseAdd(id) {
  if (level() !== 1 || !id) return;
  browse.seen = [id, ...browse.seen.filter((x) => x !== id)].slice(0, BROWSE_MAX);
  saveBrowse(); drawBrowse();
}
function browseMark(id) {
  browse.marks = browse.marks.includes(id) ? browse.marks.filter((x) => x !== id) : [id, ...browse.marks];
  saveBrowse(); drawBrowse();
}
const BOOKMARK_SVG = (on) => { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "18"); svg.setAttribute("height", "18"); svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4.6-6.5 4.6v-16a1 1 0 0 1 1-1z");
  p.setAttribute("fill", on ? "currentColor" : "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "1.6"); p.setAttribute("stroke-linejoin", "round");
  svg.append(p); return svg; };
function drawBrowse() {
  const byId = (id) => threads.find((t) => t.id === id && t.kind !== "tag" && isBase(t));
  const marks = browse.marks.map(byId).filter(Boolean), rest = browse.seen.filter((id) => !browse.marks.includes(id)).map(byId).filter(Boolean);
  if (level() !== 1 || !browseOn() || phone() || innerWidth < 966 || view !== "threads" || (!marks.length && !rest.length)) { browsePanel.hidden = true; return; }
  const cur = (location.hash.match(/^#t\/(.+)$/) || [])[1];
  const row = (t) => { const x = info(t.tracks[0]), on = browse.marks.includes(t.id);
    return el("div", { "data-id": t.id, class: "side-row browse-row" + (cur && decodeURIComponent(cur) === t.id ? " here" : "") + (x.dead ? " dead" : ""), role: "button", tabindex: "0",
        onclick: (e) => { if (e.target.closest(".browse-mark")) return; if (e.metaKey || e.ctrlKey) { openThreadTab(t.id); return; } goToThread(t); markThread(t.id, true); } },
      img(x.thumb, "side-thumb"),
      el("span", { class: "browse-text" }, el("span", { class: "side-name" }, x.title), el("span", { class: "browse-date" }, fmtDay(postDate(t)))),
      el("button", { type: "button", class: "browse-mark" + (on ? " on" : ""), "aria-label": on ? "Remove bookmark" : "Bookmark", "aria-pressed": String(on),
        onclick: () => browseMark(t.id) }, BOOKMARK_SVG(on))); };
  const old = browsePanel.querySelector(".tp-p-list"), y = old ? old.scrollTop : 0;
  const before = new Map(); // where each row was (to slide them from there)
  if (old && !browsePanel.hidden) for (const r of old.children) before.set(r.dataset.id, r.getBoundingClientRect().top);
  const list = el("div", { class: "tp-p-list" }, marks.map(row), rest.map(row));
  browsePanel.replaceChildren(list);
  list.scrollTop = y;
  browsePanel.hidden = false;
  placeSidePanel(browsePanel);
  fadeEnd(list);
  if (!before.size || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const r of list.children) {
    const was = before.get(r.dataset.id), now = r.getBoundingClientRect().top;
    if (was === undefined) r.animate([{ opacity: 0, transform: "translateY(-12px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" }); // the new one comes in on top
    else if (Math.abs(was - now) > 1) r.animate([{ transform: `translateY(${was - now}px)` }, { transform: "none" }], { duration: 260, easing: "ease-out" }); // the others are pushed down
  }
}
function fadeEnd(list) { // (the side list: the gap between rows so that exactly 9 fit when it's scrolled to the top, no row cut off)
  const rows = [...list.children];
  if (!rows.length) return;
  const panel = list.parentElement, max = parseFloat(panel.style.maxHeight) || panel.offsetHeight;
  const cs = getComputedStyle(list), h = rows[0].getBoundingClientRect().height;
  const room = max - (panel.offsetHeight - list.clientHeight) - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0); // (the most the list can be)
  const want = +new URLSearchParams(location.search).get("sl") === 10 ? 10 : 9; // (temporary: ?sl=10 to compare with 10)
  const n = Math.max(2, Math.min(want, Math.floor((room + 2) / (h + 2)))); // (9, or as many whole rows as a short window has room for)
  const gap = Math.max(2, (room - n * h) / (n - 1));
  list.style.setProperty("--bg-gap", gap.toFixed(2) + "px");
}
addEventListener("resize", () => drawBrowse());
function monthNode({ t }) {
  const [y, mo] = t.month.split("-");
  return el("li", { class: "month", id: "th-" + t.id },
    el("h2", { class: "month-name" }, `${MONTHS[+mo - 1]} ${y}`, el("span", { class: "month-count" }, ` · ${t.threads.length} ${t.threads.length === 1 ? "post" : "posts"}`)),
    el("ol", { class: "month-list" }, t.threads.map((th) => {
      const x = info(th.tracks[0]), n = th.tracks.length;
      const hover = phone() ? {} : { onmouseenter: (e) => { const row = e.currentTarget; clearTimeout(histHoverT); histHoverT = setTimeout(() => (n > 1 ? showHistPanel(th, row) : hideHistPanel()), 80); } };
      return el("li", { class: "month-row" + (x.dead ? " dead" : ""), ...hover }, el("div", { class: "month-line", "data-k": `${th.id}:0` },
        el("button", { class: "when-link", "data-thread": th.id, title: "Go to the thread (" + fmtDay(postDate(th)) + ")", onclick: () => goToThread(th) }, fmtDay(postDate(th)).replace(/ \d{4}$/, "")),
        el("button", { class: "play month-play", onclick: () => play(th, 0), "aria-label": `Play ${x.title}` }, img(x.thumb, "mini"), el("span", { class: "tr-title" }, x.title)),
        n > 1 ? el("button", { class: "when-link month-n", "aria-expanded": "false", title: "Show the tracks",
          onclick: (e) => { const box = e.currentTarget.closest(".month-row").querySelector(".month-tracks"), open = box.hidden;
            box.hidden = !open; e.currentTarget.setAttribute("aria-expanded", String(open)); } }, `${n} tracks`) : el("span", { class: "month-n" })),
        n > 1 ? el("ol", { class: "month-tracks", hidden: true }, th.tracks.slice(1).map((tr, k) => {
          const y = info(tr);
          return el("li", { class: y.dead ? "dead" : "", "data-k": `${th.id}:${k + 1}` },
            el("button", { class: "play month-play", onclick: () => play(th, k + 1), "aria-label": `Play ${y.title}` }, img(y.thumb, "mini"), el("span", { class: "tr-title" }, y.title)));
        })) : null);
    })));
}
/* the genre index: the biggest 40, "all 263 genres" shows the rest */
function genreIndex(items, limit) {
  const box = el("div", { class: "genre-index" },
    items.slice(0, limit).flatMap((g) => [el("button", { class: "when-link", onclick: () => jumpTo(g.id) }, g.name, el("span", { class: "gi-n" }, g.tracks.length)), " "]),
    items.length > limit ? el("button", { class: "more-toggle gi-all", onclick: () => box.replaceWith(genreIndex(items, Infinity)) }, `all ${items.length} genres`) : null);
  return box;
}
function drawViewHead() {
  const head = $("#viewHead");
  head.className = "view-head view-" + view;
  if (view === "genres") {
    head.replaceChildren(genrePicker(true)); // on a computer the cursor waits in the genre field
  } else if (view === "genreboxes") {
    const items = shown.map((x) => x.t);
    head.replaceChildren(
      genreIndex(items, 40));
  } else if (view === "mixes") {
    if (!shown.length) { head.hidden = true; return; }
    head.replaceChildren(el("p", { class: "view-note" }, "Tracks ticked as Mix in the edit card, grouped by their other tags."));
  } else if (view === "history") {
    const months = shown.map((x) => x.t), years = [...new Set(months.map((m) => m.month.slice(0, 4)))];
    const monthRow = el("div", { class: "hist-months" });
    const pickYear = (y) => {
      head.querySelectorAll(".hist-years .when-link").forEach((b) => b.classList.toggle("on", b.textContent === y));
      monthRow.replaceChildren(...MONTHS.map((name, k) => {
        const id = `m-${y}-${String(k + 1).padStart(2, "0")}`, has = months.some((m) => m.id === id);
        return el("button", { class: "when-link" + (has ? "" : " none"), disabled: !has, onclick: () => jumpTo(id) }, phone() ? String(k + 1) : name.slice(0, 3));
      }));
    };
    const size = (d) => { thumbSize = Math.max(0, Math.min(THUMB_SIZES.length - 1, thumbSize + d)); setThumbSize(); };
    const thumbsBtn = el("span", { class: "hist-size" },
      el("button", { class: "when-link", title: "Smaller thumbnails", onclick: () => size(-1) }, "−"),
      el("button", { class: "when-link", title: "Bigger thumbnails", onclick: () => size(1) }, "+"));
    const yearRow = el("div", { class: "hist-years" }, years.map((y) => el("button", { class: "when-link", onclick: () => { pickYear(y); jumpTo(months.find((m) => m.month.startsWith(y)).id); } }, y)));
    const edgeFade = () => { yearRow.classList.toggle("fade-l", yearRow.scrollLeft > 2); yearRow.classList.toggle("fade-r", yearRow.scrollLeft + yearRow.clientWidth < yearRow.scrollWidth - 2); };
    yearRow.addEventListener("scroll", edgeFade, { passive: true }); requestAnimationFrame(edgeFade);
    head.replaceChildren(yearRow, el("div", { class: "hist-months-row" }, monthRow, thumbsBtn));
    head._pickYear = pickYear;
    if (years.length) pickYear(years[0]);
  } else if (view === "activity") {
    head.replaceChildren(act.head); head.hidden = false; return;
  } else if (view === "lookup") {
    head.className = "view-head view-history view-lookup"; head.replaceChildren(lk.head); head.hidden = false; return;
  } else if (view === "tag") {
    head.className = "view-head view-tagpage"; head.replaceChildren(el("div", { class: "tp-page-head" }, drawTagPanel(true, true))); head.hidden = false; return;
  } else if (tagsView()) {
    head.className = "view-head view-tags";
    head.replaceChildren(view === "tags" ? tagGridHead() : tagPageHead()); head.hidden = false;
    if (!phone() && !tp.focused) { tp.focused = true; requestAnimationFrame(() => { const a = document.activeElement; if (!a || !a.matches("input, textarea")) head.querySelector(".tp-search .tag-input")?.focus({ preventScroll: true }); }); }
    return;
  } else if (view === "tagsold") {
    head.hidden = true; return;
  } else { head.hidden = true; return; }
  head.hidden = false;
}
/* History: the year and month you are looking at light up while you scroll */
function watchIndex() { scroller().addEventListener("scroll", () => {
  if (view !== "tags") return;
  const head = $("#viewHead"), top = head.getBoundingClientRect().bottom + 12;
  const all = [...document.querySelectorAll("#threads .tg-letter")];
  const cur = all.filter((h) => h.getBoundingClientRect().top <= top + 20).pop() || all[0];
  const k = cur ? cur.id.slice(3) : "";
  head.querySelectorAll(".tg-jump").forEach((b) => b.classList.toggle("on", b.textContent === k));
}, { passive: true }); }
function watchHistory() { scroller().addEventListener("scroll", () => {
  if (view !== "history" || $("#q").value.trim()) return;
  const head = $("#viewHead"), top = head.getBoundingClientRect().bottom + 4;
  const all = [...document.querySelectorAll("#threads > .month")];
  const cur = all.filter((m) => m.getBoundingClientRect().top <= top + 12).pop() || all[0];
  if (!cur) return;
  const [, y, mo] = cur.id.match(/m-(\d{4})-(\d{2})/);
  if (!head.querySelector(`.hist-years .on`) || head.querySelector(".hist-years .on").textContent !== y) head._pickYear(y);
  head.querySelectorAll(".hist-months .when-link").forEach((b, k) => b.classList.toggle("on", k === +mo - 1));
}, { passive: true }); }
const contentTop = () => Math.max(headerBottom(), (view === "history" || view === "activity" || view === "tags") && !$("#viewHead").hidden ? $("#viewHead").getBoundingClientRect().bottom : 0);
/* bring a thread, playlist or month on this page to the top */
function jumpTo(id) {
  const at = shown.findIndex((x) => x.t.id === id);
  if (at < 0) return;
  while (rendered <= at && rendered < shown.length) renderMore();
  const node = document.getElementById("th-" + id);
  if (!node) return;
  holdAt(node, () => contentTop() + 8);
}
/* uBlock Origin Lite for this browser (iPhone/iPad and Safari: the App Store app) */
function ublockUrl() {
  const ua = navigator.userAgent, apple = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const url = /Firefox|FxiOS/.test(ua) && !apple ? "https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/"
    : apple || (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) ? "https://apps.apple.com/de/app/ublock-origin-lite/id6745342698"
    : "https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh?hl=en";
  return url;
}
const openUblock = () => open(ublockUrl(), "_blank", "noopener");
$('#menu [data-view="ublock"]').href = ublockUrl();
function setView(v, keepHash) {
  setTimeout(() => (document.body.dataset.view = view), 0);
  if (v === "ublock") { // first press: "Confirm"; the second opens the store
    const b = $('#menu [data-view="ublock"]');
    if (b.dataset.confirm) { clearTimeout(b._t); delete b.dataset.confirm; b.textContent = "uBlock Origin Lite"; openUblock(); }
    else { b.style.minWidth = b.getBoundingClientRect().width + "px"; b.dataset.confirm = "1"; b.textContent = "Confirm"; b._t = setTimeout(() => { delete b.dataset.confirm; b.textContent = "uBlock Origin Lite"; }, 5000); }
    return;
  }
  if (v === "random") { // a random thread, at the top of the page with the divider above it still in view
    const b = $('#menu [data-view="random"]'); b.classList.add("flash"); setTimeout(() => b.classList.remove("flash"), 350);
    const menuH = $("#menu").hidden ? 0 : $("#menu").getBoundingClientRect().height; // the open menu covers the top
    if (view === "tagged") { randomTagged(22 + menuH); return; }
    const base = threads.filter(isBase); goToThread(base[Math.floor(Math.random() * base.length)], 22 + menuH); return;
  }
  const from = view;
  view = VIEW_NAMES[v] ? v : "threads";
  if (!viewAllowed(view)) view = "threads"; // (a page this level can't open)
  document.body.dataset.view = view; // now, before the page is drawn (set a moment later, the new page showed for one frame with the old page's sizes)
  setTimeout(updateTitle, 0);
  if (view === "tags" && from !== "tags") { // Index: a fresh start, unless coming back from a tag's page opened from it
    const back = from === "tag" && tp.returnTo;
    tp.terms = back ? back.terms : []; tp.q = back ? back.q : "";
    tp.restoreY = back ? back.y : null;
  }
  if (!tagsView()) hideTagPanel();
  tp.focused = false; // (opening Tags puts the cursor in its search field)
  if (!keepHash) history.replaceState(null, "", view === "threads" ? location.pathname : view === "tag" ? "#/tag/" + encodeURIComponent(tagPageName) : "#/" + (HASH_OF[view] || view));
  document.querySelectorAll("#menu [data-view]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === view || (view === "lookup" && b.dataset.view === "activity"))));
  preSearch = null; $("#q").value = ""; syncClear();
  runSearch(); pageScrollTo(0);
  if (view === "tags" && tp.restoreY != null) { const y = tp.restoreY; tp.restoreY = null; requestAnimationFrame(() => pageScrollTo(y)); }
}
function toggleMenu(open = $("#menu").hidden) {
  if (open && !$("#addPanel").hidden) closeAddForm($("#addPanel").querySelector("form"));
  $("#menu").hidden = !open; $("#home").setAttribute("aria-expanded", String(open));
  document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");
}
addEventListener("hashchange", () => { // back/forward and links between pages
  const tg = location.hash.match(/^#\/tag\/(.+)$/);
  if (tg) { tagPageName = decodeURIComponent(tg[1]); setView("tag", true); return; }
  const page = location.hash.match(/^#\/(\w+)/), pv = page && (VIEW_OF[page[1]] || page[1]);
  if (page && HASH_OF[page[1]]) history.replaceState(null, "", location.hash.replace("#/" + page[1], "#/" + HASH_OF[page[1]])); // (an old #/tagged link: shown as #/archive)
  if (page && VIEW_NAMES[pv] && pv !== view) setView(pv, true);
  else if (!location.hash && view !== "threads") setView("threads", true);
});
$("#menu").addEventListener("click", (e) => {
  const b = e.target.closest("#menu [data-view]"); // (not the page itself: <body> has a data-view too)
  if (!b) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return; // Ctrl/Cmd+click: the browser opens it in a new tab
  e.preventDefault();
  if (VIEW_NAMES[b.dataset.view] || (phone() && b.dataset.view === "random")) toggleMenu(false); // a page closes the menu (phone: Random too)
  if (b.dataset.view === "tags") tagsByLatest = false; // (Tags opens A–Z)
  setView(b.dataset.view);
});
/* scrolling the page closes the menu; the page is moved back by the menu's height, so nothing jumps */
let keepMenuUntil = 0; // (a size change moves the page a little: that doesn't close the menu)
function closeMenuByScroll() {
  if ($("#menu").hidden || Date.now() < keepMenuUntil) return;
  const h = $(".top").getBoundingClientRect().height;
  toggleMenu(false);
  const dh = h - $(".top").getBoundingClientRect().height;
  if (dh > 0) pageScrollBy(-dh);
}
addEventListener("wheel", (e) => { if (!e.target.closest(".top")) closeMenuByScroll(); }, { passive: true });
addEventListener("touchmove", (e) => { if (!e.target.closest(".top")) closeMenuByScroll(); }, { passive: true });

/* ---------- rendering: every thread is shown open ---------- */
const img = (src, cls) => src
  ? el("img", { class: cls, src, alt: "", loading: "lazy", decoding: "async", onerror: (e) => e.target.classList.add("broken") })
  : el("span", { class: cls + " empty" });

/* tags under a title; clicking one searches for it */
const HIDDEN_TAGS = new Set(); // (none now: "mix" is an ordinary tag again)
/* which tags this visitor sees (see level()): 1 and 2 all; 3 no playlists and no automatic tags; 4 none */
function tagVisible(g, lv = level()) {
  if (HIDDEN_TAGS.has(g) || lv >= 4) return false;
  if (isAutoTag(g) || isPlaylist(g)) return lv <= 2;
  return true;
}
const shownTags = (tr) => Object.keys(tr.tags || {}).filter((g) => tagVisible(g));
function tagLine(tr, extra, list) {
  const all = list || shownTags(tr), tags = all.filter((g) => !isPlaylist(g) && !/ characters$/.test(g)); // (the "… characters" tags: only on the Tags page)
  const pl = !list && all.some(isPlaylist); // in a playlist: only PL_MARK under the track (the names show in the Edit card)
  return [el("span", { class: "tag-wrap" }, tags.map((g) => el("span", { class: "tag" + (g === "duplicate" ? " tag-dup" : "") + (isAutoTag(g) ? " tag-auto" : "") }, g)), pl ? el("span", { class: "tag tag-pl" }, PL_MARK) : null), extra ? el("span", { class: "sub-note" }, extra) : null];
}
/* phone search: touching the page outside a result that scrolls makes it stop scrolling (the page scrolls again) */
document.addEventListener("touchmove", (e) => {
  if (!phone() || !activeId || !$("#q").value.trim()) return;
  const node = document.getElementById("th-" + activeId);
  if (!node || !node.querySelector(".scroll-list") || node.contains(e.target) || e.target.closest(".dock, .top")) return;
  setActive(null);
}, { passive: true });
/* computer: clicking a track's "duplicate" tag searches for its title (without "(Official Video)" and the like), so the
   threads it was posted in show together */
const coreTitle = (title) => title.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, " ").replace(/\b(19|20)\d\d\b/g, " ").replace(/[^\p{L}\p{N}&']+/gu, " ").replace(/\s+/g, " ").trim();
document.addEventListener("click", (e) => {
  const tag = e.target.closest && e.target.closest(".tag.tag-dup");
  if (!tag || phone() || e.metaKey || e.ctrlKey) return;
  const row = tag.closest("[data-k]"), at = row && trackAt(row.dataset.k);
  if (!at || (row.nextElementSibling && row.nextElementSibling.classList.contains("edit-wrap"))) return; // (editing: the tag is being removed)
  e.preventDefault(); e.stopPropagation();
  const group = duplicatesOf(at.tr), q = coreTitle(info(at.tr).title);
  dupFilter = group.size > 1 ? { q: fold(q), ids: group } : null;
  searchFor(q);
}, true);
/* the tracks the automatic "duplicate" tag counts as copies of this one: the same link (same YouTube video), or the same
   title once "(Official Video)", years and punctuation are left out */
const DUP_NOISE = /[\(\[][^\)\]]*\b(official|lyric|lyrics|audio|video|hd|hq|4k|remaster(ed)?|visuali[sz]er|explicit|clip|music video|mv|full album|out now|premiere)\b[^\)\]]*[\)\]]/gi;
function dupTitleKey(tr) {
  const m = meta[tr.url] || {};
  let t = (tr.title || m.title || m.wb_title || "").toLowerCase();
  if (t.includes(" · ")) { const [a, b] = t.split(" · "); t = b + " - " + a; }
  return fold(t.replace(DUP_NOISE, " ").replace(/\b(19|20)\d\d\b/g, " "));
}
function dupLinkKey(tr) {
  if (!tr.url) return "id:" + tr.id;
  if (tr.yt) return "yt:" + tr.yt;
  return "u:" + tr.url.trim().toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/, "").split("#")[0].replace(/\/$/, "").replace(/[?&](si|feature|utm_[a-z]+)=[^&]*/g, "");
}
function duplicatesOf(tr) {
  const lk = dupLinkKey(tr), tk = dupTitleKey(tr), ids = new Set([tr.id]);
  for (const t of threads) if (isBase(t)) for (const x of t.tracks) if (dupLinkKey(x) === lk || (tk.length >= 6 && dupTitleKey(x) === tk)) ids.add(x.id);
  return ids;
}
let dupFilter = null; // {q, ids}: the search shows exactly these tracks (cleared when the search changes)
/* a post's date (and "source" in the player): Cmd+click (Ctrl+click on Windows) opens that thread in a new tab */
const openThreadTab = (id) => open(location.pathname + "#t/" + encodeURIComponent(id), "_blank");
const markThread = (id, fromBrowse) => { // the address remembers the post (a reload comes back to it); Backspace too, also from other pages
  history.replaceState(null, "", location.pathname + "#t/" + encodeURIComponent(id));
  try { sessionStorage.setItem("nrgfm-last-post", id); } catch {}
  if (fromBrowse) drawBrowse(); else browseAdd(id); // (opened from the side list: it keeps its place there)
};
/* Backspace (not while typing): back to the post in the address, or the last one that was there before going to
   another page; the address points at it again. (Cmd+Esc was tried: on a Mac it doesn't reach the page.) */
addEventListener("keydown", (e) => {
  if (e.key !== "Backspace" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
  if (e.target.closest && e.target.closest("input:not([type=range]), textarea, select, [contenteditable]")) return;
  const m = location.hash.match(/^#t\/(.+)$/);
  let id = m ? m[1] : null; try { id = id ? decodeURIComponent(id) : sessionStorage.getItem("nrgfm-last-post"); } catch {}
  const t = id && threads.find((x) => x.id === id && x.kind !== "tag" && isBase(x));
  freshIfNewer(); // (also: what was changed in another tab or on another device shows up, without a reload)
  if (!t) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const node = view === "threads" && !$("#q").value && document.getElementById("th-" + t.id);
  if (node) pageScrollBy(node.getBoundingClientRect().top - (headerBottom() + 22), true); // already on the page: glide there (as double Esc does)
  else { if (view !== "threads") setView("threads"); goToThread(t); }
  markThread(t.id);
});
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-thread]");
  if (!b) return;
  if (e.metaKey || e.ctrlKey) { e.preventDefault(); e.stopPropagation(); openThreadTab(b.dataset.thread); return; }
  setTimeout(() => markThread(b.dataset.thread), 0); // (after the page has gone there)
}, true);
/* on a Mac, Ctrl+click is a right-click (no "click" event), and the middle button is an "auxclick": both open the thread in a new tab too */
function threadOf(target) {
  if (!target.closest) return null;
  const b = target.closest("[data-thread]");
  if (b) return b.dataset.thread;
  if (target.closest("#sourceBtn") && playing) { const home = homeOf(playing.thread.tracks[playing.index]); return home ? home.id : null; }
  return null;
}
document.addEventListener("contextmenu", (e) => {
  if (!e.ctrlKey) return;
  const id = threadOf(e.target);
  if (id) { e.preventDefault(); openThreadTab(id); }
}, true);
document.addEventListener("auxclick", (e) => {
  if (e.button !== 1) return;
  const id = threadOf(e.target);
  if (id) { e.preventDefault(); openThreadTab(id); }
}, true);
function searchFor(text) { $("#q").value = text; syncClear(); runSearch(); pageScrollTo(0); }
const fmtDay = (d) => { const [y, mo, da] = (d || "").split("-"); return y ? `${+da} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+mo - 1]} ${y}` : ""; };
const RECOVERED = "title recovered from Internet Archive";

function trackRow(t, tr, i, hits) {
  const x = info(tr);
  const chip = img(x.thumb, "chip"); chip.addEventListener("click", () => play(t, i)); chip.style.cursor = "pointer"; // (the thumbnail plays it too)
  const wholeRow = (view === "threads" || view === "tagged" || view === "tag") && !phone(); // Threads, Archive, a tag's page (computer): anywhere on the row plays it (not its buttons, links or tags)
  return el("li", { class: ["track", x.dead && "dead", hits && hits.has(i) && "hit", wholeRow && "row-plays"].filter(Boolean).join(" "), "data-k": `${t.id}:${i}`,
    onclick: wholeRow ? (e) => { if (e.target.closest("button, a, input, .tag, .chip, .edit-wrap, form")) return; play(t, i); } : null },
    chip,
    el("button", { class: "play", onclick: () => play(t, i), "aria-label": `Play ${x.title}` },
      el("span", { class: "tr-title" }, x.title, (view === "tag" || view === "tagged" || view === "threads") && !query && lenOf(tr) ? el("span", { class: "tr-len" }, fmtTime(lenOf(tr))) : null),
      el("span", { class: "tr-sub" }, tagLine(tr, x.recovered ? RECOVERED : null, t.mix ? genresOf(tr) : null))),
    rowLinks(t, i, x));
}

/* right side of a row: "Edit" (only on a device with a key) and the platform link */
function rowLinks(t, i, x) {
  const tr = t.tracks[i];
  const findable = (x.dead && x.title !== "Unavailable") || x.nolink; // (a track without a link: look its title up on YouTube)
  return el("span", { class: "row-links" },
    el("button", { class: "linkbtn edit-btn", onclick: (e) => toggleEditForm(t, i, e.currentTarget.closest("[data-k]")) }, "Edit"),
    findable ? el("a", { class: "src find-yt", href: "https://www.youtube.com/results?search_query=" + encodeURIComponent(x.title), target: "_blank", rel: "noopener" }, "Search") : null,
    x.nolink ? null : x.archive
      ? el("a", { class: "src", href: x.archive, target: "_blank", rel: "noopener" }, "Archive")
      : el("a", { class: "src", href: tr.url, target: "_blank", rel: "noopener" }, PLATFORM[tr.platform] || "Open"));
}

/* A tag is shown as its own thread: a blue "tag" box, the tag's name, and its first 8 tracks
   (Expand shows all of them). */
const TAG_PREVIEW = 5;
const SEARCH_AROUND = 5;       // in search results: 5 replies, the hit in the middle
const threadLimit = () => Infinity; // a thread always shows all its tracks (no Expand; it used to come after 30, or 20 on a phone)
const expanded = new Set();    // threads opened with Expand
const scrollOn = new Set();    // search results whose list was switched to scrolling
const fixedRows = new Map();   // phone: the window kept after playing from a scrolled result
const userToggled = new Set();

const phone = () => window.matchMedia("(max-width: 640px)").matches;
/* iPhone: the page scrolls inside the body instead of the window, so the browser's bars don't pop up and down */
const INNER_SCROLL = (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) && phone();
if (INNER_SCROLL) document.documentElement.classList.add("inner-scroll");
if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) document.documentElement.classList.add("ios");
if (window.matchMedia("(max-width: 400px)").matches) $("#q").placeholder = "Artist, title or tag"; // small phones: it all fits
const scroller = () => (INNER_SCROLL ? document.body : window);
const pageScrollBy = (y, smooth) => scroller().scrollBy({ top: y, behavior: smooth ? "smooth" : "auto" });
const pageScrollTo = (y) => scroller().scrollTo({ top: y, behavior: "auto" });
const pageY = () => (INNER_SCROLL ? document.body.scrollTop : scrollY);
/* keep a node at a spot under the header while things above it settle: the position is set absolutely each frame
   (never added to), and it stops once it has stayed put for a few frames */
function holdAt(node, offset) {
  let frames = 0, still = 0;
  const step = () => {
    if (!node.isConnected) return;
    const dy = node.getBoundingClientRect().top - offset();
    if (Math.abs(dy) > 1) { pageScrollTo(pageY() + dy); still = 0; } else still++;
    if (++frames < 90 && still < 8) requestAnimationFrame(step);
  };
  step();
}
/* bring an element fully into view (between the header and the player), moving as little as possible */
function revealWhole(node, smooth = true) {
  const r = node.getBoundingClientRect(), top = headerBottom() + 8;
  const bottom = innerHeight - (dockH()) - 8;
  let dy = 0;
  if (r.bottom > bottom) dy = r.bottom - bottom;
  if (r.top - dy < top) dy = r.top - top; // too tall: show its top
  if (dy) pageScrollBy(dy, smooth);
}
const headerBottom = () => $(".top").getBoundingClientRect().bottom;
const btn = (cls, label, fn) => el("button", { class: "more-toggle " + cls, onclick: fn }, label);

/* A box that scrolls inside the page only scrolls once its thread is selected: click anywhere in it, play one
   of its tracks or press Expand. Collapse unselects it. Until then the wheel scrolls the page. */
let activeId = null, addingId = null; // the selected thread; the thread with an open "Add a track here" card
function setActive(id, clickedK) {
  const before = activeId;
  activeId = id;
  document.querySelectorAll(".thread.active").forEach((n) => n.classList.remove("active"));
  if (id) document.getElementById("th-" + id)?.classList.add("active");
  // search results: unselected they show the hits grouped (padded to 5); selected, the whole thread in order
  for (const x of new Set([before, id])) {
    if (!x || !$("#q").value.trim()) continue;
    const entry = shown.find((e) => e.t.id === x && e.hits);
    const node = document.getElementById("th-" + x);
    if (!entry || !node || expanded.has(x)) continue;
    const old = node.querySelector(".tracks");
    if (x === id && old) keptHeight.set(x, old.getBoundingClientRect().height); // the box keeps its height
    // the first track on screen stays where it is when the box starts scrolling (no jump)
    const oldTop = old ? old.getBoundingClientRect().top : 0;
    const first = old && [...old.querySelectorAll(":scope > li.track")].find((r) => r.getBoundingClientRect().bottom > oldTop + 2);
    const firstK = first && first.dataset.k, firstAt = first ? first.getBoundingClientRect().top - oldTop : 0;
    const fresh = rerenderKeep(entry.t, entry.hits);
    if (fresh) fitList(fresh);
    const same = x === id && firstK && fresh && fresh.querySelector(`.scroll-list [data-k="${CSS.escape(firstK)}"]`);
    if (same) { const box = same.closest(".scroll-list"); box.dataset.centred = "1"; box.scrollTop += same.getBoundingClientRect().top - box.getBoundingClientRect().top - firstAt; }
    const row = x === id && clickedK && fresh && fresh.querySelector(`.scroll-list [data-k="${CSS.escape(clickedK)}"]`);
    if (row) { const box = row.closest(".scroll-list"); if (row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop; }
  }  requestAnimationFrame(fadeAll); // the fades come back when a result is unselected again
}
const searchLaptop = () => !phone() && !!$("#q").value.trim(); // (computer, searching: a click doesn't select a result)
const selectable = (th) => !th.classList.contains("genre-mix") && (th.querySelector(".scroll-list") || (th.classList.contains("searching") && th.querySelector(".tracks")));
document.addEventListener("click", (e) => {
  if (!e.target.closest || e.target.closest(".dock, .edit-btn, .add-form, .edit-wrap, .scroll-link")) return;
  if ((e.metaKey || e.ctrlKey) && !phone()) return; // Cmd+click: the quick tag field, nothing gets selected // the player, editing and the phone's Scroll counter (it does its own) leave it as it is
  if (addingId) return; // adding a track: stays selected until the card closes
  const th = e.target.closest("#threads > .thread");
  if (th && th.classList.contains("active") && e.target.closest("button, a")) return; // playing, matches, links: stays selected
  const k = e.target.closest("[data-k]")?.dataset.k;
  if (th && selectable(th) && !th.classList.contains("active") && !searchLaptop()) setActive(th.id.slice(3), k); // select (and unselect another)
  else if (activeId) setActive(null); // a click in the selected box or anywhere else unselects
}, true);
document.addEventListener("wheel", (e) => {
  // computer: scrolling with the pointer outside the selected box unselects it (its list stops scrolling)
  if (activeId && !phone() && e.target.closest && !e.target.closest(".thread.active, .dock, .top, .side, .quick-drop, .move-pop")) {
    const a = document.getElementById("th-" + activeId);
    if (a && !a.querySelector(".edit-wrap, .add-form")) setActive(null);
  }
  // inside a selected box but not over its list (the name, the thumbnail, the counter): scroll the list anyway
  const sel = e.target.closest && e.target.closest(".thread.active");
  const selList = sel && sel.querySelector(".scroll-list");
  const fits = selList && selList.scrollHeight <= selList.clientHeight + 1; // nothing to scroll to: the page scrolls
  if (selList) selList.classList.toggle("no-overflow", !!fits);
  if (sel && !fits && !selList.classList.contains("open") && !sel.querySelector(".edit-wrap") && !e.target.closest(".scroll-list, .add-form, .edit-wrap")) { // (an expanded box leaves the page scrolling)
    e.preventDefault(); selList.scrollBy(0, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY); return;
  }
  const box = e.target.closest && e.target.closest(".scroll-list");
  if (!box || box.closest(".thread").classList.contains("active") || box.querySelector(".edit-wrap") || box.closest(".genre-mix")) return; // selected, editing in it, or the Genres playlist
  e.preventDefault();
  scroller().scrollBy(0, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY);
}, { passive: false });

function rerenderKeep(t, hits) {
  const node = document.getElementById("th-" + t.id);
  if (!node) return null;
  const fresh = threadNode({ t, hits });
  node.replaceWith(fresh);
  markPlaying();
  return fresh;
}
const keepDrawn = new Map();
function toggleExpand(t, hits) {
  userToggled.add(t.id);
  const wasOpen = expanded.has(t.id);
  const oldList = document.querySelector(`#th-${CSS.escape(t.id)} .scroll-list`), keep = oldList ? oldList.scrollTop : 0;
  if (oldList) keepDrawn.set(t.id, oldList.children.length); // playlists drawn in batches: draw as far again
  wasOpen ? expanded.delete(t.id) : expanded.add(t.id);
  const fresh = rerenderKeep(t, hits);
  if (!fresh) return;
  if (wasOpen) { setActive(null); pageScrollBy(fresh.getBoundingClientRect().top - headerBottom() - 8); } // collapsed: the thread at the top
  else {
    setActive(t.id);
    if (searchLaptop()) { const n = document.getElementById("th-" + t.id); if (n) { n.classList.remove("frame-fade"); void n.offsetWidth; n.classList.add("frame-fade"); } } // (search: the frame shows, then fades)
  }
  fitList(fresh, !wasOpen);
  if (!wasOpen && hits && phone()) { // phone search: the whole thread, its main track at the top
    pageScrollBy(fresh.getBoundingClientRect().top - headerBottom() - 8);
    return;
  }
  if (!wasOpen && hits && t.tracks.length > threadLimit()) pageScrollBy(fresh.getBoundingClientRect().top - headerBottom() - 8); // long thread: at the top
  const list = fresh.querySelector(".scroll-list"); // carry on from where you were in the list
  if (list && keep) { list.scrollTop = keep; fresh.querySelector(".scroll-list").dataset.centred = "1"; updateListPos(fresh); }
}
const keptHeight = new Map(); // search results: Scroll keeps the box as tall as it was
/* "2 matches" in a selected result: the next match goes to the top of the box */
function nextMatch(node) {
  node = node && document.getElementById(node.id); // the first press re-draws the result (it gets selected)
  const list = node && node.querySelector(".scroll-list"); // (the page stays where it is)
  if (!list) return;
  const hs = [...list.querySelectorAll(":scope > li.track.hit")];
  const at = (h) => h.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop; // inside the box
  const cur = +(list.dataset.match ?? -1);
  const k = cur >= 0 && cur < hs.length - 1 ? cur + 1 : 0; // each press: the next match, then round again
  const next = hs[k];
  if (!next) return;
  list.dataset.match = k;
  list.scrollTo({ top: Math.max(0, at(next) - (list.clientHeight - next.offsetHeight) / 2), behavior: "smooth" }); // in the middle of the box
  hs.forEach((h) => h.classList.toggle("match-now", h === next));
}
function toggleScroll(t, hits) {
  setActive(t.id);
  const old = document.querySelector(`#th-${CSS.escape(t.id)} .tracks`);
  if (old && !scrollOn.has(t.id)) keptHeight.set(t.id, old.getBoundingClientRect().height);
  scrollOn.has(t.id) ? scrollOn.delete(t.id) : scrollOn.add(t.id);
  fixedRows.delete(t.id);
  const fresh = rerenderKeep(t, hits);
  if (fresh) fitList(fresh);
}

/* Expanded: the thread moves to the top of the window and its list fills the rest of it
   (down to the player) and scrolls inside. Collapsed boxes on a laptop show a few tracks and
   scroll for the rest. The counter follows the scrolling. */
/* phone: a selected search result that scrolls shows its own scroll bar all the time (the iPhone's only shows while
   moving), so you can see which way there is more */
function scrollIndicator(node, list) {
  node.querySelector(":scope > .scroll-ind")?.remove();
  if (!phone() || !node.classList.contains("active") || list.scrollHeight <= list.clientHeight + 2) { list._ind = null; return; }
  const thumb = el("span", { class: "scroll-ind-thumb" }), bar = el("span", { class: "scroll-ind", "aria-hidden": "true" }, thumb);
  node.append(bar);
  list._ind = () => {
    if (!bar.isConnected) return;
    const nr = node.getBoundingClientRect(), lr = list.getBoundingClientRect();
    bar.style.top = lr.top - nr.top + "px"; bar.style.height = lr.height + "px";
    const h = Math.max(24, lr.height * list.clientHeight / list.scrollHeight);
    thumb.style.height = h + "px";
    thumb.style.transform = `translateY(${(lr.height - h) * list.scrollTop / Math.max(1, list.scrollHeight - list.clientHeight)}px)`;
  };
  list.addEventListener("scroll", list._ind, { passive: true });
  list._ind();
}
function fitList(node, scroll) {
  if (!node) return;
  if (!document.querySelector(".scroll-list.open")) { $("main").style.minHeight = ""; document.body.style.minHeight = ""; } // nothing open: no extra room
  const list = node.querySelector(".scroll-list");
  if (!list || !list.children.length) return;
  if (node.classList.contains("genre-mix")) { list.style.maxHeight = ""; fitMix(node); return; } // the Genres playlist sizes itself
  requestAnimationFrame(() => updateFade(list));
  if (!list.classList.contains("open")) {
    const rows = [...list.querySelectorAll(":scope > li.track")];
    const last = rows[Math.min(rows.length, +list.dataset.show || TAG_PREVIEW) - 1];
    const id = node.id.slice(3);
    if (keptHeight.has(id) && node.classList.contains("searching")) list.style.maxHeight = keptHeight.get(id) + "px";
    else if (last) list.style.maxHeight = last.offsetTop + last.offsetHeight + 4 + "px";
    const hitsIn = list.querySelectorAll(":scope > li.track.hit"), focus = hitsIn[0];
    if (focus && list.dataset.centred !== "1") { // search: one hit in the middle, several: the first at the top
      list.dataset.centred = "1";
      list.scrollTop = hitsIn.length > 1 ? focus.offsetTop : focus.offsetTop - (list.clientHeight - focus.offsetHeight) / 2;
    }
    updateListPos(node);
    return;
  }
  // open: the box goes right under the header and its list reaches down to the lowest point of the screen that is
  // surely visible (see visibleBottom), with the same small gap above and below. Worked out in one go: the place the
  // list will have once the box is at the top, then the page is scrolled there (instantly, no animation).
  const GAP = 8;
  const below = node.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom; // Collapse, Add a track…
  const listOffset = list.getBoundingClientRect().top - node.getBoundingClientRect().top;  // the box's top to its list
  const top = scroll ? headerBottom() + GAP : node.getBoundingClientRect().top;             // where the box will be
  const h = Math.max(200, visibleBottom() - GAP - (top + listOffset) - below) + "px";
  list.style.maxHeight = h;
  // (a playlist with few tracks keeps just their height: no stretching to the bottom)
  if (scroll) {
    const room = INNER_SCROLL ? $("main") : document.body; // room to scroll that far even near the end of the page
    room.style.minHeight = (INNER_SCROLL ? document.body.scrollHeight : document.documentElement.scrollHeight) + innerHeight + "px";
    scroller().scrollTo({ top: pageY() + node.getBoundingClientRect().top - top, behavior: "instant" });
  }
  updateListPos(node);
}
/* the lowest point of the screen that is surely visible: the smallest of the window, the visual viewport and the
   "small viewport" (the iPhone's browser bars showing), above the iPhone's home bar and the player */
const vbProbe = el("div", { style: "position:fixed;left:0;top:0;width:0;height:100vh;height:100svh;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none", "aria-hidden": "true" });
document.body.append(vbProbe);
function visibleBottom() {
  const inset = parseFloat(getComputedStyle(vbProbe).paddingBottom) || 0, svh = vbProbe.getBoundingClientRect().height; // (border-box: the padding is inside)
  const vv = window.visualViewport ? visualViewport.height : innerHeight;
  const dock = $("#dock").hidden ? inset : dockH(); // the player already keeps clear of the home bar
  return Math.min(innerHeight, vv, svh) - dock;
}
function updateListPos(node) {
  const list = node.querySelector(".scroll-list"), pos = node.querySelectorAll(".more-pos");
  if (!list || !pos.length) return;
  const offset = list.classList.contains("tracks") ? 1 : 0; // a track thread's main post is number 1
  const rows = [...list.children].filter((r) => r.matches("li.track")), top = list.scrollTop, bottom = top + list.clientHeight;
  let first = 0, last = 0;
  rows.forEach((r, k) => { if (r.offsetTop + r.offsetHeight > top && !first) first = k + 1; if (r.offsetTop < bottom) last = k + 1; });
  const total = +list.dataset.total || rows.length + offset;
  const n = offset && top < 4 ? 1 : (first || 1) + offset, text = `${n} of ${total}`;
  pos.forEach((p) => { // a split counter keeps "of" in place: the numbers change on either side of it
    if (p.classList.contains("pos-split")) { p.querySelector(".pos-a").textContent = n; p.querySelector(".pos-b").textContent = total; }
    else p.textContent = text;
  });
  if (list._ind) list._ind();
}
addEventListener("resize", () => {
  document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");
  document.querySelectorAll(".scroll-list").forEach((l) => fitList(l.closest(".thread")));
});
document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");
new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", $(".top").getBoundingClientRect().height + "px")).observe($(".top"));

/* A tag: its name, track count, Expand and counter on the left, the newest tagged tracks on the right,
   all inside one frame. */
function tagThreadNode({ t, hits }) {
  const open = expanded.has(t.id), n = t.tracks.length, many = n > TAG_PREVIEW;
  // on a laptop every track is in the list (5 visible, scroll for more); on a phone only 5 until Expand
  const all = open || !phone();
  // big playlists (Genres) draw their rows a batch at a time while you scroll, so the page stays quick
  const BATCH = 50;
  let drawn = all ? Math.min(n, Math.max(BATCH, keepDrawn.get(t.id) || 0)) : Math.min(n, TAG_PREVIEW);
  const rows = t.tracks.slice(0, drawn).map((tr, i) => trackRow(t, tr, i, hits));
  const scrolls = many && all;
  const list = el("ol", { class: "tag-list" + (scrolls ? " scroll-list" : "") + (open ? " open" : ""), "data-show": TAG_PREVIEW, "data-total": n }, rows);
  if (all && drawn < n) list.addEventListener("scroll", () => {
    if (drawn >= n || list.scrollTop + list.clientHeight < list.scrollHeight - 400) return;
    const more = t.tracks.slice(drawn, drawn + BATCH).map((tr, k) => trackRow(t, tr, drawn + k, hits));
    drawn += more.length; list.append(...more); markPlaying();
  }, { passive: true });
  const pos = () => el("span", { class: "more-pos" }, `1 of ${n}`);
  const node = el("li", { class: "thread tag-thread framed" + (open ? " expanded" : "") + (t.id === activeId ? " active" : ""), id: "th-" + t.id },
    el("div", { class: "tag-frame" },
      el("div", { class: "tag-side" },
        el("div", { class: "tag-label" },
          el("span", { class: "tag-name" }, t.name),
          el("span", { class: "tag-count" }, `${n} ${n === 1 ? "track" : "tracks"}`),
          many ? pos() : null),
        many ? el("div", { class: "tag-more" }, pos(), btn("", open ? "Collapse" : "Expand", () => toggleExpand(t, hits))) : null),
      list));
  if (scrolls) {
    list.addEventListener("scroll", () => updateListPos(node), { passive: true });
    requestAnimationFrame(() => fitList(node));
  }
  return node;
}

/* Search results: the hits next to each other, padded with the tracks around them to 5 replies.
   More than 5 hits: all hits, no padding. Returns reply indices (1 = first reply). */
function searchRows(t, hits) {
  const n = t.tracks.length, found = [...hits].filter((i) => i > 0).sort((x, y) => x - y);
  if (found.length > SEARCH_AROUND) return found;
  if (!found.length) return range(1, Math.min(n, 1 + SEARCH_AROUND));
  // the hits plus the replies closest to them, up to 5 (one pass, no loop that could get stuck)
  const dist = (i) => Math.min(...found.map((h) => Math.abs(i - h)));
  return range(1, n)
    .sort((x, y) => dist(x) - dist(y) || x - y)
    .slice(0, Math.min(SEARCH_AROUND, n - 1))
    .sort((x, y) => x - y);
}
const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);

/* search as a list: one found track, laid out as in Archive (bigger thumbnail, the post's date over it) */
function resultItemNode(t, i) {
  return el("li", { class: "thread tagged-thread result-item", id: "th-" + t.id + "-" + i },
    el("div", { class: "tg-when" }, el("button", { class: "when-link", "data-thread": t.id, onclick: () => goToThread(t) }, fmtDay(t.tracks[0].shown_date || t.tracks[0].date))),
    el("ol", { class: "tracks tg-tracks" }, trackRow(t, t.tracks[i], i, new Set([i])))); // (highlighted as found, as in the posts view)
}
const forcedRank = (s, tr, terms) => (dupFilter && dupFilter.q === query ? 0 : matchRank(tr, terms));
/* a track with one of the group's own tags (the automatic ones don't count) */
const userTagged = (tr) => shownTags(tr).some((g) => !isAutoTag(g));
/* Tagged: a thread as only its tagged tracks (bigger thumbnails) */
function taggedNode(t) {
  const rows = [];
  t.tracks.forEach((tr, i) => {
    if (userTagged(tr)) rows.push(trackRow(t, tr, i, null));
  });
  if (view === "tag") return el("li", { class: "thread tagged-thread tagpage-thread", id: "th-" + t.id }, el("ol", { class: "tracks tg-tracks" }, t.tracks.map((tr, i) => trackRow(t, tr, i, null)))); // (a tag's page: all its tracks)
  const head = t.tracks[0];
  return el("li", { class: "thread tagged-thread", id: "th-" + t.id },
    el("div", { class: "tg-when" }, el("button", { class: "when-link", "data-thread": t.id, onclick: () => { setView("threads"); setTimeout(() => goToThread(t), 0); } }, fmtDay(head.shown_date || head.date))),
    el("ol", { class: "tracks tg-tracks" }, rows));
}
function threadNode({ t, hits, one }) {
  if (one != null) return resultItemNode(t, one); // search as a list: one found track, as in Archive
  if (t.kind === "shufpart") return shufflePartNode(t);
  if ((view === "tagged" && !hits && t.kind === "thread") || (view === "tag" && !hits && t.kind === "tag")) return taggedNode(t);
  if (t.kind === "month") return monthNode({ t });
  if (t.mix) return genreMixNode(t);
  if (t.kind === "tag") return tagThreadNode({ t, hits });
  const n = t.tracks.length, limit = threadLimit(), mobile = phone();
  const long = n > limit, open = expanded.has(t.id) && (long || !!hits);
  const searching = !!hits && !open && n - 1 > SEARCH_AROUND; // results: hits with a few tracks around them
  const scrolling = searching && activeId === t.id; // selected: the whole thread in a box that scrolls
  const peek = new Set();
  let idx, listCls = "tracks", show = long ? TAG_PREVIEW : limit - 1; // long threads show 5, like tags
  const addingHere = addingId === t.id && !hits && !long && n - 1 > TAG_PREVIEW; // adding a track here: 5 replies in a box
  if (addingHere) { idx = range(1, n); listCls += " scroll-list"; show = TAG_PREVIEW; }
  else if (open && hits && mobile) { idx = range(1, n); }                     // phone search: the whole thread
  else if (open && long) { idx = range(1, n); listCls += " scroll-list open"; } // fills the window, scrolls inside
  else if (open) { idx = range(1, n); }                                 // short thread: simply all of it
  else if (scrolling) { idx = range(1, n); listCls += " scroll-list"; show = SEARCH_AROUND; }
  else if (searching) { // a slice of the track before and after peeks out under the fades: there is more
    idx = searchRows(t, hits);
  }
  else if (searching) { idx = fixedRows.get(t.id) || searchRows(t, hits); }
  else if (long && !mobile) { idx = range(1, n); listCls += " scroll-list"; }
  else if (long) { idx = range(1, 1 + TAG_PREVIEW); }
  else { idx = range(1, n); }
  const head = t.tracks[0], hi = info(head);
  const core = idx.filter((i) => !peek.has(i)); // the peeking slices don't count
  const lo = core.length ? core[0] + 1 : 1, hiIdx = core.length ? core[core.length - 1] + 1 : 1;
  const posText = `${!searching || lo === 2 ? 1 : lo} of ${n}`;
  const pos = () => el("span", { class: "more-pos" }, posText);
  const expandBtn = (cls = "") => btn("tg-expand " + cls, open ? "Collapse" : "Expand", () => toggleExpand(t, hits));
  const day = fmtDay(head.shown_date || head.date);

  // what goes where
  let side = null, foot = null, after = null;
  // under the thumbnail: the post date; in search results it leads to the thread, with the track count under it
  const when = el("div", { class: "t-when" + (hits ? " in-search" : "") },
    el("button", { class: "when-link", "data-thread": t.id, onclick: () => goToThread(t) }, day)); // (Cmd/Ctrl+click: the thread in a new tab)
  if (hits && !mobile) {
    // laptop search: "175 tracks" under the tracks, centred, shows the whole thread (no Collapse)
    if (searching) foot = el("div", { class: "search-foot" }, el("span", {}),
      btn("tg-expand", `${n} ${n === 1 ? "track" : "tracks"}`, () => toggleExpand(t, hits)), el("span", {}));
    else if (open && long) foot = el("div", { class: "search-foot" }, el("span", {}), expandBtn(), el("span", {})); // long threads: Collapse
  } else if (hits && mobile) {
    // phone search: counter, Scroll and Expand under the tracks; Expand shows the whole thread (no Collapse)
    // phone search: the post date (to the thread, as on a computer) and, when there is more, the counter as the
    // button that lets the box scroll (lit while it does)
    foot = el("div", { class: "search-foot phone-foot" },
      el("button", { class: "when-link foot-date", "data-thread": t.id, onclick: (e) => { e.stopPropagation(); goToThread(t); } }, day),
      searching ? el("button", { class: "more-toggle scroll-link" + (scrolling ? " on" : ""), style: `--digits:${String(n).length}`, onclick: (e) => {
        e.stopPropagation();
        const on = activeId !== t.id; // (the tap may already have selected it: ask the page, not this button)
        setActive(on ? t.id : null);
        if (on) { // the box's top border just under the header; held there while the keyboard closes and things settle
          $("#q").blur();
          const n = document.getElementById("th-" + t.id);
          if (n) holdAt(n, () => headerBottom() + 8);
        }
      } }, scrolling // off: how many tracks; on: where you are ("7 of 12", the "of" stays put)
        ? el("span", { class: "more-pos pos-split" }, el("span", { class: "pos-a" }, lo), el("span", { class: "pos-of" }, " of "), el("span", { class: "pos-b" }, n))
        : `${n} tracks`) : el("span", {}));
  } else if (long) {
    side = el("div", { class: "thread-more" },
      el("div", { class: "more-info" }, el("span", { class: "more-title" }, hi.title), pos()),
      el("div", { class: "more-btns" }, expandBtn()));
    // (phone: the counter and Expand only on top)
  }
  const li = el("li", { class: "thread" + (side ? " long framed" : "") + (open ? " expanded" : "") + (hits ? " searching" : "") + (t.id === activeId ? " active" : ""), id: "th-" + t.id },
    hits ? null : el("div", { class: "tg-when t-when-phone" }, el("button", { class: "when-link", "data-thread": t.id, onclick: () => goToThread(t) }, day)), // phone: the date above the thumbnail (as in Archive)
    el("div", { class: ["head-row", hi.dead && "dead", hits && hits.has(0) && "hit", ].filter(Boolean).join(" "), "data-k": `${t.id}:0` },
      el("button", { class: "thread-head", onclick: () => play(t, 0), "aria-label": `Play ${hi.title}` },
        el("span", { class: "thumb" }, img(hi.thumb, "thumb-img"), hi.thumb ? null : el("span", { class: "ph" }, PLATFORM[head.platform] || "")),
        el("span", { class: "thread-main" },
          el("span", { class: "t-title" }, hi.title, view === "threads" && !hits && lenOf(head) ? el("span", { class: "tr-len" }, fmtTime(lenOf(head))) : null), // (its length, as in Archive)
          el("span", { class: "t-sub t-tags" }, tagLine(head)),
          el("span", { class: "t-sub t-date" + (hi.recovered ? "" : " only-date") },
            hits ? null : el("span", { class: "t-date-phone" }, el("span", { class: "when-link", role: "link", "data-thread": t.id,
              onclick: (e) => { e.stopPropagation(); goToThread(t); } }, day), hi.recovered ? " · " : ""), // phone: the date under the title (a link)
            hi.recovered ? el("span", { class: "sub-note" }, RECOVERED) : null))),
      el("span", { class: "head-side" }, rowLinks(t, 0, hi))),
    when,
    side,
    n > 1 ? el("ol", { class: listCls, "data-show": show }, idx.map((i) => { const row = trackRow(t, t.tracks[i], i, hits); if (peek.has(i)) row.classList.add("peek"); return row; })) : null,
    foot, after,
    // search results (computer): "3 of 17" under the thumbnail, level with the middle of the tracks (placed by placeMidPos)
    hits && !mobile && (searching || scrolling) ? el("span", { class: "more-pos mid-pos" }, posText) : null,
    hits ? null : el("div", { class: "thread-foot" }, // no "Add a track here" in search results
      el("button", { class: "linkbtn add-here", onclick: (e) => toggleAddForm(t, e.currentTarget.closest(".thread")) }, "Add a track here")));
  const list = li.querySelector(".scroll-list");
  if (list) {
    list.addEventListener("scroll", () => updateListPos(li), { passive: true });
    requestAnimationFrame(() => fitList(li));
  }
  return li;
}

/* "Thread": leave the search and show this thread where it sits in the feed */
function goToThread(t, gap = 22) { // a little under the header: the dividing line of the thread before shows
  preSearch = null; $("#q").value = ""; syncClear(); $("#q").blur(); // (phone: the keyboard goes away first, so the page doesn't shift afterwards)
  if (view !== "threads") { view = "threads"; document.body.dataset.view = view; history.replaceState(null, "", location.pathname); document.querySelectorAll("#menu [data-view]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === "threads"))); }
  expanded.delete(t.id);
  runSearch();
  const at = shown.findIndex((x) => x.t === t);
  if (at < 0) return;
  while (rendered <= at && rendered < shown.length) renderMore();
  const node = document.getElementById("th-" + t.id);
  if (!node) return;
  holdAt(node, () => headerBottom() + gap); // boxes above size themselves a moment later
}

/* Archive: Random goes to a random track there (one with a tag of its own; automatic tags don't count) */
function randomTagged(gap = 22) {
  if (archiveShuffle && view === "tagged") { // shuffled: a random spot in the shuffled list
    const k = Math.floor(Math.random() * archiveShuffle.tracks.length), at = Math.floor(k / SHUF_PART);
    while (rendered <= at && rendered < shown.length) renderMore();
    const row = document.querySelector(`[data-k="${archiveShuffle.id}:${k}"]`);
    if (row) holdAt(row, () => headerBottom() + gap);
    return;
  }
  const pool = [];
  for (const t of threads) if (isBase(t)) t.tracks.forEach((tr, i) => { if (userTagged(tr)) pool.push([t, i]); });
  if (!pool.length) return;
  const [t, i] = pool[Math.floor(Math.random() * pool.length)];
  if ($("#q").value) { $("#q").value = ""; syncClear(); }
  $("#q").blur();
  runSearch();
  const at = shown.findIndex((x) => x.t === t);
  if (at < 0) return;
  while (rendered <= at && rendered < shown.length) renderMore();
  const node = document.getElementById("th-" + t.id), row = node && node.querySelector(`[data-k="${t.id}:${i}"]`);
  if (row) holdAt(row, () => headerBottom() + gap);
}
function markPlaying() {
  document.querySelectorAll(".playing").forEach((n) => n.classList.remove("playing"));
  if (playing) document.querySelectorAll(`[data-k="${playing.thread.id}:${playing.index}"]`).forEach((n) => n.classList.add("playing"));
}

function renderMore(count = PAGE) {
  const frag = document.createDocumentFragment();
  const end = Math.min(shown.length, rendered + count);
  for (; rendered < end; rendered++) frag.append(threadNode(shown[rendered]));
  const added = [...frag.children];
  $("#threads").append(frag);
  markPlaying();
  requestAnimationFrame(fadeAll);
  if (phone() && (view === "tagged" || (resultList && query))) requestAnimationFrame(() => fitTitles(added));
}
/* phone, Archive: a title longer than its two lines gets smaller until all of it fits (down to 10px);
   one that still doesn't fit gets a third line, and as big a size as fits there */
function fitTitles(nodes) {
  for (const n of nodes) for (const t of n.querySelectorAll(".tr-title")) {
    const start = parseFloat(getComputedStyle(t).fontSize);
    const shrink = () => { let fs = start; t.style.fontSize = ""; while (t.scrollHeight > t.clientHeight + 1 && fs > 10) { fs -= 0.5; t.style.fontSize = fs + "px"; } };
    shrink();
    if (t.scrollHeight > t.clientHeight + 1) { t.style.webkitLineClamp = "3"; shrink(); } // (as big as it can be on three lines)
  }
}

new IntersectionObserver((e) => { if (e[0].isIntersecting && rendered < shown.length) renderMore(); }, { rootMargin: "1200px" }).observe($("#more"));

/* ---------- player dock ---------- */
const scripts = {};
function loadScript(src, ready) {
  if (!scripts[src]) scripts[src] = new Promise((res, rej) => {
    if (ready && ready()) return res();
    const s = document.createElement("script");
    s.src = src; s.onload = () => res(); s.onerror = rej;
    document.head.append(s);
  });
  return scripts[src];
}
function loadYT() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (!scripts.yt) scripts.yt = new Promise((res) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev && prev(); res(); };
    const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.append(s);
  });
  return scripts.yt;
}

let adapter = null, loadToken = 0, autoplay = false, seeking = false;
let volume = 100;
try { const v = parseInt(localStorage.getItem("nrgfm-volume"), 10); if (v >= 0 && v <= 100) volume = v; } catch {}
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return "0:00";
  s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/* the tab: "nrgfm" (on a tag's page "nrgfm: tag"), with 🔊 and the speaker icon while something plays */
let soundOn = false;
/* the tab's name: "nrgfm: <tag>" on a tag's page, "nrgfm: <main track's title>" when the address points at a post (#t/…) */
function postInAddress() {
  const m = location.hash.match(/^#t\/(.+)$/);
  if (!m || (view !== "threads" && view !== "tagged")) return null;
  let id = m[1]; try { id = decodeURIComponent(id); } catch {}
  const t = threads.find((x) => x.id === id && x.kind !== "tag");
  return t && t.tracks[0] ? info(t.tracks[0]).title : null;
}
for (const f of ["replaceState", "pushState"]) { const orig = history[f].bind(history); history[f] = (...a) => { orig(...a); updateTitle(); }; }
addEventListener("hashchange", () => updateTitle());
function updateTitle() {
  const post = typeof threads !== "undefined" && threads.length ? postInAddress() : null;
  document.title = view === "tag" && tagPageName ? "nrgfm: " + showTag(tagPageName) : post ? "nrgfm: " + post : "nrgfm"; // (playing: only the icon changes)
  for (const l of document.querySelectorAll('link[rel="icon"]')) {
    const base = l.getAttribute("href").replace("-playing", "");
    l.setAttribute("href", soundOn ? base.replace(/\.png$/, "-playing.png") : base);
  }
}
/* Play / Pause answers at once: a press is a request (wantPlay), shown on the button straight away; the player catches up
   (a new track loads either way, and is paused as soon as it starts if Pause was asked for meanwhile). The request
   ends when the player is in that state, or after 10 s (e.g. the iPhone didn't allow starting): then the button
   shows what the player really does. */
let wantPlay = null, wantTimer = null, startedOnce = false; // (startedOnce: this track has really played; until then a "paused" may be the loading's)
const setLoading = (on) => $("#playBtn").classList.toggle("loading", !!on); // the ring round Play turns while the player loads
function showPlayBtn() {
  const on = wantPlay !== null ? wantPlay : soundOn;
  $("#playBtn").textContent = on ? "Pause" : "Play";
  $("#playBtn").setAttribute("aria-pressed", on ? "true" : "false");
}
function requestPlay(on) {
  wantPlay = on; clearTimeout(wantTimer);
  wantTimer = setTimeout(() => { wantPlay = null; setLoading(false); showPlayBtn(); }, 10000);
  showPlayBtn();
}
function setPlayState(isPlaying) {
  setLoading(false); // (playing or paused: whatever was loading is there)
  if (soundOn !== isPlaying) { soundOn = isPlaying; updateTitle(); }
  if (isPlaying) startedOnce = true;
  if (wantPlay !== null) {
    if (isPlaying === wantPlay && (isPlaying || startedOnce)) { wantPlay = null; clearTimeout(wantTimer); }
    else if (isPlaying && wantPlay === false) { try { adapter && adapter.pause(); } catch {} } // started while Pause was asked for: pause now
  }
  showPlayBtn();
}
let lastTime = 0;
/* The position bar answers at once too, as Play/Pause does: a drag (or a click on a time, or ←/→) is a request. The knob
   stays where it was put until the player is there, then simply follows the player again (no waiting).
   While the track loads, the bar keeps the length we know from before (expectDur), so a drag to the middle means the
   middle; without a known length the request is kept as a share of the track (half way stays half way).
   Sending: before a YouTube track has started, it is loaded again from that spot (one reload for a burst of drags);
   once it plays, it jumps. If the player is somewhere else on a tick (it ignored the jump, or went back to the start a
   moment after arriving), the jump is sent again. Ends when the player is there and moving on from it; dropped by a
   new track, an error, the end, closing the player, or after a few tries. */
let pendingSeek = null, durKnown = false, expectDur = 0, reloadTimer = 0, seekGuard = null; // seekGuard: a jump that just arrived, watched for 4 s in case YouTube goes back to the start
// pendingSeek: { t, frac, sent, tries, at (the player was there: time), from (player time then) }
function requestSeek(t) {
  if (!adapter || !adapter.controllable) return;
  const max = durKnown ? +seekEl.max : expectDur;
  t = Math.max(0, t);
  seekGuard = null;
  pendingSeek = { t, frac: !max ? Math.min(1, t / (+seekEl.max || 1)) : null, sent: 0, tries: 0, at: 0, from: 0 };
  showSeek(pendingSeek.frac != null ? pendingSeek.frac : t, max || +seekEl.max || 1);
  if (!startedOnce && adapter.restartAt && max > 1) { // not started yet: load it from there (a jump now is ignored, or undone when it starts)
    const at = Math.min(t, Math.max(0, max - 1));
    pendingSeek.t = at; pendingSeek.sent = Date.now(); pendingSeek.tries = 1;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { if (pendingSeek && !startedOnce) try { adapter.restartAt(pendingSeek.t); } catch {} }, 250); // (several drags in a row: one reload, to the last spot)
    return;
  }
  trySeek(lastTime, durKnown ? max : 0, true);
}
function trySeek(cur, dur, now) {
  const q = pendingSeek;
  if (!q || !adapter) return;
  if (!startedOnce || !(dur > 0)) return; // (not ready yet: wait)
  if (q.frac != null) { q.t = q.frac * dur; q.frac = null; } // (the real length is known now)
  q.t = Math.min(q.t, Math.max(0, dur - 1)); // (never right onto the end: that would end the track)
  if (Math.abs(cur - q.t) < 2) { // the player is there
    if (!q.at) { q.at = Date.now(); q.from = cur; }
    if (cur - q.from > 0.6 || (!soundOn && Date.now() - q.at > 1500)) { pendingSeek = null; seekGuard = { t: q.t, until: Date.now() + 4000 }; } // and plays on from there (or is there, paused)
    return;
  }
  if (q.at && cur < q.t - 2) { q.at = 0; q.sent = 0; } // (it went back after all)
  if (!now && q.sent && Date.now() - q.sent < 700) return; // (give a jump a moment to take effect)
  if (q.tries >= 6) { pendingSeek = null; return; } // (it won't go: the bar follows the player again)
  q.sent = Date.now(); q.tries++;
  try { adapter.seek(q.t); } catch {}
}
function showSeek(cur, dur) {
  $("#tCur").textContent = fmtTime(cur);
  if (dur > 0) $("#tDur").textContent = fmtTime(dur);
  seekEl.max = dur > 0 ? dur : 1;
  seekEl.value = Math.min(cur, seekEl.max);
  seekEl.style.setProperty("--p", (dur > 0 ? (cur / dur) * 100 : 0) + "%");
}
function setTime(cur, dur) {
  logTick(cur, dur);
  lastTime = cur || 0;
  if (dur > 0 && adapter) durKnown = true;
  const len = dur > 0 ? dur : expectDur; // (still loading: the length we know from before)
  if (!pendingSeek && seekGuard) { // (arrived a moment ago, and now back near the start: YouTube undid it; send it again)
    if (Date.now() > seekGuard.until) seekGuard = null;
    else if (cur < 3 && seekGuard.t > 5) { pendingSeek = { t: seekGuard.t, frac: null, sent: 0, tries: 0, at: 0, from: 0 }; seekGuard = null; }
  }
  if (pendingSeek) {
    trySeek(cur, dur);
    const q = pendingSeek;
    if (q && !q.at) { if (!seeking) showSeek(q.frac != null ? q.frac * (len || 1) : q.t, len || +seekEl.max); return; } // (not there yet: the knob stays)
  }
  if (seeking) return;
  showSeek(cur, len);
}
/* autoplay goes to the next track that can play, skipping deleted links and ones that only play on YouTube */
function playable(tr) { const x = info(tr); return !x.dead && !x.noEmbed && !x.nolink; }
function autoNext() {
  if (!autoplay || !playing) return;
  const { thread: t, index: i } = playing;
  if (view === "tagged" && !t.shuffle) { // Archive: the next track with a tag of its own, down the Archive's list (across posts)
    const seq = [];
    for (const x of shown) if (x.t && isBase(x.t) && x.t.kind !== "shufpart") x.t.tracks.forEach((tr, k) => { if (userTagged(tr) || (x.t === t && k === i)) seq.push([x.t, k]); });
    const at = seq.findIndex(([u, k]) => u === t && k === i);
    if (at > -1) { for (const [u, k] of seq.slice(at + 1)) if (playable(u.tracks[k])) { play(u, k); return; } return; }
  }
  for (let k = i + 1; k < t.tracks.length; k++) if (playable(t.tracks[k])) { play(t, k); return; }
}
function onEnded() { setLoading(false); pendingSeek = null; wantPlay = null; clearTimeout(wantTimer); setPlayState(false); autoNext(); }
const YT_ONLY = "plays on youtube only";
/* YouTube's player said no: 101/150 = it can't play on other sites (the owner's choice, or age-restricted). The track gets
   the tag "plays on youtube only" (with the key, or a level 2 login: saved; otherwise only for now), so autoplay skips it
   and a backup link plays instead when it has one. Then on to the next track. */
function onError(code) {
  pendingSeek = null; setPlayState(false);
  const tr = playing && playing.thread.tracks[playing.index];
  if (tr && (code === 101 || code === 150) && !(tr.tags && tr.tags[YT_ONLY])) {
    tr._ytOnly = true; tr._hay = null;
    if (canEdit()) {
      const ts = Math.floor(Date.now() / 1000);
      writeInbox({ action: "tag", ids: [tr.id], add: [YT_ONLY], remove: [], ts, auto: "player" }, "tag")
        .then(() => { applyTags(tr, [...Object.keys(tr.tags || {}), YT_ONLY], ts); tr._hay = null; refreshTags(); }).catch(() => {});
    }
  }
  autoNext();
}
/* a section of a long video (the track's start and end): the player starts there, shows only that part,
   and when the end is reached it counts as the track ending (autoplay goes on to the next) */
let section = null;
function sectionState(on) {
  const sc = section;
  if (sc && on) {
    sc.live = true;
    if (sc.done) { sc.done = false; sc.rawSeek && sc.rawSeek(sc.s); } // Play again after the end: from the start of the section
  }
  setPlayState(on);
}
function sectionTime(cur, dur) {
  const sc = section;
  if (sc) {
    if (!sc.live) { setTime(0, sc.e ? sc.e - sc.s : 0); return; } // (until it really plays: the times may still be the last video's)
    if (!sc.started && dur > 0) { sc.started = true; if (sc.s && cur < sc.s - 2 && sc.rawSeek) { sc.rawSeek(sc.s); return; } }
    if (sc.e && cur >= sc.e) {
      if (!sc.done) { sc.done = true; try { adapter && adapter.pause(); } catch {} onEnded(); }
      setTime(sc.e - sc.s, sc.e - sc.s); return;
    }
    const end = sc.e && (!dur || sc.e < dur) ? sc.e : dur;
    cur = Math.max(0, cur - sc.s); dur = Math.max(0, end - sc.s);
  }
  setTime(cur, dur);
}
const events = { state: sectionState, time: sectionTime, ended: onEnded, error: onError };

/* Each adapter wraps one platform's embed and exposes the same controls. */
/* One YouTube player is kept for the whole visit and reused for every YouTube track.
   iPhones only start sound in a player the person has already tapped, so after the first
   play, later tracks (and autoplay through a thread) start by themselves. */
const yt = { player: null, ready: false, active: false, pending: null, waiters: [], timer: null };
function ytSlot() { return $("#ytSlot"); }
function makeYouTube(tr) {
  ytSlot().hidden = false;
  yt.active = true;
  const a = {
    controllable: true,
    play: () => yt.player && yt.player.playVideo(), pause: () => yt.player && yt.player.pauseVideo(),
    seek: (s) => yt.player && yt.player.seekTo(s, true),
    restartAt: (s) => { if (yt.ready) yt.player.loadVideoById({ videoId: tr.yt, startSeconds: s }); else { yt.pendingStart = s; yt.reloadAt = true; } }, // (before it has started: load it again from there)
    setVolume: (v) => { if (yt.ready) { if (IOS) { yt.player.unMute(); return; } yt.player.setVolume(v); v > 0 ? yt.player.unMute() : yt.player.mute(); } }, // iPhone: only its own buttons set the volume
    destroy: () => { yt.active = false; try { yt.ready && yt.player.pauseVideo(); } catch {} ytSlot().hidden = true; },
  };
  if (yt.ready) {
    // load straight away, inside the click, so the browser still counts it as the person's action
    try { if (IOS) yt.player.unMute(); } catch {} // iPhone: sound on before loading, still inside the tap
    yt.player.loadVideoById({ videoId: tr.yt, startSeconds: tr.start || 0 });
    try { if (IOS) yt.player.unMute(); else { yt.player.setVolume(volume); volume ? yt.player.unMute() : yt.player.mute(); } } catch {}
    a.ready = Promise.resolve();
    return a;
  }
  yt.pending = tr.yt; yt.pendingStart = tr.start || 0;
  a.ready = loadYT().then(() => new Promise((res) => {
    yt.waiters.push(res);
    if (yt.player) return; // still starting up; it will load yt.pending when ready
    const host = el("div"); ytSlot().replaceChildren(host);
    yt.player = new YT.Player(host, {
      videoId: yt.pending, host: "https://www.youtube-nocookie.com", width: "100%", height: "100%",
      playerVars: { autoplay: 1, mute: 0, rel: 0, playsinline: 1, vq: "hd1080", start: Math.floor(yt.pendingStart || 0) },
      events: {
        onReady: () => {
          yt.ready = true;
          try { if (IOS) yt.player.unMute(); else { yt.player.setVolume(volume); if (!volume) yt.player.mute(); } } catch {}
          const vid = yt.player.getVideoData && yt.player.getVideoData().video_id;
          if (yt.pending && (vid !== yt.pending || yt.reloadAt)) yt.player.loadVideoById({ videoId: yt.pending, startSeconds: yt.pendingStart || 0 });
          yt.reloadAt = false;
          yt.timer = setInterval(() => { if (yt.active && yt.player.getCurrentTime) events.time(yt.player.getCurrentTime(), yt.player.getDuration()); }, 250);
          yt.waiters.splice(0).forEach((f) => f());
        },
        onStateChange: (e) => {
          if (!yt.active) return;
          if (e.data === YT.PlayerState.PLAYING) {
            events.state(true);
            // iPhone: a video started without a tap is muted by the browser; unmute it as soon as it plays
            try { if (IOS || volume > 0) yt.player.unMute(); } catch {} // (iPhone: always; it can report "not muted" while it is)
          }
          else if (e.data === YT.PlayerState.PAUSED) events.state(false);
          else if (e.data === YT.PlayerState.BUFFERING) setLoading(true); // (loading more while playing: the ring turns again)
          else if (e.data === YT.PlayerState.ENDED) events.ended();
        },
        onError: (e) => { if (yt.active) events.error(e && e.data); },
      },
    });
  }));
  return a;
}
function makeSoundCloud(box, tr, src) {
  const f = el("iframe", { src, allow: "autoplay", title: "Soundcloud player" }); box.append(f);
  let w = null, dur = 0;
  return {
    controllable: true,
    ready: loadScript("https://w.soundcloud.com/player/api.js", () => window.SC && SC.Widget).then(() => {
      w = SC.Widget(f); const E = SC.Widget.Events;
      w.bind(E.READY, () => { w.setVolume(volume); w.getDuration((d) => { dur = d / 1000; events.time(0, dur); }); });
      w.bind(E.PLAY, () => { events.state(true); w.getDuration((d) => (dur = d / 1000)); });
      w.bind(E.PAUSE, () => events.state(false));
      w.bind(E.FINISH, () => events.ended());
      if (E.ERROR) w.bind(E.ERROR, () => events.error());
      w.bind(E.PLAY_PROGRESS, (e) => events.time(e.currentPosition / 1000, dur));
    }),
    play: () => w && w.play(), pause: () => w && w.pause(),
    seek: (s) => w && w.seekTo(s * 1000),
    setVolume: (v) => w && w.setVolume(v),
    destroy: () => {},
  };
}
function makeVimeo(box, tr) {
  const f = el("iframe", { src: `https://player.vimeo.com/video/${tr.vimeo}?autoplay=1`, allow: "autoplay; fullscreen", allowfullscreen: true, title: "Vimeo player" }); box.append(f);
  let p = null;
  return {
    controllable: true,
    ready: loadScript("https://player.vimeo.com/api/player.js", () => window.Vimeo).then(() => {
      p = new Vimeo.Player(f); p.setVolume(volume / 100).catch(() => {});
      p.on("play", () => events.state(true)); p.on("pause", () => events.state(false));
      p.on("ended", () => events.ended());
      p.on("error", () => events.error());
      p.on("timeupdate", (d) => events.time(d.seconds, d.duration));
    }),
    play: () => p && p.play(), pause: () => p && p.pause(),
    seek: (s) => p && p.setCurrentTime(s),
    setVolume: (v) => p && p.setVolume(v / 100).catch(() => {}),
    destroy: () => { try { p && p.destroy(); } catch {} },
  };
}
function makePlain(box, src, title) {
  box.append(el("iframe", { src, allow: "autoplay; encrypted-media; fullscreen", allowfullscreen: true, title }));
  return { controllable: false, ready: Promise.resolve(), play() {}, pause() {}, seek() {}, setVolume() {}, destroy() {} };
}

/* Archive shows only a post's tracks with a tag of their own: played from there, "1 of 4" counts those, Prev/Next and the
   list go through those, and autoplay goes on to the next such track (across posts, as before) */
function archiveScope(t, i) {
  if (view !== "tagged" || t.shuffle || t.kind !== "thread") return null;
  const sc = []; t.tracks.forEach((tr, k) => { if (userTagged(tr) || k === i) sc.push(k); });
  return sc.length < t.tracks.length ? sc : null;
}
function play(t, i) {
  if (i < 0 || i >= t.tracks.length) return;
  const keep = playing && playing.thread === t && playing.scope && playing.scope.includes(i); // (Prev/Next or the list inside the same Archive post)
  playing = { thread: t, index: i, scope: keep ? playing.scope : archiveScope(t, i) };
  if ((t.mix || t.shuffle || (t.kind === "tag" && view === "tag")) && !autoplay) { autoplay = true; $("#autoBtn").setAttribute("aria-pressed", "true"); $("#autoBtn").textContent = "Autoplay on"; } // a Genres playlist plays on
  const pn = document.getElementById("th-" + t.id);
  // the thread you play from gets the selected frame (in search results only the ones that scroll)
  if (pn && activeId !== t.id && !addingId && selectable(pn) && !searchLaptop()) setActive(t.id, `${t.id}:${i}`); // only boxes that scroll
  const token = ++loadToken;
  const tr0 = t.tracks[i], x = info(tr0);
  const tr = x.alt ? altSource(tr0) : tr0, m = meta[tr.url] || {}; // (the main link is gone: its alternative link plays)
  if (adapter) adapter.destroy();
  adapter = null;
  const box = $("#otherSlot"); box.replaceChildren();
  const dock = $("#dock"); dock.hidden = false; dock.classList.remove("idle");
  $("#infoBtn").disabled = $("#copyBtn").disabled = false;
  if (!lockPlayerWidths.done) { lockPlayerWidths(); lockPlayerWidths.done = true; }
  $("#nowTitle").textContent = x.title;
  startPlayLog(tr0, x);
  $("#dock").classList.remove("wide"); // a new track: the buttons come back
  showFlag();
  const sc = playing.scope, pos = sc ? sc.indexOf(i) : i, len = sc ? sc.length : t.tracks.length;
  $("#threadBtn").textContent = `${pos + 1} of ${len}` + (phone() ? "" : t.shuffle ? " in shuffle" : t.kind === "tag" ? " in this tag" : " in this thread");
  closeThread();
  fitTitle();
  $("#prevBtn").disabled = pos === 0;
  $("#nextBtn").disabled = pos === len - 1 && !sc; // (in Archive the last one goes on to the next post's, as autoplay does)
  wantPlay = null; startedOnce = false; pendingSeek = null; durKnown = false; seeking = false; setPlayState(false); expectDur = lenOf(tr) || 0; seekGuard = null; clearTimeout(reloadTimer); setTime(0, expectDur); durKnown = false; requestPlay(true); setLoading(true); // (the bar has the length we know already, so a drag while loading means something) // (a new track: the button shows Pause at once, its ring turns until it plays)
  section = (tr.start || tr.end) && ["youtube", "soundcloud", "vimeo"].includes(tr.platform)
    ? { s: tr.start || 0, e: tr.end || 0, live: false, started: false, done: false } : null;

  let kind = "video";
  if (x.nolink) {
    kind = "note";
    box.append(el("p", { class: "nolink" }, "This track has no link yet. ", el("a", { href: "https://www.youtube.com/results?search_query=" + encodeURIComponent(x.title), target: "_blank", rel: "noopener" }, "Search for it on Youtube")));
  } else if (x.dead) {
    kind = "note";
    box.append(el("p", { class: "nolink" }, x.archive
      ? "This track was deleted."
      : "This track was deleted and no archived copy of its page was found."));
  } else if (tr.platform === "youtube" && tr.yt && m.status !== 401) {
    adapter = makeYouTube(tr);
  } else if (tr.platform === "soundcloud") {
    kind = "audio";
    adapter = makeSoundCloud(box, tr, (m.sc_src || `https://w.soundcloud.com/player/?url=${encodeURIComponent(tr.url)}`) + "&auto_play=true&visual=false");
  } else if (tr.platform === "vimeo" && tr.vimeo) {
    adapter = makeVimeo(box, tr);
  } else if (tr.platform === "bandcamp" && m.bandcamp_embed) {
    kind = "bandcamp"; // Bandcamp's player is 120px high
    const css = getComputedStyle(document.documentElement), hex = (v) => css.getPropertyValue(v).trim().replace("#", "");
    adapter = makePlain(box, `https://bandcamp.com/EmbeddedPlayer/${m.bandcamp_embed}/size=large/bgcol=${hex("--surface")}/linkcol=${hex("--jade")}/artwork=small/tracklist=false/transparent=true/`, x.title);
  } else if (tr.platform === "mixcloud") {
    kind = "audio";
    adapter = makePlain(box, `https://player-widget.mixcloud.com/widget/iframe/?hide_cover=1&autoplay=1&feed=${encodeURIComponent(new URL(tr.url).pathname)}`, x.title);
  } else {
    kind = "note";
    box.append(el("p", { class: "nolink" }, `${PLATFORM[tr.platform] || "These"} links can't play in the player.`));
  }
  if (section && adapter && adapter.controllable) { // the slider and the ±5 work inside the section
    const sc = section, raw = adapter.seek; sc.rawSeek = raw;
    adapter.seek = (x) => { sc.done = false; raw(Math.max(0, x) + sc.s); };
    if (adapter.restartAt) { const rs = adapter.restartAt; adapter.restartAt = (x) => { sc.done = false; sc.started = true; rs(Math.max(0, x) + sc.s); }; }
  } else section = null;
  $("#media").dataset.kind = kind;
  const controllable = !!(adapter && adapter.controllable);
  $("#dock").classList.toggle("no-transport", !controllable);
  $("#playBtn").disabled = !controllable; $("#seek").disabled = !controllable; $("#volBtn").disabled = !controllable;
  if (!controllable) { setLoading(false); closeVol(); logUncounted(); soundOn = true; updateTitle(); }
  if (adapter) adapter.ready.catch(() => {
    if (token !== loadToken) return;
    ytSlot().hidden = true;
    box.replaceChildren(el("p", { class: "nolink" }, "The player didn't load."));
  });
  markPlaying();
  syncDockSpace();
}
/* phone, search results with Scroll on: playing a track switches Scroll off and keeps
   the tracks that were on screen as the result window */
function freezeScrolledResult(t) {
  if (!phone() || !scrollOn.has(t.id)) return;
  const node = document.getElementById("th-" + t.id), list = node && node.querySelector(".scroll-list");
  const entry = shown.find((x) => x.t === t);
  if (!list || !entry) return;
  const box = list.getBoundingClientRect();
  const seen = [...list.querySelectorAll(":scope > li.track")]
    .filter((r) => { const q = r.getBoundingClientRect(); return q.bottom > box.top + 4 && q.top < box.bottom - 4; })
    .map((r) => +r.dataset.k.split(":").pop());
  if (!seen.length) return;
  fixedRows.set(t.id, seen);
  scrollOn.delete(t.id);
  rerenderKeep(t, entry.hits);
}

/* a button that was used flashes once, filled like Play (Prev/Next, also from Cmd+Left/Right); the volume lights up */
function flashBtn(b, cls = "flash", ms = 260) { if (!b) return; b.classList.remove(cls); void b.offsetWidth; b.classList.add(cls); clearTimeout(b._fl); b._fl = setTimeout(() => b.classList.remove(cls), ms); }
function stepTrack(d) {
  const { thread: t, index: i, scope: sc } = playing;
  if (!sc) { play(t, i + d); return; }
  const at = sc.indexOf(i) + d;
  if (at >= 0 && at < sc.length) play(t, sc[at]);
  else if (d > 0) { const a = autoplay; autoplay = true; autoNext(); autoplay = a; } // (Archive: on to the next post's tracks)
}
$("#prevBtn").onclick = (e) => { if (!playing) return; flashBtn(e.currentTarget); stepTrack(-1); };
$("#nextBtn").onclick = (e) => { if (!playing) return; flashBtn(e.currentTarget); stepTrack(1); };
$("#playBtn").onclick = () => {
  if (!adapter) return;
  const on = $("#playBtn").textContent !== "Pause"; // what the button asks for now
  requestPlay(on);
  try { on ? adapter.play() : adapter.pause(); } catch {} // (still loading: the request waits for the player, see setPlayState)
};

const seekEl = $("#seek");
seekEl.addEventListener("input", () => {
  seeking = true;
  $("#tCur").textContent = fmtTime(+seekEl.value);
  seekEl.style.setProperty("--p", (seekEl.value / seekEl.max) * 100 + "%");
});
seekEl.addEventListener("change", () => { seeking = false; requestSeek(+seekEl.value); seekEl.blur(); });
/* clicking the time on the left goes back 5 seconds, the length on the right forward 5 (they light up a moment) */
for (const [id, step] of [["#tCur", -5], ["#tDur", 5]]) $(id).addEventListener("click", () => {
  if (!adapter || !adapter.controllable) return; // (phone and computer)
  const from = pendingSeek ? pendingSeek.t : lastTime; // (pressed again before the player got there: from where it was asked to go)
  requestSeek(Math.max(0, Math.min(+seekEl.max || 0, from + step)));
  $(id).classList.add("tapped"); setTimeout(() => $(id).classList.remove("tapped"), 250);
});
/* iPhone: the first touch also unmutes a YouTube video the browser started muted */
document.addEventListener("touchend", () => { try { if (yt.ready && yt.active) yt.player.unMute(); } catch {} }, { passive: true });
/* after using the position or volume slider, keys work as before (Space plays/pauses, not scroll or move the slider) */
for (const s of [seekEl, $("#vol")]) s.addEventListener("pointerup", () => setTimeout(() => s.blur(), 0));

/* thread menu: list the playing thread above the bar; picking a track plays it and closes the menu */
function closeThread() { $("#threadPop").hidden = true; $("#threadBtn").setAttribute("aria-expanded", "false"); }
function openThread() {
  if (!playing) return;
  const t = playing.thread, only = playing.scope;
  $("#threadList").replaceChildren(...t.tracks.map((tr, i) => {
    if (only && !only.includes(i)) return null; // (from Archive: only the tracks it shows)
    const x = info(tr);
    return el("li", {},
      el("button", { class: "tl-item" + (i === playing.index ? " current" : "") + (x.dead ? " dead" : ""), "aria-current": i === playing.index ? "true" : null,
        onclick: () => { const y = $("#threadPop").scrollTop; play(t, i); openThread(); $("#threadPop").scrollTop = y; } }, // (the list stays open, where it was)
        img(x.thumb, "chip"),
        el("span", { class: "tl-text" },
          el("span", { class: "tr-title" }, x.title),
          el("span", { class: "tr-sub" }, tagLine(tr, null, shownTags(tr).filter((g) => !isPlaylist(g) && (g !== "duplicate" || !phone()))))))); // (tags as everywhere: dotted, no # playlists)
  }).filter(Boolean));
  const room = $(".bar").getBoundingClientRect().top - headerBottom() - 16;
  $("#threadPop").style.maxHeight = phone() ? Math.max(120, room) + "px" : "";
  $("#threadPop").hidden = false; $("#threadBtn").setAttribute("aria-expanded", "true");
  $("#threadList .current")?.scrollIntoView({ block: "nearest" });
}
$("#threadBtn").onclick = (e) => { e.stopPropagation(); $("#threadPop").hidden ? openThread() : closeThread(); };
$("#threadPop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("touchmove", (e) => {
  if (!$("#threadPop").hidden && !e.target.closest("#threadPop")) e.preventDefault();
}, { passive: false });
document.addEventListener("click", closeThread);

/* copy the playing track's original link */
$("#copyBtn").onclick = (e) => { if (playing) copyText(playing.thread.tracks[playing.index].url, e.currentTarget, "Copied"); };

/* "Artist – Title" for the playing track. YouTube titles often lack the artist when the
   uploader is the artist's own channel ("Randy Newman - Topic", "SomeoneVEVO"), so add it then. */
function fullInfo(tr) {
  return info(tr).title; // info() already puts the artist in front for artist channels
}
$("#infoBtn").onclick = (e) => { if (playing) copyText(fullInfo(playing.thread.tracks[playing.index]), e.currentTarget, "Copied"); };

/* phone: shrink the player title so long names fit on one line (down to 11px, then "…") */
const narrow = window.matchMedia("(max-width: 640px)");
function fitTitle() {
  const n = $("#nowTitle");
  n.style.fontSize = "";
  if (!narrow.matches || $("#dock").hidden) return;
  let size = 16;
  while (n.scrollWidth > n.clientWidth && size > 11) { size -= 0.5; n.style.fontSize = size + "px"; }
}
window.addEventListener("resize", fitTitle);

/* volume popup; the level is remembered and applied to every track that loads */
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (IOS) $("#volWrap").hidden = true; // iOS only allows the hardware volume buttons
function closeVol() { $("#volWrap").classList.remove("open"); $("#volBtn").setAttribute("aria-expanded", "false"); }
const speaker = (v) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  n.setAttribute("viewBox", "0 0 16 16"); n.setAttribute("class", "spk"); n.setAttribute("aria-hidden", "true");
  n.innerHTML = '<path d="M2 6h3l4-3v10L5 10H2z" fill="currentColor"/>' +
    (v === 0 ? '<path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.4" fill="none"/>'
      : '<path d="M11 5.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" stroke-width="1.4" fill="none"/>' + (v > 50 ? '<path d="M12.8 3.5a6 6 0 0 1 0 9" stroke="currentColor" stroke-width="1.4" fill="none"/>' : ""));
  return n;
};
function showVolume() {
  $("#vol").value = volume; $("#volVal").textContent = volume;
  $("#vol").style.setProperty("--p", volume + "%");
  $("#volBtn").replaceChildren(speaker(volume), el("span", { class: "vol-n" }, volume)); // the button shows the volume
  $("#volBtn").classList.toggle("muted", volume === 0);
}
showVolume();
$("#volBtn").onclick = (e) => {
  e.stopPropagation();
  const open = !$("#volWrap").classList.contains("open"); // the slider slides out to the left of the number
  $("#volWrap").classList.toggle("open", open); $("#volBtn").setAttribute("aria-expanded", open ? "true" : "false");
};
$("#volPop").addEventListener("click", (e) => e.stopPropagation());
/* computer: resting the pointer on the volume opens the slider. Opened that way, it stays open while the pointer
   is on the volume or the slider and closes 0.5 s after the pointer leaves them (Nielsen Norman Group's advice for
   content shown on hover: wait about 0.5 s after the pointer leaves, so a slightly wobbly move doesn't close it). */
if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
  let volTimer = 0, byHover = false;
  const wrap = $("#volWrap");
  wrap.addEventListener("mouseenter", () => {
    clearTimeout(volTimer);
    if ($("#volBtn").disabled || wrap.classList.contains("open")) return;
    byHover = true; wrap.classList.add("open"); $("#volBtn").setAttribute("aria-expanded", "true");
  });
  const later = () => { clearTimeout(volTimer); volTimer = setTimeout(() => { byHover = false; closeVol(); }, 500); };
  wrap.addEventListener("mouseleave", (e) => { if (byHover && wrap.classList.contains("open") && !e.buttons) later(); }); // not while dragging the slider
  document.addEventListener("mouseup", (e) => { if (byHover && wrap.classList.contains("open") && !wrap.contains(e.target) && !wrap.matches(":hover")) later(); });
  // computer: a click on the volume mutes, the next one unmutes to the volume it had (the slider is already out from hovering)
  $("#volBtn").addEventListener("click", (e) => {
    e.stopImmediatePropagation(); e.stopPropagation();
    let back = 100; try { back = +localStorage.getItem("nrgfm-volume-last") || 100; } catch {}
    if (volume > 0) { try { localStorage.setItem("nrgfm-volume-last", String(volume)); } catch {} }
    $("#vol").value = volume > 0 ? 0 : back; $("#vol").dispatchEvent(new Event("input"));
  }, true);
}
$("#volNum").onclick = (e) => $("#volBtn").click();
document.addEventListener("click", closeVol);
$("#vol").addEventListener("input", () => {
  volume = +$("#vol").value; showVolume();
  adapter && adapter.setVolume(volume);
  try { localStorage.setItem("nrgfm-volume", String(volume)); } catch {}
});

/* buttons whose text changes keep the width of their longest text, so the row doesn't move */
function lockWidth(btn, texts) {
  const was = btn.textContent;
  btn.style.minWidth = Math.ceil(Math.max(...texts.map((t) => { btn.textContent = t; return btn.getBoundingClientRect().width; }))) + "px";
  btn.textContent = was;
}
const lockPlayerWidths = () => {
  lockWidth($("#autoBtn"), ["Autoplay off", "Autoplay on"]);
  lockWidth($("#infoBtn"), ["Copy info", "Copied"]); lockWidth($("#copyBtn"), ["Copy link", "Copied"]);
};
/* a title too long for the player: click it and Autoplay and the Copy buttons step aside to make room
   (click again, or the next track, brings them back) */
$("#nowTitle").onclick = () => {
  if (phone()) return; // phone: the title is already shrunk to fit
  const t = $("#nowTitle"), d = $("#dock");
  if (d.classList.contains("wide") || t.scrollWidth > t.clientWidth + 1) d.classList.toggle("wide");
};
$("#autoBtn").onclick = () => {
  autoplay = !autoplay;
  $("#autoBtn").setAttribute("aria-pressed", autoplay ? "true" : "false");
  $("#autoBtn").textContent = autoplay ? "Autoplay on" : "Autoplay off";
};



/* keep the end of the list reachable above the dock */
/* The × first unloads the track (the video goes, the bar stays, empty); pressed again on the empty bar it closes
   the bar. On a computer the empty bar is there from the start, so the volume can be set before anything plays. */
function idleDock() {
  const d = $("#dock");
  d.hidden = false; d.classList.add("idle"); d.classList.remove("wide", "no-transport");
  $("#media").dataset.kind = "";
  $("#nowTitle").textContent = ""; closeThread();
  wantPlay = null; clearTimeout(wantTimer); pendingSeek = null; seekGuard = null; durKnown = false; expectDur = 0; clearTimeout(reloadTimer); setPlayState(false); setLoading(false); setTime(0, 0);
  for (const b of ["#prevBtn", "#playBtn", "#nextBtn", "#seek", "#infoBtn", "#copyBtn"]) $(b).disabled = true;
  $("#volBtn").disabled = false;
  if (!lockPlayerWidths.done) { lockPlayerWidths(); lockPlayerWidths.done = true; }
  syncDockSpace();
}
function closeDock() {
  soundOn = false; updateTitle();
  const loaded = !!playing;
  try { adapter && adapter.pause(); } catch {}
  if (adapter) adapter.destroy();
  adapter = null;
  ytSlot().hidden = true;
  $("#otherSlot").replaceChildren();
  playing = null;
  setPlayState(false);
  markPlaying();
  if (loaded && !phone()) { idleDock(); return; } // phone: the × closes the video and the player together
  closeVol();
  $("#dock").hidden = true;
  syncDockSpace();
}
$("#closeBtn").onclick = closeDock;

function syncDockSpace() {
  const d = $("#dock");
  document.body.style.setProperty("--dock-h", d.hidden ? "0px" : dockH() + "px"); // the video beside the content doesn't count
  fitMix();
  document.querySelectorAll(".scroll-list.open").forEach((l) => { // an open box at the top ends above the player
    const th = l.closest(".thread"), top = th.getBoundingClientRect().top - headerBottom();
    if (top > -4 && top < 40) fitList(th);
  });
}
new ResizeObserver(syncDockSpace).observe($("#dock"));

/* ---------- add track: saved straight to the repository with a key stored on this device ----------
   The key is a GitHub fine-grained token limited to this one repository (Contents: read & write).
   It lives in this browser's storage for this site only. Without it, adding is hidden. */
const TOKEN_KEY = "nrgfm-token";
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };
/* ---------- access levels ----------
   1: the GitHub key (Setup) — everything (its lock hides and shows the tags under the tracks).  2: my password — tags, playlists, automatic tags, notes in search; adds and
   edits tracks and tags (Cmd+I, no Edit buttons), through the Activity server; no deleting or moving.  3: friends'
   password — tags (no playlists, no automatic ones), Archive, Tags, Genres, History.  4: no password — Threads and
   Random. A password login lasts 12 hours. Levels 2–4 only change what is shown (the data itself is public). */
const SESSION_KEY = "nrgfm-session";
function session() { try { const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); return s && s.exp * 1000 > Date.now() ? s : null; } catch { return null; } }
const keyHidden = () => { try { return !!getToken() && localStorage.getItem("nrgfm-key-hidden") === "1"; } catch { return false; } }; // the key's lock "closed": no tags under the tracks (all else stays)
function level() { return getToken() ? 1 : (session() || {}).level || 4; }
const canEdit = () => level() <= 2;
const VIEW_LEVEL = { tagged: 3, tags: 3, tag: 3, history: 3, genres: 3, activity: 1, lookup: 1, mixes: 2, tagsold: 1, tagsrows: 1, threadsold: 1 }; // the highest level that may open each page (others: all)
const viewAllowed = (v, lv = level()) => lv <= (VIEW_LEVEL[v] || 4);
let shownLevel = null, levelTimer = null;
function updateCanAdd() {
  const lv = level(), b = document.body.classList;
  b.toggle("can-add", lv <= 2); b.toggle("key", lv === 1);
  for (const k of [1, 2, 3, 4]) b.toggle("lv-" + k, lv === k);
  clearTimeout(levelTimer);
  const s = !getToken() && session();
  if (s) levelTimer = setTimeout(applyLevel, Math.min(2 ** 31 - 1, s.exp * 1000 - Date.now() + 500)); // the 12 hours run out: back to level 4 by itself
  if (typeof drawLock === "function") drawLock();
  applyThSize(); if (typeof drawMenuSize === "function" && $("#menuSize")) drawMenuSize();
  return lv;
}
/* after logging in or out: what's on screen follows the new level, without reloading (what plays keeps playing) */
function applyLevel() {
  const before = shownLevel, lv = updateCanAdd();
  shownLevel = lv;
  if (before === null || before === lv) return;
  for (const t of threads) for (const tr of t.tracks) { tr._hay = null; tr._f = null; } // (search reads tags and notes again)
  refreshTags();
  if (!viewAllowed(view)) return; // a page this level can't open stays as it is (its tags hidden) until you go elsewhere
  const y = scroller() === window ? scrollY : document.body.scrollTop;
  if (view === "tag" && !tagVisible(tagPageName || "")) { $("#threads").querySelectorAll(".tag-wrap").forEach((w) => w.replaceChildren()); document.querySelectorAll(".tp-back-arrow").forEach((a) => a.remove()); return; }
  runSearch();
  while (rendered < shown.length && $("#threads").getBoundingClientRect().height < y + innerHeight * 2) renderMore();
  pageScrollTo(y);
}
/* the lock at the top right: logged out, a click slides the password field out to its left; logged in (2 or 3), a click
   logs out; with the key (1) it shows as logged in */
const LOCK_SVG = (open) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="${open ? "M8 11V7a4 4 0 0 1 7.8-1.2" : "M8 11V7a4 4 0 0 1 8 0v4"}"/></svg>`;
function drawLock() {
  const b = $("#lockBtn"); if (!b) return;
  const lv = level(), on = lv <= 3;
  b.innerHTML = LOCK_SVG(on);
  $("#lock").classList.toggle("on", on);
  document.body.classList.toggle("tags-off", keyHidden());
  b.setAttribute("aria-label", getToken() ? "Options" : on ? "Log out" : "Log in");
  drawLockOpts();
}
/* the key (level 1) can't log out: its lock slides out switches instead: the tags under the tracks, and the side list
   of opened posts on Threads (each on or off, remembered on this browser) */
const browseOn = () => { try { return localStorage.getItem("nrgfm-browse-on") !== "0"; } catch { return true; } };
function drawLockOpts() {
  let box = $("#lockOpts");
  if (!getToken()) { if (box) box.remove(); $("#lock").classList.remove("opts-open"); return; }
  if (!box) { box = el("span", { id: "lockOpts", class: "lock-opts" }); $("#lockPw").before(box); }
  box.onclick = (e) => e.stopPropagation(); // (a switch redraws itself: the click mustn't count as one outside, closing them)
  const tagsOn = !keyHidden(), listOn = browseOn();
  box.replaceChildren(
    el("button", { type: "button", class: "btn ghost" + (tagsOn ? " on" : ""), "aria-pressed": String(tagsOn), tabindex: $("#lock").classList.contains("opts-open") ? 0 : -1,
      onclick: () => { try { localStorage.setItem("nrgfm-key-hidden", tagsOn ? "1" : "0"); } catch {} drawLock(); } }, tagsOn ? "Hide tags" : "Show tags"),
    el("button", { type: "button", class: "btn ghost" + (listOn ? " on" : ""), "aria-pressed": String(listOn), tabindex: $("#lock").classList.contains("opts-open") ? 0 : -1,
      onclick: () => { try { localStorage.setItem("nrgfm-browse-on", listOn ? "0" : "1"); } catch {} drawLockOpts(); drawBrowse(); } }, listOn ? "Hide side list" : "Show side list"));
}
{ // the key: the switches slide out while the pointer is on the lock (or them), and back in a moment after it leaves
  let t = null;
  const lk = $("#lock");
  lk.addEventListener("mouseenter", () => { if (!getToken()) return; clearTimeout(t); if (!lk.classList.contains("opts-open")) { lk.classList.add("opts-open"); drawLockOpts(); } });
  lk.addEventListener("mouseleave", () => { if (!getToken()) return; clearTimeout(t); t = setTimeout(() => { lk.classList.remove("opts-open"); drawLockOpts(); }, 350); });
}
document.addEventListener("click", (e) => { const l = $("#lock"); if (l && l.classList.contains("opts-open") && !l.contains(e.target)) { l.classList.remove("opts-open"); drawLockOpts(); } });
function closeLock() { $("#lock").classList.remove("open"); $("#lockPw").value = ""; $("#lockPw").placeholder = "Password"; $("#lockPw").tabIndex = -1; $("#lockPw").blur(); }
$("#lockBtn").addEventListener("click", async () => {
  const lv = level();
  if (getToken()) { if (!matchMedia("(hover: hover)").matches) { $("#lock").classList.toggle("opts-open"); drawLockOpts(); } return; } // the key: the switches (on hover; a touch screen: by tapping)
  if (lv <= 3) { // log out, quietly: only what's shown changes
    const s = session();
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    applyLevel();
    if (s && ACT_URL) fetch(ACT_URL + "/logout", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ token: s.token }) }).catch(() => {});
    return;
  }
  const box = $("#lock");
  if (box.classList.contains("open")) { closeLock(); return; }
  box.classList.add("open"); $("#lockPw").tabIndex = 0; $("#lockPw").focus();
});
$("#lockPw").addEventListener("keydown", async (e) => {
  if (e.key === "Escape") { closeLock(); return; }
  if (e.key !== "Enter") return;
  const inp = e.currentTarget, pw = inp.value;
  if (!pw || !ACT_URL) return;
  inp.disabled = true;
  try {
    const r = await fetch(ACT_URL + "/login", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ password: pw, who: DEVICE_ID }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.token) {
      try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token: d.token, level: d.level, exp: d.exp })); } catch {}
      closeLock(); applyLevel();
    } else {
      inp.value = ""; inp.placeholder = d.error === "locked" ? `Locked for ${Math.max(1, Math.ceil((d.until * 1000 - Date.now()) / 60000))} min` : "Wrong password";
      $("#lock").classList.remove("shake"); void $("#lock").offsetWidth; $("#lock").classList.add("shake");
    }
  } catch { inp.value = ""; inp.placeholder = "No connection"; }
  inp.disabled = false; inp.focus();
});
document.addEventListener("mousedown", (e) => { if ($("#lock").classList.contains("open") && !e.target.closest("#lock")) closeLock(); });
shownLevel = updateCanAdd();

async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${opts.token || getToken()}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
  });
  return r;
}

/* setup screen: open the site with #setup in the address */
function openSetup() {
  $("#tokenInput").value = "";
  $("#setupMsg").textContent = getToken() ? "A key is saved on this device." : "No key saved on this device yet.";
  $("#tokenRemove").hidden = !getToken();
  $("#setupDlg").showModal();
}
$("#setupForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const token = $("#tokenInput").value.trim();
  if (!token) return;
  $("#setupMsg").textContent = "Checking the key…";
  try {
    const r = await gh("", { token });
    const j = r.ok ? await r.json() : null;
    if (!r.ok) throw new Error(r.status === 401 ? "GitHub doesn't accept this key. Check that you copied all of it." : `GitHub answered ${r.status}. Check the key has access to the nrgfm repository.`);
    if (!j.permissions || !j.permissions.push) throw new Error("This key can read the repository but not save to it. Give it Contents: Read and write.");
    try { localStorage.setItem(TOKEN_KEY, token); } catch { throw new Error("This browser won't store the key (private window?)."); }
    updateCanAdd();
    $("#setupMsg").textContent = "Saved on this device. You can now add tracks.";
    $("#tokenRemove").hidden = false;
    $("#tokenInput").value = "";
  } catch (e) {
    $("#setupMsg").textContent = e.message;
  }
});
$("#tokenRemove").onclick = () => {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  updateCanAdd();
  $("#setupMsg").textContent = "Key removed from this device.";
  $("#tokenRemove").hidden = true;
};
$("#setupClose").onclick = () => { $("#setupDlg").close(); history.replaceState(null, "", location.pathname); };
function checkSetupHash() { if (location.hash === "#setup") openSetup(); }
window.addEventListener("hashchange", checkSetupHash);

/* Inline add form: under the header for a new thread, under a thread's footer for a reply.
   Title first, then link. Saving writes inbox/<time>.json straight to the repository. */
const toBase64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));
const LINK_RE = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|soundcloud\.com|[\w-]+\.bandcamp\.com|bandcamp\.com|vimeo\.com|mixcloud\.com|open\.spotify\.com)\//i;

/* Tag field: type, pick a suggestion with Enter (or the arrow keys), keep typing the next one.
   Chosen tags show as chips; clicking a chip removes it. */
/* Tag field: type, pick a suggestion with Enter (or the arrow keys), keep typing the next one.
   Editing a track: its tags under the title get an × and can be clicked away.
   Adding a track: the tags stack in two rows to the right of the field. */
/* The tag field: added tags sit inside the field as small boxes (× removes one); typing shows matching tags,
   and suggested tags (the main track's) show with a dotted outline, in a list that opens over the page below
   the field, so nothing moves. */
function tagEditor(initial, suggested = []) {
  const chosen = [...initial];
  const input = el("input", { type: "text", class: "tag-input", placeholder: "Add tag", autocomplete: "off", spellcheck: "false", "aria-label": "Add tag" });
  const chips = el("span", { class: "tag-chips-in" });
  const field = el("span", { class: "tag-field", onmousedown: (e) => { if (e.target === field || e.target === chips) { e.preventDefault(); input.focus(); } } }, chips, input);
  const drop = el("div", { class: "tag-drop", hidden: true });
  let opts = [], active = 0;
  const remove = (g) => { chosen.splice(chosen.indexOf(g), 1); drawChips(); drawDrop(); input.focus(); };
  const drawChips = () => {
    chips.replaceChildren(...chosen.map((g) => el("button", { type: "button", class: "tag-chip in", title: "Remove tag",
      onmousedown: (e) => e.preventDefault(), onclick: () => remove(g) }, showTag(g), el("span", { class: "x", "aria-hidden": "true" }, " ×"))));
    input.placeholder = chosen.length ? "" : "Add tag";
    field.scrollLeft = field.scrollWidth;
  };
  const drawDrop = () => {
    const q = fold(input.value);
    const sug = suggested.filter((g) => !chosen.includes(g) && (!q || fold(g).includes(q)));
    opts = q ? allTags().filter((g) => !isAutoTag(g) && !chosen.includes(g) && !sug.includes(g) && fold(g).includes(q)) // (no automatic tags)
      .sort(byTagFit(q)).slice(0, 6) : [];
    active = 0;
    const parts = [];
    if (sug.length) parts.push(el("div", { class: "drop-sug" }, sug.map((g) => el("button", { type: "button", class: "tag-chip suggest", title: "Use this tag",
      onmousedown: (e) => { e.preventDefault(); add(g); } }, "+ " + showTag(g)))));
    if (opts.length) { // like the quick tag field: name left, how many tracks have it right; the pointer highlights
      const n = tagCounts();
      parts.push(el("ul", { class: "drop-list" }, opts.map((g, k) => el("li", { class: k === active ? "on" : "",
        onmouseenter: (e) => { active = k; [...e.currentTarget.parentNode.children].forEach((li, j) => li.classList.toggle("on", j === k)); showTagSide(g); },
        onmousedown: (e) => { e.preventDefault(); add(g); } }, showTag(g), el("span", { class: "gi-n" }, n.get(g) || 0)))));
    }
    drop.replaceChildren(...parts);
    drop.hidden = !parts.length || document.activeElement !== input;
    showTagSide(!drop.hidden && opts.length ? opts[active] : null); // the highlighted tag's tracks, in the side space
  };
  const add = (g) => { g = normTag(g); if (g && !chosen.includes(g)) chosen.push(g); input.value = ""; drawChips(); drawDrop(); input.focus(); };
  input.addEventListener("input", drawDrop);
  input.addEventListener("focus", drawDrop);
  input.addEventListener("blur", () => setTimeout(() => { drop.hidden = true; if (!quick) side.hide(); }, 100));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.shiftKey) return; // Shift+Enter saves the card (handled by the form)
    const items = [...drop.querySelectorAll(".drop-list li")];
    if (e.key === "Enter" || (e.key === "," && input.value.trim())) {
      e.preventDefault();
      if (!drop.hidden && opts[active] && input.value.trim()) add(opts[active]); else if (input.value.trim()) add(input.value);
    } else if (e.key === "ArrowRight" && input.value.trim() && input.selectionStart === input.value.length) {
      e.preventDefault(); add(input.value); // what you typed, as it is (a new tag), not the suggestion
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (drop.hidden || !items.length) return; e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length;
      items.forEach((li, k) => li.classList.toggle("on", k === active));
      showTagSide(opts[active] || null);
    } else if (e.key === "Escape" && !drop.hidden) { e.stopPropagation(); drop.hidden = true; side.hide(); }
    else if (e.key === "Backspace" && !input.value && chosen.length) { chosen.pop(); drawChips(); drawDrop(); }
  });
  drawChips();
  return {
    box: el("span", { class: "tag-area" }, el("span", { class: "tag-box" }, field, drop)),
    input,
    use: (g) => { g = normTag(g); if (g && !chosen.includes(g)) { chosen.push(g); drawChips(); } },
    has: (g) => chosen.includes(normTag(g)),
    drop: (g) => { const k = chosen.indexOf(normTag(g)); if (k > -1) { chosen.splice(k, 1); drawChips(); } },
    get: () => { if (input.value.trim()) add(input.value); return [...chosen]; }, // a typed but not yet added tag counts too
    restore: () => {},
  };
}

function addForm(thread, edit, row) {
  // edit = { t, i } when editing an existing track; row = that track's row (its tags become removable)
  const tr = edit ? edit.t.tracks[edit.i] : null;
  const host = row ? row.querySelector(".tag-wrap") : null;
  const tags = tagEditor(tr ? shownTags(tr) : [], []);
  const more = moreInfo(tr, edit, tags);
  // editing: the genres/tags under the track's title can be clicked away (a tag leaves the tags, a suggested genre the
  // suggested genres); closing without saving puts them back
  if (row && tr) {
    const gone = [], dec = decadeOf((extra[tr.url] || {}).y);
    row.querySelectorAll(".tag-wrap .tag").forEach((sp) => {
      const g = sp.textContent.trim();
      if (!g || g === dec || sp.classList.contains("tag-pl")) return; // the decade comes from the year; the ⌗ isn't one tag
      sp.classList.add("tag-rm");
      sp.addEventListener("click", (e) => {
        if (!(row.nextElementSibling && row.nextElementSibling.classList.contains("edit-wrap"))) return; // only while its card is open
        e.stopPropagation(); e.preventDefault();
        if (tags.has(g)) tags.drop(g);
        more.removeGenre && more.removeGenre(g);
        gone.push([sp, sp.parentNode, sp.nextSibling]); sp.remove();
      });
    });
    tags.restore = () => { for (const [sp, parent, next] of gone.reverse()) if (parent && parent.isConnected) parent.insertBefore(sp, next && next.parentNode === parent ? next : null); };
  }
  const arrow = el("button", { type: "button", class: "btn ghost more-info-btn", "aria-expanded": "false",
    "aria-label": "More info", onclick: (e) => {
      const open = more.hidden; more.hidden = !open; e.currentTarget.setAttribute("aria-expanded", String(open));
      if (open) more.querySelector("textarea").focus({ preventScroll: true });
      const wrap = form.closest(".edit-wrap");
      if (wrap && wrap.previousElementSibling) focusRow(wrap.previousElementSibling, true, "top", "top"); // the track stays at the top
      else if (open) revealWhole(form);
    } }, "▾");
  const sec = sectionFields(tr);
  const form = el("form", { class: "add-form" + (edit ? " edit-form" : ""), autocomplete: "off" },
    el("div", { class: "af-field" }, inBtn(edit && "Google", "https://www.google.com/search?q=",
      el("input", { name: "title", type: "text", "aria-label": "Title", placeholder: "Artist – Track (optional, filled in automatically)" }))),
    el("div", { class: "af-field" }, inBtn(edit && "Youtube", "https://www.youtube.com/results?search_query=",
      el("input", { name: "url", type: "url", "aria-label": "Link", placeholder: "Youtube, Soundcloud, Bandcamp or Vimeo link (or leave it empty)" }))),
    el("div", { class: "af-actions" },
      tags.box,
      el("span", { class: "af-gap" }),

      edit ? sec.box : null,
      edit ? arrow : null,
      el("span", { class: "af-msg hint", role: "status" }),
      edit ? el("button", { type: "button", class: "btn ghost danger key-only", onclick: (e) => deleteTrack(form, edit, e.currentTarget) }, "Delete") : null,
      edit ? null : sec.box,
      edit ? null : arrow,
      el("button", { type: "submit", class: "btn" }, "Save")),
    more);
  if (edit) { // the Google and Youtube buttons in the fields: as wide as Save under them
    const save = form.querySelector('button[type="submit"]');
    new ResizeObserver(() => { if (save.offsetWidth) form.style.setProperty("--save-w", save.offsetWidth + "px"); }).observe(save);
  }
  if (tr) { form.title.value = tr.title ? flipDotTitle(tr.title) : info(tr).title; form.url.value = tr.url; } // YouTube's "Title · Artist" shown as "Artist – Title", as on the page
  form.url.addEventListener("input", () => {
    form.url.setCustomValidity("");
    const clean = withoutPlaylist(form.url.value);
    if (clean !== form.url.value) form.url.value = clean; // a video from a playlist: only the video
    sec.fromLink(form.url.value);
  });
  form.tags = tags; form.section = sec;
  form.addEventListener("submit", (ev) => { ev.preventDefault(); edit ? saveEdit(form, edit) : saveTrack(form, thread); });
  // Shift+Enter saves from any field, the tag field included
  form.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); form.requestSubmit(); }
  }, true);
  return form;
}
/* the panel under the arrow: notes, the main post's date, suggestions from the lookups, and Meta */
let descriptions = null; // loaded only when a Description is opened
const loadDescriptions = () => (descriptions ||= fetch("data/descriptions.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
function moreInfo(tr, edit, tags) {
  const x = (tr && extra[tr.url]) || {};
  const notes = el("textarea", { name: "notes", rows: "3", placeholder: "Not shown on the site; searches still find them" });
  notes.value = (tr && tr.notes) || "";
  const box = el("div", { class: "af-more", hidden: true },
    el("div", { class: "af-field" }, el("span", {}, "Notes"),
      el("div", { class: "notes-row" }, notes, edit && edit.t.tracks.length > 1 ? el("div", { class: "order-btns" },
        orderBtn(true, () => reorderTrack(box.closest("form"), edit, -1), edit.i === 0),
        orderBtn(false, () => reorderTrack(box.closest("form"), edit, 1), edit.i === edit.t.tracks.length - 1)) : null)),
    edit ? keyOnly(movePanel(() => box.closest("form"), edit)) : null);
  if (edit && edit.i === 0) {
    const date = el("input", { name: "date", type: "hidden" }); // YYYY-MM-DD, sent with Save
    date.value = tr.shown_date || tr.date;
    const shown = el("button", { type: "button", class: "rel-name date-name" });
    const showDate = () => shown.replaceChildren(fmtDay(date.value));
    const typeDate = () => { // the date in numbers: 18.10.2026 (or 2026-10-18)
      const [y, m, d] = date.value.split("-");
      const input = el("input", { type: "text", class: "rel-input", value: `${+d}.${+m}.${y}`, size: 11, inputmode: "numeric", "aria-label": "Posted" });
      let finished = false;
      const done = (keep) => {
        if (finished) return; finished = true;
        if (keep) {
          const v = input.value.trim(), a = v.match(/^(\d{1,2})[.\/ -](\d{1,2})[.\/ -](\d{4})$/), b = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
          const [yy, mm, dd] = a ? [a[3], a[2], a[1]] : b ? [b[1], b[2], b[3]] : [];
          const iso = yy && `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
          if (iso && !isNaN(Date.parse(iso + "T12:00:00Z"))) { date.value = iso; pos = null; note.textContent = ""; }
        }
        input.replaceWith(shown); showDate();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.stopPropagation(); done(false); } });
      input.addEventListener("blur", () => done(true));
      shown.replaceWith(input); input.focus(); input.select();
    };
    shown.onclick = typeDate;
    showDate();
    // the arrows move the thread one place up or down in the feed (saved with Save)
    const t = edit.t, note = el("span", { class: "hint" });
    let pos = null;
    const others = () => threads.filter((o) => isBase(o) && o !== t).sort((a, b) => activity(b) - activity(a));
    const step = (up) => {
      const cur = pos ?? activity(t), list = others();
      let next, beyond;
      if (up) { const above = list.filter((o) => activity(o) > cur); next = above[above.length - 1]; beyond = above[above.length - 2]; }
      else { const below = list.filter((o) => activity(o) < cur); next = below[0]; beyond = below[1]; }
      if (!next) return;
      const a = activity(next), b = beyond ? activity(beyond) : a + (up ? 7200 : -7200);
      pos = Math.round((a + b) / 2); // halfway between the next thread and the one after it
      if (pos === a) pos = a + (up ? 1 : -1);
      date.value = new Date(pos * 1000).toISOString().slice(0, 10); showDate();
      note.textContent = (up ? "above " : "below ") + info(next.tracks[0]).title;
    };
    box.feedPos = () => pos;
    box.append(el("div", { class: "af-sug af-date" }, el("span", { class: "af-label" }, "Posted"), date, shown,
      tr.shown_date ? el("span", { class: "hint" }, `(originally ${fmtDay(tr.date)})`) : null,
      stepBtn(true, step), stepBtn(false, step), note));
  }
  if (tr) {
    const sug = el("div", { class: "af-sug" }, el("span", { class: "af-label" }, "Suggested genres"), genreEditor(tr, x, box));
    box.append(sug,
      el("div", { class: "af-sug rel-line" }, el("span", { class: "af-label" }, "Suggested release"), releaseEditor(tr, x, box)),
      el("div", { class: "af-sug" }, el("span", { class: "af-label" }, "Suggested year"),
        yearEditor(tr, x, box),
        // other years only when the suggestion is uncertain; where it came from shows when hovering the line
        x.ys && x.ys.length && x.conf !== "high" ? el("span", { class: "hint" }, "(also " + x.ys.join(", ") + ")") : null));
    const yearLine = box.lastChild;
    // hovering: where each year came from (the suggested one first)
    const ySrc = (y) => (x.ysrc || {})[y] || "";
    const yearNote = [x.y ? `${x.y}: ${ySrc(x.y) || "set by hand or unknown source"}` + (x.conf ? ` (${x.conf} confidence)` : "") : null,
      ...(x.ys || []).map((y) => `${y}: ${ySrc(y) || "MusicBrainz or Discogs"}`)].filter(Boolean);
    if (yearNote.length) hoverNote(yearLine, yearNote);
    // Meta: uploader and upload date; inside it, Description
    const descBox = el("div", { class: "af-desc", hidden: true });
    const descBtn = el("button", { type: "button", class: "thread-btn", onclick: async () => {
      if (!descBox.hidden) { descBox.hidden = true; return; }
      descBox.hidden = false; descBox.textContent = "Loading…";
      const d = await loadDescriptions();
      descBox.textContent = d[tr.url] || "No description found.";
    } }, "Description");
    const metaBox = el("div", { class: "af-meta", hidden: true },
      edit ? el("label", { class: "af-field af-alt" }, el("span", { class: "af-label" }, "Alternative link"),
        el("span", { class: "af-alt-box" },
          Object.assign(el("input", { name: "alt", type: "url", inputmode: "url", autocomplete: "off", spellcheck: "false", placeholder: "Plays if the main link stops working" }), { value: (tr && tr.alt) || "" }),
          el("button", { type: "button", class: "af-alt-copy", onclick: (e) => { e.preventDefault(); const f = e.currentTarget.closest("form"), u = f.url.value.trim(); if (!u) return; f.alt.value = u; f.alt.setCustomValidity(""); f.url.value = ""; f.url.focus(); } }, "Copy link"))) : null,
      el("div", {}, el("span", { class: "af-label" }, "Uploader"), x.by || el("span", { class: "hint" }, "unknown")),
      el("div", {}, el("span", { class: "af-label" }, "Uploaded"), x.up ? fmtDay(x.up) : el("span", { class: "hint" }, "unknown")),
      el("div", {}, descBtn), descBox);
    // Meta, then the track's length and the suggested artist on the same line
    box.append(el("div", { class: "af-meta-line" }, el("button", { type: "button", class: "thread-btn", onclick: () => (metaBox.hidden = !metaBox.hidden) }, "Meta"),
      el("span", {}, el("span", { class: "af-label" }, "Duration"), x.d ? fmtTime(x.d) : el("span", { class: "hint" }, "unknown")),
      el("span", {}, el("span", { class: "af-label" }, "Artist"), textEditor(box, "artist", x.ar || "", (v) => v)),
      el("span", {}, el("span", { class: "af-label" }, "Country"), textEditor(box, "country", x.co || "", countryName))), metaBox);
    if (x.about) box.append(el("p", { class: "af-about" }, x.about)); // what Gemini found out about it
  } else {
    box.append(el("p", { class: "hint af-later" }, "Suggested genres, year and the uploader are looked up after saving (every few hours)."));
  }
  return box;
}
/* Start and End of a section of a long video: shown when a link with a time is pasted (or the track has a section).
   Clear takes the time out of the link and leaves the whole video. */
const hms = (sec) => { sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, x = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
function readHms(v) { // "1:45:35", "105:35", "6335" -> seconds; "" -> 0; not a time -> null
  v = String(v || "").trim(); if (!v) return 0;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(v)) return null;
  return v.split(":").reduce((a, n) => a * 60 + +n, 0);
}
function timeInLink(u) { // t=7225, t=7225s, t=2h0m25s, t=1:02:05, start=, #t= -> seconds, or null
  const m = String(u || "").match(/[?&#](?:t|start|time_continue)=([\dhms:.]+)/i);
  if (!m) return null;
  const v = m[1].replace(/\.\d+$/, "");
  if (/^\d+s?$/.test(v)) return parseInt(v, 10);
  if (/^[\d:]+$/.test(v)) return readHms(v);
  const p = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
  return p ? (+p[1] || 0) * 3600 + (+p[2] || 0) * 60 + (+p[3] || 0) : null;
}
function linkWithoutTime(u) {
  try {
    const x = new URL(u.trim());
    for (const k of ["t", "start", "time_continue", "si", "feature", "pp", "list", "index", "start_radio", "rv"]) x.searchParams.delete(k);
    for (const k of [...x.searchParams.keys()]) if (/^(fbclid|utm_)/.test(k)) x.searchParams.delete(k);
    if (/^#t=/.test(x.hash)) x.hash = "";
    return x.toString();
  } catch { return u; }
}
function withoutPlaylist(u) { // a YouTube video link that is part of a playlist or mix: the playlist parts go (a link to a whole playlist stays)
  try {
    const x = new URL(u.trim());
    if (!/(^|\.)(youtube\.com|youtu\.be)$/.test(x.hostname) || !(x.searchParams.get("v") || x.hostname.endsWith("youtu.be"))) return u;
    let n = 0;
    for (const k of ["list", "index", "start_radio", "pp", "rv", "si", "feature"]) if (x.searchParams.has(k)) { x.searchParams.delete(k); n++; }
    return n ? x.toString() : u;
  } catch { return u; }
}
function videoLength(u) { // the whole video's length when it's already known (seconds), else 0
  const id = (String(u || "").match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1];
  return ((extra[u] || extra[linkWithoutTime(u)] || (id && extra["https://www.youtube.com/watch?v=" + id]) || {}).d) || 0;
}
function sectionFields(tr) {
  const field = (label, name) => {
    const input = el("input", { type: "text", name, class: "tag-input af-time-in", inputmode: "numeric", autocomplete: "off", spellcheck: "false", "aria-label": label, placeholder: label });
    input.addEventListener("input", () => input.setCustomValidity(""));
    return [el("span", { class: "tag-field af-time-f", onmousedown: (e) => { if (e.target !== input) { e.preventDefault(); input.focus(); } } }, input), input];
  };
  const [sf, start] = field("Start", "secStart"), [ef, end] = field("End", "secEnd");
  let url = tr ? tr.url : "", cleared = false;
  const had = !!(tr && (tr.start || tr.end));
  const box = el("span", { class: "af-time", hidden: !had }, sf, ef,
    el("button", { type: "button", class: "btn ghost af-clear", onclick: () => {
      const f = box.closest("form"); f.url.value = linkWithoutTime(f.url.value);
      start.value = end.value = ""; box.hidden = true; cleared = true;
    } }, "Clear"));
  // the fields as wide as "0:00:00" in their own font (and not a character more)
  const fit = () => requestAnimationFrame(() => {
    if (!start.isConnected || box.hidden) return;
    const c = (fit.c ||= document.createElement("canvas").getContext("2d"));
    c.font = getComputedStyle(start).font;
    const w = Math.ceil(Math.max(...["0:00:00", "8:58:58", "4:44:44", "2:22:22"].map((t) => c.measureText(t).width))) + 2 + "px";
    start.style.setProperty("--tw", w); end.style.setProperty("--tw", w);
  });
  if (had) { let n = 0; const wait = () => (start.isConnected ? fit() : ++n < 20 && setTimeout(wait, 50)); wait(); }
  const fillEnd = () => { const d = videoLength(url); if (!end.value && d) end.value = hms(d); };
  if (had) { start.value = hms(tr.start || 0); if (tr.end) end.value = hms(tr.end); fillEnd(); }
  return {
    box,
    fromLink(v) { // the link field changed: a time in it opens Start and End
      url = v.trim();
      const t = timeInLink(url);
      if (t === null) return;
      cleared = false; box.hidden = false; start.value = hms(t); fillEnd(); fit();
    },
    // {start, end} in seconds (0 = none); null: no section; false: a field isn't a time (it says so)
    get() {
      if (box.hidden) return had && cleared ? { start: 0, end: 0 } : null;
      const s = readHms(start.value), e = readHms(end.value), d = videoLength(url);
      if (s === null) { start.setCustomValidity("A time like 1:45:35"); start.reportValidity(); return false; }
      if (e === null || (e && e <= s)) { end.setCustomValidity(e === null ? "A time like 1:45:35" : "After the start"); end.reportValidity(); return false; }
      return { start: s, end: d && e && Math.abs(e - d) <= 1 ? 0 : e }; // the end of the video: no end needed
    },
  };
}
const mixTags = (form) => form.tags.get(); // ("mix" is an ordinary tag: the Mixes page shows tracks tagged "mix")
/* Edit card: a small button inside the field (right), searching the web for the title in the title field, in a new tab */
function inBtn(label, search, input) {
  if (!label) return input;
  return el("span", { class: "af-alt-box" }, input,
    el("button", { type: "button", class: "af-alt-copy", onclick: (e) => {
      e.preventDefault();
      const q = e.currentTarget.closest("form").title.value.trim();
      if (q) open(search + encodeURIComponent(q), "_blank", "noopener");
    } }, label));
}
function closeAddForm(form, opts = {}) {
  if (!form) return;
  if (form.tags) form.tags.restore();
  if (form.parentElement && form.parentElement.classList.contains("edit-li")) {
    const wrap = form.parentElement, th = form.closest(".thread"), row = wrap.previousElementSibling, inBox = !!wrap.closest(".scroll-list");
    if (wrap._ro) wrap._ro.disconnect();
    if (row) row.classList.remove("editing");
    wrap.remove(); fitList(th);
    // (the page stays where it is)
    return;
  }
  if (form.parentElement && form.parentElement.id === "addPanel") { $("#addPanel").hidden = true; $("#addBtn").setAttribute("aria-expanded", "false"); }
  const inThread = form.parentElement && form.parentElement.classList.contains("thread");
  form.remove();
  if (inThread && addingId) { // the thread shows all its tracks again and is no longer selected
    const t = threads.find((x) => x.id === addingId);
    addingId = null; setActive(null);
    if (t) rerenderKeep(t, null);
  }
}
/* only one add/edit card open at a time */
function closeAllCards() { document.querySelectorAll(".add-form").forEach((f) => closeAddForm(f, { quiet: true })); }
function openAdd(thread) {
  if (!canEdit()) { openSetup(); return; }
  if (thread) toggleAddForm(thread, document.getElementById("th-" + thread.id));
  else toggleHeaderForm();
}
function toggleHeaderForm() {
  if (!canEdit()) { openSetup(); return; }
  const panel = $("#addPanel");
  if (!panel.hidden) { closeAddForm(panel.querySelector("form")); return; }
  if (!$("#menu").hidden) toggleMenu(false); // stays on this page
  closeAllCards();
  panel.replaceChildren(addForm(null));
  panel.hidden = false; $("#addBtn").setAttribute("aria-expanded", "true");
  panel.querySelector("input").focus();
}
function toggleAddForm(thread, li) {
  if (!canEdit()) { openSetup(); return; }
  if (!li) return;
  const open = li.querySelector(":scope > .add-form");
  if (open) { closeAddForm(open); return; }
  closeAllCards();
  const form = addForm(thread);
  li.querySelector(".thread-foot").after(form);
  form.querySelector("input").focus({ preventScroll: true });
  revealWhole(form); // the card in view
}
$("#addBtn").onclick = toggleHeaderForm;

function toggleEditForm(t, i, row) {
  if (!canEdit()) { openSetup(); return; }
  const next = row.nextElementSibling;
  if (next && next.classList.contains("edit-wrap")) { closeAddForm(next.querySelector(".add-form")); return; }
  closeAllCards();
  if (t.kind === "tag") { // the track lives in its own thread; edit it there
    const tr = t.tracks[i], home = threads.find((x) => x.kind !== "tag" && x.tracks.includes(tr));
    if (!home) return;
    t = home; i = home.tracks.indexOf(tr);
  }
  const form = addForm(null, { t, i }, row);
  const wrap = el(row.tagName === "LI" ? "li" : "div", { class: "edit-wrap edit-li" }, form);
  row.after(wrap);
  const box = wrap.closest(".scroll-list");
  form.title.focus({ preventScroll: true }); // start in the title
  if (box) {
    // inside a scrolling box: the box grows to fit the card (and its More info), the track goes a third of the way down
    const base = box.clientHeight, grow = () => { box.style.maxHeight = base + wrap.offsetHeight + "px"; };
    grow();
    wrap._ro = new ResizeObserver(grow); wrap._ro.observe(wrap);
  }
  // the page stays where it is (the ▾ in the card brings the track to the top)
}

async function writeInbox(item, kind) {
  if (!item.ts) item.ts = Math.floor(Date.now() / 1000);
  if (!getToken() && level() === 2) { // level 2: saved through the Activity server (which holds a GitHub key of its own)
    const r = await fetch(ACT_URL + "/inbox", { method: "POST", headers: { Authorization: "Session " + session().token, "Content-Type": "text/plain" }, body: JSON.stringify({ item, kind: kind || "" }) });
    if (r.ok) { watchPublish(item); return; }
    const why = (await r.json().catch(() => ({}))).error || "";
    if (r.status === 401) throw new Error("The login ran out. Log in again with the lock at the top right. Nothing was saved.");
    if (r.status === 403) throw new Error("This can only be done with the key. Nothing was saved.");
    throw new Error(`The server answered ${r.status}${why ? " (" + why + ")" : ""}. Nothing was saved; try again.`);
  }
  // 409: someone else's change reached GitHub at the same moment (another save, or the site's own update): tried again
  let r;
  for (let k = 0; k < 5; k++) {
    if (k) await new Promise((ok) => setTimeout(ok, 700 * k + Math.random() * 500));
    const name = `${Date.now()}${kind ? "-" + kind : ""}.json`;
    r = await gh(`/contents/inbox/${name}`, {
      method: "PUT",
      body: JSON.stringify({ message: kind ? `${kind[0].toUpperCase() + kind.slice(1)} track` : "Add track", content: toBase64(JSON.stringify(item, null, 2) + "\n") }),
    });
    if (r.status !== 409) break;
  }
  if (!r.ok) {
    if (r.status === 401) throw new Error("The saved key no longer works (expired or deleted). Open the site with #setup and paste a new one.");
    throw new Error(`GitHub answered ${r.status}. Nothing was saved; try again.`);
  }
  watchPublish(item);
}
/* After a save: once the site has been published again (a minute or two later), the archive is loaded again quietly,
   so promoted, moved and added tracks are as on the server (searchable, with their own addresses) without a reload.
   Only index.html (6 KB) is looked at, every 15 s, for up to 6 minutes after the last save; then tracks.json and
   meta.json once. Waits while a card or the quick tag field is open, and keeps the page where it is.
   Only when every save made here has reached the server's data (data/changes.jsonl lists them): an older version
   would take away what was just saved (tags on the next track, say) until the next one. */
let pub = null, pendingSaves = [], saveSeq = 0;
const saveKey = (c) => [c.action || "", c.ts, JSON.stringify(c.ids || c.id || c.url || c.from || "")].join("|");
const siteVersion = () => fetch("index.html?check=" + Date.now(), { cache: "no-store" }).then((r) => r.text()).then((h) => (h.match(/app\.js\?v=([\w-]+)/) || [])[1] || "").catch(() => "");
async function watchPublish(item) {
  saveSeq++;
  if (item && item.action !== "tagdesc") pendingSaves.push({ key: saveKey(item), at: Date.now() }); // (a tag's description isn't in the change log)
  const until = Date.now() + 6 * 60000;
  if (pub) { pub.until = until; return; }
  pub = { until, base: await siteVersion() };
  const tick = async () => {
    if (!pub) return;
    if (Date.now() > pub.until) { pub = null; return; }
    const v = await siteVersion();
    if (v && pub.base && v !== pub.base) { pub.base = v; await freshData(v); }
    if (!pub.base) pub.base = v;
    setTimeout(tick, 15000);
  };
  setTimeout(tick, 15000);
}
/* the version of the site this page's data came from; Backspace loads the data again when a newer one is published */
let dataVersion = ((document.querySelector('script[src*="app.js?v="]') || {}).src || "").match(/v=([\w-]+)/)?.[1] || "";
async function freshIfNewer() {
  const v = await siteVersion();
  if (v && v !== dataVersion) freshData(v);
}
async function freshData(version) {
  const busy = () => document.querySelector(".add-form") || quick || (document.activeElement && document.activeElement.closest && document.activeElement.closest("input, textarea, [contenteditable]") && document.activeElement !== $("#q"));
  if (busy()) { setTimeout(() => freshData(version), 10000); return; } // (not while something is being edited: later)
  const seq = saveSeq;
  // which saves the published data holds: the end of the change log
  pendingSaves = pendingSaves.filter((p) => Date.now() - p.at < 10 * 60000); // (one that never arrives doesn't hold it up forever)
  if (pendingSaves.length) {
    let tail = "";
    try { tail = await fetch("data/changes.jsonl?fresh=" + Date.now(), { cache: "no-store", headers: { Range: "bytes=-60000" } }).then((r) => (r.ok ? r.text() : "")); } catch {}
    const done = new Set();
    for (const line of tail.split("\n")) { try { done.add(saveKey(JSON.parse(line))); } catch {} }
    pendingSaves = pendingSaves.filter((p) => !done.has(p.key));
    if (pendingSaves.length) return; // not all there yet: the next publish
  }
  let d, m;
  try {
    [d, m] = await Promise.all([
      fetch("data/tracks.json?fresh=" + Date.now(), { cache: "no-store" }).then((r) => { if (!r.ok) throw 0; return r.json(); }),
      fetch("data/meta.json?fresh=" + Date.now(), { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
  } catch { return; }
  if (busy()) { setTimeout(() => freshData(version), 10000); return; }
  if (saveSeq !== seq) return; // saved again meanwhile: wait for that one to be published
  // where the page is: the first post (or row) on screen and how far down it sits
  const top = headerBottom(), anchor = [...document.querySelectorAll("#threads [id^='th-']")].find((n) => n.getBoundingClientRect().bottom > top + 4);
  const anchorId = anchor && anchor.id, anchorAt = anchor ? anchor.getBoundingClientRect().top : 0;
  const nowTr = playing && playing.thread.tracks[playing.index], nowThread = playing && playing.thread.id;
  if (m) meta = m;
  if (version) dataVersion = version;
  threads = d.threads;
  for (const t of threads) for (const tr of t.tracks) { setYear(tr); setGenresOf(tr); setArtistCountry(tr); }
  threads.push(...makeTagThreads());
  sortThreads();
  gIndex = null;
  if (playing && nowTr) { // the player keeps playing: the same track in the new data
    const t = threads.find((x) => x.id === nowThread && x.tracks.some((y) => y.id === nowTr.id)) || threads.find((x) => isBase(x) && x.tracks.some((y) => y.id === nowTr.id));
    if (t) playing = { ...playing, thread: t, index: t.tracks.findIndex((y) => y.id === nowTr.id) };
  }
  if (view === "activity" || view === "lookup") return; // (those pages don't show the archive)
  if (view === "tags" || view === "tag") refreshTags();
  runSearch();
  if (anchorId) {
    const k = shown.findIndex((x) => "th-" + x.t.id === anchorId);
    if (k > -1) while (rendered <= k && rendered < shown.length) renderMore();
    const n = document.getElementById(anchorId);
    if (n) pageScrollTo(pageY() + n.getBoundingClientRect().top - anchorAt);
  }
  markPlaying();
}
const netMsg = (e) => (e.message === "Failed to fetch" ? "No connection to GitHub. Nothing was saved; try again." : e.message);

/* a track's alternative link, read like a main link ({platform, url, yt, vimeo}); kept in case the main one breaks */
function altSource(t) {
  if (!t.alt) return null;
  try { return { ...parseLocal(t.alt), id: t.id, title: t.title }; } catch { return null; }
}
function parseLocal(url) {
  const yt = (url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/) || [])[1];
  const host = new URL(url).hostname;
  const platform = yt ? "youtube" : /soundcloud/.test(host) ? "soundcloud" : /bandcamp/.test(host) ? "bandcamp" : /vimeo/.test(host) ? "vimeo" : /mixcloud/.test(host) ? "mixcloud" : "link";
  const vimeo = (url.match(/vimeo\.com\/(\d+)/) || [])[1];
  return { platform, url: yt ? `https://www.youtube.com/watch?v=${yt}` : url, yt, vimeo };
}
function rerenderThread(t, flashIndex) {
  const old = document.getElementById("th-" + t.id);
  if (!old) return;
  if (!t.tracks.length) { old.remove(); return; }
  const entry = shown.find((x) => x.t === t); // in search results it stays a search result (no "Add a track here")
  const node = threadNode({ t, hits: entry ? entry.hits : null });
  old.replaceWith(node);
  markPlaying();
  if (entry && entry.hits) requestAnimationFrame(() => { fitList(node); fadeAll(); });
  if (flashIndex != null) {
    const row = node.querySelector(`[data-k="${t.id}:${flashIndex}"]`);
    if (row) { row.classList.add("just-saved"); setTimeout(() => row.classList.remove("just-saved"), 3000); }
  }
}

async function saveEdit(form, { t, i }) {
  const tr = t.tracks[i];
  const fromThread = form.closest(".thread") ? form.closest(".thread").id.slice(3) : t.id; // where the track was edited (a tag thread or its own)
  const typed = form.url.value.trim();
  let url = (typed && timeInLink(typed) !== null ? linkWithoutTime(typed) : typed) || tr.url;
  if (tr.yt && LINK_RE.test(url) && parseLocal(url).yt === tr.yt) url = tr.url; // the same video (with a time, or as youtu.be): not a new link
  const title = form.title.value.trim();
  const sec = form.section.get();
  if (sec === false) return;
  if (url && !LINK_RE.test(url)) {
    form.url.setCustomValidity("Use a Youtube, Soundcloud, Bandcamp, Vimeo or Mixcloud link.");
    form.url.reportValidity();
    return;
  }
  const item = { action: "edit", thread: t.id, id: tr.id, title, url, tags: mixTags(form), ts: Math.floor(Date.now() / 1000) };
  if (url !== tr.url) item.tags = item.tags.filter((g) => g !== "broken link" && g !== "plays on youtube only"); // a new link: those tags go
  const notes = form.notes.value.trim();
  if (notes !== (tr.notes || "")) item.notes = notes;
  const alt = form.alt ? form.alt.value.trim() : (tr.alt || "");
  if (alt && !LINK_RE.test(alt)) {
    form.alt.setCustomValidity("Use a Youtube, Soundcloud, Bandcamp, Vimeo or Mixcloud link.");
    form.alt.reportValidity(); form.alt.addEventListener("input", () => form.alt.setCustomValidity(""), { once: true });
    return;
  }
  if (alt !== (tr.alt || "")) item.alt = alt;
  if (sec && (sec.start !== (tr.start || 0) || sec.end !== (tr.end || 0))) { item.start = sec.start; item.end = sec.end; }
  const rel = form.querySelector(".af-more")?.releaseChanged?.();
  if (rel) item.release = rel;
  const yr = form.querySelector(".af-more")?.yearChanged?.();
  if (yr !== undefined) item.year = yr;
  const gn = form.querySelector(".af-more")?.genresChanged?.();
  if (gn !== undefined) item.genres = gn;
  const ar = form.querySelector(".af-more")?.artistChanged?.(), co = form.querySelector(".af-more")?.countryChanged?.();
  if (ar !== undefined) item.artist = ar;
  if (co !== undefined) item.country = co;
  if (form.date && i === 0) {
    if (!form.date.value) { form.date.reportValidity(); return; }
    const pos = form.querySelector(".af-more").feedPos();
    if (pos) { item.date = form.date.value; item.pos = pos; }
    else if (form.date.value !== (tr.shown_date || tr.date)) item.date = form.date.value;
  }
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button"), save = form.querySelector("button[type=submit]");
  btns.forEach((b) => (b.disabled = true)); save.textContent = "Saving…"; msg.textContent = "";
  try { await writeInbox(item, "edit"); }
  catch (e) { msg.textContent = netMsg(e); save.textContent = "Save"; btns.forEach((b) => (b.disabled = false)); return; }
  // apply on screen right away
  if (url !== tr.url) { const p = parseLocal(url); delete tr.yt; delete tr.vimeo; Object.assign(tr, p); if (!p.yt) delete tr.yt; if (!p.vimeo) delete tr.vimeo; }
  if (title) tr.title = title; else delete tr.title;
  applyTags(tr, item.tags, item.ts);
  if ("notes" in item) { if (notes) tr.notes = notes; else delete tr.notes; }
  if ("alt" in item) { if (alt) tr.alt = alt; else delete tr.alt; }
  if ("start" in item) { for (const k of ["start", "end"]) { if (item[k]) tr[k] = item[k]; else delete tr[k]; } }
  if (item.release) tr.release = item.release;
  if ("year" in item) { tr.year = item.year; setYear(tr); }
  if ("genres" in item) { tr.genres = item.genres; setGenresOf(tr); }
  if ("artist" in item) tr.artist = item.artist;
  if ("country" in item) tr.country = item.country;
  setArtistCountry(tr);
  if (item.date) { // option A: the thread takes its place by this date (on the next load of the feed)
    if (item.date === tr.date && !item.pos) { delete tr.shown_date; delete t.pos_ts; delete t.pos_set; }
    else {
      if (item.date === tr.date) delete tr.shown_date; else tr.shown_date = item.date;
      t.pos_ts = item.pos || Math.floor(Date.parse(item.date + "T12:00:00Z") / 1000); t.pos_set = item.ts;
    }
    sortThreads();
  }
  tr._hay = null;
  rerenderThread(t, i);
  refreshTags();
  refreshHistory();
  // back to the track, at the top (once the re-drawn boxes above it have their final height)
  requestAnimationFrame(() => requestAnimationFrame(() => focusTrack(fromThread, tr, "top")));
}
function applyTags(tr, list, ts) {
  const old = tr.tags || {}, nu = {};
  for (const g of list) nu[g] = old[g] || ts;
  if (Object.keys(nu).length) tr.tags = nu; else delete tr.tags;
}

/* ---------- move a track to another thread ---------- */
const threadLabel = (t) => t.name || info(t.tracks[0]).title;

/* up / down in the thread (from the second place, up makes it the main post) */
function orderBtn(up, fn, disabled) {
  const b = el("button", { type: "button", class: "btn ghost order-btn", "aria-label": up ? "Up in the thread" : "Down in the thread", disabled: disabled || null, onclick: fn });
  b.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${up ? "M2.5 7.5 6 4l3.5 3.5" : "M2.5 4.5 6 8l3.5-3.5"}" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
  return b;
}
async function reorderTrack(form, { t, i }, d) {
  const to = i + d, tr = t.tracks[i], playTr = playing && playing.thread === t ? t.tracks[playing.index] : null;
  if (to < 0 || to >= t.tracks.length) return;
  const msg = form.querySelector(".af-msg");
  try { await writeInbox({ action: "reorder", thread: t.id, id: tr.id, to, ts: Math.floor(Date.now() / 1000) }, "reorder"); }
  catch (e) { msg.textContent = netMsg(e); return; }
  t.tracks.splice(i, 1); t.tracks.splice(to, 0, tr);
  t.tracks.forEach((x, k) => { if (k === 0) x.main = true; else delete x.main; });
  if (playTr) playing.index = t.tracks.indexOf(playTr);
  closeAddForm(form, { quiet: true });
  rerenderThread(t, to); markPlaying();
  // the card opens again on the track, with the extended part open
  const row = document.querySelector(`.track[data-k="${CSS.escape(t.id)}:${to}"], .head-row[data-k="${CSS.escape(t.id)}:${to}"]`);
  if (row) { toggleEditForm(t, to, row); row.nextElementSibling?.querySelector(".more-info-btn")?.click(); }
}
/* small thin arrows (one place up / down in the feed) */
function stepBtn(up, step) {
  const b = el("button", { type: "button", class: "date-step", "aria-label": up ? "Move up in the feed" : "Move down in the feed", onclick: () => step(up) });
  b.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${up ? "M6 10V2M2.5 5.5 6 2l3.5 3.5" : "M6 2v8M2.5 6.5 6 10l3.5-3.5"}" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
  return b;
}
/* the suggested releases, each with a dotted underline: click one to correct it (× deletes it); saved with the card */
function releaseEditor(tr, x, box) {
  const start = tr.release || x.rl || [], rel = [...start];
  const wrap = el("span", { class: "rel-list rel-releases" });
  const draw = () => wrap.replaceChildren(...(rel.length ? rel.map((r, k) => {
    const item = el("span", { class: "rel-item" + (k ? " rel-other" : "") });
    const edit = () => {
      const input = el("input", { type: "text", class: "rel-input", value: r, size: Math.max(8, r.length + 2), "aria-label": "Release" });
      let finished = false;
      const done = (keep) => { if (finished) return; finished = true; if (keep) { const v = input.value.trim(); if (v) rel[k] = v; else rel.splice(k, 1); } draw(); };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.stopPropagation(); done(false); } });
      input.addEventListener("blur", () => done(true));
      item.replaceChildren(input, el("button", { type: "button", class: "rel-x", "aria-label": "Delete this release",
        onmousedown: (e) => { e.preventDefault(); rel.splice(k, 1); draw(); } }, "×"));
      input.focus(); input.select();
    };
    const btn = el("button", { type: "button", class: "rel-name", onclick: edit }, r);
    item.append(btn);
    // hovering a release: where this one came from
    const at = (x.rl || []).findIndex((n) => n.toLowerCase() === r.toLowerCase());
    const from = tr.release && tr.release.includes(r) && at < 0 ? "set by hand" : at > -1 && x.rls ? x.rls[at] : "";
    if (from) hoverNote(btn, [`From: ${from}` + (at === 0 && x.conf ? ` (${x.conf} confidence)` : "")]);
    return item;
  }) : [el("button", { type: "button", class: "rel-name rel-none", onclick: () => { rel.push(""); draw(); wrap.querySelector(".rel-name").click(); } }, // add one yourself
    start.length || tr.release ? "none" : x.chk && x.v >= 3 ? "none found" : "not looked up yet")]));
  draw();
  box.releaseChanged = () => (JSON.stringify(rel) !== JSON.stringify(start) ? [...rel] : undefined);
  return wrap;
}
/* the suggested genres, each clicked to change or delete it; "+ add" for one more. Saved as the track's genres. */
function genreEditor(tr, x, box) {
  const start = [...new Set(x.gm || (x.g || []).map(sameGenre))], gs = [...start]; // written as the site writes them
  const wrap = el("span", { class: "rel-list rel-releases" });
  const editAt = (k) => {
    const item = wrap.children[k] || wrap.appendChild(el("span", { class: "rel-item" }));
    const input = el("input", { type: "text", class: "rel-input", value: gs[k] || "", size: Math.max(8, (gs[k] || "").length + 2), "aria-label": "Genre" });
    let finished = false;
    const done = (keep) => {
      if (finished) return; finished = true;
      if (keep) { const v = sameGenre(input.value || ""); if (v && !gs.some((g, j) => g === v && j !== k)) gs[k] = v; else gs.splice(k, 1); } else if (gs[k] === undefined) gs.splice(k, 1);
      draw();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.stopPropagation(); done(false); } });
    input.addEventListener("blur", () => done(true));
    item.replaceChildren(input, el("button", { type: "button", class: "rel-x", "aria-label": "Delete this genre",
      onmousedown: (e) => { e.preventDefault(); finished = true; gs.splice(k, 1); draw(); } }, "×"));
    input.focus(); input.select();
  };
  const draw = () => wrap.replaceChildren(
    ...gs.map((g, k) => el("span", { class: "rel-item" }, el("button", { type: "button", class: "rel-name", onclick: () => editAt(k) }, g))),
    el("span", { class: "rel-item" }, el("button", { type: "button", class: "rel-name rel-none", onclick: () => { gs.push(undefined); gs.pop(); editAt(gs.length); } },
      gs.length ? "+ add" : start.length || tr.genres ? "none" : x.chk ? "none found" : "not looked up yet")));
  draw();
  box.genresChanged = () => (JSON.stringify(gs) !== JSON.stringify(start) ? [...gs] : undefined);
  box.removeGenre = (g) => { const k = gs.indexOf(g); if (k > -1) { gs.splice(k, 1); draw(); } };
  return wrap;
}
/* genres set by hand replace the suggested ones everywhere */
function setGenresOf(tr) {
  if (!Array.isArray(tr.genres)) return;
  const x = extra[tr.url] || (extra[tr.url] = {});
  x.g = [...tr.genres]; x.gm = [...new Set(tr.genres.map(sameGenre))];
  tr._hay = null; gIndex = null;
}
/* one value (Artist, Country), clicked to change it like the year; emptied it means "none". box[name + "Changed"]()
   gives the new value when it was changed */
function textEditor(box, name, start, show) {
  let val = start;
  const wrap = el("span", { class: "rel-list" });
  const draw = () => wrap.replaceChildren(el("span", { class: "rel-item" }, el("button", { type: "button", class: "rel-name" + (val ? "" : " rel-none"), onclick: edit }, val ? show(val) : "unknown")));
  function edit() {
    const input = el("input", { type: "text", class: "rel-input", value: show(val), size: Math.max(10, show(val).length + 2), "aria-label": name });
    let finished = false;
    const done = (keep) => { if (finished) return; finished = true; if (keep) val = input.value.trim().slice(0, 120); draw(); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.stopPropagation(); done(false); } });
    input.addEventListener("blur", () => done(true));
    wrap.replaceChildren(el("span", { class: "rel-item" }, input));
    input.focus(); input.select();
  }
  draw();
  box[name + "Changed"] = () => (val !== start && show(val) !== show(start) ? val : undefined);
  return wrap;
}
/* artist and country set by hand replace the looked-up ones */
function setArtistCountry(tr) {
  if (tr.artist === undefined && tr.country === undefined) return;
  const x = extra[tr.url] || (extra[tr.url] = {});
  if (tr.artist !== undefined) x.ar = tr.artist;
  if (tr.country !== undefined) x.co = tr.country;
}
/* the suggested year, clicked to change it (like the release); emptied it means "no year" */
function yearEditor(tr, x, box) {
  const start = x.y || 0;
  let year = start;
  const wrap = el("span", { class: "rel-list" });
  const draw = () => wrap.replaceChildren(el("span", { class: "rel-item" }, year
    ? el("button", { type: "button", class: "rel-name", onclick: edit }, String(year))
    : el("button", { type: "button", class: "rel-name rel-none", onclick: edit }, tr.year === 0 ? "none" : x.chk ? "none found" : "not looked up yet")));
  function edit() {
    const input = el("input", { type: "text", class: "rel-input", value: year || "", size: 6, inputmode: "numeric", maxlength: 4, "aria-label": "Year" });
    let finished = false;
    const done = (keep) => {
      if (finished) return; finished = true;
      if (keep) { const v = input.value.trim(), n = parseInt(v, 10); if (!v) year = 0; else if (/^\d{4}$/.test(v) && n >= 1900 && n <= new Date().getFullYear()) year = n; }
      draw();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.stopPropagation(); done(false); } });
    input.addEventListener("blur", () => done(true));
    wrap.replaceChildren(el("span", { class: "rel-item" }, input));
    input.focus(); input.select();
  }
  draw();
  box.yearChanged = () => (year !== start ? year : undefined);
  return wrap;
}
/* a year set by hand replaces the suggested one everywhere (search, decades, Genres); the suggestion stays as "also" */
function setYear(tr) {
  if (tr.year === undefined) return;
  const x = extra[tr.url] || (extra[tr.url] = {});
  if (x.y0 === undefined) x.y0 = x.y || null;
  x.y = tr.year || null;
  x.ys = [x.y0, ...(x.ys || [])].filter((y, k, all) => y && y !== x.y && all.indexOf(y) === k);
  tr._hay = null; gIndex = null;
}
const keyOnly = (n) => { if (n) n.classList.add("key-only"); return n; }; // (deleting and moving: only with the key)
function movePanel(formOf, edit) {
  const input = el("input", { type: "search", placeholder: "Search a track in the thread you want to move it to", autocomplete: "off", spellcheck: "false" });
  // the matches open in a box of their own over the page (three at a time; scroll it for the rest)
  const list = el("ul", { class: "move-results move-pop", hidden: true });
  const place = () => {
    if (!input.isConnected) { list.remove(); removeEventListener("scroll", place, true); removeEventListener("resize", place); return; }
    if (list.hidden) return;
    const r = input.getBoundingClientRect(), h = list.offsetHeight, below = innerHeight - dockH() - r.bottom - 8;
    list.style.left = r.left + "px"; list.style.width = r.width + "px";
    list.style.top = (below >= h || below >= r.top - headerBottom() ? r.bottom + 4 : r.top - 4 - h) + "px";
  };
  const hide = () => { list.hidden = true; };
  addEventListener("scroll", place, true); addEventListener("resize", place);
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) hide(); }, 150));
  input.addEventListener("focus", () => { if (list.children.length) { list.hidden = false; place(); } });
  // Promote (replies only): the track becomes its own thread, at the top of the feed or at its own date
  // Isolate (a main post with replies): it becomes a thread of its own just above; the first reply becomes the main post
  const promote = edit.i > 0 ? el("span", { class: "promote" }) : edit.t.tracks.length > 1 ? el("span", { class: "promote" },
    el("button", { type: "button", class: "btn ghost promote-btn", onclick: (e) => {
      const b = e.currentTarget;
      if (b.dataset.confirm) { clearTimeout(b._t); promoteTrack(formOf(), edit, "isolate"); return; }
      b.style.minWidth = b.getBoundingClientRect().width + "px"; b.dataset.confirm = "1"; b.textContent = "Confirm";
      b._t = setTimeout(() => { delete b.dataset.confirm; b.textContent = "Isolate"; }, 5000);
    } }, "Isolate")) : null;
  const drawPromote = (ask) => edit.i > 0 && promote.replaceChildren(
    ...(ask ? [] : [el("button", { type: "button", class: "btn ghost promote-btn", onclick: () => drawPromote(true) }, "Promote")]),
    ...(ask ? [
      el("button", { type: "button", class: "btn ghost promote-btn", onclick: () => promoteTrack(formOf(), edit, "main") }, "To the top"),
      el("button", { type: "button", class: "btn ghost promote-btn", onclick: () => promoteTrack(formOf(), edit, "top") }, "Own thread (new)"),
      el("button", { type: "button", class: "btn ghost promote-btn", onclick: () => promoteTrack(formOf(), edit, "original") }, "Own thread (dated)")] : []));
  drawPromote(false);
  const panel = el("div", { class: "move-panel" }, el("span", { class: "af-label-line" }, "Move to the thread of…"),
    el("div", { class: "move-row" }, input, promote));
  document.body.append(list);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const first = list.querySelector("button"); if (first) first.click(); }
    else if (e.key === "Escape" && !list.hidden) { e.preventDefault(); e.stopPropagation(); hide(); }
  });
  input.addEventListener("input", () => {
    const terms = fold(input.value).split(" ").filter(Boolean);
    list.replaceChildren();
    if (!terms.length) { hide(); return; }
    list.hidden = false;
    const found = [], all = new Set(); // (matched as the main search does, with every part of a track searched; best match first)
    for (const t of threads) {
      if (t === edit.t || t.kind === "tag") continue;
      const byName = t.name && terms.every((w) => fold(t.name).includes(w));
      let k = byName ? 0 : -1, rank = byName ? 0 : 99;
      if (!byName) t.tracks.forEach((tr, i) => { if (matches(tr, terms, all)) { const r = matchRank(tr, terms); if (r < rank) { rank = r; k = i; } } });
      if (k > -1) found.push({ t, k, rank });
    }
    found.sort((a, b) => Math.floor(a.rank) - Math.floor(b.rank) || fit(a.rank) - fit(b.rank) || (b.k === 0) - (a.k === 0) || a.rank - b.rank || activity(b.t) - activity(a.t));
    if (!found.length) { list.appendChild(el("li", { class: "move-none hint" }, "No other thread has a track like that.")); place(); return; }
    for (const { t, k } of found) {
      const x = info(t.tracks[k]);
      list.appendChild(el("li", {},
        el("button", { type: "button", class: "move-hit", onmousedown: (e) => e.preventDefault(), onclick: () => { hide(); moveTrack(formOf(), edit, t); } },
          el("span", { class: "mh-thumb" }, img(x.thumb, "thumb-img")),
          el("span", { class: "mh-text" },
            el("span", { class: "mh-title" }, x.title),
            el("span", { class: "mh-thread" }, "Thread: " + threadLabel(t) + ` (${t.tracks.length} ${t.tracks.length === 1 ? "track" : "tracks"})`)))));
    }
    list.scrollTop = 0; place();
  });
  return panel;
}

async function promoteTrack(form, { t, i }, to) {
  const tr = t.tracks[i], ts = Math.floor(Date.now() / 1000);
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true)); msg.textContent = to === "isolate" ? "Isolating…" : "Promoting…";
  try { await writeInbox({ action: "promote", thread: t.id, id: tr.id, to, ts }, "promote"); }
  catch (e) { msg.textContent = netMsg(e); btns.forEach((b) => (b.disabled = false)); return; }
  if (to === "isolate") { // its own thread, just above; the first reply becomes the main post
    t.tracks.shift();
    t.tracks.forEach((x, k) => { if (k === 0) x.main = true; else delete x.main; });
    tr.main = true;
    const id = threads.some((x) => x.id === "x" + tr.id) ? "xi" + tr.id : "x" + tr.id;
    const nt = { id, kind: "thread", tracks: [tr], date: tr.date, ts: tr.ts, pos_ts: activity(t) + 1, pos_set: ts };
    if (playing && playing.thread === t) { if (playing.index === 0) playing.thread = nt; else playing.index--; }
    threads.push(nt); sortThreads();
    closeAddForm(form, { quiet: true });
    rerenderThread(t, 0);
    const node = document.getElementById("th-" + t.id), k = shown.findIndex((x) => x.t === t);
    if (node && k > -1) { node.before(threadNode({ t: nt, hits: null })); shown.splice(k, 0, { t: nt, hits: null }); rendered++; }
    refreshTags(); refreshHistory(); return;
  }
  if (to === "main") { // the main post of its thread; the old one becomes the first reply. The thread keeps its date
    const day = postDate(t);
    t.tracks.unshift(t.tracks.splice(i, 1)[0]);
    if (day && day !== tr.date) tr.shown_date = day; else delete tr.shown_date;
    t.tracks.forEach((x, k) => { if (k === 0) x.main = true; else delete x.main; });
    closeAddForm(form, { quiet: true }); rerenderThread(t, 0); refreshHistory(); return;
  }
  // on screen right away: its own thread
  t.tracks.splice(i, 1);
  tr.main = true;
  const nt = { id: "x" + tr.id, kind: "thread", tracks: [tr], date: tr.date, ts: tr.ts };
  if (to === "top") { tr.shown_date = new Date(ts * 1000).toISOString().slice(0, 10); nt.pos_ts = ts; nt.pos_set = ts; }
  else if (tr.added) { // added here, so its own date is the day it was added: date it like the thread it came from, just above it
    const day = postDate(t);
    if (day && day !== tr.date) tr.shown_date = day;
    nt.pos_ts = (t.pos_ts || t.ts) + 1; nt.pos_set = ts;
  }
  threads.push(nt); sortThreads();
  closeAddForm(form, { quiet: true });
  rerenderThread(t, null);
  if (view === "threads" && !$("#q").value.trim() && to === "top") { $("#threads").prepend(threadNode({ t: nt, hits: null })); shown.unshift({ t: nt, hits: null }); rendered++; }
  refreshHistory();
}
async function moveTrack(form, { t, i }, dest) {
  const tr = t.tracks[i];
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true)); msg.textContent = "Moving…"; msg.textContent = "";
  try { await writeInbox({ action: "move", thread: t.id, id: tr.id, to: dest.id, ts: Math.floor(Date.now() / 1000) }, "move"); }
  catch (e) { msg.textContent = netMsg(e); btns.forEach((b) => (b.disabled = false)); return; }
  if (playing && playing.thread === t) playing = null;
  t.tracks.splice(i, 1);
  t.tracks.forEach((x, k) => { if (k === 0) x.main = true; else delete x.main; });
  delete tr.main;
  dest.tracks.push(tr); // the newest reply of its new thread, like "Add a track here"
  dest.tracks.forEach((x, k) => { if (k === 0) x.main = true; else delete x.main; });
  if (!t.tracks.length) { threads.splice(threads.indexOf(t), 1); shown = shown.filter((x) => x.t !== t); }
  rerenderThread(t, null);
  rerenderThread(dest, dest.tracks.indexOf(tr));
  refreshTags();
  // say where it went, on the spot where the track was
  const src = document.getElementById("th-" + t.id);
  if (src) {
    const note = el("p", { class: "moved-note" }, "Moved to: ", el("a", { href: "#th-" + dest.id, onclick: (e) => { e.preventDefault(); const n = document.getElementById("th-" + dest.id); if (n) n.scrollIntoView({ behavior: "smooth", block: "center" }); else { history.replaceState(null, "", `#t/${dest.id}`); threads.unshift(threads.splice(threads.indexOf(dest), 1)[0]); runSearch(); pageScrollTo(0); } } }, threadLabel(dest)));
    src.querySelector(".thread-foot").before(note);
    setTimeout(() => note.remove(), 8000);
  }
}

async function deleteTrack(form, { t, i }, btn) {
  if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "Confirm delete"; return; }
  const tr = t.tracks[i];
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true)); btn.textContent = "Deleting…"; msg.textContent = "";
  try { await writeInbox({ action: "delete", thread: t.id, id: tr.id, ts: Math.floor(Date.now() / 1000) }, "delete"); }
  catch (e) { msg.textContent = netMsg(e); btn.textContent = "Delete"; btn.dataset.confirm = ""; btns.forEach((b) => (b.disabled = false)); return; }
  if (playing && playing.thread === t && playing.index === i) playing = null;
  t.tracks.splice(i, 1);
  if (t.tracks[0]) t.tracks[0].main = true;
  if (!t.tracks.length) { threads.splice(threads.indexOf(t), 1); shown = shown.filter((x) => x.t !== t); }
  rerenderThread(t, null);
  if (tr.tags) refreshTags();
  refreshHistory();
}
/* History: draw the months on screen again after an edit (fold-outs that were open stay open) */
function refreshHistory() {
  if (view !== "history" || $("#q").value.trim()) return;
  const open = new Set([...document.querySelectorAll(".month-tracks:not([hidden])")].map((o) => o.closest(".month-row").querySelector(".month-line").dataset.k));
  const items = new Map(historyMonths().map((m) => [m.id, m]));
  shown.forEach((x) => {
    const nm = items.get(x.t.id), node = document.getElementById("th-" + x.t.id);
    if (nm) { x.t = nm; if (node) node.replaceWith(monthNode({ t: nm })); } else if (node) node.remove();
  });
  document.querySelectorAll(".month-line").forEach((l) => { if (open.has(l.dataset.k)) l.querySelector(".month-n")?.click(); });
  markPlaying();
}

async function saveTrack(form, thread) {
  const url = form.url.value.trim();
  if (!url && !form.title.value.trim()) { form.title.setCustomValidity("A title, a link, or both."); form.title.reportValidity(); form.title.addEventListener("input", () => form.title.setCustomValidity(""), { once: true }); return; }
  if (url && !LINK_RE.test(url)) {
    form.url.setCustomValidity("Use a Youtube, Soundcloud, Bandcamp, Vimeo or Mixcloud link.");
    form.url.reportValidity();
    return;
  }
  const ts = Math.floor(Date.now() / 1000);
  const sec = form.section.get();
  if (sec === false) return;
  const item = { url: url ? linkWithoutTime(url) : url, title: form.title.value.trim(), thread: thread ? thread.id : "", tags: mixTags(form), ts };
  if (sec && sec.start) item.start = sec.start;
  if (sec && sec.end) item.end = sec.end;
  if (form.notes.value.trim()) item.notes = form.notes.value.trim();
  const msg = form.querySelector(".af-msg"), btn = form.querySelector("button[type=submit]");
  btn.disabled = true; btn.textContent = "Saving…"; msg.textContent = "";
  try { await writeInbox(item, ""); }
  catch (e) { msg.textContent = netMsg(e); btn.textContent = "Save"; btn.disabled = false; return; }
  closeAddForm(form);
  showLocally(item);
}

/* show the new track right away; the full title and thumbnail arrive with the next site update */
function showLocally(item) {
  const yt = (item.url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1];
  const host = item.url ? new URL(item.url).hostname : "";
  const platform = !item.url ? "none" : yt ? "youtube" : /soundcloud/.test(host) ? "soundcloud" : /bandcamp/.test(host) ? "bandcamp" : /vimeo/.test(host) ? "vimeo" : /mixcloud/.test(host) ? "mixcloud" : "link";
  const tr = { id: `t${item.ts}_0`, date: new Date(item.ts * 1000).toISOString().slice(0, 10), ts: item.ts, platform, url: item.url };
  if (yt) tr.yt = yt;
  if (item.title) tr.title = item.title;
  if (item.notes) tr.notes = item.notes;
  if (item.start) tr.start = item.start;
  if (item.end) tr.end = item.end;
  if (item.tags && item.tags.length) applyTags(tr, item.tags, item.ts);
  let th = item.thread && threads.find((x) => x.id === item.thread);
  if (th) th.tracks.push(tr);
  else { tr.main = true; th = { id: `p${item.ts}`, date: tr.date, ts: item.ts, kind: "thread", tracks: [tr] }; threads.unshift(th); }
  // update only what changed, so the page doesn't jump
  const old = document.getElementById("th-" + th.id);
  const node = threadNode({ t: th, hits: null });
  if (old) old.replaceWith(node);
  else if (!$("#q").value.trim() && view === "threads") { $("#threads").prepend(node); rendered++; shown.unshift({ t: th, hits: null }); }
  markPlaying();
  const row = node.querySelector(`[data-k="${th.id}:${th.tracks.length - 1}"]`);
  if (row) {
    row.classList.add("just-saved");
    row.querySelector(".tr-sub, .t-sub")?.prepend(el("span", { class: "saved-tag" }, "Saved"));
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => row.classList.remove("just-saved"), 4000);
  }
  if (item.tags && item.tags.length) refreshTags();
}


async function copyText(text, btn, done) {
  try { await navigator.clipboard.writeText(text); } catch { prompt("Copy this:", text); return; }
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent; // (pressed again while it says "Copied": still goes back to its own name)
  btn.textContent = done; btn.classList.add("done");
  clearTimeout(btn._copied);
  btn._copied = setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove("done"); delete btn.dataset.label; }, 2500);
}
function copyLink(t, btn) {
  copyText(`${location.origin}${location.pathname}#t/${t.id}`, btn, "Copied");
}

/* Escape: close every add/edit card and leave the search */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#threadPop").hidden) { closeThread(); return; } // the "1 of 5 in this thread" list closes first
  const cards = document.querySelectorAll(".add-form");
  if (cards.length) { cards.forEach((f) => closeAddForm(f)); return; } // an open card closes first, nothing else
  if (view === "genres" && gSel.length && !$("#q").value) { setGenres([]); return; } // Genres: Esc empties the field
  if (activeId) setActive(null);
  if (!$("#menu").hidden) toggleMenu(false);
  const now = Date.now(), twice = now - lastEsc < 450;
  lastEsc = twice ? 0 : now;
  if (twice) { showPlaying(); return; }
  document.querySelectorAll(".add-form").forEach((f) => closeAddForm(f));
  if ($("#q").value) { $("#q").value = ""; syncClear(); endSearch(); }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
});
/* a button clicked with the mouse doesn't keep the focus: no ring after the next key, and Enter doesn't press it again */
document.addEventListener("click", (e) => {
  if (!e.detail) return; // a keyboard "click" keeps it
  const b = e.target.closest && e.target.closest("button, a");
  if (b && !b.closest(".add-form, .quick-tag")) setTimeout(() => { if (document.activeElement === b) b.blur(); }, 0);
});
/* Cmd+Backspace (Ctrl+Backspace): like the player's × (computer: the video goes, the bar stays). Caught first.
   Cmd+Left/Right: previous/next track in the thread or tag; Cmd+Up/Down: volume in steps of 2. */
addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const inField = e.target.closest && e.target.closest("input:not([type=range]), textarea, [contenteditable]");
  if (e.key === "Backspace" && playing && !inField) { e.preventDefault(); e.stopPropagation(); closeDock(); return; } // Cmd+Backspace: like the player's ×
  if (inField || $("#dock").hidden || e.shiftKey) return;
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && playing) {
    e.preventDefault(); e.stopPropagation(); // (instead of the browser's Back/Forward)
    $(e.key === "ArrowLeft" ? "#prevBtn" : "#nextBtn").click();
  } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !IOS) {
    e.preventDefault(); e.stopPropagation();
    const v = Math.max(0, Math.min(100, volume + (e.key === "ArrowUp" ? 2 : -2)));
    $("#vol").value = v; $("#vol").dispatchEvent(new Event("input")); flashBtn($("#volWrap"), "lit", 900); // (the number and speaker light up while the keys change it)
  }
}, true);
/* Ctrl+I (Cmd+I): the Edit card of the playing track, on the row on screen, or in its thread.
   Again: the card's more info (▾), again: its Meta, again: the card closes */
addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "i" || !playing) return;
  const card = [...document.querySelectorAll(".edit-wrap")].find((w) => w.offsetParent && w.previousElementSibling && w.previousElementSibling.classList.contains("playing"));
  const inCard = card && e.target.closest && card.contains(e.target);
  if (!inCard && e.target.closest && e.target.closest(".add-form, textarea, [contenteditable]")) return; // (a search field is fine)
  e.preventDefault(); e.stopPropagation();
  if (card) {
    const form = card.querySelector(".add-form"), more = form.querySelector(".af-more"), meta = form.querySelector(".af-meta");
    if (more && more.hidden) form.querySelector(".more-info-btn").click();
    else if (meta && meta.hidden) { form.querySelector(".af-meta-line .thread-btn").click(); meta.scrollIntoView({ block: "nearest" }); }
    else closeAddForm(form);
    return;
  }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (!canEdit()) { openSetup(); return; }
  const edit = (row) => { const b = row && row.querySelector(".edit-btn"); if (!b) return false; b.click(); const w = row.nextElementSibling; (w && w.classList.contains("edit-wrap") ? w : row).scrollIntoView({ block: "center" }); return true; };
  if (edit([...document.querySelectorAll(".playing")].find((r) => r.offsetParent && r.querySelector(".edit-btn")))) return;
  const tr = playing.thread.tracks[playing.index], home = homeOf(tr);
  if (!home) return;
  goToThread(home);
  setTimeout(() => {
    const node = document.getElementById("th-" + home.id), k = `${home.id}:${home.tracks.indexOf(tr)}`;
    edit(node && [...node.querySelectorAll(`[data-k="${k}"]`)].find((r) => r.offsetParent));
  }, 60);
}, true);
/* Esc twice quickly: bring the playing track to the middle of the screen (when it is on the page) */
let lastEsc = 0;
function showPlaying() {
  if (!playing) return;
  const row = [...document.querySelectorAll(".playing")].find((r) => r.offsetParent);
  if (row) focusRow(row, true);
}
/* a track a third of the way down the window (and in view inside its scrolling box) */
function focusTrack(threadId, tr, at = "third") {
  const t = threads.find((x) => x.id === threadId);
  const i = t ? t.tracks.indexOf(tr) : -1;
  const row = i > -1 && document.querySelector(`[data-k="${CSS.escape(threadId)}:${i}"]`);
  if (row) focusRow(row, true, "top", at);
}
function focusRow(row, smooth, boxAt = "center", at = "third") {
  const box = row.closest(".scroll-list"); // inside a scrolling box: first bring it into the box's view
  if (box) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - (boxAt === "top" ? 0 : (box.clientHeight - row.offsetHeight) / 2);
  const top = headerBottom(), dock = dockH();
  const under = contentTop();
  const y = at === "top" ? under + 8 : top + (innerHeight - dock - top) / 3; // right under the header (and History's bar), or a third of the way down
  pageScrollBy(row.getBoundingClientRect().top - y, smooth);
}
/* typing a letter or number anywhere starts a search */
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || e.key === " ") return;
  const t = e.target;
  if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
  $("#q").focus(); // the key itself then lands in the search field
});

/* "Source" in the player: the playing track's own thread (when playing from a tag) */
const homeOf = (tr) => threads.find((x) => x.kind !== "tag" && x.tracks.includes(tr));
$("#discogsBtn").onclick = () => {
  if (!playing) return;
  const title = info(playing.thread.tracks[playing.index]).title;
  open("https://www.google.com/search?q=" + encodeURIComponent("discogs " + title), "_blank", "noopener");
};
$("#sourceBtn").onclick = (e) => {
  if (!playing) return;
  const home = homeOf(playing.thread.tracks[playing.index]);
  if (home && (e.metaKey || e.ctrlKey)) { openThreadTab(home.id); return; }
  if (home) { goToThread(home); markThread(home.id); }
};
/* "flag" in the player (phone): tags the playing track "flagged" (again: takes it off) */
function showFlag() {
  const tr = playing && playing.thread.tracks[playing.index];
  $("#flagBtn").classList.toggle("on", !!(tr && tr.tags && tr.tags.flagged));
}
async function toggleFlag(tr) {
  if (!getToken()) { openSetup(); return false; }
  const on = !(tr.tags && tr.tags.flagged), ts = Math.floor(Date.now() / 1000);
  try { await writeInbox({ action: "tag", ids: [tr.id], add: on ? ["flagged"] : [], remove: on ? [] : ["flagged"], ts }, "tag"); } catch { return false; }
  applyTags(tr, on ? [...Object.keys(tr.tags || {}), "flagged"] : Object.keys(tr.tags || {}).filter((g) => g !== "flagged"), ts);
  tr._hay = null; showFlag(); refreshTags();
  return true;
}
$("#flagBtn").onclick = () => { if (playing) toggleFlag(playing.thread.tracks[playing.index]); };


/* ---------- Tags page: one row per tag, the tag added to most recently first; the automatic tags at the end.
   Computer: three ways to show a row's tracks (thumbnails / thumbnails with titles / a list), and the panel on
   the right with the tag's description, a year range, the order to play in, Rename. Phone: the rows open the panel
   full screen ("Shelves"), or open their tracks in place ("Lists"). ---------- */
const isAutoTag = (g) => AUTO_TAGS.has(g) || / characters$/.test(g); // (every "<script> characters" tag is automatic)
const isPlaylist = (g) => g.startsWith("#"); // a playlist: a tag starting with #; under a track only as PL_MARK
const PL_MARK = "⌗"; // how the site shows the # of a playlist (one place to change it; the Edit card keeps the real #)
const showTag = (g) => (isPlaylist(g) ? PL_MARK + g.slice(1) : g);
const AUTO_TAGS = new Set(["backup link", "duplicate", "+10 min", "+30 min", "+1 hour", "japanese characters", "chinese characters", "korean characters", "broken link", "plays on youtube only", "flagged"]);
let tagInfo = { desc: {} };
fetch("data/tags.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) { tagInfo = { desc: {}, ...d }; if (tagsView()) renderTagsPage(); } }).catch(() => {});
const tagPref = (k, def) => { try { return localStorage.getItem("nrgfm-tags-" + k) || def; } catch { return def; } };
const setTagPref = (k, v) => { try { localStorage.setItem("nrgfm-tags-" + k, v); } catch {} };
const tp = { active: null, pinned: false, editing: false, order: {}, years: {}, lens: {}, open: new Set(), hoverT: 0, terms: [], q: "" };
const yearOf = (tr) => (extra[tr.url] || {}).y || null;
const lenOf = (tr) => { // seconds (a section of a long video: its own length)
  const d = (extra[tr.url] || {}).d || 0, s = tr.start || 0, e = tr.end && (!d || tr.end < d) ? tr.end : d;
  return e > s ? e - s : null;
};
/* a tag's page: "+30 min" (30 min up to an hour) and "+1 hour" can be left out of its list */
const LONG = { "+30 min": (d) => d >= 1800 && d < 3600, "+1 hour": (d) => d >= 3600 };
function tagYears(t) { const ys = t.tracks.map(yearOf).filter(Boolean).sort((a, b) => a - b); return ys; }
function yearsText(ys) { return !ys.length ? "" : ys[0] === ys[ys.length - 1] ? String(ys[0]) : ys[0] + "—" + ys[ys.length - 1]; }
/* the tracks of a tag as they will play: in the year range picked, in the order picked */
function tagPlaylist(t) {
  const [lo, hi] = tp.years[t.name] || [];
  let list = t.tracks.slice(); // most recently tagged first
  if (lo) list = list.filter((tr) => { const y = yearOf(tr); return y && y >= lo && y <= hi; });
  const off = tp.lens[t.name]; // (the long ones left out)
  if (off && off.size) list = list.filter((tr) => { const d = lenOf(tr); return !d || ![...off].some((k) => LONG[k](d)); });
  const order = tp.order[t.name] || "newest";
  if (order === "oldest") list.reverse();
  if (order === "shuffle") { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } }
  return { id: t.id, name: t.name, kind: "tag", tracks: list, last: t.last };
}
function playTag(t, tr) {
  const pl = tagPlaylist(t);
  let i = pl.tracks.indexOf(tr);
  if (i < 0) { pl.tracks = t.tracks.slice(); i = pl.tracks.indexOf(tr); } // (a track outside the year range: the whole tag)
  play(pl, Math.max(0, i));
  if (tp.active === t.name) drawTagPanel();
}

/* ---------- Tags: every tag as a box under its first letter (A–Z, then numbers, playlists and, with the key, the
   automatic tags); the line at the top jumps to a letter. Hover: its tracks in the panel; click: the tag's own page
   (Cmd/Ctrl+click: a new tab). ---------- */
const tagSection = (g) => {
  if (isPlaylist(g)) return "#";
  if (isAutoTag(g)) return "Automatic";
  const c = fold(g).charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "0–9";
};
const SECTION_ORDER = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0–9", "#", "Automatic"];
function tagGridHead() {
  const have = new Set(threads.filter((t) => t.kind === "tag").map((t) => tagSection(t.name)).filter((k) => !tagsByLatest || k === "#")); // (Latest added: no letters)
  const jumps = SECTION_ORDER.filter((k) => k !== "Automatic" && (k !== "#" || level() <= 2)).map((k) => el("button", {
    class: "when-link tg-jump" + (have.has(k) ? "" : " none"), disabled: !have.has(k) || null,
    onclick: () => { const h = document.getElementById("tl-" + k); if (h) pageScrollTo(Math.max(0, (scroller() === window ? scrollY : document.body.scrollTop) + h.getBoundingClientRect().top - contentTop() - 8)); } }, k === "0–9" ? "0\u2060–\u20609" : k)); // (word joiners: 0–9 never breaks)
  return el("div", { class: "tp-head tg-head" }, el("div", { class: "tg-jumps" }, jumps), tagSearchField());
}
function renderTagsGrid() {
  const list = $("#threads");
  const words = [...tp.terms, ...(tp.q.trim() ? [tp.q.trim()] : [])];
  const all = threads.filter((t) => t.kind === "tag" && tagVisible(t.name) && (!words.length || words.some((w) => tagMatches(t.name, w.replace(/^#/, "")) || tagMatches(t.name, w))))
    .sort((a, b) => a.name.replace(/^#/, "").localeCompare(b.name.replace(/^#/, "")));
  if (!all.length) { list.replaceChildren(el("p", { class: "view-note tp-none" }, "No tags match.")); hideTagPanel(); return; }
  const groups = new Map((tagsByLatest ? ["Latest", "#", "Automatic"] : SECTION_ORDER).map((k) => [k, []]));
  if (tagsByLatest) all.sort((a, b) => b.last - a.last); // (playlists and automatic tags still last)
  for (const t of all) { const k = tagSection(t.name); groups.get(tagsByLatest && k !== "#" && k !== "Automatic" ? "Latest" : k).push(t); }
  const card = (t) => {
    const ys = tagYears(t);
    const b = el("a", { class: "tg-card", href: "#/tag/" + encodeURIComponent(t.name), "data-tag": t.name,
      onclick: (e) => { e.preventDefault(); openTagPage(t.name, e); } },
      el("span", { class: "tg-name" }, showTag(t.name)),
      el("span", { class: "tg-meta" }, `${t.tracks.length} ${t.tracks.length === 1 ? "track" : "tracks"}` + (ys.length ? " · " + yearsText(ys) : "")));
    if (!phone()) b.addEventListener("mouseenter", () => { clearTimeout(tp.hoverT); tp.hoverT = setTimeout(() => openTagPanel(t.name, false), 80); });
    return b;
  };
  const out = [];
  for (const [k, ts] of groups) if (ts.length) out.push(el("h2", { class: "tg-letter", id: "tl-" + k }, k === "#" ? "# Playlists" : k === "Automatic" ? "Automatic tags" : k === "Latest" ? "Latest added" : k), el("div", { class: "tg-grid" }, ts.map(card)));
  list.replaceChildren(el("div", { class: "tg-page" }, out));
  const first = [...groups.values()].flat()[0]; // (the first box on the page: A, not an automatic tag)
  if (!phone() && (!tp.active || !all.some((t) => t.name === tp.active))) tp.active = first.name;
  tp.pinned = false;
  if (!phone()) drawTagPanel();
}
/* a tag's own page: #/tag/<name>, all its tracks as one thread (playing one turns autoplay on) */
let tagPageName = null;
function openTagPage(name, e) {
  const href = location.pathname + "#/tag/" + encodeURIComponent(name);
  if (e && (e.metaKey || e.ctrlKey)) { open(href, "_blank"); return; }
  tp.returnTo = view === "tags" ? { terms: tp.terms.slice(), q: tp.q, y: scroller() === window ? scrollY : document.body.scrollTop } : null;
  tagPageName = name;
  history.pushState(null, "", href); // (Back returns to where you were)
  setView("tag", true);
}
function tagsView() { return view === "tags" || view === "tagsrows"; } // (#/tagsrows: this Tags page, kept as a backup of Nov 2026)
/* computer: zoom − / 0 / + : 3 rows of 3 small titles, 2 rows of 2 (default), thumbnails with titles under them;
   every row scrolls sideways through all of the tag's tracks */
const tagZoom = () => { const z = +tagPref("zoom", "1"); return Math.max(-1, Math.min(2, Number.isFinite(z) ? z : 1)); };
const tagMode = () => (phone() ? tagPref("phone", "shelves") : tagZoom() > 1 ? "titles" : "list");
const ZOOM_GRID = { "-1": [3, 3], 0: [2, 3], 1: [2, 2] }; // rows, tracks per row (2×2 by default)
/* Cmd+click (Ctrl+click on Windows) on a track of the Tags page or its panel: the quick tag field for it */
function quickClick(e, t, tr) {
  if (!(e.metaKey || e.ctrlKey) || !canEdit() || phone()) return false;
  e.preventDefault();
  openQuick(null, { t, i: t.tracks.indexOf(tr), tr });
  return true;
}
function tagPageHead() {
  const sort = tagPref("sort", "az"), z = tagZoom();
  const sortBtns = [["az", "A–Z"], ["newest", "Newest added"], ["count", "Track count"]].map(([k, name]) => el("button", { class: "when-link" + (sort === k ? " on" : ""),
    onclick: () => { setTagPref("sort", k); drawViewHead(); renderTagsPage(); pageScrollTo(0); } }, name));
  const zoom = (d) => { setTagPref("zoom", String(Math.max(-1, Math.min(2, z + d)))); drawViewHead(); renderTagsPage(); };
  if (phone()) {
    const mode = tagPref("phone", "shelves");
    return el("div", { class: "tp-head" }, el("div", { class: "tp-views" },
      [["shelves", "Shelves"], ["lists", "Lists"]].map(([k, name]) => el("button", { class: "when-link" + (mode === k ? " on" : ""),
        onclick: () => { setTagPref("phone", k); drawViewHead(); renderTagsPage(); } }, name)),
      el("span", { class: "tp-sort" }, sortBtns)), tagSearchField());
  }
  return el("div", { class: "tp-head" }, el("div", { class: "tp-views" }, sortBtns, tagSearchField(),
    el("span", { class: "tp-zoom" },
      el("button", { class: "when-link", disabled: z <= -1 || null, "aria-label": "Smaller", onclick: () => zoom(-1) }, "−"),
      el("button", { class: "when-link", disabled: z >= 2 || null, "aria-label": "Bigger", onclick: () => zoom(1) }, "+"))));
}
/* the search field of the Tags page: the tags show as you type (a word of the name starting with it); Enter keeps
   the words typed and another can be added; a suggestion picked with the arrows and Enter keeps that tag, which is
   also kept in the panel */
const tagMatches = (name, q) => { const f = fold(name), w = fold(q); return !w || f.startsWith(w) || f.split(" ").some((x) => x.startsWith(w)); };
function tagSearchField() {
  const input = el("input", { type: "text", class: "tag-input", placeholder: tp.terms.length ? "" : "Search tags", autocomplete: "off", spellcheck: "false", "aria-label": "Search tags" });
  input.value = tp.q || "";
  const chips = el("span", { class: "tag-chips-in" });
  const field = el("span", { class: "tag-field", onmousedown: (e) => { if (e.target === field || e.target === chips) { e.preventDefault(); input.focus(); } } }, chips, input);
  const drop = el("div", { class: "tag-drop", hidden: true });
  const clear = el("button", { type: "button", class: "btn ghost square gm-clear", "aria-label": "Clear", onclick: () => { tp.terms = []; tp.q = ""; input.value = ""; update(); input.focus(); } });
  clear.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  let opts = [], active = -1;
  const drawChips = () => {
    chips.replaceChildren(...tp.terms.map((g) => el("button", { type: "button", class: "tag-chip in", onmousedown: (e) => e.preventDefault(),
      onclick: () => { tp.terms = tp.terms.filter((x) => x !== g); update(); } }, showTag(g), el("span", { class: "x", "aria-hidden": "true" }, " ×"))));
    input.placeholder = tp.terms.length ? "" : "Search tags";
    clear.hidden = !tp.terms.length && !input.value;
  };
  const drawDrop = () => {
    const q = input.value.trim();
    opts = q ? threads.filter((t) => t.kind === "tag" && tagMatches(t.name, q) && !tp.terms.includes(t.name)).sort((a, b) => tagFit(a.name, q) - tagFit(b.name, q) || b.tracks.length - a.tracks.length).slice(0, 8) : [];
    active = -1;
    drop.replaceChildren(el("ul", { class: "drop-list" }, opts.map((t, k) => el("li", { onmousedown: (e) => { e.preventDefault(); pick(t.name); } },
      t.name, el("span", { class: "gi-n" }, t.tracks.length)))));
    drop.hidden = !opts.length;
  };
  const update = () => { tp.q = input.value; drawChips(); drawDrop(); renderTagsPage(); };
  const pick = (g) => { // a tag picked from the suggestions: kept as a search, highlighted and in the panel
    tp.terms = [...tp.terms.filter((x) => x !== g), g]; input.value = ""; tp.q = "";
    drawChips(); drop.hidden = true; renderTagsPage();
    if (!phone()) { openTagPanel(g, true); const r = document.querySelector(`#threads [data-tag="${CSS.escape(g)}"]`); if (r) r.scrollIntoView({ block: "nearest" }); }
  };
  input.addEventListener("input", update);
  input.addEventListener("blur", () => setTimeout(() => (drop.hidden = true), 100));
  input.addEventListener("focus", () => { if (input.value.trim()) drawDrop(); });
  input.addEventListener("keydown", (e) => {
    const items = [...drop.querySelectorAll("li")];
    if (e.key === "Enter") {
      e.preventDefault();
      if (active > -1 && opts[active]) { pick(opts[active].name); return; }
      const q = input.value.trim();
      if (q && !tp.terms.includes(q)) tp.terms = [...tp.terms, q];
      input.value = ""; tp.q = ""; drawChips(); drop.hidden = true; renderTagsPage();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length && !drop.hidden) {
      e.preventDefault(); active = e.key === "ArrowDown" ? (active + 1) % items.length : (active <= 0 ? items.length - 1 : active - 1);
      items.forEach((li, k) => li.classList.toggle("on", k === active));
    } else if (e.key === "Backspace" && !input.value && tp.terms.length) { tp.terms = tp.terms.slice(0, -1); update(); }
    else if (e.key === "Escape") { e.stopPropagation(); if (!drop.hidden) drop.hidden = true; else { tp.terms = []; input.value = ""; update(); } }
  });
  drawChips();
  return el("span", { class: "tag-box gm-field tp-search" }, field, clear, drop);
}
function tagRowTracks(t, mode) {
  let items = t.tracks;
  if (mode !== "titles") {
    const [rows, cols] = mode === "lists" ? [items.length, 1] : phone() ? [2, 1] : ZOOM_GRID[tagZoom()] || [2, 3];
    if (mode !== "lists") items = items.slice(0, rows * cols); // the newest ones; all of them in the panel
    return el("div", { class: "tp-grid" + (mode === "lists" ? " tp-grid-open" : " tp-fit"), style: mode === "lists" ? null : `--cols:${cols}` },
      items.map((tr) => { const x = info(tr);
        return el("button", { class: "tp-li" + (x.dead ? " dead" : ""), onclick: (e) => { e.stopPropagation(); if (quickClick(e, t, tr)) return; playTag(t, tr); } }, img(x.thumb, "tp-mini"), el("span", { class: "tp-li-t" }, x.title)); }));
  }
  items = items.slice(0, 16); // (as many as fit on the line show; the last one cut by the edge)
  return el("div", { class: "tp-strip titled" }, items.map((tr) => { const x = info(tr);
    return el("button", { class: "tp-card" + (x.dead ? " dead" : ""), onclick: (e) => { e.stopPropagation(); if (quickClick(e, t, tr)) return; playTag(t, tr); }, "aria-label": "Play " + x.title },
      img(x.thumb, "tp-thumb"), el("span", { class: "tp-card-t" }, x.title)); }));
}
function tagRow(t, mode) {
  const ys = tagYears(t);
  const meta = el("div", { class: "tp-meta" }, `${t.tracks.length} ${t.tracks.length === 1 ? "track" : "tracks"}` + (ys.length ? " · " + yearsText(ys) : ""));
  const name = el("div", { class: "tp-name" }, t.name);
  if (mode === "lists") { // phone: the arrow opens the tracks in place
    const open = tp.open.has(t.name);
    const row = el("div", { class: "tp-row tp-drop" + (open ? " open" : "") },
      el("button", { class: "tp-drop-head", onclick: () => { open ? tp.open.delete(t.name) : tp.open.add(t.name); row.replaceWith(tagRow(t, mode)); } },
        el("span", { class: "tp-arrow" }, open ? "▾" : "▸"), el("span", {}, name, meta)),
      open ? tagRowTracks(t, "lists") : null);
    return row;
  }
  const row = el("div", { class: "tp-row tp-" + mode + (tp.pinned && tp.active === t.name && !phone() ? " on" : ""), "data-tag": t.name },
    el("div", { class: "tp-label" }, name, meta),
    tagRowTracks(t, mode));
  // the whole row is the button (the tracks in it play): computer, click keeps the tag in the panel, again lets go
  row.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".tp-li, .tp-card")) return;
    clearTimeout(tp.hoverT);
    if (phone()) { openTagPanel(t.name, true); return; }
    if (tp.pinned && tp.active === t.name) { tp.pinned = false; row.classList.remove("on"); return; }
    openTagPanel(t.name, true);
  });
  if (!phone()) {
    row.addEventListener("mouseenter", () => { clearTimeout(tp.hoverT); if (!tp.pinned) tp.hoverT = setTimeout(() => { if (!tp.pinned) openTagPanel(t.name); }, 80); });
    row.addEventListener("mouseleave", () => clearTimeout(tp.hoverT));
  }
  return row;
}
function renderTagsPage() {
  if (view === "tags") { renderTagsGrid(); return; } // (#/tagsrows: the page below, kept as it was)
  const list = $("#threads");
  const mode = tagMode();
  const words = [...tp.terms, ...(tp.q.trim() ? [tp.q.trim()] : [])];
  const all = threads.filter((t) => t.kind === "tag" && (!words.length || words.some((w) => tagMatches(t.name, w))))
    .sort({ az: (a, b) => a.name.localeCompare(b.name), count: (a, b) => b.tracks.length - a.tracks.length || b.last - a.last }[tagPref("sort", "az")] || ((a, b) => b.last - a.last));
  const own = all.filter((t) => !isAutoTag(t.name)), auto = all.filter((t) => isAutoTag(t.name));
  if (!all.length) { list.replaceChildren(el("p", { class: "view-note tp-none" }, "No tags match.")); return; }
  list.replaceChildren(el("div", { class: "tp-page tp-mode-" + mode },
    own.map((t) => tagRow(t, mode)),
    auto.length ? el("div", { class: "tp-group" }, "Automatic tags") : null,
    auto.map((t) => tagRow(t, mode))));
  if (!phone() && (!tp.active || !all.some((t) => t.name === tp.active)) && own.length) tp.active = own[0].name;
  if (!phone()) drawTagPanel(); else if (!tagPanel.box.hidden) drawTagPanel();
}
/* the panel: computer, in the column on the right (hovering a row shows its tag; clicking a row keeps it there);
   phone, full screen over the page */
const tagPanel = { box: el("aside", { class: "tag-panel", hidden: true }) };
document.body.append(tagPanel.box);
function openTagPanel(g, pin) {
  if (tp.active !== g) tp.editing = false;
  tp.active = g; if (pin !== undefined) tp.pinned = !!pin;
  document.querySelectorAll(".tp-row.on").forEach((r) => r.classList.remove("on"));
  const r = document.querySelector(`.tp-row[data-tag="${CSS.escape(g)}"]`); if (r && !phone() && tp.pinned) r.classList.add("on");
  drawTagPanel(true);
}
function placeTagPanel() { placeSidePanel(tagPanel.box); placeSidePanel(histPanel); placeSidePanel(browsePanel); }
function placeSidePanel(box) {
  if (box.hidden || phone()) return;
  const top = headerBottom() + 10, d = $("#dock");
  let bottom = innerHeight - 16;
  if (!d.hidden) { const m = $("#media").getBoundingClientRect(), bar = d.querySelector(".bar").getBoundingClientRect(); bottom = (m.height && !d.classList.contains("idle") ? m.top : bar.top) - 10; }
  if (box === browsePanel) { // never over the video window, also while it isn't there yet (its size and gap kept free above the player bar)
    const barTop = d.hidden ? innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dock-h")) || 90) : d.querySelector(".bar").getBoundingClientRect().top;
    bottom = Math.min(bottom, barTop - 8 - 204 - 10);
  }
  box.style.top = top + "px"; box.style.maxHeight = Math.max(160, bottom - top) + "px";
}
addEventListener("resize", () => { if (tagsView()) { if (!phone() && innerWidth < 966) tagPanel.box.hidden = true; else if (!phone()) drawTagPanel(); } });
function hideTagPanel() { tagPanel.box.hidden = true; document.body.classList.remove("tag-panel-open"); if (typeof placeTpBar === "function") placeTpBar(); }
/* the tag's panel; page = true: the same controls for the top of a tag's own page (#/tag/name), without the list */
function drawTagPanel(show, page) {
  const box = tagPanel.box, t = page ? tagThreadOf(tagPageName) : tp.active && tagThreadOf(tp.active);
  if (page) { if (!t) return [el("p", { class: "view-note" }, "There's no tag called that.")]; }
  else if (!tagsView() || !t || (!phone() && innerWidth < 966) || (phone() && !show && box.hidden)) { hideTagPanel(); return; }
  const redraw = () => (page ? runSearch() : drawTagPanel(true));
  const g = t.name, ys = tagYears(t), key = level() === 1;
  const pl = tagPlaylist(t);
  const desc = tagInfo.desc[g] || "";
  const descBox = el("div", { class: "tp-desc" + (desc ? "" : " empty") }, desc || (key ? "" : ""));
  const editDesc = () => {
    const ta = el("textarea", { rows: "4", class: "tp-desc-edit", placeholder: "What this tag is about" }); ta.value = desc;
    const save = async () => {
      const text = ta.value.trim();
      try { await writeInbox({ action: "tagdesc", tag: g, text, ts: Math.floor(Date.now() / 1000) }, "tag"); } catch (e) { msg.textContent = netMsg(e); return; }
      tagInfo.desc[g] = text; if (!text) delete tagInfo.desc[g]; redraw();
    };
    const msg = el("span", { class: "hint" });
    descBox.replaceWith(el("div", { class: "tp-desc-form" }, ta, el("div", { class: "tp-btns" },
      el("button", { class: "when-link", onclick: save }, "Save"), el("button", { class: "when-link", onclick: () => redraw() }, "Cancel"), msg)));
    ta.focus();
  };
  const rename = () => {
    const input = el("input", { type: "text", class: "tp-rename", value: g, maxlength: 40, "aria-label": "New name" });
    const msg = el("span", { class: "hint" });
    const save = async () => {
      const to = normTag(input.value);
      if (!to || to === g) { redraw(); return; }
      try { await writeInbox({ action: "tagrename", from: g, to, ts: Math.floor(Date.now() / 1000) }, "tag"); } catch (e) { msg.textContent = netMsg(e); return; }
      for (const th of threads) if (isBase(th)) for (const tr of th.tracks) if (tr.tags && tr.tags[g] !== undefined) {
        const at = tr.tags[g]; delete tr.tags[g]; tr.tags[to] = Math.min(at, tr.tags[to] || at); tr._hay = null;
      }
      if (tagInfo.desc[g]) { tagInfo.desc[to] = tagInfo.desc[to] || tagInfo.desc[g]; delete tagInfo.desc[g]; }
      tp.active = to;
      if (page) { tagPageName = to; history.replaceState(null, "", "#/tag/" + encodeURIComponent(to)); }
      refreshTags(); if (page) runSearch();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") redraw(); });
    head.replaceChildren(el("div", { class: "tp-rename-row" }, input, el("button", { class: "when-link", onclick: save }, "Save"), el("button", { class: "when-link", onclick: () => redraw() }, "Cancel"), msg));
    input.focus(); input.select();
  };
  const head = el("div", { class: "tp-p-head" },
    page ? el("h2", { class: "tp-p-title tp-page-title" }, showTag(g))
      : el("button", { class: "tp-p-title tp-title-link", onclick: (e) => openTagPage(g, e) }, showTag(g)), // (the tag's own page; Cmd+click: a new tab)
    phone() && !page ? el("button", { class: "when-link tp-close", onclick: hideTagPanel }, "Close") : null); // (Close: the panel over the Tags page on a phone, not a tag's own page)
  // year range: two handles on one line
  let slider = null;
  const span = ys.length ? [ys[0], ys[ys.length - 1]] : null;
  if (span && span[0] !== span[1]) {
    const [lo, hi] = tp.years[g] || span;
    const a = el("input", { type: "range", min: span[0], max: span[1], value: lo, step: 1, "aria-label": "From year" });
    const b = el("input", { type: "range", min: span[0], max: span[1], value: hi, step: 1, "aria-label": "To year" });
    const fill = el("span", { class: "tp-range-fill" });
    const labels = el("div", { class: "tp-range-labels" });
    const sync = (final) => {
      let x = +a.value, y = +b.value; if (x > y) [x, y] = [y, x];
      const pct = (v) => ((v - span[0]) / (span[1] - span[0])) * 100;
      fill.style.left = pct(x) + "%"; fill.style.right = 100 - pct(y) + "%";
      const n = t.tracks.filter((tr) => { const yy = yearOf(tr); return yy && yy >= x && yy <= y; }).length;
      labels.replaceChildren(el("span", {}, x), el("span", {}, x === span[0] && y === span[1] ? "all years" : `${n} ${n === 1 ? "track" : "tracks"}`), el("span", {}, y));
      if (final) { if (x === span[0] && y === span[1]) delete tp.years[g]; else tp.years[g] = [x, y]; page ? runSearch() : drawTagList(); }
    };
    a.addEventListener("input", () => sync(false)); b.addEventListener("input", () => sync(false));
    a.addEventListener("change", () => sync(true)); b.addEventListener("change", () => sync(true));
    slider = el("div", { class: "tp-range" }, el("div", { class: "tp-range-track" }, fill, a, b), labels);
    sync(false);
  }
  // a tag's page: a toggle for each kind of long track it has (struck through = left out)
  const off = tp.lens[g] || new Set();
  const longBtns = page ? Object.keys(LONG).filter((k) => t.tracks.some((tr) => { const d = lenOf(tr); return d && LONG[k](d); }))
    .map((k) => el("button", { class: "tpg-len" + (off.has(k) ? " off" : ""), "aria-pressed": String(!off.has(k)),
      onclick: () => { const o = tp.lens[g] || (tp.lens[g] = new Set()); o.has(k) ? o.delete(k) : o.add(k); runSearch(); } },
      k, el("span", { class: "gi-n" }, t.tracks.filter((tr) => { const d = lenOf(tr); return d && LONG[k](d); }).length))) : []; // (as the search's field filters)
  const order = tp.order[g] || "newest";
  const orderBtn = (k, name) => el("button", { class: "when-link" + (order === k ? " on" : ""), onclick: () => { tp.order[g] = k; redraw(); } }, name);
  const list = el("div", { class: "tp-p-list" });
  const drawTagList = () => {
    const p = tagPlaylist(t);
    list.replaceChildren(...p.tracks.map((tr) => { const x = info(tr), y = yearOf(tr);
      return el("button", { class: "side-row" + (playing && playing.thread.tracks[playing.index] === tr ? " playing" : ""), onclick: (e) => { if (quickClick(e, t, tr)) return; playTag(t, tr); } },
        img(x.thumb, "side-thumb"), el("span", { class: "side-name" }, x.title)); }));
    if (!p.tracks.length) list.append(el("p", { class: "hint" }, "No tracks in these years."));
  };
  if (!page) drawTagList();
  if (page) { // a tag's page: the name and how many tracks, the years on the right; the order and Add description / Rename under
    const n = t.tracks.length;
    head.append(el("span", { class: "tp-page-n" }, `${n} ${n === 1 ? "track" : "tracks"}` + (ys.length ? " · " + yearsText(ys) : "")));
    if (tp.returnTo) { // opened from Tags: ‹ before the name; the arrow and the name both go back there
      const title = head.querySelector(".tp-page-title");
      title.classList.add("tp-back-title"); title.setAttribute("role", "link"); title.setAttribute("aria-label", "Back to Tags");
      title.prepend(el("span", { class: "tp-back-arrow", "aria-hidden": "true" }, "‹"));
      title.addEventListener("click", () => { if (viewAllowed("tags")) setView("tags"); }); // (logged out meanwhile: nothing to go back to)
    }
    const parts = [el("div", { class: "tpg-row1" }, head, slider ? el("div", { class: "tpg-years" }, slider) : null), descBox,
      el("div", { class: "tp-btns tpg-row2" }, orderBtn("newest", "Newest added"), orderBtn("oldest", "Oldest added"), orderBtn("shuffle", "Shuffle"),
        longBtns.length ? el("span", { class: "tpg-long" }, longBtns) : null,
        key && !phone() && (desc || level() === 1) ? el("span", { class: "tpg-edit" }, desc ? el("button", { class: "when-link", onclick: editDesc }, "Edit description") : null, // (no "Add description"; one already written can still be edited)
          !isAutoTag(g) && level() === 1 ? el("button", { class: "when-link", onclick: rename }, "Rename") : null) : null)].filter(Boolean); // (Rename: only with the key)
    if (desc) descBox.addEventListener("dblclick", () => key && editDesc());
    return parts;
  }
  const parts = [head,
    el("div", { class: "tp-p-meta" }, `${t.tracks.length} ${t.tracks.length === 1 ? "track" : "tracks"}` + (ys.length ? " · " + yearsText(ys) : "") + " · last added " + fmtTs(t.last)),
    descBox,
    page ? null : list].filter(Boolean); // (the years, the order and Edit are on the tag's own page)
  if (desc) descBox.addEventListener("dblclick", () => key && editDesc());
  if (page) return parts;
  box.replaceChildren(...parts);
  box.hidden = false;
  document.body.classList.toggle("tag-panel-open", phone());
  placeTagPanel(); placeTpBar();
}
/* the page's scroll bar between the list and the panel (the browser's own one is hidden on this page) */
const tpBar = el("div", { class: "tp-bar", hidden: true }, el("div", { class: "tp-bar-thumb" }));
document.body.append(tpBar);
function placeTpBar() {
  const on = tagsView() && !phone() && !tagPanel.box.hidden && !$("#q").value.trim();
  document.documentElement.classList.toggle("tp-own-bar", on);
  tpBar.hidden = !on;
  if (!on) return;
  const list = $("#threads").getBoundingClientRect(), pl = tagPanel.box.getBoundingClientRect();
  const vh0 = $("#viewHead"), top = (vh0.hidden ? headerBottom() : vh0.getBoundingClientRect().bottom) + 4, d = $("#dock"), bottom = (d.hidden ? innerHeight : d.querySelector(".bar").getBoundingClientRect().top) - 4; // (down to the player bar, also with the video window open: that sits right of the bar)
  const H = Math.max(40, bottom - top), docH = document.documentElement.scrollHeight, vh = innerHeight;
  tpBar.style.left = Math.round((list.right + pl.left) / 2 - 4) + "px";
  tpBar.style.top = top + "px"; tpBar.style.height = H + "px";
  const thumb = tpBar.firstChild, th = Math.max(30, H * Math.min(1, vh / docH));
  tpBar.hidden = docH <= vh + 2;
  thumb.style.height = th + "px";
  thumb.style.top = (docH > vh ? Math.max(0, Math.min(1, scrollY / (docH - vh))) * (H - th) : 0) + "px"; // (no overshoot past the ends)
  tpBar._k = (docH - vh) / Math.max(1, H - th); // page pixels per pixel of the bar
}
tpBar.addEventListener("pointerdown", (e) => {
  const thumb = tpBar.firstChild;
  if (e.target !== thumb) { // a click beside the handle: the page goes there
    const r = tpBar.getBoundingClientRect(), th = thumb.offsetHeight;
    scrollTo({ top: (e.clientY - r.top - th / 2) * tpBar._k });
    return;
  }
  e.preventDefault(); thumb.setPointerCapture(e.pointerId); tpBar.classList.add("drag");
  const y0 = e.clientY, s0 = scrollY;
  const move = (ev) => scrollTo({ top: s0 + (ev.clientY - y0) * tpBar._k });
  const up = () => { tpBar.classList.remove("drag"); thumb.removeEventListener("pointermove", move); thumb.removeEventListener("pointerup", up); };
  thumb.addEventListener("pointermove", move); thumb.addEventListener("pointerup", up);
});
addEventListener("scroll", () => {
  if (tpBar.hidden && !tagsView()) return;
  placeTpBar();
  tpBar.classList.add("live"); clearTimeout(tpBar._t); tpBar._t = setTimeout(() => tpBar.classList.remove("live"), 600); // lit while scrolling
}, { passive: true });
addEventListener("resize", placeTpBar);
function fmtTs(ts) { const d = new Date(ts * 1000); return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3) + " " + d.getFullYear(); }
addEventListener("scroll", () => placeTagPanel(), { passive: true });

/* ---------- Activity: every play of 10 seconds or more is logged on the Activity server (worker/, on Cloudflare);
   only a device with the key can see the log. Each browser has a random id; devices with the key can be named. ---------- */
let ACT_URL = "";
fetch("data/worker.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).then((d) => { ACT_URL = (d.url || "").replace(/\/$/, ""); if (view === "activity") renderActivity(); if (view === "lookup") renderLookup(); }).catch(() => {});
const DEVICE_ID = (() => { try { let v = localStorage.getItem("nrgfm-did"); if (!v) { v = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, ""); localStorage.setItem("nrgfm-did", v); } return v; } catch { return "nostorage"; } })();
let plog = null; // the play being logged now
function sendPlay(final) {
  if (!plog || !ACT_URL) return;
  const body = JSON.stringify({ id: plog.id, who: DEVICE_ID, owner: !!getToken(), ts: plog.ts, url: plog.url, tid: plog.tid, title: plog.title,
    sec: plog.sec === null ? null : Math.round(plog.sec), dur: plog.dur ? Math.round(plog.dur) : null });
  plog.sent = true; plog.lastSend = Date.now(); plog.sentSec = plog.sec;
  if (final && navigator.sendBeacon) { try { navigator.sendBeacon(ACT_URL + "/play", new Blob([body], { type: "text/plain" })); return; } catch {} }
  fetch(ACT_URL + "/play", { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
}
function endPlayLog() {
  if (plog && plog.sent && plog.sec !== plog.sentSec) sendPlay(true);
  if (plog) clearTimeout(plog.wall);
  plog = null;
}
function startPlayLog(tr, x) {
  endPlayLog();
  plog = { id: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, ""), ts: Math.floor(Date.now() / 1000),
    url: tr.url, tid: tr.id, title: x.title, sec: 0, dur: lenOf(tr) || 0, prev: 0, sent: false };
}
function logTick(cur, dur) { // seconds really played: the time moving forward in small steps (a jump is a seek)
  if (!plog || plog.sec === null) return;
  if (dur > 0) plog.dur = dur;
  const d = (cur || 0) - plog.prev;
  if (d > 0 && d < 2.5) plog.sec += d;
  plog.prev = cur || 0;
  if (!plog.sent && plog.sec >= 10) sendPlay(false);
  else if (plog.sent && Date.now() - plog.lastSend > 60000) sendPlay(false);
}
function logUncounted() { // players that don't say where they are (Bandcamp, Mixcloud): logged after 10 seconds open
  if (!plog) return;
  const p = plog; p.sec = null;
  p.wall = setTimeout(() => { if (plog === p) sendPlay(false); }, 10000);
}
addEventListener("pagehide", endPlayLog);
document.addEventListener("visibilitychange", () => { if (document.hidden && plog && plog.sent && plog.sec !== plog.sentSec) sendPlay(true); });

const act = { day: null, who: null, flagged: false, full: false, days: [], devices: [], periods: [], period: null, group: "month",
  mode: (() => { try { return localStorage.getItem("nrgfm-act-mode") || "plays"; } catch { return "plays"; } })(), head: el("div", { class: "act-head" }), token: 0 };
const actTz = () => -new Date().getTimezoneOffset();
const actApi = (path) => fetch(ACT_URL + path + (path.includes("?") ? "&" : "?") + "tz=" + actTz(), { headers: { Authorization: "Bearer " + getToken() } })
  .then((r) => { if (!r.ok) throw new Error(r.status === 401 ? "The key wasn't accepted." : "The Activity server answered " + r.status + "."); return r.json(); });
const myName = () => { try { return localStorage.getItem("nrgfm-device") || ""; } catch { return ""; } };
function deviceLabel(d) {
  if (!d) return "Unknown";
  if (d.who === DEVICE_ID && myName()) return myName();
  if (d.name) return d.name;
  return (d.owner ? (d.who === DEVICE_ID ? "This device" : "Unnamed device") : "Guest") + (d.city ? " · " + d.city : "");
}
const FLAG_SVG = (on) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = `<path d="M3.5 15V1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3.5 2h9l-2.2 3.5L12.5 9h-9" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`; return s; };
function trackByPlay(p) {
  if (!act.index) { act.index = new Map(); for (const t of threads) if (isBase(t)) t.tracks.forEach((tr, i) => { act.index.set(tr.id, { t, i }); if (!act.index.has(tr.url)) act.index.set(tr.url, { t, i }); }); }
  return act.index.get(p.tid) || act.index.get(p.url) || null;
}
function actDayName(day) {
  const d = new Date(day + "T12:00:00"), now = new Date();
  return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3) + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "");
}
async function renderActivity() {
  const list = $("#threads"), token = ++act.token;
  act.index = null;
  if (!getToken()) { act.head.replaceChildren(); list.replaceChildren(el("p", { class: "view-note" }, "Activity is only shown on a device with the key.")); return; }
  if (!ACT_URL) { act.head.replaceChildren(); list.replaceChildren(el("p", { class: "view-note" }, "The Activity server isn't set up yet.")); return; }
  list.replaceChildren(el("p", { class: "view-note" }, "Loading…"));
  if ((act.mode === "logs" || act.mode === "logins") && phone()) act.mode = "plays";
  if (act.mode === "logins") { // Logins: the two passwords
    let set = null;
    try { set = await actApi("/passwords"); } catch {}
    if (token !== act.token) return;
    drawActHead(); drawLoginsPanel(set); return;
  }
  if (act.mode === "logs") { // Logs: everything changed on the site (data/changes.jsonl), laptop only
    try { await loadLogs(); } catch { if (token === act.token) list.replaceChildren(el("p", { class: "view-note" }, "The log couldn't be loaded.")); return; }
    if (token !== act.token) return;
    if (!act.logDays.some((d) => d.day === act.day)) act.day = act.logDays.length ? act.logDays[0].day : null;
    drawActHead(); drawLogList(); return;
  }
  try {
    const q = "?min=" + (act.full ? 15 : 0) + (act.who ? "&who=" + encodeURIComponent(act.who) : "");
    if (act.mode === "top") [act.periods, act.devices] = await Promise.all([actApi("/periods" + q + "&group=month"), actApi("/devices")]);
    else [act.days, act.devices] = await Promise.all([actApi("/days" + q), actApi("/devices")]);
  } catch (e) { if (token === act.token) list.replaceChildren(el("p", { class: "view-note" }, e.message || "The Activity server didn't answer.")); return; }
  if (token !== act.token) return;
  if (act.mode === "top") { if (!act.periods.some((d) => d.p === act.period)) act.period = act.periods.length ? act.periods[0].p : null; }
  else if (!act.days.some((d) => d.day === act.day)) act.day = act.days.length ? act.days[0].day : null;
  drawActHead();
  await (act.mode === "top" ? drawTopList(token) : drawActList(token));
}
const actPeriodName = (p) => (p === "all" ? "All time" : /^\d{4}-\d\d$/.test(p) ? MONTHS[+p.slice(5) - 1].slice(0, 3) + " " + p.slice(0, 4) : p);
/* Most played: the tracks played most in the month (year, all time) picked, with how many times */
async function drawTopList(token) {
  const list = $("#threads");
  let rows = [];
  try {
    if (act.period) rows = await actApi(`/top?group=${act.period === "all" ? "all" : "month"}&p=${encodeURIComponent(act.period)}&min=${act.full ? 15 : 0}` + (act.who ? "&who=" + encodeURIComponent(act.who) : ""));
  } catch (e) { if (token === act.token) list.replaceChildren(el("p", { class: "view-note" }, e.message)); return; }
  if (token !== act.token) return;
  if (act.flagged) rows = rows.filter((r) => { const at = trackByPlay(r), tr = at && at.t.tracks[at.i]; return tr && tr.tags && tr.tags.flagged; });
  if (!rows.length) { list.replaceChildren(el("p", { class: "view-note" }, "Nothing has been played yet.")); return; }
  list.replaceChildren(el("ul", { class: "act-list act-top" }, rows.map((r, k) => {
    const at = trackByPlay(r), tr = at && at.t.tracks[at.i], x = tr ? info(tr) : null;
    const flagBtn = tr ? el("button", { class: "act-flag" + (tr.tags && tr.tags.flagged ? " on" : ""), "aria-label": "Flag", onclick: async (e) => {
      const b = e.currentTarget; if (await toggleFlag(tr)) { const on = !!(tr.tags && tr.tags.flagged); b.classList.toggle("on", on); b.replaceChildren(FLAG_SVG(on)); }
    } }, FLAG_SVG(!!(tr.tags && tr.tags.flagged))) : el("span");
    return el("li", { class: "act-line" },
      el("span", { class: "act-time act-rank" }, k + 1),
      el("button", { class: "play month-play", disabled: !tr || null, onclick: () => tr && play(at.t, at.i) },
        img(x ? x.thumb : "", "mini"), el("span", { class: "act-text" }, el("span", { class: "tr-title" }, x ? x.title : r.title || r.url))),
      el("span", { class: "act-count" }, `${r.n} ${r.n === 1 ? "play" : "plays"}`),
      flagBtn);
  })));
  fitActTitles();
}
/* Activity's lists: a long title gets smaller until it fits (two lines at most), as in Archive */
function fitActTitles() { requestAnimationFrame(() => { const l = document.querySelector("#threads .act-list"); if (l) fitTitles([l]); }); }
function drawActHead() {
  const go = (fn) => () => { fn(); renderActivity(); };
  const top = act.mode === "top", logs = act.mode === "logs", logins = act.mode === "logins";
  const dayRow = el("div", { class: "hist-years act-days" }, logins ? [] : logs
    ? act.logDays.map((d) => el("button", { class: "when-link" + (d.day === act.day ? " on" : ""), onclick: go(() => { act.day = d.day; }) }, actDayName(d.day), el("span", { class: "gi-n" }, d.n)))
    : top
    ? act.periods.map((d) => el("button", { class: "when-link" + (d.p === act.period ? " on" : ""), onclick: go(() => { act.period = d.p; }) }, actPeriodName(d.p), el("span", { class: "gi-n" }, d.n)))
    : act.days.map((d) => el("button", { class: "when-link" + (!act.flagged && d.day === act.day ? " on" : ""),
      onclick: go(() => { act.day = d.day; act.flagged = false; }) }, actDayName(d.day), el("span", { class: "gi-n" }, d.n))));
  const setMode = (m) => { act.mode = m; try { localStorage.setItem("nrgfm-act-mode", m); } catch {} };
  const views = el("div", { class: "act-views" },
    el("button", { class: "when-link" + (!top && !logs && !logins ? " on" : ""), onclick: go(() => setMode("plays")) }, "Plays"),
    el("button", { class: "when-link" + (top ? " on" : ""), onclick: go(() => setMode("top")) }, "Most played"));
  const edgeFade = () => { dayRow.classList.toggle("fade-l", dayRow.scrollLeft > 2); dayRow.classList.toggle("fade-r", dayRow.scrollLeft + dayRow.clientWidth < dayRow.scrollWidth - 2); };
  dayRow.addEventListener("scroll", edgeFade, { passive: true }); requestAnimationFrame(edgeFade);
  dayRow.addEventListener("wheel", (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && dayRow.scrollWidth > dayRow.clientWidth) { e.preventDefault(); dayRow.scrollLeft += e.deltaY; } }, { passive: false });
  const owners = act.devices.filter((d) => d.owner && d.n);
  const cur = act.who && act.devices.find((d) => d.who === act.who);
  const logsBtn = el("span", { class: "act-logs" },
    el("button", { class: "when-link", onclick: () => setView("lookup") }, "Lookup"),
    phone() ? null : el("button", { class: "when-link" + (logins ? " on" : ""), onclick: go(() => setMode(logins ? "plays" : "logins")) }, "Logins"),
    phone() ? null : el("button", { class: "when-link" + (logs ? " on" : ""), onclick: go(() => setMode(logs ? "plays" : "logs")) }, "Logs"));
  const chips = logs || logins ? el("div", { class: "hist-months act-filters" }) : el("div", { class: "hist-months act-filters" },
    el("button", { class: "when-link" + (!act.who ? " on" : ""), onclick: go(() => { act.who = null; }) }, "All devices"),
    owners.map((d) => el("button", { class: "when-link" + (act.who === d.who ? " on" : ""), onclick: go(() => { act.who = d.who; }) }, deviceLabel(d))),
    cur && !cur.owner ? el("button", { class: "when-link on", onclick: go(() => { act.who = null; }) }, deviceLabel(cur) + " ×") : null,
    el("span", { class: "act-sep" }),
    el("button", { class: "when-link act-flag-filter" + (act.flagged ? " on" : ""), onclick: go(() => { act.flagged = !act.flagged; }) }, FLAG_SVG(act.flagged), "Flagged"));
  // this device: give it a name (once)
  let naming = null;
  if (!myName()) {
    const input = el("input", { type: "text", class: "act-name", placeholder: "Name this device", maxlength: 40, "aria-label": "Name this device" });
    const save = async () => {
      const name = input.value.trim(); if (!name) return;
      try {
        const r = await fetch(ACT_URL + "/name", { method: "POST", headers: { Authorization: "Bearer " + getToken(), "Content-Type": "text/plain" }, body: JSON.stringify({ who: DEVICE_ID, name }) });
        if (!r.ok) throw 0;
        try { localStorage.setItem("nrgfm-device", name); } catch {}
        renderActivity();
      } catch { input.value = ""; input.placeholder = "Didn't save, try again"; }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
    naming = el("span", { class: "act-naming" }, input, el("button", { type: "button", class: "when-link", onclick: save }, "Save"));
  }
  act.head.replaceChildren(el("div", { class: "act-row1" }, dayRow, views), el("div", { class: "hist-months-row act-row2" }, chips, naming, logsBtn));
  const head = $("#viewHead");
  if (view === "activity" && !$("#q").value.trim()) { head.className = "view-head view-history view-activity"; head.replaceChildren(act.head); head.hidden = false; }
}
async function drawActList(token) {
  const list = $("#threads");
  let plays;
  try {
    if (act.flagged) {
      const urls = [...new Set(threads.filter(isBase).flatMap((t) => t.tracks).filter((tr) => tr.tags && tr.tags.flagged).map((tr) => tr.url))].slice(0, 200);
      plays = urls.length ? await actApi("/plays?urls=" + encodeURIComponent(urls.join("|")) + (act.who ? "&who=" + encodeURIComponent(act.who) : "")) : [];
    } else if (act.day) {
      plays = await actApi("/plays?day=" + act.day + (act.who ? "&who=" + encodeURIComponent(act.who) : ""));
    } else plays = [];
  } catch (e) { if (token === act.token) list.replaceChildren(el("p", { class: "view-note" }, e.message)); return; }
  if (token !== act.token) return;
  if (act.full) plays = plays.filter((p) => p.sec === null || p.sec >= 15); // (players that don't say how long count as full)
  if (!plays.length) { list.replaceChildren(el("p", { class: "view-note" }, act.flagged ? "No flagged tracks have been played." : "Nothing has been played yet.")); return; }
  const devs = new Map(act.devices.map((d) => [d.who, d]));
  const part = (ts) => { const h = new Date(ts * 1000).getHours(); return h < 5 ? "Night" : h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening"; };
  const groupOf = (p) => (act.flagged ? actDayName(new Date(p.ts * 1000).toLocaleDateString("sv-SE")) : part(p.ts)); // (sv-SE: YYYY-MM-DD in local time)
  const out = [];
  let last = null;
  for (const p of plays) {
    const g = groupOf(p);
    if (g !== last) { out.push(el("li", { class: "act-part" }, g)); last = g; }
    const at = trackByPlay(p), tr = at && at.t.tracks[at.i], x = tr ? info(tr) : null;
    const time = new Date(p.ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const full = !p.sec || !p.dur || p.sec >= p.dur - 5;
    const d = devs.get(p.who);
    const flagBtn = tr ? el("button", { class: "act-flag" + (tr.tags && tr.tags.flagged ? " on" : ""), "aria-label": "Flag", onclick: async (e) => {
      const b = e.currentTarget; if (await toggleFlag(tr)) { const on = !!(tr.tags && tr.tags.flagged); b.classList.toggle("on", on); b.replaceChildren(FLAG_SVG(on)); }
    } }, FLAG_SVG(!!(tr.tags && tr.tags.flagged))) : el("span");
    out.push(el("li", { class: "act-line" + (playing && tr && playing.thread === at.t && playing.index === at.i ? " playing" : ""), "data-tid": p.tid || "" },
      el("span", { class: "act-time" }, time),
      el("button", { class: "play month-play", disabled: !tr || null, onclick: () => tr && play(at.t, at.i) },
        img(x ? x.thumb : "", "mini"),
        el("span", { class: "act-text" }, el("span", { class: "tr-title" }, x ? x.title : p.title || p.url),
          null)),
      el("button", { class: "when-link act-dev", onclick: () => { act.who = p.who; act.flagged = false; act.day = null; renderActivity(); } }, deviceLabel(d || { who: p.who, city: p.city })),
      flagBtn));
  }
  list.replaceChildren(el("ul", { class: "act-list" }, out));
  fitActTitles();
}
/* Logins: set (or change, or turn off) the two passwords. Level 2: mine; level 3: friends'. Every login shows in Logs */
function drawLoginsPanel(set) {
  const list = $("#threads");
  const field = (lv, name, note) => {
    const inp = el("input", { type: "text", class: "lg-input", placeholder: set && set["level" + lv] ? "Set — type a new one to change it" : "Not set", autocomplete: "off", spellcheck: "false", "aria-label": name });
    const msg = el("span", { class: "lg-msg" });
    const save = async (pw) => {
      msg.textContent = "Saving…";
      try {
        const r = await fetch(ACT_URL + "/passwords", { method: "POST", headers: { Authorization: "Bearer " + getToken(), "Content-Type": "text/plain" }, body: JSON.stringify({ ["level" + lv]: pw }) });
        if (!r.ok) throw new Error("The server answered " + r.status);
        inp.value = ""; inp.placeholder = pw ? "Set — type a new one to change it" : "Not set";
        msg.textContent = pw ? "Saved. Anyone logged in at this level was logged out." : "Turned off.";
      } catch (e) { msg.textContent = e.message || "Not saved."; }
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && inp.value.trim()) save(inp.value.trim()); });
    return el("div", { class: "lg-row" }, el("div", { class: "lg-name" }, name, el("span", { class: "lg-note" }, note)),
      el("div", { class: "lg-line" }, inp, el("button", { class: "btn", onclick: () => inp.value.trim() && save(inp.value.trim()) }, "Save"),
        el("button", { class: "when-link", onclick: () => save("") }, "Turn off")), msg);
  };
  list.replaceChildren(el("div", { class: "lg-panel" },
    set ? null : el("p", { class: "view-note" }, "The Activity server didn't answer; the passwords can't be shown or changed right now."),
    field(2, "Level 2 password", "yours: playlists, automatic tags, notes in search; adding and editing tracks and tags"),
    field(3, "Level 3 password", "for friends: tags (no playlists or automatic tags), Archive, Tags, Genres, History"),
    phoneKeyRow(set),
    el("p", { class: "lg-foot" }, "A login lasts 12 hours. After 5 wrong passwords within an hour, logging in is locked for an hour. Every login, wrong password and logout is in Logs.")));
}
/* the upload key for the "Save to nrgfm" shortcut on the phone: a new one only after Confirm (the old one stops working) */
function phoneKeyRow(set) {
  const has = !!(set && set.phoneKey);
  const out = el("div", { class: "lg-line" }), msg = el("span", { class: "lg-msg" });
  const btn = el("button", { class: "btn", onclick: async () => {
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = "1"; btn.textContent = "Confirm";
      msg.textContent = has ? "The key in the shortcut will stop working." : "";
      btn._t = setTimeout(() => { delete btn.dataset.confirm; btn.textContent = has ? "New phone key" : "Make a phone key"; msg.textContent = ""; }, 5000);
      return;
    }
    clearTimeout(btn._t); delete btn.dataset.confirm; btn.disabled = true; msg.textContent = "…";
    try {
      const k = (await lkApi("/lookup/key", {})).key;
      const val = el("input", { type: "text", readonly: true, value: k, class: "lg-input lk-key-val", onfocus: (e) => e.target.select() });
      out.replaceChildren(val, el("button", { class: "btn", onclick: async (e) => { try { await navigator.clipboard.writeText(k); e.currentTarget.textContent = "Copied"; } catch {} } }, "Copy"));
      msg.textContent = "Paste it into the shortcut on the phone (after “Upload ”). It's only shown now.";
    } catch (e) { msg.textContent = e.message || "Not made."; btn.disabled = false; btn.textContent = "New phone key"; }
  } }, has ? "New phone key" : "Make a phone key");
  out.append(btn);
  return el("div", { class: "lg-row" }, el("div", { class: "lg-name" }, "Phone key", el("span", { class: "lg-note" }, has ? "set: the “Save to nrgfm” shortcut uploads to Lookup with it" : "for the “Save to nrgfm” shortcut on the phone (uploads to Lookup)")), out, msg);
}
/* Logs: every change made on the site, newest first (the same list the data is rebuilt from) */
async function loadLogs() {
  const text = await fetch("data/changes.jsonl?v=" + Date.now(), { cache: "no-store" }).then((r) => { if (!r.ok) throw 0; return r.text(); });
  act.logs = text.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((c) => c && c.ts);
  try { for (const l of await actApi("/logins")) act.logs.push({ ...l, action: "login" }); } catch {} // (password logins, from the Activity server)
  act.logs.sort((a, b) => b.ts - a.ts);
  const n = new Map();
  for (const c of act.logs) { const d = new Date(c.ts * 1000).toLocaleDateString("sv-SE"); n.set(d, (n.get(d) || 0) + 1); }
  act.logDays = [...n].map(([day, k]) => ({ day, n: k }));
}
function drawLogList() {
  const list = $("#threads");
  act.index = null;
  const titles = new Map(); // track id: a title from the log itself (for tracks deleted since)
  for (const c of act.logs) if (c.id && c.title && !titles.has(c.id)) titles.set(c.id, c.title);
  const byId = (id) => { trackByPlay({}); const at = act.index.get(id); return at ? { at, tr: at.t.tracks[at.i] } : null; };
  const byUrl = (u) => { trackByPlay({}); const at = u && act.index.get(u); return at ? { at, tr: at.t.tracks[at.i] } : null; };
  const threadOf = (id) => threads.find((t) => t.id === id && isBase(t));
  const trackBtn = (f, fallback) => f
    ? el("button", { class: "play month-play", onclick: () => play(f.at.t, f.at.i) }, img(info(f.tr).thumb, "mini"), el("span", { class: "act-text" }, el("span", { class: "tr-title" }, info(f.tr).title)))
    : el("span", { class: "act-text act-gone" }, el("span", { class: "tr-title" }, fallback || "A track no longer on the site (its title wasn't kept)"));
  const postLink = (id, label) => { const t = threadOf(id); return t ? el("button", { class: "when-link", "data-thread": t.id, onclick: () => goToThread(t) }, label) : null; };
  const tagList = (a) => (a || []).map(showTag).join(", ");
  const PROMOTE = { main: "Made the main track of its post", top: "Moved to its own post (new)", original: "Moved to its own post (dated)", isolate: "Moved to its own post" };
  const row = (c) => {
    const a = c.action || "add", f = c.id ? byId(c.id) : byUrl(c.url);
    let what = a, track = null, more = [];
    if (a === "add") { what = "Added"; track = trackBtn(byUrl(c.url) || f, c.title || c.url); more.push(c.thread ? postLink(c.thread, "in a post") : "as a new post"); if (c.tags && c.tags.length) more.push("· " + tagList(c.tags)); }
    else if (a === "edit") { what = "Edited"; track = trackBtn(f, c.title || titles.get(c.id)); }
    else if (a === "delete") { what = "Deleted"; track = trackBtn(null, c.title || titles.get(c.id) || (c.url ? c.url : "")); more.push(postLink(c.thread, "from a post")); }
    else if (a === "move") { what = "Moved"; track = trackBtn(f, titles.get(c.id)); more.push(postLink(c.to, "to another post")); }
    else if (a === "reorder") { what = "Moved"; track = trackBtn(f, titles.get(c.id)); more.push("within its post"); }
    else if (a === "promote") { what = PROMOTE[c.to] || "Moved"; track = trackBtn(f, titles.get(c.id)); }
    else if (a === "tag") {
      what = "Tags"; const ids = c.ids || [];
      track = ids.length === 1 ? trackBtn(byId(ids[0]), titles.get(ids[0])) : el("span", { class: "act-text" }, el("span", { class: "tr-title" }, ids.length + " tracks"));
      if (c.add && c.add.length) more.push("+ " + tagList(c.add)); if (c.remove && c.remove.length) more.push("− " + tagList(c.remove));
    }
    else if (a === "login") {
      what = { 1: "Logged in", 0: "Wrong password", "-1": "Login refused", 2: "Logged out" }[c.ok] || "Login";
      const lock = el("span", { class: "act-lock" }); lock.innerHTML = LOCK_SVG(c.ok === 1);
      track = el("span", { class: "act-login-row" + (c.ok === 1 || c.ok === 2 ? "" : " act-gone") }, lock,
        el("span", { class: "act-text act-login" }, el("span", { class: "tr-title" }, c.level ? `Level ${c.level}` : c.ok === -1 ? "Locked: 5 wrong passwords within an hour" : "")));
      more.push(c.name || "Unnamed device" + (c.city ? " · " + c.city : c.country ? " · " + c.country : ""));
    }
    else if (a === "tagrename") { what = "Renamed a tag"; track = el("span", { class: "act-text" }, el("span", { class: "tr-title" }, showTag(c.from) + " → " + showTag(c.to))); }
    else if (a === "split") { what = "Split a post"; track = el("span", { class: "act-text" }, el("span", { class: "tr-title" }, (c.groups || []).length + " parts")); }
    else if (a === "regroup") { what = "Regrouped posts"; track = el("span", { class: "act-text" }, el("span", { class: "tr-title" }, (c.threads || []).length + " posts")); }
    else if (a === "recheck") { what = "Checked links"; track = el("span", { class: "act-text" }, el("span", { class: "tr-title" }, Object.keys(c.meta_set || {}).length + " changed")); }
    else track = el("span", { class: "act-text" }, el("span", { class: "tr-title" }, ""));
    const time = new Date(c.ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    // the time: to the post the change was made in (or to, or from)
    const home = (id) => { const g = id && byId(id); return g ? g.at.t : null; };
    const post = a === "add" ? ((byUrl(c.url) || f || {}).at || {}).t || threadOf(c.thread)
      : a === "delete" ? threadOf(c.thread) : a === "move" ? threadOf(c.to) || home(c.id)
      : a === "tag" ? home((c.ids || [])[0]) : c.id ? home(c.id) || threadOf(c.thread) : null;
    const realPost = post && isBase(post) ? (threads.find((x) => x.id === post.id && isBase(x)) || post) : post;
    const timeEl = realPost && a !== "login"
      ? el("button", { class: "act-time act-time-link", onclick: () => { setView("threads"); goToThread(realPost); markThread(realPost.id); } }, time)
      : el("span", { class: "act-time" }, time);
    return el("li", { class: "act-line act-log" }, timeEl, el("span", { class: "act-what" }, what), track,
      el("span", { class: "act-more" }, more.filter(Boolean).flatMap((m, k) => (k ? [" ", m] : [m]))));
  };
  const day = act.logs.filter((c) => new Date(c.ts * 1000).toLocaleDateString("sv-SE") === act.day);
  list.replaceChildren(day.length ? el("ul", { class: "act-list" }, day.map(row)) : el("p", { class: "view-note" }, "Nothing changed that day."));
  fitActTitles();
}
/* "edit" in the player: the playing track's edit card */
$("#editBtn").onclick = () => editPlaying(false);
/* Cmd+Enter (Ctrl+Enter on Windows) while a track plays: open its edit card (on a device with a key) */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !playing || !canEdit()) return;
  const t = e.target;
  if (t.closest && t.closest("input, textarea, select, [contenteditable]") && !t.closest(".edit-form")) return;
  e.preventDefault();
  editPlaying(true);
});
/* the playing track's edit card: where it shows on this page, otherwise in its own thread;
   already open: Cmd+Enter opens (or closes) its More info, the player's "edit" closes it */
function editPlaying(more) {
  if (!playing) return;
  if (!canEdit()) { openSetup(); return; }
  const tr = playing.thread.tracks[playing.index], home = homeOf(tr);
  if (!home) return;
  const i = home.tracks.indexOf(tr);
  let t = playing.thread, k = playing.index;
  const rowOf = (id, n) => document.querySelector(view === "history" && !$("#q").value.trim()
    ? `.month-line[data-k="${CSS.escape(id)}:${n}"], .month-tracks li[data-k="${CSS.escape(id)}:${n}"]`
    : `.track[data-k="${CSS.escape(id)}:${n}"], .head-row[data-k="${CSS.escape(id)}:${n}"]`);
  let row = rowOf(t.id, k);
  if (!row) { t = home; k = i; row = rowOf(home.id, i); }
  if (!row) { goToThread(home); row = rowOf(home.id, i); }
  if (!row) return;
  const next = row.nextElementSibling;
  if (next && next.classList.contains("edit-wrap")) {
    if (more) next.querySelector(".more-info-btn")?.click(); else closeAddForm(next.querySelector(".add-form"));
    return;
  }
  toggleEditForm(t, k, row);
}

/* keyboard (laptop): Space plays/pauses, Left/Right jump 5 seconds back/forward */
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.closest && t.closest("input:not([type=range]), textarea, select, [contenteditable]")) return; // the sliders don't keep the keys
  if ($("#dock").hidden) return;
  if (e.code === "Space") { e.preventDefault(); if (!$("#playBtn").disabled) $("#playBtn").click(); }
  else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !IOS) { // volume in steps of 5
    e.preventDefault();
    const v = Math.max(0, Math.min(100, volume + (e.key === "ArrowUp" ? 5 : -5)));
    $("#vol").value = v; $("#vol").dispatchEvent(new Event("input")); flashBtn($("#volWrap"), "lit", 900); // (the number and speaker light up while the keys change it)
  }
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && adapter && adapter.controllable) {
    e.preventDefault();
    requestSeek(Math.max(0, Math.min(+seekEl.max || Infinity, (pendingSeek ? pendingSeek.t : lastTime) + (e.key === "ArrowRight" ? 5 : -5)))); flashBtn($(e.key === "ArrowRight" ? "#tDur" : "#tCur"), "tapped", 900); // (that side's time lights up, as clicking it does)
  }
});

/* ---------- boot ---------- */
let timer;
function syncClear() { $("#clearQ").hidden = !$("#q").value; }
/* leaving a search while the address points at a post (#t/…): back at that post, not at the newest one */
function endSearch() {
  if (preSearch && preSearch.view === view) { // back to where you were before searching
    const spot = preSearch; preSearch = null;
    runSearch();
    if (spot.k) { // (a post far down isn't drawn yet after the page is rebuilt: draw down to it first)
      const tid = spot.k.slice(0, spot.k.lastIndexOf(":")), at = shown.findIndex((x) => x.t.id === tid);
      while (at >= 0 && rendered <= at && rendered < shown.length) renderMore();
    }
    const row = spot.k && document.querySelector(`#threads [data-k="${CSS.escape(spot.k)}"]`);
    if (row) holdAt(row, () => spot.top); else pageScrollTo(spot.y); // (holdAt: it stays there while pictures above load)
    return;
  }
  const m = view === "threads" && location.hash.match(/^#t\/(.+)$/);
  let id = m && m[1]; try { id = id && decodeURIComponent(id); } catch {}
  const t = id && threads.find((x) => x.id === id && x.kind !== "tag");
  if (t) goToThread(t); else runSearch();
}
$("#q").addEventListener("input", () => { if (!$("#menu").hidden) toggleMenu(false); syncClear(); clearTimeout(timer); timer = setTimeout(() => ($("#q").value.trim() ? runSearch() : endSearch()), 70); });
$("#clearQ").onclick = () => { $("#q").value = ""; syncClear(); endSearch(); if (phone()) $("#q").blur(); else $("#q").focus(); };
// phones: Enter, or touching anywhere outside the search field, puts the keyboard away
/* Shift+Enter in the search field: plays the first result shown, then the next one each time (in the order shown) */
let qPlay = { q: null, n: -1 };
function playNextResult() {
  const list = [];
  for (const s of shown) {
    if (s.one != null) list.push([s.t, s.one]);
    else if (s.hits && s.t.kind !== "tag") for (const i of [...s.hits].sort((a, b) => a - b)) list.push([s.t, i]);
  }
  if (!list.length) return;
  if (qPlay.q !== query) qPlay = { q: query, n: -1 };
  qPlay.n = (qPlay.n + 1) % list.length;
  const [t, i] = list[qPlay.n];
  play(t, i);
}
$("#q").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault(); clearTimeout(timer);
  if (e.shiftKey && !phone()) { if (fold($("#q").value) !== query) runSearch(); playNextResult(); return; } // (the cursor stays in the field)
  runSearch(); $("#q").blur();
});
document.addEventListener("touchstart", (e) => { if (document.activeElement === $("#q") && !e.target.closest(".search")) $("#q").blur(); }, { passive: true });
$("#home").onclick = (e) => {
  e.preventDefault();
  if (e.metaKey || e.ctrlKey) { open(location.pathname, "_blank"); return; } // Cmd/Ctrl+click: the site in a new tab
  HOVER_MENU ? toggleMenu(true) : toggleMenu();
};
/* laptop: the menu opens as soon as the pointer is on the logo and stays open while the pointer is anywhere in
   the header (search, Add track, the menu itself); it closes ~0.4 s after leaving the header. A click on the
   logo only opens it. */
const HOVER_MENU = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
if (HOVER_MENU) {
  let tClose, tOpen;
  $("#home").addEventListener("mouseenter", () => { clearTimeout(tClose); clearTimeout(tOpen); if ($("#menu").hidden) tOpen = setTimeout(() => { if ($("#menu").hidden) toggleMenu(true); }, 40); }); // (half the Tags hover wait)
  $("#home").addEventListener("mouseleave", () => clearTimeout(tOpen));
  // it stays open while the pointer is anywhere in the header or the menu's row (also on the way from a menu
  // item to the search bar); it closes ~0.2 s after the pointer goes down into the page or leaves the window
  addEventListener("mousemove", (e) => {
    if ($("#menu").hidden) return;
    const bottom = Math.max($(".top").getBoundingClientRect().bottom, $("#menu").getBoundingClientRect().bottom) + 12;
    if (e.clientY <= bottom) { clearTimeout(tClose); tClose = null; }
    else if (!tClose) tClose = setTimeout(() => { tClose = null; toggleMenu(false); }, 100);
  }, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => { if (!$("#menu").hidden && !tClose) tClose = setTimeout(() => { tClose = null; toggleMenu(false); }, 100); });
}
$("#q").addEventListener("mousedown", () => { if (!$("#menu").hidden) toggleMenu(false); }); // clicking in the search closes the menu
$("#home").ondblclick = (e) => { e.preventDefault(); toggleMenu(false); setView("threads"); }; // back to Threads

/* Gemini's decision (from what the lookups found, or its own web search) replaces the lookups' suggested
   release, year and genres; the years the lookups found stay as "also" */
function withGemini(x, ai) {
  for (const o of Object.values(x)) if (o.rl) o.rl = [...new Set(o.rl.map((r) => String(r).replace(/[\u200b-\u200f\ufeff]/g, "").trim()).filter(Boolean))]; // "空​間" with hidden spaces = "空間"
  for (const [u, a] of Object.entries(ai || {})) {
    const o = x[u] || {};
    const ys = [o.y, ...(o.ys || [])].filter((y, k, all) => y && y !== a.y && all.indexOf(y) === k);
    const gs = [...new Set([...(a.g || []), ...(a.md || [])].map(sameGenre))]; // genres, then mood words ("synth-pop" → "synth pop")
    // releases: Gemini's pick first, then the others that were found; and where each one (and each year) came from
    const nice = (src) => (src || "").split("+").filter(Boolean).map((w) => ({ musicbrainz: "MusicBrainz", discogs: "Discogs", description: "the description" }[w] || w)).join(", ");
    const oRl = o.rl || [], oRls = o.rls || [], srcOf = (n) => { const k = oRl.findIndex((r) => r.toLowerCase() === n.toLowerCase()); return k > -1 ? nice(oRls[k]) || "MusicBrainz or Discogs" : ""; };
    const rl = a.rl ? [a.rl, ...oRl.filter((r) => r.toLowerCase() !== a.rl.toLowerCase())] : oRl;
    const who = a.how === "research" ? "Claude" : "Gemini";
    const rls = rl.map((n, k) => (k === 0 && a.rl ? who + (srcOf(n) ? " (also " + srcOf(n) + ")" : "") : srcOf(n)));
    const ysrc = {}; for (const [y, v] of Object.entries(o.ysrc || {})) ysrc[y] = nice(v);
    if (a.y) ysrc[a.y] = who + (ysrc[a.y] ? " (also " + ysrc[a.y] + ")" : "");
    x[u] = { ...o, ar: a.ar || o.ar, co: a.co || o.co, about: a.about || o.about, cover: a.cover || o.cover, rd: a.rd || o.rd, g: gs, gm: gs, y: a.y || null, ys, rl, rls, ysrc,
      src: who + (a.how === "search" || a.how === "research" ? " (web search)" : o.src ? " (checked " + o.src.split("+").join(", ") + ")" : ""), conf: a.conf, chk: o.chk || 1, v: Math.max(o.v || 0, 3) };
  }
  return x;
}
/* ---------- the side space: a box in the empty column above the video (computer, wide windows only) ----------
   General: side.show(head, items) shows it, side.hide() hides it. It hangs from under the header and is only as
   tall as its contents, at most down to just above the video (or the player bar when no video is open). */
const side = (() => {
  const box = el("aside", { class: "side", hidden: true, "aria-live": "polite" });
  const head = el("div", { class: "side-head" }), list = el("div", { class: "side-list" });
  box.append(head, list);
  document.body.append(box);
  const fits = () => !phone() && innerWidth >= 966; // the video column exists beside the list
  function place() {
    if (box.hidden) return;
    const top = headerBottom() + 10;
    let bottom = innerHeight - 16;
    const d = $("#dock");
    if (!d.hidden) {
      const m = $("#media").getBoundingClientRect(), bar = d.querySelector(".bar").getBoundingClientRect();
      bottom = (m.height && !d.classList.contains("idle") ? m.top : bar.top) - 10;
    }
    box.style.top = top + "px";
    box.style.maxHeight = Math.max(120, bottom - top) + "px";
  }
  addEventListener("resize", () => { if (!fits()) box.hidden = true; place(); });
  // (the page scrolls as usual while it is open; the wheel scrolls the box only with the pointer over it)
  return {
    fits,
    show(title, items) {
      if (!fits()) return;
      head.replaceChildren(...[].concat(title));
      list.replaceChildren(...items); list.scrollTop = 0;
      box.hidden = false; place(); document.body.classList.add("side-open");
    },
    hide() { box.hidden = true; document.body.classList.remove("side-open"); },
    get open() { return !box.hidden; },
  };
})();

/* ---------- quick tags: Cmd+click a track (Ctrl+click on Windows), or Cmd+E for the playing track ----------
   A tag field opens where the track's tags are. Picking a tag saves it straight away (Enter or a click); ","
   saves it and waits for the next one; Esc closes. The highlighted suggestion's tracks show in the side space,
   where a click plays them from that tag's playlist (the field stays open). */
let quick = null;
function trackAt(k) {
  const [id, n] = [k.slice(0, k.lastIndexOf(":")), +k.slice(k.lastIndexOf(":") + 1)];
  const t = id === "genre-mix" ? gMix : threads.find((x) => x.id === id);
  return t && t.tracks[n] ? { t, i: n, tr: t.tracks[n] } : null;
}
function tagThreadOf(g) { return threads.find((x) => x.kind === "tag" && x.name === g); }
function showTagSide(g) {
  const t = g && tagThreadOf(g);
  if (!t) { side.hide(); return; }
  const yrs = yearsText(tagYears(t));
  side.show([el("span", { class: "side-title" }, g), el("span", { class: "side-right" }, yrs ? el("span", { class: "side-years" }, yrs) : null,
    el("span", { class: "side-n" }, `${t.tracks.length} ${t.tracks.length === 1 ? "track" : "tracks"}`))],
    t.tracks.map((tr, i) => {
      const x = info(tr);
      return el("button", { type: "button", class: "side-row" + (playing && playing.thread.tracks[playing.index] === tr ? " playing" : ""),
        onmousedown: (e) => e.preventDefault(), // the tag field keeps the cursor
        onclick: () => { play(t, i); showTagSide(g); } },
        img(x.thumb, "side-thumb"), el("span", { class: "side-name" }, x.title));
    }));
}
function closeQuick() {
  if (!quick) return;
  const q = quick; quick = null;
  q.box.remove(); side.hide(); if (q.cleanup) q.cleanup();
  if (q.wrap) { // the tags line under the title, as it is now
    const fresh = tagLine(q.tr, null, q.row.closest(".genre-mix") ? genresOf(q.tr) : null)[0]; // (playlists as the ⌗ again)
    q.wrap.replaceChildren(...fresh.childNodes);
    q.wrap.style.visibility = "";
  }
  if (q.changed) refreshTags(); // the tag playlists follow (after the field is gone, so nothing jumps under it)
}
/* The field works on a draft: picking a suggestion (Enter, click, ",") puts it in the field, × or Backspace takes
   tags out, and nothing is saved until Enter on the empty field (or Shift+Enter at any time). Esc: nothing changes.
   Left/Right step through the tags already in the field (the side space shows the one you are on);
   Backspace once marks the tag before the cursor, twice takes it out. */
function openQuick(row, at, touch) {
  if (!canEdit() || (phone() && !touch)) return; // (phone: only by holding a track down)
  closeQuick();
  const { tr } = at;
  if (row) { // a track low on the screen comes up a little, so the field and its suggestions fit
    const room = innerHeight - dockH() - row.getBoundingClientRect().bottom;
    if (room < 140) pageScrollBy(140 - room);
  }
  const wrap = row && row.querySelector(".tag-wrap");
  const input = el("input", { type: "text", class: "quick-input", autocomplete: "off", spellcheck: "false", "aria-label": "Add a tag" });
  if (touch) { // phone: when the keyboard comes up, the page moves so the field (and its suggestions) stay in view above it
    const keepInView = () => {
      const vv = window.visualViewport; if (!vv || !input.isConnected) return;
      const box = input.closest(".quick-tag") || input, r = box.getBoundingClientRect();
      const drop = box.querySelector(".quick-drop"), bottom = Math.max(r.bottom, drop && !drop.hidden ? drop.getBoundingClientRect().bottom : 0);
      const visibleBottom = vv.offsetTop + vv.height - 8, visibleTop = vv.offsetTop + headerBottom() + 8;
      if (bottom > visibleBottom) pageScrollBy(Math.min(bottom - visibleBottom, r.top - visibleTop));
    };
    input.addEventListener("focus", () => { setTimeout(keepInView, 350); if (window.visualViewport) visualViewport.addEventListener("resize", keepInView, { once: true }); });
  }
  const chips = el("span", { class: "quick-chips" });
  const drop = el("ul", { class: "quick-drop", hidden: true });
  const box = el("span", { class: "quick-tag" }, chips, input);
  // the suggestions hang on the page itself (not inside the track's box, which can fade or cut them off)
  drop.classList.add("quick-drop-fixed"); document.body.append(drop);
  quick = { row, tr, wrap, box, changed: false };
  const start = shownTags(tr), draft = [...start];
  let opts = [], active = -1, mark = -1; // mark: the tag in the field that is selected (Left / Backspace)
  const dirty = () => draft.length !== start.length || draft.some((g, k) => g !== start[k]);
  const tagCount = new Map();
  for (const t of threads) if (isBase(t)) for (const x of t.tracks) for (const g of shownTags(x)) tagCount.set(g, (tagCount.get(g) || 0) + 1);
  const drawChips = () => {
    chips.replaceChildren(...draft.map((g, k) => el("button", { type: "button", class: "quick-chip" + (k === mark ? " marked" : ""), tabindex: "-1",
      onmousedown: (e) => e.preventDefault(), onclick: () => { draft.splice(k, 1); mark = -1; drawChips(); showTagSide(null); input.focus(); } },
      showTag(g), el("span", { class: "x", "aria-hidden": "true" }, "×"))));
    box.classList.toggle("dirty", dirty());
  };
  const markAt = (k) => { mark = k; drawChips(); showTagSide(k > -1 ? draft[k] : opts[active] || null); };
  const highlight = (k) => {
    active = k;
    [...drop.children].forEach((li, j) => li.classList.toggle("on", j === k));
    if (mark < 0) showTagSide(opts[k] || null);
  };
  const drawDrop = () => {
    const q = fold(input.value.trim());
    opts = q ? [...tagCount.keys()].filter((g) => !isAutoTag(g) && !draft.includes(g) && fold(g).includes(q)) // (no automatic tags)
      .sort((a, b) => fold(b).startsWith(q) - fold(a).startsWith(q) || tagCount.get(b) - tagCount.get(a)).slice(0, 8) : [];
    drop.replaceChildren(...opts.map((g, j) => el("li", { onmouseenter: () => highlight(j),
      onmousedown: (e) => { e.preventDefault(); pick(g); } }, showTag(g), el("span", { class: "gi-n" }, tagCount.get(g)))));
    drop.hidden = !opts.length;
    placeDrop();
    highlight(opts.length ? 0 : -1); // typing: the first suggestion is highlighted and its tracks show
  };
  function placeDrop() { // under the field, or above it when there is no room (above the player)
    if (drop.hidden) return;
    const b = box.getBoundingClientRect();
    drop.style.left = b.left + "px"; drop.style.top = b.bottom + 4 + "px";
    const h = drop.getBoundingClientRect().height;
    if (b.bottom + 4 + h > innerHeight - dockH() - 8) drop.style.top = Math.max(8, b.top - 4 - h) + "px";
  }
  addEventListener("scroll", placeDrop, { passive: true, capture: true });
  quick.cleanup = () => { drop.remove(); removeEventListener("scroll", placeDrop, { capture: true }); if (fadeList) fadeList.classList.remove("no-fade"); };
  const fadeList = row && row.closest(".scroll-list, .tracks, .tag-list");
  if (fadeList) fadeList.classList.add("no-fade"); // no fading over the field while it's open
  function pick(g) { // into the field (not saved yet)
    g = normTag(g);
    if (g && !draft.includes(g)) draft.push(g);
    input.value = ""; mark = -1; drawChips(); drawDrop(); input.focus();
  }
  async function save() {
    const add = draft.filter((g) => !start.includes(g)), remove = start.filter((g) => !draft.includes(g));
    if (!add.length && !remove.length) { closeQuick(); return; }
    const ts = Math.floor(Date.now() / 1000);
    box.classList.add("saving");
    try { await writeInbox({ action: "tag", ids: [tr.id], add, remove, ts }, "tag"); }
    catch (e) { box.classList.remove("saving"); box.classList.add("failed"); return; }
    applyTags(tr, draft, ts);
    tr._hay = null; gIndex = null; quick.changed = true;
    closeQuick();
  }
  input.addEventListener("input", () => { if (mark > -1) markAt(-1); drawDrop(); });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // the page's own keys (search, Space, Esc) stay out of it
    const typed = input.value.trim(), atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    if (e.key === "Escape") { e.preventDefault(); closeQuick(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (typed) pick(opts[active] || typed);       // a suggestion (or what you typed) goes into the field
      if (e.shiftKey || !typed) save();             // Enter on the empty field, or Shift+Enter: save
    } else if (e.key === ",") { e.preventDefault(); if (typed) pick(opts[active] || typed); }
    else if (e.key === "Backspace" && !input.value) {
      e.preventDefault();
      if (mark > -1) { draft.splice(mark, 1); markAt(-1); }
      else if (draft.length) markAt(draft.length - 1); // first press marks it, the second takes it out
    } else if (e.key === "ArrowLeft" && (atStart || !input.value) && draft.length) {
      e.preventDefault(); markAt(mark < 0 ? draft.length - 1 : Math.max(0, mark - 1));
    } else if (e.key === "ArrowRight" && mark < 0 && typed && input.selectionStart === input.value.length) {
      e.preventDefault(); pick(typed); // what you typed, as it is (a new tag), not the suggestion
    } else if (e.key === "ArrowRight" && mark > -1) {
      e.preventDefault(); markAt(mark + 1 < draft.length ? mark + 1 : -1);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && opts.length) {
      e.preventDefault(); highlight((active + (e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length);
    } else if (mark > -1 && e.key.length === 1) markAt(-1);
  });
  // clicking elsewhere closes it, unless there are changes not saved yet
  input.addEventListener("blur", () => setTimeout(() => { if (quick && quick.box === box && !box.contains(document.activeElement) && !dirty()) closeQuick(); }, 150));
  box.addEventListener("mousedown", (e) => { if (e.target !== input) { e.preventDefault(); input.focus(); } });
  drawChips();
  // it lies over the tags line (the line itself is inside the track's play button, where a field can't go)
  const anchor = wrap || (row && row.querySelector(".tr-title, .t-title"));
  if (row && anchor) {
    if (getComputedStyle(row).position === "static") row.style.position = "relative";
    const a = anchor.getBoundingClientRect(), r0 = row.getBoundingClientRect();
    box.style.left = (touch ? 0 : a.left - r0.left) + "px"; // (phone: the whole width of the track)
    box.style.top = (wrap ? a.top - r0.top - 3 : a.bottom - r0.top + 2) + "px";
    if (wrap) wrap.style.visibility = "hidden";
    row.append(box);
  } else { box.classList.add("quick-float"); document.body.append(box); } // the playing track isn't on the page: over the player
  input.focus();
}
/* a click outside an open field with unsaved changes: it stays (Esc or Enter decides) */
/* Cmd+click (Ctrl+click) on a track (anywhere on its row) */
document.addEventListener("click", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !canEdit() || phone()) return;
  // anywhere on a track's row: its title, thumbnail or the box around it (not its own buttons, links or tags)
  const hit = e.target.closest && e.target.closest("#threads .track, #threads .head-row, #threads .month-play");
  if (!hit || (e.target.closest("a, button, input, textarea, .tag, form, .edit-wrap") && !e.target.closest(".play, .thread-head"))) return;
  const row = hit.closest("[data-k]"), at = row && trackAt(row.dataset.k);
  if (!at) return;
  e.preventDefault(); e.stopPropagation();
  openQuick(row, at);
}, true);
/* phone (with the key): holding a track down opens the quick tag field for it */
{
  let hold = null, swallow = false;
  const SEL = "#threads .track .play, #threads .head-row .thread-head, #threads .month-play";
  const cancel = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
  document.addEventListener("touchstart", (e) => {
    cancel();
    if (!phone() || !canEdit() || e.touches.length !== 1) return;
    const hit = e.target.closest && e.target.closest(SEL); if (!hit) return;
    const row = hit.closest("[data-k]"), at = row && trackAt(row.dataset.k); if (!at) return;
    const { clientX: x, clientY: y } = e.touches[0];
    hold = { x, y, timer: setTimeout(() => { hold = null; swallow = true; setTimeout(() => { swallow = false; }, 800); if (navigator.vibrate) navigator.vibrate(10); openQuick(row, at, true); }, 500) };
  }, { passive: true });
  document.addEventListener("touchmove", (e) => { if (hold && Math.hypot(e.touches[0].clientX - hold.x, e.touches[0].clientY - hold.y) > 10) cancel(); }, { passive: true });
  document.addEventListener("touchend", (e) => { cancel(); if (swallow) e.preventDefault(); }, { passive: false }); // (the lift after holding doesn't play the track)
  document.addEventListener("touchcancel", cancel, { passive: true });
  document.addEventListener("click", (e) => { if (swallow && e.target.closest && e.target.closest(SEL)) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener("contextmenu", (e) => { if (phone() && canEdit() && e.target.closest && e.target.closest(SEL)) e.preventDefault(); });
}
/* Cmd+E (Ctrl+E), or Cmd+click on the player's title: the playing track */
function quickPlaying() {
  if (!playing) return;
  const tr = playing.thread.tracks[playing.index];
  const rows = [...document.querySelectorAll("#threads [data-k]")].filter((r) => { const a = trackAt(r.dataset.k); return a && a.tr === tr && r.offsetParent; });
  const row = rows.find((r) => r.closest(".thread") && r.closest(".thread").id === "th-" + playing.thread.id) || rows[0] || null;
  openQuick(row, { tr });
}
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "e" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !playing || !canEdit() || phone()) return;
  e.preventDefault();
  quick ? closeQuick() : quickPlaying();
});
$("#nowTitle").addEventListener("click", (e) => { if ((e.metaKey || e.ctrlKey) && canEdit()) { e.stopImmediatePropagation(); quickPlaying(); } }, true);

/* "Please fill in this field" and the like: our own note (the browser's can't take the site's colours) */
const invalidBox = el("div", { class: "invalid-note", hidden: true }, el("span", { class: "invalid-i", "aria-hidden": "true" }, "!"), el("span", { class: "invalid-msg" }));
document.body.append(invalidBox);
let invalidAt = 0;
document.addEventListener("invalid", (e) => {
  e.preventDefault();
  if (Date.now() - invalidAt < 100) return; // a form with several: only the first one
  invalidAt = Date.now();
  const f = e.target, r = f.getBoundingClientRect();
  invalidBox.querySelector(".invalid-msg").textContent = f.validationMessage;
  invalidBox.hidden = false;
  invalidBox.style.left = Math.max(8, r.left) + "px";
  invalidBox.style.top = r.bottom + 6 + "px";
  f.focus({ preventScroll: true });
  const hide = () => { invalidBox.hidden = true; f.removeEventListener("input", hide); f.removeEventListener("blur", hide); };
  f.addEventListener("input", hide); f.addEventListener("blur", hide);
  setTimeout(hide, 4000);
}, true);
addEventListener("scroll", () => { invalidBox.hidden = true; }, { passive: true, capture: true });

/* a small note when hovering something (like the search's "why" note): lines of text */
function hoverNote(target, lines) {
  let t = 0;
  target.classList.add("has-note");
  target.addEventListener("mouseenter", (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      whyBox.replaceChildren(...lines.map((l) => el("div", {}, l)));
      whyBox.hidden = false;
      const r = target.getBoundingClientRect(), b = whyBox.getBoundingClientRect();
      whyBox.style.left = Math.min(r.left, innerWidth - b.width - 8) + "px";
      whyBox.style.top = Math.min(r.bottom + 6, innerHeight - b.height - 8) + "px";
    }, 400);
  });
  target.addEventListener("mouseleave", () => { clearTimeout(t); whyBox.hidden = true; });
}
/* "GB" → "United Kingdom" (a name stays as it is) */
const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
function countryList(c) { return String(c || "").split(/\s*,\s*/).filter(Boolean).map(countryName); } // "GB,US" → two
function countryName(c) {
  if (!c) return "";
  if (c.includes(",")) return countryList(c).join(", ");
  if (/^[A-Z]{2}$/.test(c) && regionNames) { try { return regionNames.of(c) || c; } catch { return c; } }
  return c;
}
/* computer: track titles (and the player's) can be selected with the mouse; a drag that selects doesn't also play */
document.addEventListener("click", (e) => {
  const sel = window.getSelection && getSelection();
  if (!sel || sel.isCollapsed || phone()) return;
  if (e.target.closest && e.target.closest(".tr-title, .t-title, #nowTitle")) { e.preventDefault(); e.stopPropagation(); }
}, true);

(async function boot() {
  try {
    const [d, m, x, ai] = await Promise.all([
      fetch("data/tracks.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/meta.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("data/extra.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("data/ai.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    threads = d.threads; meta = m; extra = withGemini(x, ai);
    for (const t of threads) for (const tr of t.tracks) { setYear(tr); setGenresOf(tr); setArtistCountry(tr); }
    threads.push(...makeTagThreads());
    sortThreads();
  } catch (e) {
    $("#resultInfo").hidden = false;
    $("#resultInfo").textContent = "The archive didn't load. Reload the page to try again.";
    return;
  }
  const deep = location.hash.match(/^#t\/(.+)$/);
  const deepT = deep && threads.find((t) => t.id === decodeURIComponent(deep[1])); // a post's address: the feed opens at that post
  const tagHash = location.hash.match(/^#\/tag\/(.+)$/);
  if (tagHash) tagPageName = decodeURIComponent(tagHash[1]); // a tag's own page
  const page = location.hash.match(/^#\/(\w+)/), pv = page && (VIEW_OF[page[1]] || page[1]);
  if (page && VIEW_NAMES[pv]) view = pv;
  if (page && HASH_OF[page[1]]) history.replaceState(null, "", location.hash.replace("#/" + page[1], "#/" + HASH_OF[page[1]])); // (an old #/tagged link: shown as #/archive)
  if (page && page[1] === "random") setTimeout(() => setView("random"), 0); // Random opened in a new tab
  const gq = location.hash.match(/^#\/genres\?g=(.+)$/);
  if (gq) gSel = gq[1].split(",").map(decodeURIComponent).filter(Boolean);
  document.querySelectorAll("#menu [data-view]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === view || (view === "lookup" && b.dataset.view === "activity"))));
  document.body.dataset.view = view;
  if (!phone()) idleDock(); // the empty player bar is there from the start on a computer
  runSearch();
  if (deepT) { goToThread(deepT); markThread(deepT.id); }
  watchHistory(); watchIndex();
  checkSetupHash();
})();

/* Lookup (key only): screenshots and photos of songs to look up later. They come from the phone's share sheet (the
   "Save to nrgfm" shortcut, with the upload key made here) or from Upload / dragging / pasting here. The artist and
   title in each are read on the Activity server; Youtube and Google search for them, Add opens Add track with them. */
const lk = { items: [], used: 0, max: 0, phoneKey: false, reads: true, done: false, token: 0, head: el("div", { class: "act-head lk-head" }), poll: null, newKey: null };
const lkApi = (path, body) => fetch(ACT_URL + path, body === undefined ? { headers: { Authorization: "Bearer " + getToken() } }
  : { method: "POST", headers: { Authorization: "Bearer " + getToken(), "Content-Type": "text/plain" }, body: JSON.stringify(body) })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "The Activity server answered " + r.status + "."); return d; });
const lkFile = el("input", { type: "file", accept: "image/*,video/*", multiple: true, hidden: true, onchange: (e) => { lkUpload([...e.target.files]); e.target.value = ""; } });
document.body.append(lkFile);
async function lkUpload(files) {
  files = files.filter((f) => f && /^(image|video)\//.test(f.type || "image/"));
  if (!files.length || !getToken() || !ACT_URL) return;
  lk.uploading = (lk.uploading || 0) + files.length; drawLookupHead();
  for (const f of files) {
    try {
      const r = await fetch(ACT_URL + "/lookup/up", { method: "POST", headers: { Authorization: "Bearer " + getToken(), "Content-Type": f.type || "application/octet-stream" }, body: f });
      if (!r.ok) { const d = await r.json().catch(() => ({})); lk.error = d.error || "Upload failed (" + r.status + ")."; }
    } catch { lk.error = "Upload failed: no connection."; }
    lk.uploading--;
  }
  lk.done = false;
  renderLookup();
}
async function renderLookup() {
  const list = $("#threads"), token = ++lk.token;
  clearTimeout(lk.poll);
  if (!getToken()) { lk.head.replaceChildren(); list.replaceChildren(el("p", { class: "view-note" }, "Lookup is only shown on a device with the key.")); return; }
  if (!ACT_URL) { lk.head.replaceChildren(); list.replaceChildren(el("p", { class: "view-note" }, "The Activity server isn't set up yet.")); return; }
  if (!lk.items.length) list.replaceChildren(el("p", { class: "view-note" }, "Loading…"));
  let d;
  try { d = await lkApi("/lookup"); } catch (e) { if (token === lk.token) { lk.head.replaceChildren(); list.replaceChildren(el("p", { class: "view-note" }, e.message)); } return; }
  if (token !== lk.token || view !== "lookup") return;
  const finals = new Map(lk.items.map((x) => [x.id, x.final])); // (a search being typed isn't lost)
  for (const x of d.items || []) if (finals.has(x.id) && finals.get(x.id) != null) x.final = finals.get(x.id);
  Object.assign(lk, { items: d.items || [], used: d.used || 0, max: d.max || 0, phoneKey: !!d.phoneKey, reads: d.reads !== false });
  drawLookupHead(); drawLookupList();
  if (lk.reads) lkReadAll();
}
document.addEventListener("visibilitychange", () => { // (back to this tab: anything new from the phone)
  if (!document.hidden && view === "lookup" && !$("#q").value.trim() && !(document.activeElement && document.activeElement.closest(".lk-item"))) renderLookup();
});
const lkMB = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + " GB" : Math.max(1, Math.round(n / 1024 ** 2)) + " MB");
function drawLookupHead() {
  const todo = lk.items.filter((x) => !x.done).length, done = lk.items.length - todo;
  const show = (d) => () => { lk.done = d; drawLookupHead(); drawLookupList(); };
  const msg = lk.uploading ? `Uploading ${lk.uploading}…` : lk.error || "";
  lk.head.replaceChildren(
    el("div", { class: "act-row1 lk-row1" },
      el("div", { class: "act-views lk-views" },
        el("button", { class: "when-link" + (!lk.done ? " on" : ""), onclick: show(false) }, "To look up", el("span", { class: "gi-n" }, todo)),
        el("button", { class: "when-link" + (lk.done ? " on" : ""), onclick: show(true) }, "Done", el("span", { class: "gi-n" }, done))),
      el("span", { class: "lk-msg" + (lk.error && !lk.uploading ? " err" : "") }, msg),
      el("div", { class: "act-views lk-tools" },
        el("span", { class: "lk-used" }, lk.max ? `${lkMB(lk.used)} of ${lkMB(lk.max)}` : ""),
        el("button", { class: "when-link lk-upload", onclick: () => { lk.error = ""; lkFile.click(); } }, "Upload"),
        el("button", { class: "when-link", onclick: () => setView("activity") }, "Back"))),
    );
  if (lk.error && !lk.uploading) { clearTimeout(lk.errT); lk.errT = setTimeout(() => { lk.error = ""; if (view === "lookup") drawLookupHead(); }, 8000); }
  const head = $("#viewHead");
  if (view === "lookup" && !$("#q").value.trim()) { head.className = "view-head view-history view-lookup"; head.replaceChildren(lk.head); head.hidden = false; }
}
function lkWhen(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const t = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return "Today " + t;
  if (d.toDateString() === new Date(now - 864e5).toDateString()) return "Yesterday " + t;
  return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3) + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "") + " " + t;
}
const isVideo = (x) => /^video\//.test(x.type || "");
function lkMedia(x, big) { // the image, or the video (its first frame in the list; playing in the big view)
  if (!isVideo(x)) return el("img", { class: big ? "lk-big" : "lk-img", alt: "", src: x.src, loading: "lazy" });
  return big ? el("video", { class: "lk-big", src: x.src, controls: true, autoplay: true, playsinline: true, onclick: (e) => e.stopPropagation() })
    : el("video", { class: "lk-img", src: x.src + "#t=0.1", muted: true, playsinline: true, preload: "metadata" });
}
const LK_SEARCH = [["Youtube", "https://www.youtube.com/results?search_query="], ["Google", "https://www.google.com/search?q="]];
const lkSearchBtns = (get) => LK_SEARCH.map(([name, base]) => el("button", { class: "when-link", onclick: () => { const q = get().trim(); if (q) open(base + encodeURIComponent(q), "_blank", "noopener"); } }, name));
const lkLines = (x) => x.lines || (x.songs || []).map((sg) => ({ t: [sg.artist, sg.title].filter(Boolean).join(" – ") })).concat(x.text ? [{ t: x.text }] : []); // (images read before lines: what was read then)
const lkLineText = (ln) => (typeof ln.e === "string" ? ln.e : ln.t);
lk.open = new Set(); lk.reading = new Set();
function lkSave(x, body) { return lkApi("/lookup/set", { id: x.id, ...body }).catch((e) => { lk.error = e.message; drawLookupHead(); }); }
/* one image (or video) and its text. Closed: a thumbnail with its lines. Open (click the image): the image as big as the
   page allows, the search field (the cursor goes there) and every line with Edit, Copy and the three searches */
function lkItemNode(x) {
  const open = lk.open.has(x.id), lines = lkLines(x);
  const toggle = () => { open ? lk.open.delete(x.id) : lk.open.add(x.id); lkReplace(x, !open); };
  const media = lkMedia(x, open);
  const thumb = isVideo(x) && open ? el("div", { class: "lk-thumb lk-open-media" }, media)
    : el("button", { class: "lk-thumb" + (isVideo(x) ? " lk-vid" : "") + (open ? " lk-open-media" : ""), "aria-label": open ? "Smaller" : "Bigger", onclick: toggle }, media);
  let body;
  if (!open) {
    const shown = lines.slice(0, 5).map((ln) => el("p", { class: "lk-line-plain" }, lkLineText(ln)));
    body = [x.final ? el("p", { class: "lk-final-plain" }, x.final) : null, shown,
      lines.length > 5 ? el("p", { class: "lk-more" }, `+ ${lines.length - 5} more`) : null];
  } else {
    const final = el("input", { type: "text", class: "lk-final", value: x.final || "", placeholder: "Type here, or Copy lines into it", "aria-label": "Search for" });
    let t = null;
    const saveFinal = () => { clearTimeout(t); if ((x.final || "") !== final.value) { x.final = final.value; lkSave(x, { final: final.value }); } };
    final.addEventListener("input", () => { clearTimeout(t); t = setTimeout(saveFinal, 700); });
    final.addEventListener("blur", saveFinal);
    // (Esc: the image small again, see below)
    const copyIn = (text) => { // after what's there, with a space between
      const v = final.value.replace(/\s+$/, "");
      final.value = (v ? v + " " : "") + text.trim();
      saveFinal(); final.focus(); final.setSelectionRange(final.value.length, final.value.length);
    };
    const lineRow = (ln, k) => {
      const row = el("div", { class: "lk-line" });
      const draw = () => row.replaceChildren(el("span", { class: "lk-line-text" }, lkLineText(ln)),
        el("span", { class: "lk-btns" },
          el("button", { class: "when-link", onclick: () => copyIn(lkLineText(ln)) }, "Copy"),
          el("button", { class: "when-link", onclick: edit }, "Edit"),
          lkSearchBtns(() => lkLineText(ln))));
      const edit = () => {
        const input = el("input", { type: "text", class: "lk-in lk-line-in", value: lkLineText(ln) });
        const save = () => { const v = input.value.trim(); if (v !== lkLineText(ln)) { if (v === ln.t) delete ln.e; else ln.e = v; x.lines = lines; lkSave(x, { lines }); } draw(); };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape") { e.stopPropagation(); draw(); } });
        row.replaceChildren(input, el("span", { class: "lk-btns" }, el("button", { class: "when-link", onclick: save }, "Save"), el("button", { class: "when-link", onclick: draw }, "Cancel")));
        input.focus(); input.select();
      };
      draw();
      return row;
    };
    body = [el("div", { class: "lk-final-row" }, final, el("span", { class: "lk-btns" }, lkSearchBtns(() => final.value))),
      el("div", { class: "lk-lines" }, lines.map(lineRow))];
    requestAnimationFrame(() => { if (!document.activeElement || !document.activeElement.closest(".lk-item")) { final.focus({ preventScroll: true }); final.setSelectionRange(final.value.length, final.value.length); } });
  }
  const reading = lk.reading.has(x.id) || (!x.read_ts && lk.reads);
  const status = reading ? el("p", { class: "lk-note" }, isVideo(x) ? "Reading the video…" : "Reading…")
    : !lk.reads && !x.read_ts ? el("p", { class: "lk-note" }, "Not read (no Gemini key on the server).")
    : x.read_err ? el("p", { class: "lk-note err" }, "Couldn't read it: " + x.read_err)
    : !lines.length ? el("p", { class: "lk-note" }, "No text found in it.") : null;
  const del = el("button", { class: "when-link lk-del", onclick: async (e) => {
    const b = e.currentTarget;
    if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Confirm"; setTimeout(() => { if (b.isConnected && !b.classList.contains("deleting")) { delete b.dataset.confirm; b.textContent = "Delete"; } }, 4000); return; }
    b.classList.add("deleting"); b.disabled = true; // (red until it's gone)
    try { await lkApi("/lookup/del", { id: x.id }); } catch (err) { lk.error = err.message; b.classList.remove("deleting"); b.disabled = false; delete b.dataset.confirm; b.textContent = "Delete"; drawLookupHead(); return; }
    lk.items = lk.items.filter((y) => y !== x); drawLookupHead(); drawLookupList();
  } }, "Delete");
  return el("li", { class: "lk-item" + (open ? " open" : ""), "data-id": x.id }, thumb,
    el("div", { class: "lk-body" }, ...body.flat(), status,
      el("div", { class: "lk-foot" },
        el("span", { class: "lk-when" }, lkWhen(x.ts) + (x.from === "phone" ? " · Phone" : "")),
        el("span", { class: "lk-btns" },
          reading ? null : el("button", { class: "when-link", onclick: () => lkRead(x, true) }, "Read again"),
          el("button", { class: "when-link lk-done" + (x.done ? " on" : ""), onclick: async (e) => {
            const b = e.currentTarget; if (b.classList.contains("saving")) return;
            b.classList.add("saving"); // (blue until it's saved)
            x.done = x.done ? 0 : 1; lk.open.delete(x.id); await lkSave(x, { done: !!x.done }); drawLookupHead(); drawLookupList();
          } }, x.done ? "Not done" : "Done"),
          del))));
}
/* draw one item again (keeps what's being typed in it); opened: brought to the top of the page */
function lkReplace(x, scroll) {
  const old = document.querySelector(`.lk-item[data-id="${CSS.escape(x.id)}"]`);
  if (!old) return;
  const act = document.activeElement, keep = act && old.contains(act) && act.matches(".lk-final") ? { v: act.value, a: act.selectionStart, b: act.selectionEnd } : null;
  const node = lkItemNode(x);
  old.replaceWith(node);
  if (keep) { const f = node.querySelector(".lk-final"); if (f) { f.value = keep.v; f.focus({ preventScroll: true }); f.setSelectionRange(keep.a, keep.b); } }
  if (scroll) { // opened: as big as fits between the page's header and the player, and all of it in view
    const top = $("#viewHead").getBoundingClientRect().bottom, bar = document.querySelector(".bar"), bt = bar && bar.offsetHeight ? bar.getBoundingClientRect().top : 0;
    const bottom = bt > top + 100 ? bt : (visualViewport ? visualViewport.height : innerHeight); // (the player at the bottom, when it's there)
    document.documentElement.style.setProperty("--lk-room", Math.max(200, Math.floor(bottom - top - 22)) + "px");
    // the image's top just under the header (the dotted line above the item goes up under it)
    const place = () => { const m = node.querySelector(".lk-thumb"); pageScrollTo(pageY() + (m || node).getBoundingClientRect().top - $("#viewHead").getBoundingClientRect().bottom - 8); };
    requestAnimationFrame(() => { place(); requestAnimationFrame(place); }); // (twice: the header sits differently once the page has moved)
    const m = node.querySelector(".lk-big"); if (m) m.addEventListener(m.tagName === "VIDEO" ? "loadedmetadata" : "load", place, { once: true }); // (again once its size is known)
  }
}
/* reading: one at a time, asked for by this page (the server reads while it waits) */
async function lkRead(x, again) {
  if (lk.reading.has(x.id)) return;
  lk.reading.add(x.id); lkReplace(x);
  try {
    const r = await lkApi("/lookup/read", { id: x.id });
    if (r.error) x.read_err = r.error;
  } catch (e) { x.read_err = e.message; }
  lk.reading.delete(x.id);
  try { const d = await lkApi("/lookup"); const y = (d.items || []).find((i) => i.id === x.id); if (y) Object.assign(x, y, { final: x.final }); } catch {}
  if (!x.read_ts) x.read_ts = Math.floor(Date.now() / 1000);
  lkReplace(x);
}
async function lkReadAll() {
  if (lk.readingAll) return;
  lk.readingAll = true;
  try { for (const x of lk.items.filter((y) => !y.read_ts)) { if (view !== "lookup") break; await lkRead(x); } } finally { lk.readingAll = false; }
}
function drawLookupList() {
  const list = $("#threads");
  const rows = lk.items.filter((x) => !!x.done === lk.done);
  if (!rows.length) {
    list.replaceChildren(el("p", { class: "view-note" }, lk.done ? "Nothing marked done yet." : lk.items.length ? "Everything has been looked up."
      : phone() ? "Nothing saved yet. Share a screenshot or screen recording to “Save to nrgfm”." : "Nothing saved yet. Upload, drag images or videos here, or paste one (⌘V). On the phone: share a screenshot or screen recording to “Save to nrgfm”."));
    return;
  }
  list.replaceChildren(el("ul", { class: "lk-list" }, rows.map(lkItemNode)));
}
/* Lookup: Esc makes the opened image small again (Esc while correcting a line only stops correcting it) */
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || view !== "lookup" || !lk.open.size || e.defaultPrevented) return;
  const t = e.target;
  if (t && t.closest && (t.closest(".lk-line-in") || t.closest("#q") || t.closest("#addPanel") || t.closest(".lock"))) return;
  e.preventDefault();
  const f = t && t.closest && t.closest(".lk-final"); if (f) f.blur(); // (saves what was typed)
  for (const id of [...lk.open]) { lk.open.delete(id); const x = lk.items.find((y) => y.id === id); if (x) lkReplace(x); }
});
/* Lookup on the computer: drop images anywhere on the page, or paste one */
addEventListener("dragover", (e) => { if (view === "lookup" && getToken() && [...(e.dataTransfer?.items || [])].some((i) => i.kind === "file")) { e.preventDefault(); document.body.classList.add("lk-drop"); } });
addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("lk-drop"); });
addEventListener("drop", (e) => {
  document.body.classList.remove("lk-drop");
  if (view !== "lookup" || !getToken()) return;
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) { e.preventDefault(); lkUpload(files); }
});
addEventListener("paste", (e) => {
  if (view !== "lookup" || !getToken() || (e.target && e.target.closest && e.target.closest("input, textarea"))) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); lkUpload(files); }
});
