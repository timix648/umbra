// The whole venue, bring-your-own-wallet: ALL THREE participants are external
// parties whose private keys this server has never held.
//
//   node wallet_full_flow_demo.js                 dry run (checks funding, writes nothing)
//   node wallet_full_flow_demo.js --execute       run the trade
//
// Prereq: three onboarded+funded wallets, one keyfile each:
//   WALLET_KEY_FILE=~/umbra-wallet-keys/<role>.local.json node wallet_onboard_demo.js --execute
//   WALLET_KEY_FILE=~/umbra-wallet-keys/<role>.local.json node wallet_fund_demo.js --execute ...
//
// The earlier demos each proved ONE side (wallet_trade_demo = dealer,
// wallet_requester_demo = requester) with the other side server-signed. This proves
// there is no server-signed side left: every party-authorised command in the flow --
// RFQ, InviteDealer, SubmitSwapQuote x2, AcceptSwapQuote, both allocations,
// ProposeRealSwap, AcceptRealSwap -- is signed by a key held in a file outside the
// backend. The operator signs exactly one thing, ExecuteRealSwap, which is
// `controller operator` in the Daml and is the venue's own authority, not a party's.

require("dotenv").config();
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://127.0.0.1:" + (process.env.PORT || 4000));
const KEYDIR = process.env.WALLET_KEY_DIR || path.join(os.homedir(), "umbra-wallet-keys");
const EXECUTE = process.argv.includes("--execute");
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };

const OFFER_SYM = argOf("--offer-asset", "Amulet");   // what the requester gives
const OFFER_AMT = argOf("--offer", "100");
const WANT_SYM  = argOf("--want-asset", "cETH");      // what the dealers pay in
const PRICE_D1  = argOf("--price1", "0.02");
const PRICE_D2  = argOf("--price2", "0.03");          // better bid -> should win
// Stop the moment a step belongs to someone else, instead of signing it. That is what
// a real browser session is limited to -- it holds one key -- so this reproduces the
// half-settled state the dealer's own desk has to be able to finish.
const HALT      = process.argv.includes("--halt-on-counterparty");

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

async function until(label, fn, tries = 24, gap = 2500) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    process.stdout.write("."); await sleep(gap);
  }
  throw new Error("timed out waiting for " + label);
}

// ---- the signer registry -------------------------------------------------
// The single-wallet demos could close over one key. Here a settle round can ask
// EITHER side to sign, so signatures are dispatched by the party the server names.
const signers = {};   // partyId -> { role, partyId, fingerprint, privDer }

function loadSigners() {
  for (const role of ["requester", "dealer1", "dealer2"]) {
    const f = path.join(KEYDIR, role + ".local.json");
    if (!fs.existsSync(f)) throw new Error(`missing keyfile ${f} - onboard ${role} first`);
    const k = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!k.partyId) throw new Error(`${f} has no partyId - re-run wallet_onboard_demo.js`);
    signers[k.partyId] = { role, partyId: k.partyId, fingerprint: k.fingerprint, privDer: k.privDer };
  }
}

async function submitAs(partyId, commands, disclosed, tag) {
  const s = signers[partyId];
  if (!s) throw new Error("no wallet key for party " + String(partyId).slice(0, 32) + "… (server would have to sign - that is the thing we are disproving)");
  const prep = await must("/api/ext/prepare", { party: s.partyId, commands,
    disclosedContracts: disclosed || [], tag: tag || "wflow" });
  const out = await must("/api/ext/execute", { party: s.partyId, commandId: prep.commandId,
    preparedTransaction: prep.preparedTransaction, hashingSchemeVersion: prep.hashingSchemeVersion,
    signature: sign(prep.preparedTransactionHash, s.privDer), signedBy: s.fingerprint });
  console.log(`      signed by ${s.role} wallet`);
  return out;
}

// Pick an unlocked holding of `sym` that covers `amt` on its own.
async function holdingFor(partyId, sym, amt) {
  const h = await must(`/api/real/holdings?role=${encodeURIComponent(partyId)}`);
  return (h.raw || []).filter(x => x.id === sym && !x.lock && Number(x.amount) >= Number(amt))
    .sort((a, b) => Number(a.amount) - Number(b.amount))[0] || null;
}
const holdingsOf = async (partyId) =>
  (await must(`/api/real/holdings?role=${encodeURIComponent(partyId)}`)).instruments || [];

(async () => {
  const PKGN = process.env.PACKAGE_NAME;
  loadSigners();
  const R  = Object.values(signers).find(s => s.role === "requester").partyId;
  const D1 = Object.values(signers).find(s => s.role === "dealer1").partyId;
  const D2 = Object.values(signers).find(s => s.role === "dealer2").partyId;

  console.log("API:", API, "| package:", PKGN);
  console.log("requester wallet:", R.slice(0, 46) + "…");
  console.log("dealer1   wallet:", D1.slice(0, 46) + "…");
  console.log("dealer2   wallet:", D2.slice(0, 46) + "…");

  console.log("\n--- funding check ---");
  const offerH = await holdingFor(R, OFFER_SYM, OFFER_AMT);
  if (!offerH) throw new Error(`requester wallet has no unlocked ${OFFER_SYM} >= ${OFFER_AMT}`);
  const d1H = await holdingFor(D1, WANT_SYM, PRICE_D1);
  const d2H = await holdingFor(D2, WANT_SYM, PRICE_D2);
  if (!d1H) throw new Error(`dealer1 wallet has no unlocked ${WANT_SYM} >= ${PRICE_D1}`);
  if (!d2H) throw new Error(`dealer2 wallet has no unlocked ${WANT_SYM} >= ${PRICE_D2}`);
  console.log(`requester: ${OFFER_AMT} ${OFFER_SYM} (admin ${offerH.admin.split("::")[0]})`);
  console.log(`dealer1  : quotes ${PRICE_D1} ${WANT_SYM}`);
  console.log(`dealer2  : quotes ${PRICE_D2} ${WANT_SYM}  <- better bid`);

  const before = { R: await holdingsOf(R), D1: await holdingsOf(D1), D2: await holdingsOf(D2) };
  console.log("\nBEFORE requester:", JSON.stringify(before.R));
  console.log("BEFORE dealer1  :", JSON.stringify(before.D1));
  console.log("BEFORE dealer2  :", JSON.stringify(before.D2));

  if (!EXECUTE) return console.log("\ndry run - nothing written. Re-run with --execute.");

  // 1. requester wallet raises the RFQ
  console.log("\n--- 1. requester wallet signs the RFQ ---");
  const rfqBuilt = await must("/api/swap/rfq", {
    requester: R,
    offerAsset: { admin: offerH.admin, symbol: disp(OFFER_SYM) }, offerAmount: OFFER_AMT,
    wantAsset: { admin: d2H.admin, symbol: disp(WANT_SYM) },
    // `invited` is an ALLOWLIST fixed at creation: InviteDealer asserts the dealer is
    // already on it (the choice's failure message reads the opposite of what it checks).
    invited: [D1, D2],
  });
  if (!rfqBuilt.build) throw new Error("expected build mode for a wallet requester");
  // SwapRfq is nonconsuming and lives for its full TTL, so a previous run's RFQ is
  // still active and matches on requester and invite list alike. Identify OURS as the
  // cid that did not exist a moment ago -- anything weaker silently reuses the old one
  // and stacks duplicate invitations and quotes onto it.
  const rfqsBefore = new Set(((await must(`/api/swap/rfqs?role=${encodeURIComponent(R)}`)).rfqs || []).map(x => x.contractId));
  await submitAs(R, rfqBuilt.commands, [], "wfrfq");
  const rfq = await until("rfq", async () => {
    const o = await must(`/api/swap/rfqs?role=${encodeURIComponent(R)}`);
    return (o.rfqs || o.items || []).find(x => !rfqsBefore.has(x.contractId) &&
      x.payload && x.payload.requester === R &&
      new Date(x.payload.expiresAt).getTime() > Date.now());
  });
  console.log("\nrfq:", rfq.contractId.slice(0, 26) + "…");

  // 2. requester invites both dealer wallets (one signature each)
  console.log("\n--- 2. requester wallet signs InviteDealer x2 ---");
  for (const [label, d] of [["dealer1", D1], ["dealer2", D2]]) {
    const b = await must(`/api/swap/rfqs/${rfq.contractId}/invite`, { dealer: d, requester: R });
    if (!b.build) throw new Error("expected build mode for invite");
    console.log(`   inviting ${label}`);
    await submitAs(R, b.commands, [], "wfinv");
  }

  // 3. each dealer wallet quotes with its OWN key
  console.log("\n--- 3. each dealer wallet signs SubmitSwapQuote ---");
  const quoted = [];
  for (const [label, d, price] of [["dealer1", D1, PRICE_D1], ["dealer2", D2, PRICE_D2]]) {
    const inv = await until(`${label} invitation`, async () => {
      const o = await must(`/api/swap/invitations?role=${encodeURIComponent(d)}`);
      return (o.invitations || []).find(i => i.payload && i.payload.rfqCid === rfq.contractId);
    });
    console.log(`\n   ${label} invitation:`, inv.contractId.slice(0, 24) + "…");
    const qb = await must(`/api/swap/invitations/${inv.contractId}/quote`, { dealer: d, price });
    if (!qb.build) throw new Error(`expected build mode for wallet ${label} quote`);
    await submitAs(d, qb.commands, [], "wfquote");
    quoted.push({ label, d, price });
  }

  // 4. requester sees both quotes (it is observer on each) and lifts the better one
  console.log("\n--- 4. requester wallet signs AcceptSwapQuote ---");
  const quotes = await until("both quotes", async () => {
    const o = await must(`/api/swap/quotes?role=${encodeURIComponent(R)}`);
    const mine = (o.quotes || []).filter(x => x.payload && x.payload.rfqCid === rfq.contractId);
    return mine.length >= 2 ? mine : null;
  });
  console.log("\n   quotes visible to requester:",
    quotes.map(q => `${String(q.payload.dealer).split("::")[0]}=${q.payload.price}`).join("  "));
  const best = quotes.sort((a, b) => Number(b.payload.price) - Number(a.payload.price))[0];
  console.log("   lifting:", String(best.payload.dealer).split("::")[0], "@", best.payload.price);

  const accBuilt = await must(`/api/swap/quotes/${best.contractId}/accept`, { requester: R });
  if (!accBuilt.build) throw new Error("expected build mode for wallet requester accept");
  // Same trap as the RFQ above: a proposal from an earlier run -- especially one that
  // could never settle, like an underfunded test case -- is still open and matches on
  // requester alone. Take the cid that did not exist a moment ago.
  const propsBefore = new Set(((await must(`/api/swap/proposals?role=${encodeURIComponent(R)}`)).proposals || [])
    .map(p => p.contractId));
  await submitAs(R, accBuilt.commands, [], "wfacc");
  const prop = await until("proposal", async () => {
    const o = await must(`/api/swap/proposals?role=${encodeURIComponent(R)}`);
    return (o.proposals || []).find(p => !propsBefore.has(p.contractId) &&
      p.payload && p.payload.requester === R);
  });
  console.log("\nproposal:", prop.contractId.slice(0, 26) + "…", "tradeId:", prop.payload.tradeId);

  // 5. settle, dispatching every requested signature to whichever wallet owns it
  console.log("\n--- 5. settle-real (signatures routed by party) ---");
  for (let round = 1; round <= 8; round++) {
    const r = await j(`/api/swap/proposals/${prop.contractId}/settle-real`, {});
    console.log(`\nround ${round}: HTTP ${r.status}`);
    (r.body.steps || []).forEach(s => console.log("   -", s));

    if (r.status === 202 && r.body.awaiting) {
      const a = r.body.awaiting;
      const who = signers[a.party] ? signers[a.party].role : String(a.party).slice(0, 20) + "…";
      console.log(`   AWAITING: ${a.step} from ${who}`);
      if (HALT && a.party !== R) {
        console.log(`\nHALTED: the next step belongs to ${who}, who must sign it from its own`);
        console.log(`session. Proposal ${prop.contractId.slice(0, 26)}… is left open for it.`);
        return;
      }
      if (a.step === "AllocateLeg") {
        const pick = await holdingFor(a.party, a.allocate.instrument, a.allocate.amount);
        if (!pick) throw new Error(`${who} has no unlocked ${a.allocate.instrument} >= ${a.allocate.amount}`);
        const ab = await must("/api/real/allocate?build=1", {
          build: true, senderRole: a.party, receiver: a.allocate.receiver,
          admin: a.allocate.admin, id: a.allocate.instrument, amount: a.allocate.amount,
          holdingCids: [pick.contractId], settleId: a.allocate.settlementRef,
          legId: a.legId, registry: a.allocate.registry });
        await submitAs(a.party, ab.commands, ab.disclosedContracts, "wfalloc");
        console.log(`   ${who} allocated the ${a.legId} leg`);
      } else {
        await submitAs(a.party, a.commands, [], "wfsettle");
      }
      await sleep(5000);
      continue;
    }

    // ProposeRealSwap is consuming: once the requester signs it, the proposal is gone
    // and the trade lives as a RealSwapPending awaiting the DEALER's accept.
    if (r.status === 404 && /proposal not found/i.test(String(r.body.error || ""))) {
      console.log("   proposal consumed - finding the pending swap");
      // Only settlements for THIS trade. Matching on requester alone picks up an older
      // one -- including a failed attempt that can never execute -- and then reports its
      // failure as this trade's, which has already cost two debugging cycles.
      const mineHere = x => x.payload && x.payload.requester === R &&
        Number(x.payload.price) === Number(best.payload.price) &&
        Number(x.payload.offerAmount) === Number(prop.payload.offerAmount) &&
        x.payload.dealer === best.payload.dealer;
      let s = await must(`/api/swap/settlements?role=${encodeURIComponent(R)}`);
      let setl = (s.settlements || []).filter(mineHere).pop();

      if (!setl) {
        const pend = await must(`/api/swap/pending-real?role=${encodeURIComponent(R)}`);
        const pw = (pend.pending || []).filter(mineHere).pop();
        if (!pw) { console.log("   nothing pending and nothing settled"); break; }
        console.log("   pending:", pw.contractId.slice(0, 26) + "…");

        // The dealer accepts -- and it is a wallet, so IT signs, not the server.
        const ab = await must(`/api/swap/pending/${pw.contractId}/accept-real`, {});
        if (ab.build) {
          console.log("   dealer accept handed back for wallet signing");
          await submitAs(ab.party, ab.commands, [], "wfacceptreal");
        } else {
          console.log("   accepted server-side ->", JSON.stringify(ab).slice(0, 120));
        }
        setl = await until("settlement", async () => {
          const o = await must(`/api/swap/settlements?role=${encodeURIComponent(R)}`);
          return (o.settlements || []).filter(x => x.payload && x.payload.requester === R).pop();
        });
      }
      console.log("\n   settlement:", setl.contractId.slice(0, 26) + "…");

      // ExecuteRealSwap is `controller operator` in the Daml -- the venue's own
      // authority, the one signature that is meant to be the operator's.
      const ex = await j(`/api/swap/settlements/${setl.contractId}/execute-real`, {});
      console.log("   EXECUTE:", ex.status, JSON.stringify(ex.body).slice(0, 240));
      if (ex.status === 200) {
        await sleep(9000);
        console.log("\nAFTER requester:", JSON.stringify(await holdingsOf(R)));
        console.log("AFTER dealer1  :", JSON.stringify(await holdingsOf(D1)));
        console.log("AFTER dealer2  :", JSON.stringify(await holdingsOf(D2)));
      }
      break;
    }

    if (r.status >= 400) { console.log("   ERROR:", String(r.body.error).slice(0, 300)); break; }
    console.log("   SETTLED:", JSON.stringify(r.body).slice(0, 300));
    break;
  }
})().catch(e => console.log("\nFAILED:", e.message));
