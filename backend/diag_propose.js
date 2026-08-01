// Diagnostic for: "timed out waiting for new UmbraSwap:RealSwapPending".
//
// The settle-real SIGNED path does prepare -> sign -> execute (async-accepted) and
// then polls for the new contract for ~14.4s. If the poll misses, we cannot tell
// WHY from the server log alone. Three candidates, and this script separates them:
//
//   (A) late commit      -> RealSwapPending EXISTS now (we gave up too early)
//   (B) silent rejection -> a completion carries a non-OK status for our submission
//   (D) filter blindness -> the contract exists under a package the #PKGN filter misses
//
// Read-only. Submits nothing. Safe to run against the live VPS at any time.
//   cd /root/umbra/backend && node diag_propose.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ledgerFetch } = require("./token");

const PKGN = process.env.PACKAGE_NAME;
const SIGNED = String(process.env.SIGNED_MODE || "false").toLowerCase() === "true";
const USER_ID = process.env.LEDGER_USER_ID || "6";
const STORE = path.join(__dirname, "ext-parties.local.txt");

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; }
}
function partyIdFor(role, store) {
  if (SIGNED && store[role] && store[role].partyId) return store[role].partyId;
  return process.env[role.toUpperCase()];
}

async function ledgerEnd() {
  const r = await ledgerFetch("/v2/state/ledger-end");
  return (await r.json()).offset;
}

function parseMaybeNdjson(text) {
  try { return JSON.parse(text); }
  catch { return text.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { _raw: l }; } }); }
}

// Same shape as server.js queryActive, but the template filter is optional so we
// can also ask "everything this party can see" (catches the package-mismatch case).
async function queryActive(party, templateModuleEntity) {
  const offset = await ledgerEnd();
  const identifierFilter = templateModuleEntity
    ? { TemplateFilter: { value: { templateId: `#${PKGN}:${templateModuleEntity}`, includeCreatedEventBlob: false } } }
    : { WildcardFilter: { value: { includeCreatedEventBlob: false } } };
  const body = {
    filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter }] } } },
    verbose: false,
    activeAtOffset: offset,
  };
  const r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 300)}`);
  const arr = [].concat(parseMaybeNdjson(text));
  return arr.map((x) => {
    const ce = x?.contractEntry?.JsActiveContract?.createdEvent || x?.activeContract?.createdEvent || x?.createdEvent;
    if (!ce) return null;
    return { contractId: ce.contractId, templateId: ce.templateId, payload: ce.createArgument || ce.createArguments };
  }).filter(Boolean);
}

(async () => {
  const store = loadStore();
  const requester = partyIdFor("requester", store);
  console.log("=== CONFIG ===");
  console.log("SIGNED_MODE :", SIGNED, "| PACKAGE_NAME:", PKGN, "| userId:", USER_ID);
  console.log("requester   :", requester);
  console.log("dealer1     :", partyIdFor("dealer1", store));
  console.log("dealer2     :", partyIdFor("dealer2", store));
  if (!requester) return console.log("\nNo requester party resolved - check .env / ext-parties.local.txt");

  // ---- (A) does a RealSwapPending exist right now? -------------------------
  console.log("\n=== (A) TEMPLATE-FILTERED ACTIVE CONTRACTS (as requester) ===");
  for (const t of ["UmbraSwap:RealSwapPending", "UmbraSwap:SwapProposal", "UmbraSwap:SwapSettlement",
                   "UmbraSwap:SwapRfq", "UmbraSwap:SwapInvitation", "UmbraSwap:SwapQuote"]) {
    try {
      const items = await queryActive(requester, t);
      console.log(`${t}: ${items.length}`);
      for (const c of items.slice(0, 6)) {
        console.log("   ", String(c.contractId).slice(0, 28) + "…", JSON.stringify(c.payload).slice(0, 200));
      }
    } catch (e) { console.log(`${t}: QUERY FAILED - ${e.message}`); }
  }

  // ---- (D) anything at all, grouped by templateId --------------------------
  console.log("\n=== (D) ALL VISIBLE CONTRACTS BY TEMPLATE (catches package mismatch) ===");
  try {
    const all = await queryActive(requester, null);
    const byT = {};
    for (const c of all) {
      const t = typeof c.templateId === "string" ? c.templateId : JSON.stringify(c.templateId);
      (byT[t] = byT[t] || []).push(c);
    }
    const keys = Object.keys(byT).sort();
    console.log("total visible:", all.length, "across", keys.length, "templates");
    for (const k of keys) console.log(`   ${byT[k].length.toString().padStart(4)}  ${k}`);
    const pend = keys.filter((k) => /RealSwapPending/.test(k));
    console.log(pend.length
      ? "\n>>> RealSwapPending FOUND under: " + pend.join(", ")
      : "\n>>> no RealSwapPending under ANY package.");
  } catch (e) { console.log("wildcard query FAILED -", e.message); }

  // ---- (B) completions: the actual fate of our submissions -----------------
  console.log("\n=== (B) RECENT COMPLETIONS (rejection reasons) ===");
  const end = await ledgerEnd();
  const begin = Math.max(0, Number(end) - 50000);
  console.log("ledgerEnd:", end, "| scanning from:", begin);
  const url = "/v2/commands/completions?limit=200&stream_idle_timeout_ms=4000";
  try {
    const r = await ledgerFetch(url, {
      method: "POST",
      body: JSON.stringify({ userId: USER_ID, parties: [requester], beginExclusive: begin }),
    });
    const text = await r.text();
    if (!r.ok) {
      console.log("completions HTTP", r.status, "-", text.slice(0, 400));
      console.log("(if 4xx, the shape differs on this build - paste this output back)");
    } else {
      const rows = [].concat(parseMaybeNdjson(text));
      console.log("completions returned:", rows.length);
      let shown = 0;
      for (const row of rows) {
        const c = row?.completionResponse?.Completion?.value || row?.Completion?.value || row?.completion || row;
        const cmdId = c?.commandId || "";
        const status = c?.status;
        const code = status?.code;
        const isErr = code !== undefined && code !== 0;
        // show every umbra submission, and loudly show anything that failed
        if (!/swap|umbra|alloc|rsub|ext/i.test(String(cmdId)) && !isErr) continue;
        if (shown++ > 60) break;
        console.log(`${isErr ? "REJECTED" : "ok      "}  ${String(cmdId).slice(0, 46).padEnd(46)}` +
                    (isErr ? `  code=${code} ${String(status?.message || "").slice(0, 220)}` : ""));
      }
      if (!shown) console.log("(no umbra-tagged completions in window - widen `begin` or check userId)");
    }
  } catch (e) { console.log("completions FAILED -", e.message); }

  console.log("\n=== HOW TO READ THIS ===");
  console.log("RealSwapPending count > 0        -> (A) late commit: the poll window is too short.");
  console.log("a REJECTED swap-propose-real row -> (B) silent rejection: read the message, that is the bug.");
  console.log("found only under another package -> (D) the #PKGN template filter is blind to it.");
  console.log("none of the above                -> the tx never sequenced; compare with seqcheck.js.");
})().catch((e) => console.log("FATAL", e && (e.stack || e.message)));
