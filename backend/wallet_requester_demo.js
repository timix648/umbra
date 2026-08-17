// The mirror of wallet_trade_demo.js: here the WALLET is the REQUESTER.
//
//   node wallet_requester_demo.js --execute
//
// The wallet raises the RFQ, invites a dealer, accepts the winning quote, allocates its
// own offer leg and signs ProposeRealSwap -- every requester-side signature. Umbra's
// only signature is the operator's ExecuteRealSwap at the end, which is `controller
// operator` by design.

require("dotenv").config();
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://127.0.0.1:" + (process.env.PORT || 4000));
const KEYFILE = process.env.WALLET_KEY_FILE || path.join(os.homedir(), "umbra-wallet-key.local.json");
const WALLET_STORE = path.join(__dirname, "ext-wallets.local.txt");
const EXECUTE = process.argv.includes("--execute");
const DEALER = "dealer1";
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const OFFER = argOf("--offer", "0.0002");   // CBTC the wallet offers
const PRICE = argOf("--price", "0.004");    // cETH the dealer pays

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(p, b) {
  const r = await fetch(API + p, { method: b ? "POST" : "GET",
    headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let o; try { o = JSON.parse(t); } catch { o = { raw: t }; }
  return { status: r.status, body: o };
}
async function must(p, b) {
  const r = await j(p, b);
  if (r.status >= 400) throw new Error(`${p} -> ${r.status} ${String(r.body.error || r.body.raw).slice(0, 220)}`);
  return r.body;
}
const sign = (h, k) => crypto.sign(null, Buffer.from(h, "base64"),
  crypto.createPrivateKey({ key: Buffer.from(k, "base64"), format: "der", type: "pkcs8" })).toString("base64");

async function walletSubmit(wallet, key, commands, disclosed, tag) {
  const prep = await must("/api/ext/prepare", { party: wallet.partyId, commands,
    disclosedContracts: disclosed || [], tag: tag || "wreq" });
  return must("/api/ext/execute", { party: wallet.partyId, commandId: prep.commandId,
    preparedTransaction: prep.preparedTransaction, hashingSchemeVersion: prep.hashingSchemeVersion,
    signature: sign(prep.preparedTransactionHash, key.privDer), signedBy: wallet.fingerprint });
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
  const key = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const wallet = Object.values(JSON.parse(fs.readFileSync(WALLET_STORE, "utf8")))[0];
  console.log("API:", API, "| PACKAGE_NAME:", PKGN);
  console.log("wallet REQUESTER:", wallet.partyId.slice(0, 44) + "…");

  const wh = await must(`/api/real/holdings?role=${encodeURIComponent(wallet.partyId)}`);
  console.log("wallet holdings :", JSON.stringify(wh.instruments || []));
  const cbtc = (wh.raw || []).filter(x => x.id === "CBTC" && !x.lock && Number(x.amount) >= Number(OFFER))
    .sort((a, b) => Number(a.amount) - Number(b.amount))[0];
  if (!cbtc) throw new Error(`wallet has no unlocked CBTC >= ${OFFER}`);

  const dh = await must(`/api/real/holdings?role=${DEALER}`);
  const dceth = (dh.raw || []).find(x => x.id === "cETH" && !x.lock && Number(x.amount) >= Number(PRICE));
  if (!dceth) throw new Error(`${DEALER} has no unlocked cETH >= ${PRICE}`);
  console.log("dealer cETH admin:", dceth.admin.split("::")[0]);

  if (!EXECUTE) return console.log("\ndry run. Re-run with --execute.");

  // 1. the WALLET raises the RFQ (build -> sign)
  console.log("\n--- 1. wallet signs the RFQ create ---");
  const built = await must("/api/swap/rfq", {
    requester: wallet.partyId,
    offerAsset: { admin: cbtc.admin, symbol: "CBTC" }, offerAmount: OFFER,
    wantAsset: { admin: dceth.admin, symbol: "cETH" },
    invited: [DEALER],
  });
  if (!built.build) throw new Error("expected build mode for a wallet requester");
  await walletSubmit(wallet, key, built.commands, [], "wreqrfq");
  const rfq = await until("rfq", async () => {
    const o = await must(`/api/swap/rfqs?role=${encodeURIComponent(wallet.partyId)}`);
    const list = o.rfqs || o.items || [];
    return list.find(r => r.payload && r.payload.requester === wallet.partyId &&
      new Date(r.payload.expiresAt).getTime() > Date.now());
  });
  console.log("\nrfq:", rfq.contractId.slice(0, 24) + "…");

  // 2. the WALLET invites the dealer (build -> sign)
  console.log("\n--- 2. wallet signs InviteDealer ---");
  const inviteBuilt = await must(`/api/swap/rfqs/${rfq.contractId}/invite`,
    { dealer: DEALER, requester: wallet.partyId });
  await walletSubmit(wallet, key, inviteBuilt.commands, [], "wreqinv");
  const inv = await until("invitation", async () => {
    const o = await must(`/api/swap/invitations?role=${DEALER}`);
    return (o.invitations || []).find(i => i.payload && i.payload.rfqCid === rfq.contractId);
  });
  console.log("\ninvitation:", inv.contractId.slice(0, 24) + "…");

  // 3. the dealer is a demo party -> the server signs for it, as it legitimately can
  console.log("\n--- 3. dealer quotes (server-signed demo party) ---");
  await must(`/api/swap/invitations/${inv.contractId}/quote`, { dealer: DEALER, price: PRICE });
  const q = await until("quote", async () => {
    const o = await must(`/api/swap/quotes?role=${encodeURIComponent(wallet.partyId)}`);
    return (o.quotes || []).find(x => x.payload && x.payload.rfqCid === rfq.contractId);
  });
  console.log("\nquote:", q.contractId.slice(0, 24) + "…", "price", q.payload.price);

  // 4. the WALLET accepts (build -> sign)
  console.log("\n--- 4. wallet signs AcceptSwapQuote ---");
  // The venue can't see quotes (blind auction), so the accepting party names itself.
  const accBuilt = await must(`/api/swap/quotes/${q.contractId}/accept`, { requester: wallet.partyId });
  if (!accBuilt.build) throw new Error("expected build mode for a wallet requester accept");
  await walletSubmit(wallet, key, accBuilt.commands, [], "wreqacc");
  const prop = await until("proposal", async () => {
    const o = await must(`/api/swap/proposals?role=${encodeURIComponent(wallet.partyId)}`);
    return (o.proposals || []).find(p => p.payload && p.payload.requester === wallet.partyId);
  });
  console.log("\nproposal:", prop.contractId.slice(0, 24) + "…", "tradeId:", prop.payload.tradeId);

  // 5. settle, resuming around every requester-side signature
  console.log("\n--- 5. settle-real ---");
  for (let round = 1; round <= 5; round++) {
    const r = await j(`/api/swap/proposals/${prop.contractId}/settle-real`, {});
    console.log(`\nround ${round}: HTTP ${r.status}`);
    (r.body.steps || []).forEach(s => console.log("   -", s));
    if (r.status === 202 && r.body.awaiting) {
      const a = r.body.awaiting;
      console.log("   AWAITING:", a.step);
      if (a.step === "AllocateLeg") {
        const h = await must(`/api/real/holdings?role=${encodeURIComponent(a.party)}`);
        const pick = (h.raw || []).filter(x => x.id === a.allocate.instrument && !x.lock &&
          Number(x.amount) >= Number(a.allocate.amount))
          .sort((x, y) => Number(x.amount) - Number(y.amount))[0];
        if (!pick) throw new Error(`no unlocked ${a.allocate.instrument} >= ${a.allocate.amount}`);
        const ab = await must("/api/real/allocate?build=1", {
          build: true, senderRole: a.party, receiver: a.allocate.receiver,
          admin: a.allocate.admin, id: a.allocate.instrument, amount: a.allocate.amount,
          holdingCids: [pick.contractId], settleId: a.allocate.settlementRef,
          legId: a.legId, registry: a.allocate.registry });
        await walletSubmit(wallet, key, ab.commands, ab.disclosedContracts, "wreqalloc");
        console.log("   wallet allocated its", a.legId, "leg");
      } else {
        await walletSubmit(wallet, key, a.commands, [], "wreqsettle");
        console.log("   wallet signed", a.step);
      }
      await sleep(5000);
      continue;
    }
    if (r.status === 404 && /proposal not found/i.test(String(r.body.error || ""))) {
      // ProposeRealSwap is consuming, so the proposal is gone once the requester signs.
      // The trade now lives as a RealSwapPending awaiting the dealer's accept.
      console.log("   proposal consumed - looking for a pending swap or a settlement");
      let s = await must(`/api/swap/settlements?role=${encodeURIComponent(wallet.partyId)}`);
      let setl = (s.settlements || []).filter(x => x.payload && x.payload.requester === wallet.partyId).pop();
      if (!setl) {
        const pend = await must(`/api/swap/pending-real?role=${encodeURIComponent(wallet.partyId)}`);
        const pw = (pend.pending || []).filter(x => x.payload && x.payload.requester === wallet.partyId).pop();
        if (!pw) { console.log("   nothing pending and nothing settled"); break; }
        console.log("   pending swap:", pw.contractId.slice(0, 24) + "… - dealer accepting");
        const acc = await must(`/api/swap/pending/${pw.contractId}/accept-real`, {});
        console.log("   accepted ->", acc.settlementCid ? acc.settlementCid.slice(0, 24) + "…" : JSON.stringify(acc).slice(0, 120));
        await sleep(4000);
        s = await must(`/api/swap/settlements?role=${encodeURIComponent(wallet.partyId)}`);
        setl = (s.settlements || []).filter(x => x.payload && x.payload.requester === wallet.partyId).pop();
      }
      if (!setl) { console.log("   no settlement found"); break; }
      const before = await must(`/api/real/holdings?role=${encodeURIComponent(wallet.partyId)}`);
      console.log("   wallet before:", JSON.stringify(before.instruments || []));
      const ex = await j(`/api/swap/settlements/${setl.contractId}/execute-real`, {});
      console.log("   EXECUTE:", ex.status, JSON.stringify(ex.body).slice(0, 220));
      if (ex.status === 200) {
        await sleep(9000);
        const after = await must(`/api/real/holdings?role=${encodeURIComponent(wallet.partyId)}`);
        console.log("   wallet after :", JSON.stringify(after.instruments || []));
      }
      break;
    }
    if (r.status >= 400) { console.log("   ERROR:", String(r.body.error).slice(0, 300)); break; }
    console.log("   SETTLED:", JSON.stringify(r.body).slice(0, 300));
    break;
  }
})().catch(e => console.log("\nFAILED:", e.message));
