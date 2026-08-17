// A full trade in which the DEALER is an external wallet.
//
//   node wallet_trade_demo.js              dry run (plan only)
//   node wallet_trade_demo.js --execute    run it
//
// Umbra never signs for the dealer. It coordinates: builds commands, assembles the
// registry choice-contexts it alone can produce, and waits. Every dealer-side
// signature -- quote, allocation, accept -- is produced here from a key the server
// has never seen.
//
// Flow:
//   1. requester (demo party) creates an RFQ and invites the WALLET as dealer
//   2. wallet signs SubmitSwapQuote
//   3. requester accepts -> SwapProposal carrying tradeId + real deadlines (v9)
//   4. wallet reads tradeId and allocates its own want leg   (build=1 + sign)
//   5. settle-real adopts that leg, proposes, and STOPS at AcceptRealSwap (202)
//   6. wallet signs AcceptRealSwap
//   7. settle-real is called again and resumes to settlement

require("dotenv").config();
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://localhost:" + (process.env.PORT || 4000));
const KEYFILE = process.env.WALLET_KEY_FILE || path.join(os.homedir(), "umbra-wallet-key.local.json");
const WALLET_STORE = path.join(__dirname, "ext-wallets.local.txt");
const EXECUTE = process.argv.includes("--execute");
const PRICE = "0.02";        // cETH the dealer pays
const OFFER = "0.001";       // CBTC the requester offers
const FUND  = "0.05";        // cETH to seed the wallet with

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(p, b, method) {
  const r = await fetch(API + p, { method: method || (b ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let o; try { o = JSON.parse(t); } catch { o = { raw: t }; }
  return { status: r.status, body: o };
}
async function must(p, b, method) {
  const r = await j(p, b, method);
  if (r.status >= 400) throw new Error(`${p} -> ${r.status} ${String(r.body.error || r.body.raw).slice(0, 220)}`);
  return r.body;
}
const sign = (h, privDer) => crypto.sign(null, Buffer.from(h, "base64"),
  crypto.createPrivateKey({ key: Buffer.from(privDer, "base64"), format: "der", type: "pkcs8" })).toString("base64");

// Sign an arbitrary command set as the wallet: prepare -> sign -> execute.
async function walletSubmit(wallet, key, commands, disclosed, tag) {
  const prep = await must("/api/ext/prepare", { party: wallet.partyId, commands,
    disclosedContracts: disclosed || [], tag: tag || "wallet" });
  const out = await must("/api/ext/execute", { party: wallet.partyId, commandId: prep.commandId,
    preparedTransaction: prep.preparedTransaction, hashingSchemeVersion: prep.hashingSchemeVersion,
    signature: sign(prep.preparedTransactionHash, key.privDer), signedBy: wallet.fingerprint });
  return out;
}
async function until(label, fn, tries = 24, gap = 2500) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    process.stdout.write("."); await sleep(gap);
  }
  throw new Error("timed out waiting for " + label);
}

(async () => {
  const PKGN = process.env.PACKAGE_NAME;
  console.log("API:", API, "| PACKAGE_NAME:", PKGN);
  const key = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const wallet = Object.values(JSON.parse(fs.readFileSync(WALLET_STORE, "utf8")))[0];
  console.log("wallet dealer:", wallet.partyId.slice(0, 44) + "…");

  // real instrument admins, taken off actual holdings
  const rh = await must("/api/real/holdings?role=requester");
  const pick = sym => (rh.raw || []).filter(x => x.id === sym && !x.lock)
    .sort((a, b) => Number(a.amount) - Number(b.amount));
  const cbtc = pick("CBTC")[0], ceth = pick("cETH").find(x => Number(x.amount) >= Number(FUND));
  if (!cbtc || !ceth) throw new Error("requester lacks CBTC or cETH to run this");
  console.log("CBTC admin:", cbtc.admin.split("::")[0], "| cETH admin:", ceth.admin.split("::")[0]);

  if (!EXECUTE) return console.log("\ndry run - nothing submitted. Re-run with --execute.");

  // 0. make sure the wallet can pay the want leg
  const wh0 = await must(`/api/real/holdings?role=${encodeURIComponent(wallet.partyId)}`);
  const haveCeth = (wh0.instruments || []).find(i => i.id === "cETH");
  if (!haveCeth || Number(haveCeth.total) < Number(PRICE)) {
    console.log(`\n--- 0. funding wallet with ${FUND} cETH ---`);
    await must("/api/real/send", { senderRole: "requester", receiver: wallet.partyId,
      admin: ceth.admin, id: "cETH", amount: FUND, holdingCids: [ceth.contractId] });
    const offer = await until("transfer offer", async () => {
      const p = await must(`/api/real/pending?role=${encodeURIComponent(wallet.partyId)}`);
      return (p.pending || p.offers || p.transfers || []).find(o => o.instrument === "cETH");
    });
    const built = await must(`/api/real/pending/${offer.contractId}/accept?build=1`,
      { role: wallet.partyId, build: true });
    await walletSubmit(wallet, key, built.commands, built.disclosedContracts, "walletaccept");
    console.log("\nwallet accepted the cETH transfer");
  } else console.log("wallet already holds", haveCeth.total, "cETH");

  // 1. RFQ + invite the wallet as dealer
  console.log("\n--- 1. RFQ, inviting the wallet as dealer ---");
  // /api/swap/rfq invites the parties in `invited` itself (default dealer1+dealer2),
  // so name the wallet here rather than inviting it again afterwards -- InviteDealer
  // asserts the dealer is not already on the list.
  const rfq = await must("/api/swap/rfq", {
    offerAsset: { admin: cbtc.admin, symbol: "CBTC" }, offerAmount: OFFER,
    wantAsset: { admin: ceth.admin, symbol: "cETH" },
    invited: [wallet.partyId] });
  const rfqCid = rfq.contractId || rfq.rfqCid;
  console.log("rfq:", String(rfqCid).slice(0, 24) + "…", "| invitations:", JSON.stringify(rfq.invitations || []).slice(0, 120));
  const inv = await until("invitation", async () => {
    const o = await must(`/api/swap/invitations?role=${encodeURIComponent(wallet.partyId)}`);
    return (o.invitations || o.items || []).find(i => i.payload && i.payload.rfqCid === rfqCid);
  });
  console.log("\ninvitation:", inv.contractId.slice(0, 24) + "…");

  // 2. the WALLET quotes, signing for itself
  console.log("\n--- 2. wallet signs SubmitSwapQuote ---");
  await walletSubmit(wallet, key, [{ ExerciseCommand: {
    templateId: `#${PKGN}:UmbraSwap:SwapInvitation`, contractId: inv.contractId,
    choice: "SubmitSwapQuote",
    choiceArgument: { price: PRICE, validUntil: new Date(Date.now() + 20 * 60000).toISOString() } } }],
    [], "walletquote");
  const q = await until("quote", async () => {
    const o = await must("/api/swap/quotes?role=requester");
    return (o.quotes || o.items || []).find(x => x.payload && x.payload.dealer === wallet.partyId);
  });
  console.log("\nquote:", q.contractId.slice(0, 24) + "…", "price", q.payload.price);

  // 3. requester accepts -> SwapProposal (v9: carries tradeId + deadlines)
  console.log("\n--- 3. requester accepts -> SwapProposal ---");
  await must(`/api/swap/quotes/${q.contractId}/accept`, {});
  const prop = await until("proposal", async () => {
    const o = await must("/api/swap/proposals?role=requester").catch(() => null);
    if (o) return (o.proposals || o.items || []).find(p => p.payload && p.payload.dealer === wallet.partyId);
    return null;
  }, 4).catch(() => null);
  // no proposals endpoint on some builds -> fall back to settle-real discovering it
  let propCid = prop && prop.contractId;
  if (!propCid) {
    console.log("\n(no /api/swap/proposals endpoint; locating via history)");
    const hist = await must("/api/swap/history?role=requester").catch(() => ({}));
    const cands = (hist.proposals || []).filter(p => p.payload && p.payload.dealer === wallet.partyId);
    propCid = cands.length ? cands[cands.length - 1].contractId : null;
  }
  if (!propCid) throw new Error("could not locate the SwapProposal - inspect manually");
  console.log("proposal:", propCid.slice(0, 24) + "…");

  // 4. settle -- expect 202 awaiting the wallet's signature
  console.log("\n--- 4/5/6. settle-real, resuming around wallet signatures ---");
  for (let round = 1; round <= 4; round++) {
    const r = await j(`/api/swap/proposals/${propCid}/settle-real`, {});
    console.log(`\nround ${round}: HTTP ${r.status}`);
    (r.body.steps || []).forEach(s => console.log("   -", s));
    if (r.status === 202 && r.body.awaiting) {
      const a = r.body.awaiting;
      console.log("   AWAITING:", a.step, "from", String(a.party).slice(0, 28) + "…");

      if (a.step === "AllocateLeg") {
        // The wallet picks its OWN holdings -- that choice is the owner's, not the venue's.
        const wh = await must(`/api/real/holdings?role=${encodeURIComponent(a.party)}`);
        const cands = (wh.raw || []).filter(x => x.id === a.allocate.instrument && !x.lock &&
          Number(x.amount) >= Number(a.allocate.amount));
        if (!cands.length) throw new Error(`wallet has no unlocked ${a.allocate.instrument} >= ${a.allocate.amount}`);
        const pickH = cands.sort((x, y) => Number(x.amount) - Number(y.amount))[0];
        const built = await must("/api/real/allocate?build=1", {
          build: true, senderRole: a.party, receiver: a.allocate.receiver,
          admin: a.allocate.admin, id: a.allocate.instrument, amount: a.allocate.amount,
          holdingCids: [pickH.contractId], settleId: a.allocate.settlementRef,
          legId: a.legId, registry: a.allocate.registry });
        await walletSubmit(wallet, key, built.commands, built.disclosedContracts, "walletalloc");
        console.log(`   wallet allocated its ${a.legId} leg (${a.allocate.amount} ${a.allocate.instrument})`);
      } else {
        await walletSubmit(wallet, key, a.commands, [], "walletsettle");
        console.log("   wallet signed", a.step);
      }
      await sleep(5000);
      continue;
    }
    // AcceptRealSwap consumes the SwapProposal, so a 404 here means the accept landed
    // and the trade has moved on to its SwapSettlement -- not that anything failed.
    if (r.status === 404 && /proposal not found/i.test(String(r.body.error || ""))) {
      console.log("   proposal consumed by AcceptRealSwap - locating the settlement");
      const s = await must("/api/swap/settlements?role=requester");
      const mine = (s.settlements || []).filter(x => x.payload && x.payload.dealer === wallet.partyId);
      const setl = mine[mine.length - 1];
      if (!setl) { console.log("   no settlement found for this wallet"); break; }
      console.log("   settlement:", setl.contractId.slice(0, 24) + "…",
                  setl.payload.offerAmount, setl.payload.offerAsset.symbol, "<->",
                  setl.payload.price, setl.payload.wantAsset.symbol);
      // ExecuteRealSwap is controller `operator` (the venue), so this side needs no
      // wallet signature: both parties already committed via allocation + accept.
      // /execute would exercise stand-in ExecuteSwap, which the ledger refuses for
      // real legs -- /execute-real is the registry path.
      const before = await must(`/api/real/holdings?role=${encodeURIComponent(wallet.partyId)}`);
      console.log("   wallet before:", JSON.stringify(before.instruments || []));
      const ex = await j(`/api/swap/settlements/${setl.contractId}/execute-real`, {});
      console.log("   EXECUTE:", ex.status, JSON.stringify(ex.body).slice(0, 300));
      if (ex.status === 200) {
        await sleep(8000);
        const after = await must(`/api/real/holdings?role=${encodeURIComponent(wallet.partyId)}`);
        console.log("   wallet after :", JSON.stringify(after.instruments || []));
      }
      break;
    }
    if (r.status >= 400) { console.log("   ERROR:", String(r.body.error).slice(0, 300)); break; }
    console.log("   SETTLED:", JSON.stringify(r.body).slice(0, 400));
    break;
  }
})().catch(e => console.log("\nFAILED:", e.message));
