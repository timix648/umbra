#!/usr/bin/env python3
"""
UMBRA - backend/public/index.html
=================================
The app has TWO view components. The earlier patch fixed the first (setHold path).
The view actually rendered in the screenshots is the per-role component (~line 3160+)
which has its OWN holdings fetch (setHoldings from /api/swap/holdings) and its OWN
awardQuote() that runs the stand-in mint chain. Fix both here:

  1. Panel: fetch /api/real/holdings for `role`, map issuer-issued (real) holdings
     into the {payload:{asset:{symbol},amount,owner}} shape -> setHoldings.
  2. awardQuote: replace the stand-in commit-offer/commit-want/execute chain with
     accept -> /settle-real (real registry settlement of the awarded proposal).

Hand-authored React.createElement, no build step -> edit + hard-refresh.
"""
import time, shutil, sys

PATH = "backend/public/index.html"
s = open(PATH, encoding="utf-8").read(); orig = s

# ---- shared real-mapper: inject once near the top of the app script ----
# anchor on aggHoldings definition (exists once) and add mapRealHoldings before it.
AGG = "const aggHoldings = (hs) => {"
MAPPER = '''// Map /api/real/holdings raw -> panel holding shape; keep only issuer-issued (real).
const OURS_ISS = { Requester: 1, Dealer1: 1, Dealer2: 1, Observer: 1 };
const mapRealHoldings = (rh, ownerHint) => ((rh && rh.raw) || [])
  .filter(h => h.id && h.admin && !OURS_ISS[String(h.admin).split("::")[0]])
  .map(h => ({
    contractId: h.contractId,
    payload: {
      asset: { symbol: h.id === "Amulet" ? "CC" : h.id, admin: h.admin },
      amount: h.amount,
      owner: h.owner || ownerHint
    }
  }));

const aggHoldings = (hs) => {'''
assert s.count(AGG) == 1, f"aggHoldings anchor {s.count(AGG)}x"
s = s.replace(AGG, MAPPER, 1)

# ---- 1. per-role view: fetch real holdings for the panel ----
OLD_FETCH = '''        api("/api/swap/quotes?role=" + role).catch(() => ({})),
        api("/api/swap/holdings?role=" + role).catch(() => ({})),
        api("/api/mode").catch(() => ({})),
        api("/api/ledger-end").catch(() => ({})),
        api("/api/swap/history?role=" + role).catch(() => ({})),
        api("/api/market/rate" + rateQ).catch(() => ({})),
        api("/api/swap/rfqs").catch(() => ({}))
      ]);'''
NEW_FETCH = '''        api("/api/swap/quotes?role=" + role).catch(() => ({})),
        api("/api/real/holdings?role=" + role).catch(() => ({})),
        api("/api/mode").catch(() => ({})),
        api("/api/ledger-end").catch(() => ({})),
        api("/api/swap/history?role=" + role).catch(() => ({})),
        api("/api/market/rate" + rateQ).catch(() => ({})),
        api("/api/swap/rfqs").catch(() => ({}))
      ]);'''
assert s.count(OLD_FETCH) == 1, f"per-role fetch anchor {s.count(OLD_FETCH)}x"
s = s.replace(OLD_FETCH, NEW_FETCH, 1)

# now `sh` is a real-holdings response -> map it
OLD_SETH = '''      setHoldings((sh && sh.holdings) || []);'''
NEW_SETH = '''      setHoldings(mapRealHoldings(sh, role));'''
assert s.count(OLD_SETH) == 1, f"setHoldings anchor {s.count(OLD_SETH)}x"
s = s.replace(OLD_SETH, NEW_SETH, 1)

# ---- 2. per-role awardQuote: use settle-real instead of stand-in chain ----
OLD_AWARD = '''      setAwardStep("Accepting\\u2026");
      const mine = pick(holdings, offerSym, p.offerAmount);
      if (!mine) throw new Error("You hold no " + offerSym + " \\u2265 " + p.offerAmount);
      const dh = await api("/api/swap/holdings?role=" + dealerRole).catch(() => ({}));
      const theirs = pick(dh && dh.holdings, wantSym, p.price);
      if (!theirs) throw new Error(DEALER_NAME(p.dealer) + " holds no " + wantSym + " \\u2265 " + p.price);

      const a = await post("/api/swap/quotes/" + q.contractId + "/accept", {});
      setAwardStep("Your leg\\u2026");
      const b = await post("/api/swap/proposals/" + a.proposalCid + "/commit-offer", { holdingCid: mine });
      setAwardStep("Their leg\\u2026");
      const c = await post("/api/swap/pending/" + b.pendingCid + "/commit-want", { dealer: dealerRole, holdingCid: theirs });
      setAwardStep("Settling\\u2026");
      await post("/api/swap/settlements/" + c.settlementCid + "/execute", { dealer: dealerRole });
      // settled -- archive the RFQ so it stops showing as "live" (best-effort)
      post("/api/swap/rfqs/" + p.rfqCid + "/close", {}).catch(() => {});'''
NEW_AWARD = '''      setAwardStep("Accepting\\u2026");
      // Accept the awarded quote -> SwapProposal, then settle it with REAL tokens
      // (backend validates real holdings + allocates both real legs + atomic settle).
      const a = await post("/api/swap/quotes/" + q.contractId + "/accept", {});
      setAwardStep("Settling real\\u2026");
      const rr = await post("/api/swap/proposals/" + a.proposalCid + "/settle-real", { rfqCid: p.rfqCid });
      if (!rr.ok) throw new Error(rr.error || "real settlement failed");'''
assert s.count(OLD_AWARD) == 1, f"awardQuote anchor {s.count(OLD_AWARD)}x"
s = s.replace(OLD_AWARD, NEW_AWARD, 1)

if s == orig:
    print("NO CHANGES."); sys.exit(1)
bak = f"{PATH}.pre-perrole-{int(time.time())}"
shutil.copyfile(PATH, bak)
open(PATH, "w", encoding="utf-8").write(s)
print("  [ok] per-role view: real holdings panel + real settle-real award")
print(f"Backup: {bak}  ({len(orig)} -> {len(s)})")
