#!/usr/bin/env python3
"""
UMBRA - backend/server.js  (umbra-v6)
=====================================
Fix /api/real/award: the allocate step runs AFTER the blind auction's 4 ledger
transactions, and the registry (validating the raw input holding against its own
slightly-lagged ledger view) transiently rejects the holding as "invalid" -- the
SAME cid allocates fine directly (nothing preceding it). Fix: allocate the real
legs FIRST, while the ledger is quiet; the blind auction becomes the on-ledger
record; the settle at the end executes the pre-made allocations.

Run:  python3 patch_award_reorder.py    backend -> restart
"""
import shutil, sys, time

PATH = "backend/server.js"
src = open(PATH, encoding="utf-8").read()
orig = src

# 1) REMOVE the allocate block from its current spot (after the auction).
REMOVE = '''    steps.push("requester accepted quote (blind auction complete)");

    // ---- real settlement ----
    const settleId = "umbra-real-" + Date.now();
    const offLeg = await allocateRealLeg("requester", dealerRole, offAdmin, offerAsset.symbol,
      offerSym, offerAmount, settleId, "offer-leg");
    steps.push("allocated real offer leg (" + offerAmount + " " + offerAsset.symbol + ")");
    const wantLeg = await allocateRealLeg(dealerRole, "requester", wantAdmin, wantAsset.symbol,
      wantSym, wantAmount, settleId, "want-leg");
    steps.push("allocated real want leg (" + wantAmount + " " + wantAsset.symbol + ")");

    // record the trade on-ledger (blind-auction result + real allocation pointers)'''

REMOVE_TO = '''    steps.push("requester accepted quote (blind auction complete)");

    // record the trade on-ledger (blind-auction result + real allocation pointers)'''

# 2) INSERT the allocate block BEFORE the blind auction.
ANCHOR = '''    // ---- blind auction choreography (on-ledger, identical to stand-in) ----
    let b = await idSetSwap(requester, "UmbraSwap:SwapRfq");'''

INSERT = '''    // ---- allocate the real legs FIRST, while the ledger is quiet ----
    // The registry validates each input holding against its own (slightly lagged)
    // view of the ledger. If the blind auction's transactions run first, that churn
    // makes the registry transiently reject the holding as "invalid" (the same cid
    // allocates fine when nothing precedes it). Allocating up front avoids that: the
    // allocations lock the holdings, the blind auction below is the on-ledger trade
    // record, and the settle at the end executes these pre-made allocations.
    const settleId = "umbra-real-" + Date.now();
    const offLeg = await allocateRealLeg("requester", dealerRole, offAdmin, offerAsset.symbol,
      offerSym, offerAmount, settleId, "offer-leg");
    steps.push("allocated real offer leg (" + offerAmount + " " + offerAsset.symbol + ")");
    const wantLeg = await allocateRealLeg(dealerRole, "requester", wantAdmin, wantAsset.symbol,
      wantSym, wantAmount, settleId, "want-leg");
    steps.push("allocated real want leg (" + wantAmount + " " + wantAsset.symbol + ")");

    // ---- blind auction choreography (on-ledger, identical to stand-in) ----
    let b = await idSetSwap(requester, "UmbraSwap:SwapRfq");'''

assert src.count(REMOVE) == 1, f"REMOVE anchor found {src.count(REMOVE)}x, expected 1"
src = src.replace(REMOVE, REMOVE_TO, 1)
assert src.count(ANCHOR) == 1, f"INSERT anchor found {src.count(ANCHOR)}x, expected 1"
src = src.replace(ANCHOR, INSERT, 1)

# sanity: settleId declared exactly once in the award; allocate now before auction
assert src.count('const settleId = "umbra-real-" + Date.now();') == 1, "settleId not exactly once"
i_alloc = src.index("allocate the real legs FIRST")
i_auction = src.index("blind auction choreography (on-ledger")
assert i_alloc < i_auction, "allocate did not move before the auction"

if src == orig:
    print("NO CHANGES - aborting."); sys.exit(1)

bak = f"{PATH}.pre-awardreorder-{int(time.time())}"
shutil.copyfile(PATH, bak)
open(PATH, "w", encoding="utf-8").write(src)
print("  [ok] reordered award: allocate real legs BEFORE blind auction")
print(f"Backup: {bak}")
print(f"Patched: {PATH}  ({len(orig)} -> {len(src)} chars)")
