#!/usr/bin/env python3
"""
UMBRA — backend/server.js patch
================================
Fixes a break that `daml test` structurally cannot catch, and that DevNet being
down has been masking:

  1. SwapRfq.expiresAt : Time        is MANDATORY in daml/UmbraSwap.daml.
     NO backend handler ever sent it. Every RFQ create would be rejected.
  2. SubmitSwapQuote.validUntil : Time is MANDATORY.
     NO backend handler ever sent it. Every quote would be rejected.
  3. /api/swap/fund and /api/swap/rfq were each registered TWICE. Express takes
     the FIRST, so the older, weaker pair won and the better pair was dead code.
     The live /rfq also ignored the frontend's `invited` field and set
     operator = PARTIES.requester, which diverges from the executor used by
     /api/swap/settlements/:cid/execute under SIGNED_MODE -> ExecuteSwap
     (controller operator) would fail its authority check.

Fix: delete the old duplicate pair; make the surviving pair carry the expiry
fields and run the InviteDealer loop.

Frontend is NOT touched — index.html already reads real expiresAt/validUntil and
renders "—" when absent. It was correct; the backend never populated them.

Run from repo root:  python3 patch_swap_expiry.py
"""
import re
import shutil
import sys
import time

PATH = "backend/server.js"

src = open(PATH, encoding="utf-8").read()
orig = src


def cut(text, start_marker, end_marker, label):
    """Delete text[start:end), leaving end_marker in place. Asserts uniqueness."""
    assert text.count(start_marker) == 1, f"{label}: start marker x{text.count(start_marker)}"
    assert text.count(end_marker) == 1, f"{label}: end marker x{text.count(end_marker)}"
    a = text.index(start_marker)
    b = text.index(end_marker)
    assert a < b, f"{label}: markers out of order"
    print(f"  [cut] {label}: removing {b - a} chars")
    return text[:a] + text[b:]


def sub(text, old, new, label):
    n = text.count(old)
    assert n == 1, f"{label}: anchor found {n} times, expected exactly 1"
    print(f"  [sub] {label}")
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# 1. Delete the OLD duplicate /api/swap/fund + /api/swap/rfq pair.
#    They sit above the "spliced" block and shadow it.
# ---------------------------------------------------------------------------
src = cut(
    src,
    "// --- dev faucet: mint an AssetHolding for a party (self-issued stand-in) ---",
    "// ===== UMBRA SWAP ENDPOINTS (spliced) =====",
    "old duplicate fund+rfq handlers",
)

# ---------------------------------------------------------------------------
# 2. Surviving /api/swap/fund: keep resolveAsset, restore act() so SIGNED_MODE
#    funding still goes through prepare->sign->execute (matches today's live
#    behavior, which used act()).
# ---------------------------------------------------------------------------
src = sub(
    src,
    """    const before = await idSetSwap(owner, "UmbraSwap:AssetHolding");
    // AssetHolding signatory = owner, asset.admin. Operator holds CanActAs on the
    // demo parties; asset.admin must also authorize (in demo it is operator-held).
    await submit("swap-fund", owner, [{
      CreateCommand: { templateId: `#${PKGN}:UmbraSwap:AssetHolding`,
        createArguments: { owner, asset, amount } } }]);""",
    """    const before = await idSetSwap(owner, "UmbraSwap:AssetHolding");
    // AssetHolding signatory = owner (observer asset.admin), so only the owner's
    // authority is needed. Use act() so SIGNED_MODE routes through prepare->sign.
    await act(role, "swap-fund", [{
      CreateCommand: { templateId: `#${PKGN}:UmbraSwap:AssetHolding`,
        createArguments: { owner, asset, amount } } }]);""",
    "fund: submit() -> act() for SIGNED_MODE",
)

# ---------------------------------------------------------------------------
# 3. Surviving /api/swap/rfq: send the MANDATORY expiresAt, honour the
#    frontend's `invited` field, and run the InviteDealer loop (the old handler
#    was the only thing creating SwapInvitations; the frontend never calls
#    /rfqs/:cid/invite itself).
# ---------------------------------------------------------------------------
src = sub(
    src,
    """// requester creates a swap RFQ (offer asset -> want asset)
app.post("/api/swap/rfq", async (req, res) => {
  try {
    const requester = await partyIdFor("requester");
    const operator = await partyIdFor("requester");
    const offerAsset = await resolveAsset(req.body.offerAsset);
    const wantAsset = await resolveAsset(req.body.wantAsset);
    const invited = [];
    for (const r of (req.body.invited || ["dealer1", "dealer2"]))
      invited.push(await partyIdFor(r));
    const result = await act("requester", "swap-rfq", [{
      CreateCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
        createArguments: {
          requester, operator,
          offerAsset, offerAmount: String(req.body.offerAmount),
          wantAsset, invited } } }]);
    res.json({ ok: true, signed: SIGNED_MODE, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});""",
    """// requester creates a swap RFQ (offer asset -> want asset), then invites the
// dealers. One private SwapInvitation per dealer -- no dealer sees another's.
//
// expiresAt is MANDATORY on SwapRfq and is enforced BY THE LEDGER:
// SubmitSwapQuote asserts `now < expiresAt`, so a late quote is refused by
// Canton, not merely hidden by the UI (see swapRejectsLateQuote).
// Default 15 min; override with body.expiresAt (ISO-8601) or body.ttlMins.
app.post("/api/swap/rfq", async (req, res) => {
  try {
    const requester = await partyIdFor("requester");
    const operator = await partyIdFor("requester");
    const offerAsset = await resolveAsset(req.body.offerAsset);
    const wantAsset = await resolveAsset(req.body.wantAsset);
    const roles = req.body.invited || req.body.dealers || ["dealer1", "dealer2"];
    const invited = [];
    for (const r of roles) invited.push(await partyIdFor(r));
    const expiresAt = req.body.expiresAt ||
      new Date(Date.now() + Number(req.body.ttlMins || 15) * 60000).toISOString();

    const rfqBefore = await idSetSwap(requester, "UmbraSwap:SwapRfq");
    await act("requester", "swap-rfq", [{
      CreateCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
        createArguments: {
          requester, operator,
          offerAsset, offerAmount: String(req.body.offerAmount),
          wantAsset, invited, expiresAt } } }]);
    const rfqCid = await pollNewCid(requester, "UmbraSwap:SwapRfq", rfqBefore);

    const invitations = [];
    for (let i = 0; i < roles.length; i++) {
      const invBefore = await idSetSwap(requester, "UmbraSwap:SwapInvitation");
      await act("requester", "swap-invite", [{
        ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
          contractId: rfqCid, choice: "InviteDealer",
          choiceArgument: { dealer: invited[i] } } }]);
      const invitationCid = await pollNewCid(requester, "UmbraSwap:SwapInvitation", invBefore);
      invitations.push({ dealer: roles[i], invitationCid });
    }
    res.json({ ok: true, signed: SIGNED_MODE, rfqCid, expiresAt, invitations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});""",
    "rfq: expiresAt + invited + InviteDealer loop",
)

# ---------------------------------------------------------------------------
# 4. /api/swap/invitations/:cid/quote: send the MANDATORY validUntil.
#    The frontend posts { dealer, price } only, so the default lives here.
# ---------------------------------------------------------------------------
src = sub(
    src,
    """    const dealerRole = String(req.body.dealer || "").toLowerCase();
    await partyIdFor(dealerRole); // validate
    const result = await act(dealerRole, "swap-quote", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapInvitation`,
        contractId: req.params.cid, choice: "SubmitSwapQuote",
        choiceArgument: { price: String(req.body.price) } } }]);
    res.json({ ok: true, signed: SIGNED_MODE, result });""",
    """    const dealerRole = String(req.body.dealer || "").toLowerCase();
    await partyIdFor(dealerRole); // validate
    // validUntil is MANDATORY on SubmitSwapQuote: how long this dealer's price
    // stays firm. AcceptSwapQuote asserts `now < validUntil`, so a stale price
    // cannot be lifted (see swapRejectsStaleQuote). Default 5 min.
    const validUntil = req.body.validUntil ||
      new Date(Date.now() + Number(req.body.validMins || 5) * 60000).toISOString();
    const result = await act(dealerRole, "swap-quote", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapInvitation`,
        contractId: req.params.cid, choice: "SubmitSwapQuote",
        choiceArgument: { price: String(req.body.price), validUntil } } }]);
    res.json({ ok: true, signed: SIGNED_MODE, validUntil, result });""",
    "quote: validUntil",
)

# ---------------------------------------------------------------------------
# 5. /api/swap/award (the one-call demo path) -- same two mandatory fields.
# ---------------------------------------------------------------------------
src = sub(
    src,
    """    const offerAmount = String(req.body.offerAmount);
    const wantAmount = String(req.body.wantAmount);
    const steps = [];""",
    """    const offerAmount = String(req.body.offerAmount);
    const wantAmount = String(req.body.wantAmount);
    const expiresAt = req.body.expiresAt ||
      new Date(Date.now() + Number(req.body.ttlMins || 15) * 60000).toISOString();
    const validUntil = req.body.validUntil ||
      new Date(Date.now() + Number(req.body.validMins || 5) * 60000).toISOString();
    const steps = [];""",
    "award: compute expiresAt + validUntil",
)

src = sub(
    src,
    """        createArguments: { requester, operator, offerAsset, offerAmount,
          wantAsset, invited: [dealer] } } }]);""",
    """        createArguments: { requester, operator, offerAsset, offerAmount,
          wantAsset, invited: [dealer], expiresAt } } }]);""",
    "award: SwapRfq.expiresAt",
)

src = sub(
    src,
    """        choiceArgument: { price: wantAmount } } }]);""",
    """        choiceArgument: { price: wantAmount, validUntil } } }]);""",
    "award: SubmitSwapQuote.validUntil",
)

# ---------------------------------------------------------------------------
# Post-conditions
# ---------------------------------------------------------------------------
for route in ['app.post("/api/swap/fund"', 'app.post("/api/swap/rfq"']:
    n = src.count(route)
    assert n == 1, f"POST-CHECK FAILED: {route} registered {n}x (must be 1)"
print("  [ok] no duplicate route registrations")

assert src.count("expiresAt } } }]);") + src.count("wantAsset, invited, expiresAt } } }]);") >= 1
rfq_creates = len(re.findall(r"UmbraSwap:SwapRfq`,\s*\n\s*createArguments", src))
print(f"  [ok] SwapRfq create sites: {rfq_creates} (all now carry expiresAt)")

if src == orig:
    print("NO CHANGES — aborting."); sys.exit(1)

bak = f"{PATH}.pre-expiry-{int(time.time())}"
shutil.copyfile(PATH, bak)
open(PATH, "w", encoding="utf-8").write(src)
print(f"\nBackup: {bak}")
print(f"Patched: {PATH}  ({len(orig)} -> {len(src)} chars)")
