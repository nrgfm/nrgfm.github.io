-- the play log (kept one year) and the devices that played
CREATE TABLE IF NOT EXISTS plays (
  id TEXT PRIMARY KEY,      -- one play (made by the page)
  ts INTEGER NOT NULL,      -- when it started (unix seconds)
  who TEXT NOT NULL,        -- the browser/device that played it (a random id kept in that browser)
  url TEXT, tid TEXT, title TEXT,
  sec INTEGER,              -- seconds actually played
  dur INTEGER,              -- length of the track (seconds), when known
  city TEXT, country TEXT   -- roughly where (from Cloudflare; the IP address itself is not stored)
);
CREATE INDEX IF NOT EXISTS plays_ts ON plays(ts);
CREATE INDEX IF NOT EXISTS plays_who ON plays(who, ts);
CREATE TABLE IF NOT EXISTS devices (
  who TEXT PRIMARY KEY,
  name TEXT,                -- a name given on the Activity page ("MacBook", "iPhone"); empty for guests
  owner INTEGER DEFAULT 0,  -- played with the editing key on that device
  city TEXT, country TEXT,
  first INTEGER, last INTEGER
);
-- passwords (levels 2 and 3), logins and the sessions they give (12 hours)
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS logins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  who TEXT,                 -- the browser (as for plays)
  level INTEGER,            -- 2 or 3; NULL: a wrong password
  ok INTEGER NOT NULL,      -- 1 logged in, 0 wrong password, -1 refused (locked after 5 wrong in an hour), 2 logged out
  city TEXT, country TEXT
);
CREATE INDEX IF NOT EXISTS logins_ts ON logins(ts);
CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, level INTEGER NOT NULL, who TEXT, exp INTEGER NOT NULL);
-- Lookup: screenshots and photos of songs to look up later (the images themselves are in R2, bucket nrgfm-lookup)
CREATE TABLE IF NOT EXISTS lookup (
  id TEXT PRIMARY KEY,      -- also the image's name in R2
  ts INTEGER NOT NULL,      -- when it was saved
  type TEXT, size INTEGER,
  src TEXT,                 -- "phone" (the share sheet) or "upload" (the site)
  songs TEXT,               -- JSON [{artist, title}] read from the image (or corrected by hand)
  text TEXT,                -- other words in it that help
  read_ts INTEGER, read_err TEXT,
  done INTEGER DEFAULT 0,   -- when it was marked done (0: still to look up)
  lines TEXT,               -- JSON [{t, e}]: each line of text in it (t as read, e as corrected by hand)
  final TEXT                -- what was typed together from them to search for
);
CREATE INDEX IF NOT EXISTS lookup_ts ON lookup(ts);
-- this month's Gemini use (Google's billing month), shared by the GitHub jobs (scripts/budget.py) and Lookup
CREATE TABLE IF NOT EXISTS gemini_usage (month TEXT PRIMARY KEY, searches INTEGER DEFAULT 0, micro INTEGER DEFAULT 0,
  requests INTEGER DEFAULT 0, day TEXT, day_searches INTEGER DEFAULT 0);
