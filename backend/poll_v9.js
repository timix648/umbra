// Poll whether umbra-v9 is vetted yet (i.e. the LSU freeze has lifted). Run any time:
//   cd ~/umbra/backend && node poll_v9.js
// Prints READY when v9 can transact, otherwise the current blocker.
require("dotenv").config();
const { ledgerFetch } = require("./token");
const SYNC = process.env.SYNCHRONIZER_ID ||
  "global-domain::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";
(async () => {
  const store = JSON.parse(require("fs").readFileSync("./ext-parties.local.txt", "utf8"));
  const r = await ledgerFetch("/v2/interactive-submission/prepare", { method: "POST",
    body: JSON.stringify({
      userId: process.env.LEDGER_USER_ID || "6", actAs: [store.requester.partyId],
      commandId: "vet-" + Date.now(), synchronizerId: SYNC,
      packageIdSelectionPreference: [], disclosedContracts: [],
      commands: [{ CreateCommand: {
        templateId: "#umbra-v9:UmbraSwap:SwapProposal",
        createArguments: {
          requester: store.requester.partyId, operator: store.requester.partyId,
          dealer: store.dealer1.partyId,
          offerAsset: { admin: "cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff", symbol: "CBTC" },
          offerAmount: "0.10",
          wantAsset: { admin: "DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a", symbol: "Amulet" },
          price: "400.0" } } }],
    }) });
  const t = await r.text();
  if (r.status === 200) console.log(">>> READY: v9 is vetted. Run the render test now.");
  else if (t.includes("PACKAGE_SELECTION_FAILED") || t.includes("vetting") || t.includes("FREEZE"))
    console.log(">>> STILL FROZEN (LSU). Check again later. [" + new Date().toISOString() + "]");
  else console.log(">>> Different response (vetting may be done):", t.slice(0, 140));
})().catch(e => console.log("ERR", e.message));
