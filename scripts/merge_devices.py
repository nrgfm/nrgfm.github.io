"""One-off: devices with the same name -> the older entries' plays and logins move to the newest one, then the older entries are removed.
Usage: merge_devices.py list | merge"""
import sys, time
sys.path.insert(0, "scripts")
from budget import _sql

rows = _sql("SELECT who, name, owner, first, last, (SELECT COUNT(*) FROM plays p WHERE p.who = d.who) AS n FROM devices d WHERE name IS NOT NULL AND name != '' ORDER BY name, first")
by = {}
for r in rows:
    by.setdefault(r["name"], []).append(r)
day = lambda t: time.strftime("%Y-%m-%d %H:%M", time.gmtime(t or 0))
for name, rs in by.items():
    for r in rs:
        print(f"{name!r:24} {r['who'][:6]}…  first {day(r['first'])}  last {day(r['last'])}  plays {r['n']}")
if sys.argv[1:] == ["merge"]:
    for name, rs in by.items():
        if len(rs) < 2:
            continue
        new = max(rs, key=lambda r: r["first"] or 0)
        for old in rs:
            if old is new:
                continue
            for t in ("plays", "logins", "sessions"):
                _sql(f"UPDATE {t} SET who = ?1 WHERE who = ?2", (new["who"], old["who"]))
            _sql("UPDATE devices SET first = MIN(first, ?1), owner = MAX(owner, ?2) WHERE who = ?3", (old["first"], old["owner"], new["who"]))
            _sql("DELETE FROM devices WHERE who = ?1", (old["who"],))
            print(f"merged {name!r}: {old['who'][:6]}… -> {new['who'][:6]}…")
