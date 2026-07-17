#!/usr/bin/env python3
"""
UMBRA - backend/server.js
=========================
Option B: settle the UI's ACTUAL awarded proposal with REAL tokens.

The frontend already runs the real auction on-screen and, on award, calls
POST /api/swap/quotes/:cid/accept -> SwapProposal. This new endpoint takes that
proposal cid and runs the proven real chain against it (the same logic /api/real/award
uses internally, but on the EXISTING proposal instead of a fresh internal auction):

  1. read the SwapProposal (requester, dealer, offerAsset, wantAsset, offerAmount, price)
  2. allocate BOTH real legs via allocateRealLeg (real registry allocations)
  3. exercise SwapProposal.RecordRealSwap {realOfferAllocCid, realWantAllocCid} -> SwapSettlement(real)
  4. /api/real/settle -> both Allocation_ExecuteTransfer in ONE tx (atomic)
  5. close the RFQ

The UI then calls this ONE endpoint instead of commit-offer/commit-want/execute.
Settles the exact quote the user awarded. Backend -> restart.
"""
import time, shutil, sys

PATH = "backend/server.js"
s = open(PATH, encoding="utf-8").read(); orig = s

# insert right before the commit-offer endpoint (so it sits with the swap step routes)
ANCHOR = 'app.post("/api/swap/proposals/:cid/commit-offer", async (req, res) => {'

BLOCK = '''// ---- OPTION B: settle the awarded proposal with REAL tokens -----------------
// Runs the real allocate-both-legs -> RecordRealSwap -> atomic settle chain on the
// EXISTING proposal the UI awarded (settles the actual quote, no internal re-auction).
app.post("/api/swap/proposals/:cid/settle-real", async (req, res) => {
  const steps = [];
  try {
    const requester = await partyIdFor("requester");
    // read the proposal to learn the trade (assets/amounts/dealer) off-ledger
    const prop = (await queryActive(requester, "UmbraSwap:SwapProposal"))
      .find(c => c.contractId === req.params.cid);
    if (!prop) return res.status(404).json({ error: "proposal not found: " + req.params.cid });
    const p = prop.payload;
    const dealerRole = cleanRole(p.dealer);
    const offerAsset = p.offerAsset, wantAsset = p.wantAsset;
    const offerAmount = p.offerAmount, wantAmount = p.price;

    // real instrument ids come OFF the holdings (case-correct), like /api/real/award
    const offCands = await realHoldingBySymbol("requester", offerAsset.symbol, offerAmount);
    if (!offCands.length) throw new Error("requester has no free real " + offerAsset.symbol + " >= " + offerAmount);
    const wantCands = await realHoldingBySymbol(dealerRole, wantAsset.symbol, wantAmount);
    if (!wantCands.length) throw new Error(dealerRole + " has no free real " + wantAsset.symbol + " >= " + wantAmount);
    const offAdmin = offCands[0].admin, offInstr = offCands[0].id;
    const wantAdmin = wantCands[0].admin, wantInstr = wantCands[0].id;

    const settleId = "umbra-uiswap-" + Date.now();
    const offLeg = await allocateRealLeg("requester", dealerRole, offAdmin, offInstr,
      offerAsset.symbol, offerAmount, settleId, "offer-leg");
    steps.push("allocated real offer leg (" + offerAmount + " " + offerAsset.symbol + ")");
    const wantLeg = await allocateRealLeg(dealerRole, "requester", wantAdmin, wantInstr,
      wantAsset.symbol, wantAmount, settleId, "want-leg");
    steps.push("allocated real want leg (" + wantAmount + " " + wantAsset.symbol + ")");

    // record the real settlement on the awarded proposal (both principals authorize)
    let refMid = null;
    try { refMid = await refMidFor(offerAsset.symbol, wantAsset.symbol); } catch (e) {}
    const b = await idSetSwap(requester, "UmbraSwap:SwapSettlement");
    await actMulti(["requester", dealerRole], "swap-record-real", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapProposal`,
        contractId: req.params.cid, choice: "RecordRealSwap",
        choiceArgument: { realOfferAllocCid: offLeg.cid, realWantAllocCid: wantLeg.cid, realRefMid: refMid } } }]);
    const settlementCid = await pollNewCid(requester, "UmbraSwap:SwapSettlement", b);
    steps.push("recorded on-ledger SwapSettlement (settledVia=real)");

    // atomic settle both real legs (one tx)
    const sr = await fetch("http://localhost:" + (process.env.PORT || 4000) + "/api/real/settle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legs: [
        { cid: offLeg.cid, registry: offLeg.registry },
        { cid: wantLeg.cid, registry: wantLeg.registry },
      ] }),
    });
    const sj = await sr.json();
    if (!sj.ok) throw new Error("atomic settle failed: " + (sj.error || JSON.stringify(sj)));
    steps.push("executed REAL atomic swap: " + offerAmount + " " + offerAsset.symbol +
      " <-> " + wantAmount + " " + wantAsset.symbol + " (both legs, one tx)");

    try { await cleanupSwapRfq(p.rfqCid); steps.push("closed RFQ"); } catch (e) {}

    res.json({ ok: true, real: true, atomic: true, settlementCid,
      offerSym: offerAsset.symbol, offerAmount, wantSym: wantAsset.symbol, wantAmount,
      signed: SIGNED_MODE, steps });
  } catch (e) { res.status(500).json({ error: e.message, steps }); }
});

'''

assert s.count(ANCHOR) == 1, f"anchor found {s.count(ANCHOR)}x, expected 1"
s = s.replace(ANCHOR, BLOCK + ANCHOR, 1)
assert 'app.post("/api/swap/proposals/:cid/settle-real"' in s

if s == orig:
    print("NO CHANGES."); sys.exit(1)
bak = f"{PATH}.pre-settlereal-{int(time.time())}"
shutil.copyfile(PATH, bak)
open(PATH, "w", encoding="utf-8").write(s)
print("  [ok] added POST /api/swap/proposals/:cid/settle-real (Option B)")
print(f"Backup: {bak}")
print(f"Patched: {PATH}  ({len(orig)} -> {len(s)})")
