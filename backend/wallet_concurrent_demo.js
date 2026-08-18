// Two trades in flight AT ONCE, deliberately made hard to tell apart.
//
//   node wallet_concurrent_demo.js                 dry run
//   node wallet_concurrent_demo.js --execute       run both, interleaved
//
// Every earlier demo ran one trade to completion before starting the next, so nothing
// has ever tested whether the venue can keep two straight. This runs the SAME pair and
// the SAME offer amount on both, differing only in which dealer wins and at what price.
// If any step matched trades by amount rather than by contract id, the legs would cross
// and each side would be paid the other trade's price -- with real tokens.
//
// The settlement rounds are INTERLEAVED (A, B, A, B, ...) rather than run in sequence,
// because a bug that only shows when two settlements overlap will not show if one
// finishes first.
//
// Checks at the end:
//   - each dealer paid exactly its own quoted price, not its rival's
//   - the requester received the sum of both, and paid the sum of both
//   - nothing is left locked

require("dotenv").config();
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://127.0.0.1:" + (process.env.PORT || 4000));
const KEYDIR = process.env.WALLET_KEY_DIR || path.join(os.homedir(), "umbra-wallet-keys");
const EXECUTE = process.argv.includes("--execute");
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };

const OFFER_SYM = argOf("--offer-asset", "Amulet");
const OFFER_AMT = argOf("--offer", "3");        // identical on both trades, on purpose
const WANT_SYM  = argOf("--want-asset", "cETH");
const PRICE_A   = argOf("--priceA", "0.003");   // dealer1 wins trade A
const PRICE_B   = argOf("--priceB", "0.005");   // dealer2 wins trade B

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Holdings come back under the ledger instrument id ("Amulet", "CBTC"); the venue UI
// creates RFQs under the ticker ("CC", "cBTC"). resolveAsset passes {admin,symbol}
// through verbatim, so a script submitting the raw id writes trades that read
// differently from every UI-created one. Look holdings up by id, submit by ticker.
const disp = s => s === "Amulet" ? "CC" : (s === "CBTC" ? "cBTC" : s);


async function j(p, b) {
  const r = await fetch(API + p, { method: b ? "POST" : "GET",
    headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let o; try { o = JSON.parse(t); } catch { o = { raw: t }; }
  return { status: r.status, body: o };
}
async function must(p, b) {
  const r = await j(p, b);
  if (r.status >= 400) throw new Error(`${p} -> ${r.status} ${String(r.body.error || r.body.raw).slice(0, 240)}`);
  return r.body;
}
const sign = (h, k) => crypto.sign(null, Buffer.from(h, "base64"),
  crypto.createPrivateKey({ key: Buffer.from(k, "base64"), format: "der", type: "pkcs8" })).toString("base64");

const signers = {};
function loadSigners() {
  for (const role of ["requester", "dealer1", "dealer2"]) {
    const f = path.join(KEYDIR, role + ".local.json");
    const k = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!k.partyId) throw new Error(`${f} has no partyId`);
    signers[k.partyId] = { role, partyId: k.partyId, fingerprint: k.fingerprint, privDer: k.privDer };
  }
}
async function submitAs(partyId, commands, disclosed, tag) {
  const s = signers[partyId];
  if (!s) throw new Error("no wallet key for " + String(partyId).slice(0, 28));
  const prep = await must("/api/ext/prepare", { party: s.partyId, commands,
    disclosedContracts: disclosed || [], tag: tag || "wconc" });
  return must("/api/ext/execute", { party: s.partyId, commandId: prep.commandId,
    preparedTransaction: prep.preparedTransaction, hashingSchemeVersion: prep.hashingSchemeVersion,
    signature: sign(prep.preparedTransactionHash, s.privDer), signedBy: s.fingerprint });
}
async function until(label, fn, tries = 26, gap = 2500) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    process.stdout.write("."); await sleep(gap);
  }
  throw new Error("timed out waiting for " + label);
}
const holdingsOf = async (pid) =>
  (await must(`/api/real/holdings?role=${encodeURIComponent(pid)}`)).instruments || [];
async function freeHolding(pid, sym, amt) {
  const h = await must(`/api/real/holdings?role=${encodeURIComponent(pid)}`);
  return (h.raw || []).filter(x => x.id === sym && !x.lock && Number(x.amount) >= Number(amt))
    .sort((a, b) => Number(a.amount) - Number(b.amount))[0] || null;
}
const totalOf = (list, sym) => {
  const e = (list || []).find(x => x.id === sym);
  return e ? Number(e.total) : 0;
};

(async () => {
  loadSigners();
  const R  = Object.values(signers).find(s => s.role === "requester").partyId;
  const D1 = Object.values(signers).find(s => s.role === "dealer1").partyId;
  const D2 = Object.values(signers).find(s => s.role === "dealer2").partyId;

  console.log("requester:", R.slice(0, 40) + "…");
  console.log("trade A -> dealer1 @", PRICE_A, WANT_SYM, "| trade B -> dealer2 @", PRICE_B, WANT_SYM);
  console.log("both offering the SAME", OFFER_AMT, OFFER_SYM, "so nothing can be matched by amount\n");

  const need = Number(OFFER_AMT) * 2;
  const rh = await holdingsOf(R);
  if (totalOf(rh, OFFER_SYM) < need)
    throw new Error(`requester needs ${need} ${OFFER_SYM}, has ${totalOf(rh, OFFER_SYM)}`);
  const d1h = await holdingsOf(D1), d2h = await holdingsOf(D2);
  if (totalOf(d1h, WANT_SYM) < Number(PRICE_A)) throw new Error("dealer1 short of " + WANT_SYM);
  if (totalOf(d2h, WANT_SYM) < Number(PRICE_B)) throw new Error("dealer2 short of " + WANT_SYM);

  const before = { R: await holdingsOf(R), D1: d1h, D2: d2h };
  console.log("BEFORE requester:", JSON.stringify(before.R));
  console.log("BEFORE dealer1  :", JSON.stringify(before.D1));
  console.log("BEFORE dealer2  :", JSON.stringify(before.D2));
  if (!EXECUTE) return console.log("\ndry run - nothing written. Re-run with --execute.");

  const wantAdmin = (await freeHolding(D2, WANT_SYM, PRICE_B)).admin;
  const offerAdmin = (await freeHolding(R, OFFER_SYM, OFFER_AMT)).admin;

  // ---- open both trades up to a SwapProposal each -------------------------
  async function openTrade(tag, dealer, price) {
    const before = new Set(((await must(`/api/swap/rfqs?role=${encodeURIComponent(R)}`)).rfqs || [])
      .map(x => x.contractId));
    const built = await must("/api/swap/rfq", {
      requester: R,
      offerAsset: { admin: offerAdmin, symbol: disp(OFFER_SYM) }, offerAmount: OFFER_AMT,
      wantAsset: { admin: wantAdmin, symbol: disp(WANT_SYM) },
      invited: [dealer],
    });
    await submitAs(R, built.commands, [], tag + "rfq");
    const rfq = await until(tag + " rfq", async () => {
      const o = await must(`/api/swap/rfqs?role=${encodeURIComponent(R)}`);
      return (o.rfqs || []).find(x => !before.has(x.contractId) && x.payload.requester === R);
    });
    console.log(`\n[${tag}] rfq ${rfq.contractId.slice(0, 20)}…`);

    const inv0 = await must(`/api/swap/rfqs/${rfq.contractId}/invite`, { dealer, requester: R });
    await submitAs(R, inv0.commands, [], tag + "inv");
    const inv = await until(tag + " invitation", async () => {
      const o = await must(`/api/swap/invitations?role=${encodeURIComponent(dealer)}`);
      return (o.invitations || []).find(i => i.payload.rfqCid === rfq.contractId);
    });

    const qb = await must(`/api/swap/invitations/${inv.contractId}/quote`, { dealer, price });
    await submitAs(dealer, qb.commands, [], tag + "quote");
    const q = await until(tag + " quote", async () => {
      const o = await must(`/api/swap/quotes?role=${encodeURIComponent(R)}`);
      return (o.quotes || []).find(x => x.payload.rfqCid === rfq.contractId);
    });
    console.log(`[${tag}] quote ${q.payload.price} from ${signers[dealer].role}`);

    const props0 = new Set(((await must(`/api/swap/proposals?role=${encodeURIComponent(R)}`)).proposals || [])
      .map(x => x.contractId));
    const acc = await must(`/api/swap/quotes/${q.contractId}/accept`, { requester: R });
    await submitAs(R, acc.commands, [], tag + "acc");
    const prop = await until(tag + " proposal", async () => {
      const o = await must(`/api/swap/proposals?role=${encodeURIComponent(R)}`);
      return (o.proposals || []).find(p => !props0.has(p.contractId) && p.payload.requester === R);
    });
    console.log(`[${tag}] proposal ${prop.contractId.slice(0, 20)}… price ${prop.payload.price}`);
    return { tag, dealer, price, rfq, prop, cid: prop.contractId, done: false, settlementCid: null };
  }

  // --resume picks up two trades already past ProposeRealSwap instead of opening new
  // ones, so a run that stalled can be finished rather than leaving funds locked.
  // A dead cid makes settle-real answer 404, which routes straight to the pending branch.
  const RESUME = process.argv.includes("--resume");
  const stub = (tag, dealer, price) =>
    ({ tag, dealer, price, cid: "0".repeat(64) + "ff", done: false, settlementCid: null });
  const A = RESUME ? stub("A", D1, PRICE_A) : await openTrade("A", D1, PRICE_A);
  const B = RESUME ? stub("B", D2, PRICE_B) : await openTrade("B", D2, PRICE_B);

  // Both proposals now exist SIMULTANEOUSLY. Everything below overlaps.
  console.log("\n=== both proposals open at once — settling interleaved ===");

  // One settlement round for one trade. Returns false when that trade is finished.
  async function step(t) {
    if (t.done) return false;
    const r = await j(`/api/swap/proposals/${t.cid}/settle-real`, {});
    if (r.status === 202 && r.body.awaiting) {
      const a = r.body.awaiting;
      if (a.step === "AllocateLeg") {
        const pick = await freeHolding(a.party, a.allocate.instrument, a.allocate.amount);
        if (!pick) throw new Error(`[${t.tag}] no free ${a.allocate.instrument} >= ${a.allocate.amount}`);
        const ab = await must("/api/real/allocate?build=1", {
          build: true, senderRole: a.party, receiver: a.allocate.receiver,
          admin: a.allocate.admin, id: a.allocate.instrument, amount: a.allocate.amount,
          holdingCids: [pick.contractId], settleId: a.allocate.settlementRef,
          legId: a.legId, registry: a.allocate.registry });
        await submitAs(a.party, ab.commands, ab.disclosedContracts, t.tag + "alloc");
        console.log(`[${t.tag}] ${signers[a.party].role} allocated ${a.legId} (${a.allocate.amount} ${a.allocate.instrument})`);
      } else {
        await submitAs(a.party, a.commands, [], t.tag + "sig");
        console.log(`[${t.tag}] ${signers[a.party].role} signed ${a.step}`);
      }
      return true;
    }
    if (r.status === 404 && /proposal not found/i.test(String(r.body.error || ""))) {
      // Consumed -> now a RealSwapPending for THIS trade. Find it by its own dealer+price,
      // not by amount, since both trades share an amount.
      const pend = await must(`/api/swap/pending-real?role=${encodeURIComponent(R)}`);
      const pw = (pend.pending || []).find(x => x.payload.requester === R &&
        x.payload.dealer === t.dealer && Number(x.payload.price) === Number(t.price));
      if (pw) {
        const ab = await must(`/api/swap/pending/${pw.contractId}/accept-real`, {});
        if (ab.build) await submitAs(ab.party, ab.commands, [], t.tag + "acceptreal");
        console.log(`[${t.tag}] ${signers[t.dealer].role} accepted the swap`);
        return true;
      }
      const se = await must(`/api/swap/settlements?role=${encodeURIComponent(R)}`);
      const st = (se.settlements || []).find(x => x.payload.requester === R &&
        x.payload.dealer === t.dealer && Number(x.payload.price) === Number(t.price));
      if (st) {
        const ex = await j(`/api/swap/settlements/${st.contractId}/execute-real`, {});
        console.log(`[${t.tag}] EXECUTE ${ex.status} ${JSON.stringify(ex.body).slice(0, 130)}`);
        t.settlementCid = st.contractId; t.done = true;
        return false;
      }
      return true; // neither yet -- give the ledger a beat
    }
    if (r.status >= 400) throw new Error(`[${t.tag}] ${String(r.body.error).slice(0, 200)}`);
    t.done = true;
    console.log(`[${t.tag}] settled in one call: ${JSON.stringify(r.body).slice(0, 130)}`);
    return false;
  }

  for (let round = 1; round <= 14 && (!A.done || !B.done); round++) {
    console.log(`\n-- round ${round} --`);
    await step(A);
    await step(B);          // interleaved, not sequential
    await sleep(3500);
  }

  // ---- did the legs cross? -----------------------------------------------
  await sleep(9000);
  const after = { R: await holdingsOf(R), D1: await holdingsOf(D1), D2: await holdingsOf(D2) };
  console.log("\nAFTER requester:", JSON.stringify(after.R));
  console.log("AFTER dealer1  :", JSON.stringify(after.D1));
  console.log("AFTER dealer2  :", JSON.stringify(after.D2));

  const d = (a, b, sym) => Number((totalOf(a, sym) - totalOf(b, sym)).toFixed(10));
  const dR_offer = d(after.R, before.R, OFFER_SYM), dR_want = d(after.R, before.R, WANT_SYM);
  const d1_offer = d(after.D1, before.D1, OFFER_SYM), d1_want = d(after.D1, before.D1, WANT_SYM);
  const d2_offer = d(after.D2, before.D2, OFFER_SYM), d2_want = d(after.D2, before.D2, WANT_SYM);

  console.log("\n=== VERDICT ===");
  console.log(`requester: ${dR_offer} ${OFFER_SYM}, ${dR_want} ${WANT_SYM}`);
  console.log(`dealer1  : ${d1_offer} ${OFFER_SYM}, ${d1_want} ${WANT_SYM}  (quoted ${PRICE_A})`);
  console.log(`dealer2  : ${d2_offer} ${OFFER_SYM}, ${d2_want} ${WANT_SYM}  (quoted ${PRICE_B})`);

  const near = (x, y) => Math.abs(x - y) < 1e-9;
  const checks = [
    ["dealer1 paid its OWN price", near(d1_want, -Number(PRICE_A))],
    ["dealer2 paid its OWN price", near(d2_want, -Number(PRICE_B))],
    ["dealer1 received its leg", near(d1_offer, Number(OFFER_AMT))],
    ["dealer2 received its leg", near(d2_offer, Number(OFFER_AMT))],
    ["requester paid both legs", near(dR_offer, -2 * Number(OFFER_AMT))],
    ["requester received both prices", near(dR_want, Number(PRICE_A) + Number(PRICE_B))],
  ];
  let bad = 0;
  for (const [label, ok] of checks) { console.log((ok ? "  PASS  " : "  FAIL  ") + label); if (!ok) bad++; }

  for (const [name, pid] of [["requester", R], ["dealer1", D1], ["dealer2", D2]]) {
    const h = await must(`/api/real/holdings?role=${encodeURIComponent(pid)}`);
    const locked = (h.raw || []).filter(x => x.lock).map(x => `${x.id}=${x.amount}`);
    console.log((locked.length ? "  FAIL  " : "  PASS  ") + `${name} has nothing locked` +
      (locked.length ? ` (locked: ${locked.join(", ")})` : ""));
    if (locked.length) bad++;
  }
  console.log(bad ? `\n${bad} CHECK(S) FAILED` : "\nALL CHECKS PASSED — the two trades stayed separate");
})().catch(e => console.log("\nFAILED:", e.message));
