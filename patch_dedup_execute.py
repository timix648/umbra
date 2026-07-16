#!/usr/bin/env python3
"""
UMBRA - backend/server.js
=========================
Remove the DEAD duplicate POST /api/real/execute/:cid handler. Two handlers exist;
Express only runs the first (which uses the correct versioned interface
ALLOC_IFACE_VER). The second uses the package-NAME ALLOC_IFACE, which doesn't work
for exercises anyway, and is never reached. Strip it.

Run:  python3 patch_dedup_execute.py      backend -> restart
"""
import time, shutil, sys

PATH = "backend/server.js"
s = open(PATH, encoding="utf-8").read()
orig = s

marker = 'app.post("/api/real/execute/:cid"'
n = s.count(marker)
if n == 1:
    print("already deduped (one execute handler) - nothing to do."); sys.exit(0)
assert n == 2, f"expected 2 execute handlers, found {n}"

i1 = s.index(marker)
i2 = s.index(marker, i1 + 1)              # the dead second handler
end = s.index("\n});\n", i2) + len("\n});\n")
block = s[i2:end]
# guard: only remove the ALLOC_IFACE (non-versioned) dead one
assert "templateId: ALLOC_IFACE," in block and "ALLOC_IFACE_VER" not in block, \
    "the second handler isn't the expected dead one - aborting"

after = end
if s[after:after + 1] == "\n":
    after += 1                            # eat one trailing blank line
s = s[:i2] + s[after:]

assert s.count(marker) == 1, "should be exactly one execute handler left"
assert 'app.post("/api/real/settle"' in s and "execTransferContext" in s, "settle must stay intact"

if s == orig:
    print("NO CHANGES."); sys.exit(1)
bak = f"{PATH}.pre-dedup-{int(time.time())}"
shutil.copyfile(PATH, bak)
open(PATH, "w", encoding="utf-8").write(s)
print("  [ok] removed dead duplicate /api/real/execute handler")
print(f"Backup: {bak}")
print(f"Patched: {PATH}  ({len(orig)} -> {len(s)} chars)")
