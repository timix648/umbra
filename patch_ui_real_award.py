#!/usr/bin/env python3
"""
UMBRA - backend/public/index.html
=================================
Rewire the requester's awardSwap(q) to settle with REAL tokens (Option B):
  accept the awarded quote -> SwapProposal, then POST /settle-real on THAT proposal
  (allocate both real legs -> RecordRealSwap -> atomic settle).

Removes the stand-in pickHolding pre-checks and the commit-offer/commit-want/execute
mint chain. The backend validates real holdings itself. Frontend is hand-authored
React.createElement, no build step -> edit + hard-refresh.
"""
import time, shutil, sys

PATH = "backend/public/index.html"
s = open(PATH, encoding="utf-8").read(); orig = s

# Replace from the pipeline `steps` definition through the end of step (4) + rfq close.
OLD = '''    const steps = [
      "Requester accepts quote",
      "Requester commits " + offerSym + " leg",
      dealerRole + " commits " + wantSym + " leg",
      "Atomic execute \\u2014 both legs swap"
    ];
    setPipe({ active: -1, steps });
    addlog("swap award initiated \\u00b7 " + offerSym + " \\u2192 " + wantSym + (mode ? " \\u00b7 via party signatures" : ""), "");
    try {
      // backing holdings must exist on both sides
      const reqHold = pickHolding("requester", offerSym, p.offerAmount);
      if (!reqHold) throw new Error("Requester holds no " + offerSym + " \\u2265 " + p.offerAmount);
      const dlrHold = pickHolding(dealerRole, wantSym, p.price);
      if (!dlrHold) throw new Error(dealerRole + " holds no " + wantSym + " \\u2265 " + p.price);

      // 1) accept the dealer's quote -> SwapProposal
      const a = await post("/api/swap/quotes/" + q.contractId + "/accept", {});
      setPipe(pp => ({ ...pp, active: 0 }));

      // 2) requester commits its offer leg -> SwapDealerPending
      const b = await post("/api/swap/proposals/" + a.proposalCid + "/commit-offer", {
        holdingCid: reqHold
      });
      setPipe(pp => ({ ...pp, active: 1 }));

      // 3) dealer commits its want leg -> SwapSettlement
      const c = await post("/api/swap/pending/" + b.pendingCid + "/commit-want", {
        dealer: dealerRole,
        holdingCid: dlrHold
      });
      setPipe(pp => ({ ...pp, active: 2 }));

      // 4) operator fires the atomic swap
      await post("/api/swap/settlements/" + c.settlementCid + "/execute", {
        dealer: dealerRole
      });
      // settled -- archive the RFQ so it stops showing as "live" (best-effort)
      post("/api/swap/rfqs/" + p.rfqCid + "/close", {}).catch(() => {});
      setPipe(pp => ({ ...pp, active: pp.steps.length }));'''

NEW = '''    const steps = [
      "Requester accepts quote",
      "Allocate real " + offerSym + " + " + wantSym + " legs",
      "Record on-ledger settlement",
      "Atomic execute \\u2014 both real legs swap"
    ];
    setPipe({ active: -1, steps });
    addlog("real swap award initiated \\u00b7 " + offerSym + " \\u2192 " + wantSym + (mode ? " \\u00b7 via party signatures" : ""), "");
    try {
      // 1) accept the dealer's quote -> SwapProposal
      const a = await post("/api/swap/quotes/" + q.contractId + "/accept", {});
      setPipe(pp => ({ ...pp, active: 0 }));

      // 2) settle THAT proposal with REAL tokens: allocate both real legs ->
      //    RecordRealSwap -> atomic settle (one backend call, real registry).
      setPipe(pp => ({ ...pp, active: 1 }));
      const r = await post("/api/swap/proposals/" + a.proposalCid + "/settle-real", {
        rfqCid: p.rfqCid
      });
      if (!r.ok) throw new Error(r.error || "real settlement failed");
      setPipe(pp => ({ ...pp, active: 3 }));
      (r.steps || []).forEach(st => addlog(st, ""));
      setPipe(pp => ({ ...pp, active: pp.steps.length }));'''

assert s.count(OLD) == 1, f"awardSwap chain anchor found {s.count(OLD)}x, expected 1"
s = s.replace(OLD, NEW, 1)

# also fix the dealerRole line (cleanRole exists in frontend, keep it) -- no change needed there.
assert 'settle-real' in s
if s == orig:
    print("NO CHANGES."); sys.exit(1)
bak = f"{PATH}.pre-uireal-{int(time.time())}"
shutil.copyfile(PATH, bak)
open(PATH, "w", encoding="utf-8").write(s)
print("  [ok] awardSwap now settles real tokens via /settle-real")
print(f"Backup: {bak}  ({len(orig)} -> {len(s)})")
