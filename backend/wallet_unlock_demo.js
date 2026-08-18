// Unlock a wallet party's allocation after a settlement died on the counterparty.
//
//   node wallet_unlock_demo.js                 list locked holdings, write nothing
//   node wallet_unlock_demo.js --execute       withdraw every stuck allocation
//   node wallet_unlock_demo.js --execute --role dealer1
//
// A settlement that fails partway leaves the side that already allocated with its
// holding locked. The venue cannot undo that for a bring-your-own-wallet party --
// Allocation_Withdraw is the owner's choice and the venue has no key -- so the command
// is built server-side and signed here, in the wallet, the same bargain as every other
// party-authorised step.

require("dotenv").config();
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://127.0.0.1:" + (process.env.PORT || 4000));
const KEYDIR = process.env.WALLET_KEY_DIR || path.join(os.homedir(), "umbra-wallet-keys");
const EXECUTE = process.argv.includes("--execute");
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const ONLY_ROLE = argOf("--role", null);

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

(async () => {
  const roles = ONLY_ROLE ? [ONLY_ROLE] : ["requester", "dealer1", "dealer2"];
  let found = 0, freed = 0;

  for (const role of roles) {
    const k = JSON.parse(fs.readFileSync(path.join(KEYDIR, role + ".local.json"), "utf8"));
    const pid = k.partyId;
    const h = await must(`/api/real/holdings?role=${encodeURIComponent(pid)}`);
    const locked = (h.raw || []).filter(x => x.lock);
    if (!locked.length) { console.log(`${role}: nothing locked`); continue; }
    console.log(`${role}: ${locked.length} locked holding(s) -> ${locked.map(x => x.id + "=" + x.amount).join(", ")}`);
    found += locked.length;
    if (!EXECUTE) continue;

    // The lock lives on the holding, but the choice is on the ALLOCATION that took it.
    const al = await must(`/api/real/allocations?role=${encodeURIComponent(pid)}`).catch(() => ({}));
    const list = (al && (al.allocations || al.raw)) || [];
    if (!list.length) { console.log(`  no allocations visible to ${role} - cannot withdraw`); continue; }

    for (const a of list) {
      const cid = a.contractId || a.cid;
      if (!cid) continue;
      const built = await j(`/api/real/withdraw/${cid}?build=1`, { role: pid, build: true });
      if (built.status >= 400) { console.log(`  ${String(cid).slice(0, 18)}… build failed: ${String(built.body.error).slice(0, 120)}`); continue; }
      if (!built.body.build) { console.log(`  ${String(cid).slice(0, 18)}… server withdrew it directly`); freed++; continue; }
      try {
        const prep = await must("/api/ext/prepare", { party: pid, commands: built.body.commands,
          disclosedContracts: built.body.disclosedContracts || [], tag: "unlock" });
        await must("/api/ext/execute", { party: pid, commandId: prep.commandId,
          preparedTransaction: prep.preparedTransaction, hashingSchemeVersion: prep.hashingSchemeVersion,
          signature: sign(prep.preparedTransactionHash, k.privDer), signedBy: k.fingerprint });
        console.log(`  withdrew ${String(cid).slice(0, 18)}… (${built.body.amount} ${built.body.instrument}) - signed in the wallet`);
        freed++;
      } catch (e) {
        console.log(`  ${String(cid).slice(0, 18)}… withdraw failed: ${String(e.message).slice(0, 160)}`);
      }
      await sleep(2500);
    }
  }

  if (!EXECUTE) return console.log(`\n${found} locked holding(s). Re-run with --execute to withdraw.`);

  await sleep(6000);
  console.log("\n--- after ---");
  for (const role of roles) {
    const k = JSON.parse(fs.readFileSync(path.join(KEYDIR, role + ".local.json"), "utf8"));
    const h = await must(`/api/real/holdings?role=${encodeURIComponent(k.partyId)}`);
    const locked = (h.raw || []).filter(x => x.lock).map(x => x.id + "=" + x.amount);
    console.log(`${role}: ${locked.length ? "STILL LOCKED " + locked.join(", ") : "clear"}`);
  }
  console.log(`\nwithdrew ${freed} allocation(s)`);
})().catch(e => console.log("FAILED:", e.message));
