// The paths that must FAIL, and fail cleanly.
//
//   node failure_paths_demo.js --execute
//
// Everything proven so far is the happy path. These are the refusals the venue claims
// the LEDGER enforces rather than the UI, so each one is attempted for real and the
// rejection is read back from Daml. A test here PASSES when the ledger says no.
//
//   1. quote after the RFQ has expired            -> SubmitSwapQuote must refuse
//   2. accept a quote whose firmness has lapsed   -> AcceptSwapQuote must refuse
//   3. cancel an RFQ, then quote it               -> the invitation must be dead
//   4. dealer quotes more than it holds           -> settlement must not half-complete
//
// Test 4 is the one that can strand funds: the requester's leg is allocated before the
// dealer's shortfall is discovered. It uses the smallest amount that still exercises
// the path, and reports anything left locked rather than quietly leaving it.

require("dotenv").config();
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://127.0.0.1:" + (process.env.PORT || 4000));
const KEYDIR = process.env.WALLET_KEY_DIR || path.join(os.homedir(), "umbra-wallet-keys");
const EXECUTE = process.argv.includes("--execute");
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? process.argv[i + 1] : null; })();

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(p, b) {
  const r = await fetch(API + p, { method: b ? "POST" : "GET",
    headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let o; try { o = JSON.parse(t); } catch { o = { raw: t }; }
  return { status: r.status, body: o };
}
async function must(p, b) {
  const r = await j(p, b);
  if (r.status >= 400) throw new Error(`${p} -> ${r.status} ${String(r.body.error || r.body.raw).slice(0, 260)}`);
  return r.body;
}
const sign = (h, k) => crypto.sign(null, Buffer.from(h, "base64"),
  crypto.createPrivateKey({ key: Buffer.from(k, "base64"), format: "der", type: "pkcs8" })).toString("base64");

const S = {};
for (const role of ["requester", "dealer1", "dealer2"]) {
  const k = JSON.parse(fs.readFileSync(path.join(KEYDIR, role + ".local.json"), "utf8"));
  S[role] = k; S[k.partyId] = k;
}
const R = S.requester.partyId, D1 = S.dealer1.partyId;

// Submit and return {ok} or {err} -- these tests EXPECT failures, so never throw.
async function trySubmit(partyId, commands, disclosed, tag) {
  const k = S[partyId];
  try {
    const prep = await must("/api/ext/prepare", { party: partyId, commands,
      disclosedContracts: disclosed || [], tag: tag || "fail" });
    await must("/api/ext/execute", { party: partyId, commandId: prep.commandId,
      preparedTransaction: prep.preparedTransaction, hashingSchemeVersion: prep.hashingSchemeVersion,
      signature: sign(prep.preparedTransactionHash, k.privDer), signedBy: k.fingerprint });
    return { ok: true };
  } catch (e) { return { err: String(e.message || e) }; }
}
async function until(label, fn, tries = 20, gap = 2000) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    process.stdout.write("."); await sleep(gap);
  }
  throw new Error("timed out waiting for " + label);
}
const holdings = async pid => must(`/api/real/holdings?role=${encodeURIComponent(pid)}`);
async function freeHolding(pid, sym, amt) {
  const h = await holdings(pid);
  return (h.raw || []).filter(x => x.id === sym && !x.lock && Number(x.amount) >= Number(amt))
    .sort((a, b) => Number(a.amount) - Number(b.amount))[0] || null;
}
async function lockedOn(pid) {
  const h = await holdings(pid);
  return (h.raw || []).filter(x => x.lock).map(x => `${x.id}=${x.amount}`);
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${String(detail).slice(0, 200)}`);
};

// Open an RFQ + invitation for `dealer`, with the given ttl.
async function openRfq(dealer, ttlMins, offerAmt) {
  const amu = await freeHolding(R, "Amulet", offerAmt);
  if (!amu) throw new Error("requester has no free Amulet >= " + offerAmt);
  const eth = await freeHolding(dealer, "cETH", "0.000001");
  if (!eth) throw new Error("dealer has no cETH to name as want asset");
  const before = new Set(((await must(`/api/swap/rfqs?role=${encodeURIComponent(R)}`)).rfqs || [])
    .map(x => x.contractId));
  const built = await must("/api/swap/rfq", {
    requester: R,
    offerAsset: { admin: amu.admin, symbol: "Amulet" }, offerAmount: String(offerAmt),
    wantAsset: { admin: eth.admin, symbol: "cETH" },
    invited: [dealer], ttlMins,
  });
  const s = await trySubmit(R, built.commands, [], "frfq");
  if (s.err) throw new Error("could not open the RFQ: " + s.err);
  const rfq = await until("rfq", async () => {
    const o = await must(`/api/swap/rfqs?role=${encodeURIComponent(R)}`);
    return (o.rfqs || []).find(x => !before.has(x.contractId) && x.payload.requester === R);
  });
  const inv0 = await must(`/api/swap/rfqs/${rfq.contractId}/invite`, { dealer, requester: R });
  const s2 = await trySubmit(R, inv0.commands, [], "finv");
  if (s2.err) throw new Error("could not invite: " + s2.err);
  const inv = await until("invitation", async () => {
    const o = await must(`/api/swap/invitations?role=${encodeURIComponent(dealer)}`);
    return (o.invitations || []).find(i => i.payload.rfqCid === rfq.contractId);
  });
  return { rfq, inv };
}

// ---- 1. quote after the RFQ has expired ----------------------------------
async function testExpiredRfq() {
  console.log("\n[1] quote after the RFQ expires");
  const { rfq, inv } = await openRfq(D1, 0.05, 1);   // 3 seconds
  console.log(`    rfq ${rfq.contractId.slice(0, 18)}… expires ${rfq.payload.expiresAt}`);
  await sleep(12000);                                 // let it lapse
  const qb = await must(`/api/swap/invitations/${inv.contractId}/quote`, { dealer: D1, price: "0.001" });
  const r = await trySubmit(D1, qb.commands, [], "fexp");
  record("expired RFQ refuses a quote", !!r.err, r.err || "THE QUOTE WAS ACCEPTED AFTER EXPIRY");
}

// ---- 2. accept a quote whose firmness has lapsed --------------------------
async function testStaleQuote() {
  console.log("\n[2] accept a quote after its validUntil");
  const { rfq, inv } = await openRfq(D1, 15, 1);      // RFQ stays open
  const qb = await must(`/api/swap/invitations/${inv.contractId}/quote`,
    { dealer: D1, price: "0.001", validMins: 0.05 }); // firm for 3s only
  const s = await trySubmit(D1, qb.commands, [], "fq");
  if (s.err) return record("stale quote refuses acceptance", false, "could not place the quote: " + s.err);
  const q = await until("quote", async () => {
    const o = await must(`/api/swap/quotes?role=${encodeURIComponent(R)}`);
    return (o.quotes || []).find(x => x.payload.rfqCid === rfq.contractId);
  });
  console.log(`    quote ${q.contractId.slice(0, 18)}… firm until ${q.payload.validUntil}`);
  await sleep(12000);
  const acc = await must(`/api/swap/quotes/${q.contractId}/accept`, { requester: R });
  const r = await trySubmit(R, acc.commands, [], "facc");
  record("stale quote refuses acceptance", !!r.err, r.err || "A LAPSED PRICE WAS LIFTED");
}

// ---- 3. cancel an RFQ, then try to quote it ------------------------------
async function testCancelledRfq() {
  console.log("\n[3] quote an RFQ the buyer cancelled");
  const { rfq, inv } = await openRfq(D1, 15, 1);
  const cancel = [{ ExerciseCommand: {
    templateId: `#${process.env.PACKAGE_NAME}:UmbraSwap:SwapRfq`,
    contractId: rfq.contractId, choice: "CancelRfq", choiceArgument: {} } }];
  const c = await trySubmit(R, cancel, [], "fcancel");
  if (c.err) return record("cancelled RFQ refuses a quote", false, "CancelRfq itself failed: " + c.err);
  console.log("    rfq cancelled");
  await sleep(4000);
  const qb = await must(`/api/swap/invitations/${inv.contractId}/quote`, { dealer: D1, price: "0.001" });
  const r = await trySubmit(D1, qb.commands, [], "fcq");
  // The invitation is a separate contract, so it may well survive the cancel. What must
  // NOT happen is a quote that can still be lifted into a trade against a dead RFQ.
  record("cancelled RFQ leaves no liftable quote", !!r.err,
    r.err || "a quote was accepted against a cancelled RFQ (invitation outlives CancelRfq)");
}

// ---- 4. dealer quotes more than it holds ---------------------------------
async function testDealerShortfall() {
  console.log("\n[4] dealer quotes more cETH than it holds");
  const dh = await holdings(D1);
  const have = ((dh.instruments || []).find(x => x.id === "cETH") || {}).total || 0;
  const price = String(Number(have) + 5);             // unmistakably more than it has
  console.log(`    dealer1 holds ${have} cETH, will quote ${price}`);
  const { rfq, inv } = await openRfq(D1, 15, 1);
  const qb = await must(`/api/swap/invitations/${inv.contractId}/quote`, { dealer: D1, price });
  const s = await trySubmit(D1, qb.commands, [], "fshort");
  if (s.err) {
    return record("dealer cannot quote beyond its balance", true, "refused at quote time: " + s.err);
  }
  const q = await until("quote", async () => {
    const o = await must(`/api/swap/quotes?role=${encodeURIComponent(R)}`);
    return (o.quotes || []).find(x => x.payload.rfqCid === rfq.contractId);
  });
  const acc = await must(`/api/swap/quotes/${q.contractId}/accept`, { requester: R });
  const a = await trySubmit(R, acc.commands, [], "fshortacc");
  if (a.err) return record("underfunded quote refused at acceptance", true, a.err);
  const prop = await until("proposal", async () => {
    const o = await must(`/api/swap/proposals?role=${encodeURIComponent(R)}`);
    return (o.proposals || []).find(p => p.payload.requester === R && Number(p.payload.price) === Number(price));
  });
  console.log(`    proposal ${prop.contractId.slice(0, 18)}… — driving settlement`);

  // Drive it. The requester's leg allocates first; the dealer's cannot.
  let stopped = null;
  for (let i = 0; i < 5 && !stopped; i++) {
    const r = await j(`/api/swap/proposals/${prop.contractId}/settle-real`, {});
    if (r.status === 202 && r.body.awaiting) {
      const aw = r.body.awaiting;
      if (aw.step === "AllocateLeg") {
        const pick = await freeHolding(aw.party, aw.allocate.instrument, aw.allocate.amount);
        if (!pick) { stopped = `no free ${aw.allocate.instrument} for ${S[aw.party] ? S[aw.party].role : aw.party}`; break; }
        const ab = await must("/api/real/allocate?build=1", {
          build: true, senderRole: aw.party, receiver: aw.allocate.receiver,
          admin: aw.allocate.admin, id: aw.allocate.instrument, amount: aw.allocate.amount,
          holdingCids: [pick.contractId], settleId: aw.allocate.settlementRef,
          legId: aw.legId, registry: aw.allocate.registry });
        const sub = await trySubmit(aw.party, ab.commands, ab.disclosedContracts, "fshortalloc");
        if (sub.err) { stopped = sub.err; break; }
      } else {
        const sub = await trySubmit(aw.party, aw.commands, [], "fshortsig");
        if (sub.err) { stopped = sub.err; break; }
      }
      await sleep(3000);
      continue;
    }
    if (r.status >= 400) { stopped = String(r.body.error).slice(0, 200); break; }
    stopped = "SETTLEMENT COMPLETED — an underfunded dealer paid a leg it did not have";
    break;
  }
  const settledAnyway = /SETTLEMENT COMPLETED/.test(stopped || "");
  record("underfunded settlement does not complete", !settledAnyway, stopped);

  const lk = await lockedOn(R);
  record("requester left with nothing locked after the failure", lk.length === 0,
    lk.length ? "STILL LOCKED: " + lk.join(", ") + " — recover with wallet_resume_demo.js" : null);
}

(async () => {
  if (!EXECUTE) return console.log("dry run only — re-run with --execute (this writes to the ledger)");
  console.log("package:", process.env.PACKAGE_NAME, "| requester:", R.slice(0, 34) + "…");
  const tests = { 1: testExpiredRfq, 2: testStaleQuote, 3: testCancelledRfq, 4: testDealerShortfall };
  for (const [n, fn] of Object.entries(tests)) {
    if (ONLY && ONLY !== n) continue;
    try { await fn(); } catch (e) { record(`test ${n} crashed`, false, e.message); }
  }
  const failed = results.filter(r => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  failed.forEach(f => console.log("  FAILED: " + f.name));
})().catch(e => console.log("\nFAILED:", e.message));
