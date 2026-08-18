// Which vetted version of umbra-v9 does `#umbra-v9:...` actually resolve to?
//
//   node check_invite_guard.js
//
// Answering that by inspection is unreliable -- package selection happens at
// submission. So trip the guard on purpose: create an RFQ that allows dealer1 only,
// then try to invite dealer2. The rejection text tells us which choice body ran.
//   0.2.0 -> "dealer already invited"                  (message contradicts the check)
//   0.2.1 -> "dealer is not on this RFQ's invite list"

require("dotenv").config();
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://127.0.0.1:" + (process.env.PORT || 4000));
const KEYDIR = process.env.WALLET_KEY_DIR || path.join(os.homedir(), "umbra-wallet-keys");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function j(p, b) {
  const r = await fetch(API + p, { method: b ? "POST" : "GET",
    headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let o; try { o = JSON.parse(t); } catch { o = { raw: t }; }
  return { status: r.status, body: o };
}
async function must(p, b) {
  const r = await j(p, b);
  if (r.status >= 400) throw new Error(`${p} -> ${r.status} ${String(r.body.error || r.body.raw).slice(0, 300)}`);
  return r.body;
}
const sign = (h, k) => crypto.sign(null, Buffer.from(h, "base64"),
  crypto.createPrivateKey({ key: Buffer.from(k, "base64"), format: "der", type: "pkcs8" })).toString("base64");

const load = role => JSON.parse(fs.readFileSync(path.join(KEYDIR, role + ".local.json"), "utf8"));

(async () => {
  const R = load("requester"), D1 = load("dealer1"), D2 = load("dealer2");

  const h = await must(`/api/real/holdings?role=${encodeURIComponent(R.partyId)}`);
  const amu = (h.raw || []).find(x => x.id === "Amulet" && !x.lock);
  if (!amu) throw new Error("requester wallet has no Amulet to price the RFQ with");
  // SwapRfq's precondition rejects offer == want, so the two legs must differ.
  const dh = await must(`/api/real/holdings?role=${encodeURIComponent(D1.partyId)}`);
  const eth = (dh.raw || []).find(x => x.id === "cETH" && !x.lock);
  if (!eth) throw new Error("dealer1 wallet has no cETH to name as the want asset");

  // Allowlist dealer1 ONLY.
  const built = await must("/api/swap/rfq", {
    requester: R.partyId,
    offerAsset: { admin: amu.admin, symbol: "Amulet" }, offerAmount: "1",
    wantAsset: { admin: eth.admin, symbol: "cETH" },
    invited: [D1.partyId], ttlMins: 5,
  });
  const prep = await must("/api/ext/prepare", { party: R.partyId, commands: built.commands, tag: "guardrfq" });
  await must("/api/ext/execute", { party: R.partyId, commandId: prep.commandId,
    preparedTransaction: prep.preparedTransaction, hashingSchemeVersion: prep.hashingSchemeVersion,
    signature: sign(prep.preparedTransactionHash, R.privDer), signedBy: R.fingerprint });

  let rfq = null;
  for (let i = 0; i < 20 && !rfq; i++) {
    await sleep(2000);
    const o = await must(`/api/swap/rfqs?role=${encodeURIComponent(R.partyId)}`);
    rfq = (o.rfqs || o.items || []).find(x => x.payload && x.payload.requester === R.partyId &&
      (x.payload.invited || []).length === 1 && (x.payload.invited || [])[0] === D1.partyId &&
      new Date(x.payload.expiresAt).getTime() > Date.now());
    if (!rfq) process.stdout.write(".");
  }
  if (!rfq) throw new Error("guard RFQ never appeared");
  console.log("\nguard RFQ:", rfq.contractId.slice(0, 26) + "… (allows dealer1 only)");

  // Now invite dealer2, who is NOT on the list. This must fail.
  const inv = await must(`/api/swap/rfqs/${rfq.contractId}/invite`, { dealer: D2.partyId, requester: R.partyId });
  const bad = await j("/api/ext/prepare", { party: R.partyId, commands: inv.commands, tag: "guardbad" });

  const text = JSON.stringify(bad.body);
  console.log("\nHTTP", bad.status);
  const m = text.match(/AssertionFailed[^\"]*/);
  console.log("assertion:", m ? m[0].slice(0, 160) : text.slice(0, 300));

  if (/not on this RFQ's invite list/.test(text)) console.log("\n=> 0.2.1 IS LIVE (fixed message)");
  else if (/already invited/.test(text)) console.log("\n=> still running 0.2.0 (old message)");
  else console.log("\n=> inconclusive - the guard did not trip as expected");
})().catch(e => console.log("FAILED:", e.message));
