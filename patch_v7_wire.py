#!/usr/bin/env python3
"""
UMBRA - two fixes in settle-real (idempotent, no heredoc paste issues)
======================================================================
1. RFQ cleanup: derive rfqCid from a live SwapInvitation (SwapProposal has none)
   and close the RFQ + ALL its invitations, so no invited dealer is left with a
   stale live countdown after a trade settles.

2. Wire v7 ExecuteRealSwap: replace the two-command /api/real/settle call with a
   SINGLE on-ledger command -- SwapSettlement.ExecuteRealSwap -- which executes
   both Allocation_ExecuteTransfer legs in one choice. This is the wallet
   enablement: one command fits interactive-submission, so in signed mode the
   parties' wallets can sign the atomic settle (operator no longer "submits" it).
   Routed via realSubmit -> demo mode now, wallet-signed when SIGNED_MODE=true.

Run:  cd ~/umbra && python3 patch_v7_wire.py   (then restart backend)
"""
import time, shutil, sys

PATH = "backend/server.js"
s = open(PATH, encoding="utf-8").read(); orig = s
changed = []

# ---------- Fix 1: RFQ cleanup ----------
OLD1 = '    try { if (req.body && req.body.rfqCid) { await cleanupSwapRfq(req.body.rfqCid); steps.push("closed RFQ"); } } catch (e) {}'
NEW1 = (
    '    try {\n'
    '      let rfqCid = (req.body && req.body.rfqCid) || null;\n'
    '      if (!rfqCid) {\n'
    '        const invs = await queryActive(requester, "UmbraSwap:SwapInvitation");\n'
    '        const match = invs.find(iv => iv.payload &&\n'
    '          iv.payload.offerAsset && iv.payload.offerAsset.symbol === offerAsset.symbol &&\n'
    '          iv.payload.wantAsset && iv.payload.wantAsset.symbol === wantAsset.symbol);\n'
    '        if (match) rfqCid = match.payload.rfqCid;\n'
    '      }\n'
    '      if (rfqCid) { const cr = await cleanupSwapRfq(rfqCid); steps.push("closed RFQ (+" + cr.invitations + " invitations)"); }\n'
    '    } catch (e) {}'
)
if 'closed RFQ (+" + cr.invitations' in s:
    changed.append("fix1: already present")
elif s.count(OLD1) == 1:
    s = s.replace(OLD1, NEW1, 1); changed.append("fix1: RFQ cleanup applied")
else:
    print(f"WARN fix1: old line found {s.count(OLD1)}x (expected 1). Skipping fix1."); 

# ---------- Fix 2: ExecuteRealSwap wiring ----------
OLD2 = '''    // atomic settle both real legs (one tx)
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
      " <-> " + wantAmount + " " + wantAsset.symbol + " (both legs, one tx)");'''

NEW2 = '''    // v7: atomic settle via ONE on-ledger command -- SwapSettlement.ExecuteRealSwap
    // executes both Allocation_ExecuteTransfer legs inside a single choice. One
    // command => interactive-submission can sign it => wallet-signable in SIGNED_MODE.
    const offerCtx = await execTransferContext(offLeg.registry, offAdmin, offLeg.cid);
    const wantCtx  = await execTransferContext(wantLeg.registry, wantAdmin, wantLeg.cid);
    const _dseen = {}; const disclosed = [];
    for (const ctx of [offerCtx, wantCtx]) {
      for (const d of (ctx.disclosedContracts || [])) {
        if (_dseen[d.contractId]) continue; _dseen[d.contractId] = true;
        disclosed.push({ templateId: d.templateId, contractId: d.contractId,
          createdEventBlob: d.createdEventBlob, synchronizerId: d.synchronizerId || "" });
      }
    }
    const dealerParty = await partyIdFor(dealerRole);
    const execCmd = {
      commandId: "execreal-" + Date.now(),
      actAs: [...new Set([requester, dealerParty])],
      commands: [{ ExerciseCommand: {
        templateId: `#${PKGN}:UmbraSwap:SwapSettlement`,
        contractId: settlementCid,
        choice: "ExecuteRealSwap",
        choiceArgument: {
          offerArgs: { context: offerCtx.choiceContextData || { values: {} }, meta: { values: {} } },
          wantArgs:  { context: wantCtx.choiceContextData  || { values: {} }, meta: { values: {} } },
        },
      } }],
      disclosedContracts: disclosed,
    };
    await realSubmit(execCmd, "rexecreal");
    steps.push("executed REAL atomic swap via ExecuteRealSwap: " + offerAmount + " " + offerAsset.symbol +
      " <-> " + wantAmount + " " + wantAsset.symbol + " (one on-ledger choice)");'''

if 'choice: "ExecuteRealSwap"' in s:
    changed.append("fix2: already present")
elif s.count(OLD2) == 1:
    s = s.replace(OLD2, NEW2, 1); changed.append("fix2: ExecuteRealSwap wired")
else:
    print(f"ERROR fix2: settle block found {s.count(OLD2)}x (expected 1). Not patching fix2.")
    sys.exit(1)

if s == orig:
    print("no changes -", "; ".join(changed)); sys.exit(0)

bak = f"{PATH}.pre-v7wire-{int(time.time())}"
shutil.copyfile(PATH, bak)
open(PATH, "w", encoding="utf-8").write(s)
print("  " + " | ".join(changed))
print(f"Backup: {bak}")
print(f"Patched: {PATH}  ({len(orig)} -> {len(s)})")
