// Resume a settlement that stalled part-way, signing each remaining step with
// whichever wallet owns it.
//
//   node wallet_resume_demo.js                    show what the open trade is waiting on
//   node wallet_resume_demo.js --execute          drive it to completion
//
// Why this exists: settle-real is resumable by design, but the UI can only ever sign
// for the ONE party whose wallet is connected. When the next step belongs to the
// counterparty, the requester's browser stalls and the trade sits half-allocated with
// real funds locked. This drives it home from outside the browser.

require("dotenv").config();
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://127.0.0.1:" + (process.env.PORT || 4000));
const KEYDIR = process.env.WALLET_KEY_DIR || path.join(os.homedir(), "umbra-wallet-keys");
const EXECUTE = process.argv.includes("--execute");
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
for (const role of ["requester", "dealer1", "dealer2"]) {
  const f = path.join(KEYDIR, role + ".local.json");
  if (!fs.existsSync(f)) continue;
  const k = JSON.parse(fs.readFileSync(f, "utf8"));
  if (k.partyId) signers[k.partyId] = { role, ...k };
}

async function submitAs(partyId, commands, disclosed, tag) {
  const s = signers[partyId];
  if (!s) throw new Error("no wallet key for " + String(partyId).slice(0, 30) + "…");
  const prep = await must("/api/ext/prepare", { party: s.partyId, commands,
    disclosedContracts: disclosed || [], tag: tag || "wresume" });
  const out = await must("/api/ext/execute", { party: s.partyId, commandId: prep.commandId,
    preparedTransaction: prep.preparedTransaction, hashingSchemeVersion: prep.hashingSchemeVersion,
    signature: sign(prep.preparedTransactionHash, s.privDer), signedBy: s.fingerprint });
  console.log(`      signed by ${s.role} wallet`);
  return out;
}

(async () => {
  const R = Object.values(signers).find(s => s.role === "requester").partyId;
  const props = await must(`/api/swap/proposals?role=${encodeURIComponent(R)}`);
  const open = (props.proposals || []).filter(p => p.payload && p.payload.requester === R);
  if (!open.length) return console.log("no open proposal for the requester wallet");
  const prop = open[open.length - 1];
  console.log("proposal:", prop.contractId.slice(0, 26) + "…",
    prop.payload.offerAmount, prop.payload.offerAsset.symbol, "->", prop.payload.price, prop.payload.wantAsset.symbol);

  if (!EXECUTE) {
    const r = await j(`/api/swap/proposals/${prop.contractId}/settle-real`, {});
    (r.body.steps || []).forEach(s => console.log("   -", s));
    if (r.body.awaiting) {
      const a = r.body.awaiting;
      const who = signers[a.party] ? signers[a.party].role : String(a.party).slice(0, 24) + "…";
      console.log(`   AWAITING ${a.step} from ${who}`);
    }
    return console.log("\ndry run. Re-run with --execute to finish it.");
  }

  for (let round = 1; round <= 8; round++) {
    const r = await j(`/api/swap/proposals/${prop.contractId}/settle-real`, {});
    console.log(`\nround ${round}: HTTP ${r.status}`);
    (r.body.steps || []).forEach(s => console.log("   -", s));

    if (r.status === 202 && r.body.awaiting) {
      const a = r.body.awaiting;
      const who = signers[a.party] ? signers[a.party].role : String(a.party).slice(0, 24) + "…";
      console.log(`   AWAITING: ${a.step} from ${who}`);
      if (a.step === "AllocateLeg") {
        const h = await must(`/api/real/holdings?role=${encodeURIComponent(a.party)}`);
        const pick = (h.raw || []).filter(x => x.id === a.allocate.instrument && !x.lock &&
          Number(x.amount) >= Number(a.allocate.amount))
          .sort((x, y) => Number(x.amount) - Number(y.amount))[0];
        if (!pick) throw new Error(`${who} has no unlocked ${a.allocate.instrument} >= ${a.allocate.amount}`);
        const ab = await must("/api/real/allocate?build=1", {
          build: true, senderRole: a.party, receiver: a.allocate.receiver,
          admin: a.allocate.admin, id: a.allocate.instrument, amount: a.allocate.amount,
          holdingCids: [pick.contractId], settleId: a.allocate.settlementRef,
          legId: a.legId, registry: a.allocate.registry });
        await submitAs(a.party, ab.commands, ab.disclosedContracts, "wralloc");
        console.log(`   ${who} allocated the ${a.legId} leg`);
      } else {
        await submitAs(a.party, a.commands, [], "wrsettle");
      }
      await sleep(5000);
      continue;
    }

    if (r.status === 404 && /proposal not found/i.test(String(r.body.error || ""))) {
      console.log("   proposal consumed - finding the pending swap");
      let s = await must(`/api/swap/settlements?role=${encodeURIComponent(R)}`);
      let setl = (s.settlements || []).filter(x => x.payload && x.payload.requester === R).pop();
      if (!setl) {
        const pend = await must(`/api/swap/pending-real?role=${encodeURIComponent(R)}`);
        const pw = (pend.pending || []).filter(x => x.payload && x.payload.requester === R).pop();
        if (!pw) { console.log("   nothing pending and nothing settled"); break; }
        const ab = await must(`/api/swap/pending/${pw.contractId}/accept-real`, {});
        if (ab.build) await submitAs(ab.party, ab.commands, [], "wracceptreal");
        for (let i = 0; i < 20 && !setl; i++) {
          await sleep(2500);
          const o = await must(`/api/swap/settlements?role=${encodeURIComponent(R)}`);
          setl = (o.settlements || []).filter(x => x.payload && x.payload.requester === R).pop();
        }
      }
      if (!setl) { console.log("   no settlement appeared"); break; }
      const ex = await j(`/api/swap/settlements/${setl.contractId}/execute-real`, {});
      console.log("   EXECUTE:", ex.status, JSON.stringify(ex.body).slice(0, 220));
      if (ex.status === 200) {
        await sleep(9000);
        for (const s2 of Object.values(signers)) {
          const h = await must(`/api/real/holdings?role=${encodeURIComponent(s2.partyId)}`);
          console.log(`AFTER ${s2.role.padEnd(9)}:`, JSON.stringify(h.instruments || []));
        }
      }
      break;
    }
    if (r.status >= 400) { console.log("   ERROR:", String(r.body.error).slice(0, 300)); break; }
    console.log("   SETTLED:", JSON.stringify(r.body).slice(0, 240));
    break;
  }
})().catch(e => console.log("\nFAILED:", e.message));
