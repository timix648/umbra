// WSL2 has no IPv6 route, but DNS returns AAAA records for coingecko and the
// 5North auth host. Node >=17 resolves `verbatim` -- it tries IPv6 FIRST and
// hangs until timeout. curl survives via Happy Eyeballs; Node does not. This
// produced a full day of phantom "outages": ETIMEDOUT, 405, "fetch failed",
// against hosts that were provably up. Must run before any socket opens.
require("dns").setDefaultResultOrder("ipv4first");

// Verbose settlement debugging ([CTXDBG] context/disclosure dumps). Off by default so a
// demo run has a clean console; re-enable with  UMBRA_DEBUG=1 node server.js
// Real failures ([settle-real] FAILED/WARN) are NOT gated -- they only fire on error.
const UMBRA_DEBUG = /^(1|true|yes)$/i.test(String(process.env.UMBRA_DEBUG || ""));
function dbg(...args) { if (UMBRA_DEBUG) console.error(...args); }

const express = require("express");
const { ledgerFetch } = require("./token");
const __tok = require("./token");
async function getLedgerToken() {
  if (typeof __tok.getToken === "function") return __tok.getToken();
  if (typeof __tok.token === "function") return __tok.token();
  const b = new URLSearchParams({ grant_type: "client_credentials",
    client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET,
    audience: process.env.AUDIENCE, scope: process.env.SCOPE || "daml_ledger_api" });
  const r = await fetch(process.env.AUTH_URL, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: b });
  return (await r.json()).access_token;
}
function isScanProxy(url) { return /\/scan-proxy(\/|$)/.test(url || ""); }
function regPath(registryUrl, registrar, rest) {
  if (isScanProxy(registryUrl)) return registryUrl.replace(/\/$/, "") + "/registry/" + rest;
  return registryUrl + "/api/token-standard/v0/registrars/" +
    encodeURIComponent(registrar) + "/registry/" + rest;
}
async function regFetch(registryUrl, url, opts) {
  if (isScanProxy(registryUrl)) {
    const tok = await getLedgerToken();
    const h = Object.assign({ "Authorization": "Bearer " + tok }, (opts && opts.headers) || {});
    return fetch(url, Object.assign({}, opts, { headers: h }));
  }
  return fetch(url, opts);
}
const { onboardExternalParty, prepareSignExecute, prepareSignExecuteMulti,
        prepareInteractive, executeSigned,
        onboardWalletPrepare, onboardWalletConfirm, loadWallets } = require("./external");
require("dotenv").config();

const app = express();
app.use(express.json());

// ---- humanize(): turn raw ledger error strings into clean user-facing text ----
// Daml aborts and ledger rejections arrive as "400 {...insufficient cash...}" or
// similar. The catch blocks below all return e.message verbatim, so cleaning the
// message HERE (at the two raw-ledger throw sites) makes every endpoint inherit
// friendly text without touching each catch block. Unmatched errors fall through
// to a trimmed version of the raw string rather than a misleading guess.
function humanize(raw) {
  const m = String(raw || "");
  const has = (...needles) => needles.some(n => m.toLowerCase().includes(n.toLowerCase()));
  if (has("insufficient cash", "enough cash", "requester is not the owner of that cash"))
    return "You don't have enough USD to settle this trade.";
  if (has("currency mismatch"))
    return "Currency mismatch between the quote and your cash.";
  if (has("instrument mismatch"))
    return "The instrument in this quote doesn't match the holding provided.";
  if (has("not visible", "not active", "already archived", "contract not found"))
    return "This quote is no longer available \u2014 it may have been settled or withdrawn.";
  if (has("expired", "expiresAt"))
    return "This RFQ has expired.";
  // Fallback: strip a leading "NNN " HTTP-status prefix and any JSON envelope noise.
  const stripped = m.replace(/^\d{3}\s+/, "").trim();
  return stripped.length ? stripped : "The ledger rejected this request.";
}

const path = require("path");
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
// serve landing at "/" and the terminal at "/app"
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "landing.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

const PKG = process.env.PACKAGE_ID;
const PKGN = process.env.PACKAGE_NAME;

// ---- VENUE FEE --------------------------------------------------------------
// A few bps of the winning quote, borne by the WINNING DEALER and paid in the WANT
// asset. That is how institutional RFQ venues charge -- MarketAxess, Tradeweb and
// Bloomberg bill the liquidity providers rather than the buy-side -- and for a
// concrete reason: the buyer's alternative is a bilateral chat that costs no venue
// fee at all, so an explicit charge on the taker sends the flow straight back to it.
//
// The floor is a per-asset CONSTANT, deliberately not a USD conversion. `refMid`
// exists and is already recorded on-ledger, but the OPERATOR supplies it and the
// operator collects the fee -- letting that number set the charge would be marking
// our own homework, and it would drag a price oracle inside an atomic settlement.
// Constants are auditable and need no oracle.
//
// With no UMBRA_FEE_PARTY set the venue runs fee-free, which is what every build
// before 0.3.0 did.
const FEE_PARTY = process.env.UMBRA_FEE_PARTY || "";
const FEE_BPS = Number(process.env.UMBRA_FEE_BPS || 5);
const FEE_FLOORS = {                      // ~$25 at August 2026 marks
  cETH:   Number(process.env.UMBRA_FEE_FLOOR_CETH || 0.0132),
  cBTC:   Number(process.env.UMBRA_FEE_FLOOR_CBTC || 0.0004),
  CBTC:   Number(process.env.UMBRA_FEE_FLOOR_CBTC || 0.0004),
  CC:     Number(process.env.UMBRA_FEE_FLOOR_CC || 272),
  Amulet: Number(process.env.UMBRA_FEE_FLOOR_CC || 272),
};
const dec10 = n => Number(n).toFixed(10);

// fee = max(floor, bps x price), in the want asset. Returns null when no fee applies.
function feeFor(wantSymbol, price) {
  if (!FEE_PARTY) return null;
  const px = Number(price);
  if (!isFinite(px) || px <= 0) return null;
  const amt = Math.max(px * (FEE_BPS / 10000), FEE_FLOORS[wantSymbol] || 0);
  return amt > 0 ? dec10(amt) : null;
}

// Operator-controlled parties (demo mode). The backend holds CanActAs on these.
const PARTIES = {
  requester: process.env.REQUESTER,
  dealer1: process.env.DEALER1,
  dealer2: process.env.DEALER2,
  public: process.env.OBSERVER,
};

// ---------------------------------------------------------------------------
// SIGNED MODE  -- the "trust no operator" path.
// When on, the three trading roles are EXTERNAL parties that sign their own
// choices via prepare->sign->execute. The operator can read (display) but
// cannot forge. `public` (Observer) stays operator-namespaced in both modes:
// it is a read-only outsider that is never a stakeholder, so it sees nothing.
// ---------------------------------------------------------------------------
let SIGNED_MODE = String(process.env.SIGNED_MODE || "false").toLowerCase() === "true";
const SIGNING_ROLES = ["requester", "dealer1", "dealer2"];
const roleRec = {}; // role -> { partyId, fingerprint, privDer } (in-memory cache)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Onboard-or-load the external keypair for a signing role (cached + persisted).
async function recFor(role) {
  const r = String(role || "").toLowerCase();
  if (roleRec[r]) return roleRec[r];
  const rec = await onboardExternalParty(r);
  roleRec[r] = rec;
  return rec;
}

// Is this party one that onboarded with its own wallet? Those have no key here, so
// anything that would sign on their behalf must refuse rather than fail obscurely.
function isWalletParty(pid) {
  if (!pid || !String(pid).includes("::")) return false;
  try { return !!loadWallets()[pid]; } catch { return false; }
}

// Resolve a role name to the party id that is ACTIVE for the current mode.
// A wallet party is addressed by its full party id, which passes through unchanged --
// it has no short role name because it isn't one of ours.
async function partyIdFor(role) {
  const raw = String(role || "");
  if (raw.includes("::")) return raw;                  // already a party id (incl. wallets)
  const r = raw.toLowerCase();
  if (r === "public") return PARTIES.public;
  if (SIGNED_MODE && SIGNING_ROLES.includes(r)) return (await recFor(r)).partyId;
  const p = PARTIES[r];
  if (!p) throw new Error(`unknown role '${role}'. use requester|dealer1|dealer2|public, or a full party id`);
  return p;
}

// Reverse lookup: given a party id, which role is it (in the current mode)?
async function roleOfParty(pid) {
  for (const r of SIGNING_ROLES) if ((await partyIdFor(r)) === pid) return r;
  if (isWalletParty(pid)) return pid;   // its own id IS its handle; partyIdFor passes it through
  return null;
}

// THE branch point. Same command set, two authorities:
//  - signed mode  -> the party signs it with its own key (operator can't forge)
//  - demo mode    -> operator submits via CanActAs (submit-and-wait)
async function act(role, tag, commands) {
  const r = String(role || "").toLowerCase();
  // Refuse loudly rather than fail somewhere deeper: we cannot sign for a party whose
  // key we deliberately do not have. The caller must route this through the wallet.
  if (isWalletParty(String(role || ""))) {
    throw new Error(`no signing key for wallet party ${String(role).slice(0, 28)}… - ` +
      `build the commands and have the wallet sign them via /api/ext/prepare + /api/ext/execute`);
  }
  if (SIGNED_MODE && SIGNING_ROLES.includes(r)) {
    const rec = await recFor(r);
    return prepareSignExecute(rec, commands, tag); // async-accepted ({} on success)
  }
  return submit(tag, PARTIES[r], commands); // synchronous commit
}


// Real-token submit, routed by mode. Body shape: {commandId, actAs, commands,
// disclosedContracts}. DEMO: operator submit-and-wait. SIGNED: each actAs party
// signs its own leg with its key (operator signs nothing); disclosures forwarded.
async function realSubmit(body, tag) {
  if (SIGNED_MODE) {
    const recs = [];
    for (const pid of (body.actAs || [])) {
      // Same guard as act(): we have no key for a wallet party. Without this,
      // roleOfParty returns the party id, recFor treats it as a role name and
      // onboardExternalParty tries to ALLOCATE A NEW PARTY using it as a partyHint --
      // which fails deep inside topology with "reserved delimiter `::`".
      if (isWalletParty(pid)) {
        throw new Error(`no signing key for wallet party ${String(pid).slice(0, 28)}… - ` +
          `build the command with build=1 and have the wallet sign it via /api/ext/prepare`);
      }
      const role = await roleOfParty(pid);
      if (!role) throw new Error("signed mode: no external signer for party " + pid);
      recs.push(await recFor(role));
    }
    if (!recs.length) throw new Error("signed mode: no signers resolved for real submit");
    // Return the execute result so callers can look the submission up in
    // /v2/commands/completions -- otherwise an async-accepted allocation that was
    // actually REJECTED looks identical to one that just committed slowly, and the
    // retry loop re-submits it (producing LOCAL_VERDICT_INACTIVE_CONTRACTS).
    return await prepareSignExecuteMulti(recs, body.commands, tag || "rsub", body.disclosedContracts || []);
  }
  const r = await ledgerFetch("/v2/commands/submit-and-wait", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(humanize(`${r.status} ${text}`));
}

app.get("/health", (req, res) => res.json({ ok: true }));

// --- helper: read the current ledger end (needed as the query offset) ---
async function ledgerEnd() {
  const r = await ledgerFetch("/v2/state/ledger-end");
  const d = await r.json();
  return d.offset;
}

// --- helper: query active contracts of one template, AS a given party ---
async function queryActive(party, templateModuleEntity) {
  const offset = await ledgerEnd();
  const body = {
    filter: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: `#${PKGN}:${templateModuleEntity}`,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    },
    verbose: false,
    activeAtOffset: offset,
  };
  const r = await ledgerFetch("/v2/state/active-contracts", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(humanize(`${r.status} ${text}`));
  let items;
  try {
    items = JSON.parse(text);
  } catch {
    items = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  const arr = Array.isArray(items) ? items : [items];
  return arr
    .map((x) => {
      const ce =
        x?.contractEntry?.JsActiveContract?.createdEvent ||
        x?.activeContract?.createdEvent ||
        x?.createdEvent;
      if (!ce) return null;
      return { contractId: ce.contractId, payload: ce.createArgument || ce.createArguments };
    })
    .filter(Boolean);
}

// --- helper: poll until a NEW contract id (not in `beforeSet`) appears.
// In demo mode submit-and-wait commits synchronously so this hits on try 0;
// in signed mode execute is async-accepted, so we wait for the commit. ---
// After a successful settle, archive the RFQ, its invitations, and any leftover
// quotes for that rfqId so the board reflects "this trade is done" (best-effort;
// in signed mode external-party quotes can't be archived by the operator).
async function cleanupRfq(rfqId) {
  if (!rfqId) return;
  const requester = await partyIdFor("requester");
  for (const tmpl of ["Umbra:Quote", "Umbra:RfqInvitation", "Umbra:Rfq"]) {
    let items = [];
    try { items = await queryActive(requester, tmpl); } catch { continue; }
    for (const c of items) {
      if (!c.payload || c.payload.rfqId !== rfqId) continue;
      const actAs = (tmpl === "Umbra:Quote" && c.payload.dealer) ? [requester, c.payload.dealer] : [requester];
      try {
        await ledgerFetch("/v2/commands/submit-and-wait", { method: "POST", body: JSON.stringify({
          commandId: `cleanup-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
          actAs,
          commands: [{ ExerciseCommand: { templateId: `#${PKGN}:${tmpl}`, contractId: c.contractId, choice: "Archive", choiceArgument: {} } }]
        }) });
      } catch (e) { /* best-effort */ }
    }
  }
}

// 20 x 1200ms = 24s. Was 12 (14.4s), which is where the RealSwapPending timeouts
// came from: the proposes DID commit, just after we stopped looking. cBTC settles
// comfortably inside the old window and two cETH swaps did too, so the shortfall is
// small -- this widens it without changing anything else. Raise POLL_TRIES if a
// commit ever needs longer; nothing here fails faster because of it.
const POLL_TRIES = Number(process.env.POLL_TRIES || 20);
const POLL_TRIES_COMMITTED = Number(process.env.POLL_TRIES_COMMITTED || 30); // post-verdict
const ALLOC_POLL_TRIES = Number(process.env.ALLOC_POLL_TRIES || 12); // 12 x 400ms = 4.8s, unchanged
const COMPLETION_TIMEOUT_MS = Number(process.env.COMPLETION_TIMEOUT_MS || 60000);
// Allocations commit fast when they commit at all, so they get a much smaller
// budget: a leg that has not reached a verdict in this long is not worth blocking
// a live settlement for -- fall back to polling instead of stalling both legs.
const ALLOC_COMPLETION_TIMEOUT_MS = Number(process.env.ALLOC_COMPLETION_TIMEOUT_MS || 20000);
// OFF BY DEFAULT, opt in with UMBRA_COMPLETIONS=1 (same fail-safe shape as the
// DISCLOSE_INPUT_HOLDING probe). While off, awaitCompletion() reports "no verdict"
// and every caller runs its original contract-polling path, so the working cBTC
// settlement path is byte-identical to before. Turn it on to get real rejection
// reasons instead of a bare timeout -- ideally on a run you expect to fail.
const COMPLETIONS_ENABLED = /^(1|true|yes)$/i.test(String(process.env.UMBRA_COMPLETIONS || ""));
const LEDGER_USER_ID = process.env.LEDGER_USER_ID || "6";

async function pollNewCid(party, templateModuleEntity, beforeSet, tries = POLL_TRIES) {
  // Time to CONTRACT VISIBILITY, which is a different quantity from time to commit:
  // a completion can land before the active-contracts index catches up. The window
  // that kept expiring is this one, so this is the number to size it against.
  const t0 = Date.now();
  for (let i = 0; i < tries; i++) {
    const ids = (await queryActive(party, templateModuleEntity)).map((c) => c.contractId);
    const fresh = ids.find((id) => !beforeSet.has(id));
    if (fresh) {
      console.log(`[poll] ${templateModuleEntity} visible after ${Date.now() - t0}ms ` +
                  `(try ${i + 1}/${tries})`);
      return fresh;
    }
    await sleep(1200);
  }
  throw new Error(`timed out waiting for new ${templateModuleEntity} for ` +
                  `${party.slice(0, 24)}… after ${Date.now() - t0}ms (${tries} tries)`);
}

// ---------------------------------------------------------------------------
// COMMAND COMPLETIONS -- the ledger's actual verdict on a submission.
//
// In SIGNED mode execute is async-accepted: HTTP 200 means "admitted for
// processing", NOT "committed". This codebase used to infer the outcome purely
// from whether a contract showed up within a fixed poll window, which cannot
// distinguish these three cases:
//     committed slowly | rejected outright | never sequenced
// They were all reported as "timed out waiting for new X". Reading completions
// tells them apart, and surfaces the rejection REASON instead of discarding it.
// ---------------------------------------------------------------------------
async function readCompletions(party, beginExclusive, idleMs = 3000) {
  const r = await ledgerFetch(
    `/v2/commands/completions?limit=200&stream_idle_timeout_ms=${idleMs}`,
    { method: "POST", body: JSON.stringify({
        userId: LEDGER_USER_ID, parties: [party], beginExclusive }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 200)}`);
  let rows;
  try { rows = JSON.parse(text); }
  catch {
    rows = text.trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  return [].concat(rows);
}

// Shape varies across Canton builds; unwrap defensively.
function completionOf(row) {
  return (row && row.completionResponse && row.completionResponse.Completion &&
          row.completionResponse.Completion.value) ||
         (row && row.Completion && row.Completion.value) ||
         (row && row.completion) || row;
}

// Wait for `commandId` to reach a verdict. Returns:
//   { found:true,  ok:true  }            committed
//   { found:true,  ok:false, message }   rejected, with the ledger's reason
//   { found:false }                      unreadable/timed out -> caller falls back
// Never throws: if completions are unavailable the caller must still work.
async function awaitCompletion(party, commandId, beginExclusive, timeoutMs = COMPLETION_TIMEOUT_MS) {
  if (!commandId || !COMPLETIONS_ENABLED) return { found: false };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let rows;
    try { rows = await readCompletions(party, beginExclusive); }
    catch (e) {
      console.log("[completion] unreadable (falling back to polling):", e.message);
      return { found: false, error: e.message };
    }
    for (const row of rows) {
      const c = completionOf(row);
      if (!c || c.commandId !== commandId) continue;
      const code = c.status && c.status.code;
      const ok = code === undefined || code === 0;
      return { found: true, ok, code,
               message: (c.status && c.status.message) || "" };
    }
    await sleep(800);
  }
  return { found: false, timedOut: true };
}

// Turn an async-accepted submission into a definite answer.
//   true  -> committed (caller may poll for the contract with confidence)
//   false -> no verdict readable (caller falls back to its old best-effort poll)
//   throw -> the ledger REJECTED it, carrying the real reason
async function confirmCommitted(party, execRes, beginExclusive, what) {
  const commandId = execRes && execRes.commandId;
  if (!commandId) return false;                 // demo mode: already synchronous
  // Time it. Every window in this file (14.4s, 24s, 4.8s) has been a guess because
  // nobody ever measured how long a commit actually takes. Log it and stop guessing.
  const t0 = Date.now();
  const v = await awaitCompletion(party, commandId, beginExclusive);
  const ms = Date.now() - t0;
  if (v.found && !v.ok) {
    throw new Error(humanize(`${what} rejected by the ledger after ${ms}ms: ${v.message || "code " + v.code}`));
  }
  if (v.found) { console.log(`[completion] ${what} COMMITTED after ${ms}ms (${commandId})`); return true; }
  // Distinguish "switched off" from "asked and got no answer" -- the first is normal
  // and says nothing; only the second is evidence about the ledger.
  if (!COMPLETIONS_ENABLED) { dbg(`[completion] disabled; skipping verdict for ${what}`); return false; }
  console.log(`[completion] NO VERDICT for ${what} (${commandId}) within ` +
              `${COMPLETION_TIMEOUT_MS}ms - falling back to contract polling`);
  return false;
}

// ---- existing operator submit (demo-mode path, synchronous commit) ----
async function submit(commandId, actAsParty, commands) {
  const body = { commandId: `${commandId}-${Date.now()}`, actAs: [actAsParty], commands };
  const r = await ledgerFetch("/v2/commands/submit-and-wait", {
    method: "POST", body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(humanize(`${r.status} ${text}`));
  return JSON.parse(text);
}

// ===========================================================================
// MODE TOGGLE  -- the showmanship. Flip live, side-by-side, on stage.
// ===========================================================================
// Submit a command that needs MORE THAN ONE party's authority.
// SIGNED: every external party signs with its own key (operator signs nothing).
// DEMO:   the operator actAs all of them (it holds CanActAs on the demo parties).
async function actMulti(roles, tag, commands) {
  const rs = [...new Set(roles.map((r) => String(r || "").toLowerCase()))];
  if (SIGNED_MODE && rs.every((r) => SIGNING_ROLES.includes(r))) {
    const recs = [];
    for (const r of rs) recs.push(await recFor(r));
    return prepareSignExecuteMulti(recs, commands, tag);
  }
  const actAs = [];
  for (const r of rs) actAs.push(await partyIdFor(r));
  const body = { commandId: `${tag}-${Date.now()}`, actAs, commands };
  const resp = await ledgerFetch("/v2/commands/submit-and-wait", {
    method: "POST", body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(humanize(`${resp.status} ${text}`));
  return JSON.parse(text);
}

async function activePartyMap() {
  const out = { public: PARTIES.public };
  for (const r of SIGNING_ROLES) out[r] = await partyIdFor(r).catch(() => null);
  return out;
}

app.get("/api/mode", async (req, res) => {
  // The fee schedule ships with mode because the UI polls this anyway, and a dealer
  // must be able to price its quote INCLUSIVE of the fee before committing to it.
  // Quoting blind and discovering the charge at settlement is not a fee schedule,
  // it is a surprise.
  res.json({
    signedMode: SIGNED_MODE,
    parties: await activePartyMap(),
    fee: FEE_PARTY ? { bps: FEE_BPS, floors: FEE_FLOORS, party: FEE_PARTY } : null,
  });
});

// ---- PACKAGE DISCOVERY ------------------------------------------------------
// What a validator operator needs in order to let their users trade here.
//
// Umbra is bring-your-own-wallet AND bring-your-own-validator: the user's key stays
// in their wallet and their party stays on their own participant. The one thing that
// participant needs is Umbra's Daml package vetted, because Canton requires every
// participant informed about a transaction to have vetted its package. That is not a
// permission Umbra grants — it is a package the operator installs.
// 0.2.0 is still served alongside this and remains valid; 0.2.1 is what an operator
// should vet, and both being vetted is fine -- same package name, so `#umbra-v9:...`
// resolves either and contracts created under 0.2.0 stay usable.
const UMBRA_DAR = {
  name: "umbra-v9",
  version: "0.3.0",
  // The package id to check for once uploaded, and to pin in packageIdSelectionPreference.
  packageId: "2831ba0bbad750ebe3bfba3b881015523d722e80ba2d208ceb522a91c490bd88",
  sha256: "8af967257acc61fbc0ec68dcae6beac0d4b254e713f8136353734537a8b07ebd",
  dar: "/dar/umbra-v9-0.3.0.dar",
};

app.get("/api/package", async (req, res) => {
  try {
    const base = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const darFile = UMBRA_DAR.dar.split("/").pop();   // derived, so a version bump can't leave stale filenames here
    let vettedHere = null;
    try {
      const r = await ledgerFetch("/v2/packages");
      const j = await r.json();
      const ids = (j && (j.packageIds || j.package_ids || j)) || [];
      vettedHere = Array.isArray(ids) ? ids.includes(UMBRA_DAR.packageId) : null;
    } catch (e) { /* discovery must not depend on the ledger being reachable */ }
    res.json({
      ok: true,
      ...UMBRA_DAR,
      downloadUrl: base + UMBRA_DAR.dar,
      vettedOnUmbraParticipant: vettedHere,
      instructions: [
        "1. Download the DAR: curl -O " + base + UMBRA_DAR.dar,
        "2. Verify: sha256sum " + darFile + "  ->  " + UMBRA_DAR.sha256,
        "3. Upload+vet on YOUR validator's participant:",
        "     curl -X POST $LEDGER_API/v2/packages -H \"Authorization: Bearer $TOKEN\" " +
          "-H 'Content-Type: application/octet-stream' --data-binary @" + darFile,
        "   (or: daml ledger upload-dar --host <participant> --port <port> " + darFile + ")",
        "4. Confirm " + UMBRA_DAR.packageId.slice(0, 16) + "… appears in GET /v2/packages",
        "5. Connect your wallet at Umbra. Your key never leaves it; your party stays on your participant.",
      ],
      why: "Canton requires every participant informed about a transaction to have vetted " +
           "its package. Umbra cannot vet on your behalf, and does not need to: you keep " +
           "custody of the key and hosting of the party.",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- DEALER DIRECTORY -------------------------------------------------------
// Who a requester can invite. Discovery only: this list confers NOTHING. Umbra
// curates at the protocol level instead -- InviteDealer means a requester names
// its own counterparties, and a dealer that was never invited cannot see, let
// alone price, the block. So there is no reputation and no KYC here; those are
// mainnet questions about who may trade, not about who exists.
//
// `?role=` excludes the caller: a party inviting itself would be quoting its own
// block, and the ledger would reject the swap at settlement anyway.
app.get("/api/dealers", async (req, res) => {
  try {
    const me = req.query.role ? await partyIdFor(req.query.role).catch(() => null) : null;
    const out = [];
    for (const r of ["dealer1", "dealer2"]) {
      const pid = await partyIdFor(r).catch(() => null);
      if (pid) out.push({ id: r, partyId: pid, name: r === "dealer1" ? "Dealer 1" : "Dealer 2",
        kind: "venue", custody: "operator" });
    }
    for (const w of Object.values(loadWallets())) {
      out.push({ id: w.partyId, partyId: w.partyId, name: String(w.partyId).split("::")[0],
        kind: "wallet", custody: "self" });
    }
    res.json({ ok: true, dealers: out.filter(d => d.partyId !== me) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// body: { signed: true|false }. Turning ON pre-onboards the 3 roles so the
// first signed trade isn't slow.
app.post("/api/mode", async (req, res) => {
  try {
    SIGNED_MODE = req.body.signed === true || String(req.body.signed).toLowerCase() === "true";
    if (SIGNED_MODE) for (const r of SIGNING_ROLES) await recFor(r);
    res.json({ ok: true, signedMode: SIGNED_MODE, parties: await activePartyMap() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Handy for the UI: which identities are live right now.
app.get("/api/parties", async (req, res) => {
  try {
    res.json({ ok: true, signedMode: SIGNED_MODE, parties: await activePartyMap() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- create an RFQ as the requester ---
app.post("/api/rfqs", async (req, res) => {
  try {
    const { rfqId, instrument, quantity, currency, expiresAt } = req.body;
    const requester = await partyIdFor("requester");
    const commands = [
      {
        CreateCommand: {
          templateId: `#${PKGN}:Umbra:Rfq`,
          createArguments: {
            requester,
            rfqId, instrument, quantity: String(quantity),
            side: "Buy", currency, expiresAt,
          },
        },
      },
    ];
    const result = await act("requester", "rfq", commands);
    res.json({ ok: true, signed: SIGNED_MODE, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- list active RFQs as the requester (gives us contract IDs) ---
app.get("/api/rfqs", async (req, res) => {
  try {
    const rfqs = await queryActive(await partyIdFor("requester"), "Umbra:Rfq");
    res.json({ ok: true, count: rfqs.length, rfqs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- list quotes, scoped to whichever role asks (this is P1 in action) ---
app.get("/api/quotes", async (req, res) => {
  try {
    const role = req.query.role || "requester";
    const quotes = await queryActive(await partyIdFor(role), "Umbra:Quote");
    res.json({ ok: true, role, count: quotes.length, quotes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- invite a dealer to an RFQ (exercise Invite as the requester) ---
app.post("/api/rfqs/:cid/invite", async (req, res) => {
  try {
    const cid = req.params.cid;
    const dealer = await partyIdFor(req.body.dealer);
    const commands = [
      {
        ExerciseCommand: {
          templateId: `#${PKGN}:Umbra:Rfq`,
          contractId: cid,
          choice: "Invite",
          choiceArgument: { dealer },
        },
      },
    ];
    const result = await act("requester", "invite", commands);
    res.json({ ok: true, signed: SIGNED_MODE, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- list a dealer's invitations (scoped to that dealer) ---
app.get("/api/invitations", async (req, res) => {
  try {
    const role = req.query.role || "dealer1";
    const invs = await queryActive(await partyIdFor(role), "Umbra:RfqInvitation");
    res.json({ ok: true, role, count: invs.length, invitations: invs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- submit a quote (exercise SubmitQuote as the dealer) ---
app.post("/api/invitations/:cid/quote", async (req, res) => {
  try {
    const cid = req.params.cid;
    const dealerRole = String(req.body.dealer || "").toLowerCase();
    await partyIdFor(dealerRole); // validates role
    const commands = [
      {
        ExerciseCommand: {
          templateId: `#${PKGN}:Umbra:RfqInvitation`,
          contractId: cid,
          choice: "SubmitQuote",
          choiceArgument: { price: String(req.body.price) },
        },
      },
    ];
    const result = await act(dealerRole, "quote", commands);
    res.json({ ok: true, signed: SIGNED_MODE, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- fund the requester with cash (creates a CashHolding) ---
app.post("/api/fund/cash", async (req, res) => {
  try {
    const { currency = "USD", amount } = req.body;
    const requester = await partyIdFor("requester");
    const issuer = req.body.issuer || requester; // self-issued placeholder cash
    const result = await act("requester", "fund-cash", [
      {
        CreateCommand: {
          templateId: `#${PKGN}:Umbra:CashHolding`,
          createArguments: { owner: requester, issuer, currency, amount: String(amount) },
        },
      },
    ]);
    res.json({ ok: true, signed: SIGNED_MODE, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- fund a dealer with an instrument (creates an InstrumentHolding) ---
app.post("/api/fund/instrument", async (req, res) => {
  try {
    const dealerRole = String(req.body.dealer || "").toLowerCase();
    const dealer = await partyIdFor(dealerRole);
    const { instrument = "UST-2030", quantity } = req.body;
    const registry = req.body.registry || dealer; // self-registered placeholder
    const result = await act(dealerRole, "fund-inst", [
      {
        CreateCommand: {
          templateId: `#${PKGN}:Umbra:InstrumentHolding`,
          createArguments: { owner: dealer, registry, instrument, quantity: String(quantity) },
        },
      },
    ]);
    res.json({ ok: true, signed: SIGNED_MODE, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- list a party's holdings (cash + instruments) ---
app.get("/api/holdings", async (req, res) => {
  try {
    const role = req.query.role || "requester";
    const party = await partyIdFor(role);
    const cash = await queryActive(party, "Umbra:CashHolding");
    const inst = await queryActive(party, "Umbra:InstrumentHolding");
    res.json({ ok: true, role, cash, instruments: inst });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STEP 1: requester accepts a quote (locks cash, makes SettlementInstruction) ---
app.post("/api/quotes/:cid/accept", async (req, res) => {
  try {
    const cid = req.params.cid;
    const { requesterCashCid } = req.body;
    const result = await act("requester", "accept", [
      {
        ExerciseCommand: {
          templateId: `#${PKGN}:Umbra:Quote`,
          contractId: cid,
          choice: "AcceptQuote",
          choiceArgument: { requesterCashCid },
        },
      },
    ]);
    res.json({ ok: true, signed: SIGNED_MODE, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- list settlement instructions (scoped) ---
app.get("/api/settlements", async (req, res) => {
  try {
    const role = req.query.role || "requester";
    const si = await queryActive(await partyIdFor(role), "Umbra:SettlementInstruction");
    res.json({ ok: true, role, count: si.length, settlements: si });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STEP 2: dealer settles (delivers instrument, atomic DvP) ---
app.post("/api/settlements/:cid/settle", async (req, res) => {
  try {
    const cid = req.params.cid;
    const dealerRole = String(req.body.dealer || "").toLowerCase();
    await partyIdFor(dealerRole);
    const { dealerInstrumentCid } = req.body;
    const result = await act(dealerRole, "settle", [
      {
        ExerciseCommand: {
          templateId: `#${PKGN}:Umbra:SettlementInstruction`,
          contractId: cid,
          choice: "Settle",
          choiceArgument: { dealerInstrumentCid },
        },
      },
    ]);
    res.json({ ok: true, signed: SIGNED_MODE, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- live ledger offset (terminal ticker) ---
app.get("/api/ledger-end", async (req, res) => {
  try {
    const r = await ledgerFetch("/v2/state/ledger-end");
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- one-click award + settle: full P2 flow. Works in BOTH modes.
// In signed mode every step is signed by the controlling party and we poll
// for each async commit before chaining the next step. body: { quoteCid } ---
app.post("/api/award", async (req, res) => {
  try {
    const { quoteCid } = req.body;
    const requester = await partyIdFor("requester");
    const quotes = await queryActive(requester, "Umbra:Quote");
    const q = quotes.find((x) => x.contractId === quoteCid);
    if (!q) throw new Error("quote not found or not visible to requester");
    const { dealer: dealerParty, quantity, price, instrument } = q.payload;
    const dealerRole = await roleOfParty(dealerParty);
    if (!dealerRole) throw new Error("could not map quote's dealer party to a role");
    const dealer = await partyIdFor(dealerRole);
    const totalCost = Math.round(Number(price) * Number(quantity) * 1e6) / 1e6;
    const steps = [];
    const idSet = async (party, tmpl) =>
      new Set((await queryActive(party, tmpl)).map((c) => c.contractId));

    const cashBefore = await idSet(requester, "Umbra:CashHolding");
    await act("requester", "award-cash", [{
      CreateCommand: { templateId: `#${PKGN}:Umbra:CashHolding`,
        createArguments: { owner: requester, issuer: requester, currency: "USD", amount: String(totalCost) } } }]);
    const cashCid = await pollNewCid(requester, "Umbra:CashHolding", cashBefore);
    steps.push("funded requester cash $" + totalCost + (SIGNED_MODE ? " (requester-signed)" : ""));

    const instBefore = await idSet(dealer, "Umbra:InstrumentHolding");
    await act(dealerRole, "award-inst", [{
      CreateCommand: { templateId: `#${PKGN}:Umbra:InstrumentHolding`,
        createArguments: { owner: dealer, registry: dealer, instrument, quantity: String(quantity) } } }]);
    const instCid = await pollNewCid(dealer, "Umbra:InstrumentHolding", instBefore);
    steps.push("funded dealer instrument " + quantity + " " + instrument + (SIGNED_MODE ? " (" + dealerRole + "-signed)" : ""));

    const siBefore = await idSet(requester, "Umbra:SettlementInstruction");
    await act("requester", "award-accept", [{
      ExerciseCommand: { templateId: `#${PKGN}:Umbra:Quote`, contractId: quoteCid,
        choice: "AcceptQuote", choiceArgument: { requesterCashCid: cashCid } } }]);
    const siCid = await pollNewCid(requester, "Umbra:SettlementInstruction", siBefore);
    steps.push("requester accepted, cash locked" + (SIGNED_MODE ? " (requester-signed)" : ""));

    await act(dealerRole, "award-settle", [{
      ExerciseCommand: { templateId: `#${PKGN}:Umbra:SettlementInstruction`,
        contractId: siCid, choice: "Settle", choiceArgument: { dealerInstrumentCid: instCid } } }]);
    steps.push("settled atomically, DvP" + (SIGNED_MODE ? " (" + dealerRole + "-signed)" : ""));

    res.json({ ok: true, signed: SIGNED_MODE, price, quantity, totalCost, steps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- CIP-56 allocation-based DvP. Each party creates its OWN allocation
// (signatory = that party), then the executor (operator/venue) assembles the
// DvPSettlement and fires ExecuteDvP = atomic two-leg swap in standard form.
// body: { quoteCid }  --- mirrors /api/award but settles via the token standard.
app.post("/api/dvp/award", async (req, res) => {
  try {
    const { quoteCid } = req.body;
    const requester = await partyIdFor("requester");
    const quotes = await queryActive(requester, "Umbra:Quote");
    const q = quotes.find((x) => x.contractId === quoteCid);
    if (!q) throw new Error("quote not found or not visible to requester");
    const { dealer: dealerParty, quantity, price, instrument } = q.payload;
    const dealerRole = await roleOfParty(dealerParty);
    if (!dealerRole) throw new Error("could not map quote dealer party to a role");
    const dealer = await partyIdFor(dealerRole);
    const executor = PARTIES.requester; // venue/operator-namespaced executor party
    const totalCost = Math.round(Number(price) * Number(quantity) * 1e6) / 1e6;
    const steps = [];
    const idSet = async (party, tmpl) =>
      new Set((await queryActive(party, tmpl)).map((c) => c.contractId));

    // 1) fund requester cash
    const cashBefore = await idSet(requester, "Umbra:CashHolding");
    await act("requester", "dvp-cash", [{
      CreateCommand: { templateId: `#${PKGN}:Umbra:CashHolding`,
        createArguments: { owner: requester, issuer: requester, currency: "USD", amount: String(totalCost) } } }]);
    const cashCid = await pollNewCid(requester, "Umbra:CashHolding", cashBefore);
    steps.push("funded requester cash $" + totalCost + (SIGNED_MODE ? " (requester-signed)" : ""));

    // 2) fund dealer instrument
    const instBefore = await idSet(dealer, "Umbra:InstrumentHolding");
    await act(dealerRole, "dvp-inst", [{
      CreateCommand: { templateId: `#${PKGN}:Umbra:InstrumentHolding`,
        createArguments: { owner: dealer, registry: dealer, instrument, quantity: String(quantity) } } }]);
    const instCid = await pollNewCid(dealer, "Umbra:InstrumentHolding", instBefore);
    steps.push("funded dealer instrument " + quantity + " " + instrument + (SIGNED_MODE ? " (" + dealerRole + "-signed)" : ""));

    // 3) requester creates the CashAllocation (its own authority)
    const caBefore = await idSet(requester, "UmbraDvP:CashAllocation");
    await act("requester", "dvp-cash-alloc", [{
      CreateCommand: { templateId: `#${PKGN}:UmbraDvP:CashAllocation`,
        createArguments: {
          requester, dealer, executor,
          cashCid, cashIssuer: requester,
          currency: "USD", legAmount: String(totalCost) } } }]);
    const cashAllocCid = await pollNewCid(requester, "UmbraDvP:CashAllocation", caBefore);
    steps.push("requester allocated cash (CIP-56 Allocation)" + (SIGNED_MODE ? " (requester-signed)" : ""));

    // 4) dealer creates the InstrumentAllocation (its own authority)
    const iaBefore = await idSet(dealer, "UmbraDvP:InstrumentAllocation");
    await act(dealerRole, "dvp-inst-alloc", [{
      CreateCommand: { templateId: `#${PKGN}:UmbraDvP:InstrumentAllocation`,
        createArguments: {
          dealer, requester, executor,
          instCid, registry: dealer,
          instrument, legQty: String(quantity) } } }]);
    const instAllocCid = await pollNewCid(dealer, "UmbraDvP:InstrumentAllocation", iaBefore);
    steps.push("dealer allocated instrument (CIP-56 Allocation)" + (SIGNED_MODE ? " (" + dealerRole + "-signed)" : ""));

    // 5) executor PROPOSES the settlement (only executor signs initially)
    const propBefore = await idSet(executor, "UmbraDvP:DvPProposal");
    await submit("dvp-propose", executor, [{
      CreateCommand: { templateId: `#${PKGN}:UmbraDvP:DvPProposal`,
        createArguments: { requester, dealer, executor, cashAllocCid, instAllocCid } } }]);
    const propCid = await pollNewCid(executor, "UmbraDvP:DvPProposal", propBefore);
    steps.push("venue proposed settlement (executor)");

    // 6) dealer ACCEPTS -> DvPDealerAccepted (gathers dealer authority)
    const daBefore = await idSet(dealer, "UmbraDvP:DvPDealerAccepted");
    await act(dealerRole, "dvp-dealer-accept", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraDvP:DvPProposal`,
        contractId: propCid, choice: "AcceptAsDealer", choiceArgument: {} } }]);
    const daCid = await pollNewCid(dealer, "UmbraDvP:DvPDealerAccepted", daBefore);
    steps.push("dealer accepted settlement" + (SIGNED_MODE ? " (" + dealerRole + "-signed)" : ""));

    // 7) requester ACCEPTS -> DvPSettlement (now signed by all three)
    const dsBefore = await idSet(requester, "UmbraDvP:DvPSettlement");
    await act("requester", "dvp-req-accept", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraDvP:DvPDealerAccepted`,
        contractId: daCid, choice: "AcceptAsRequester", choiceArgument: {} } }]);
    const dvpCid = await pollNewCid(requester, "UmbraDvP:DvPSettlement", dsBefore);
    steps.push("requester accepted, settlement fully authorized" + (SIGNED_MODE ? " (requester-signed)" : ""));

    // 8) executor fires ExecuteDvP. The contract is signed by all three, so the
    // nested Allocation_ExecuteTransfer ([executor,sender,receiver]) authority is satisfied.
    {
      // ExecuteDvP authority: in SIGNED mode the requester/dealer authority is
      // already gathered into DvPSettlement via their signed accepts, and they
      // are EXTERNAL parties the operator cannot actAs -- so the executor (which
      // is operator-namespaced) submits alone. In operator mode we actAs all
      // three (operator holds CanActAs on them). Either way ExecuteDvP fires.
      const execActAs = (SIGNED_MODE) ? [executor] : [requester, dealer, executor];
      const body = { commandId: `dvp-execute-${Date.now()}`,
        actAs: execActAs,
        commands: [{ ExerciseCommand: { templateId: `#${PKGN}:UmbraDvP:DvPSettlement`,
          contractId: dvpCid, choice: "ExecuteDvP", choiceArgument: {} } }] };
      const r = await ledgerFetch("/v2/commands/submit-and-wait", { method: "POST", body: JSON.stringify(body) });
      const t = await r.text();
      if (!r.ok) throw new Error(`ExecuteDvP failed: ${r.status} ${t}`);
    }
    steps.push("executed atomic DvP via CIP-56 allocations (all three authorized)");

    await cleanupRfq(q.payload.rfqId);
    res.json({ ok: true, signed: SIGNED_MODE, mode: "cip56-dvp", price, quantity, totalCost, steps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===========================================================================
// SWAP ENDPOINTS (HackCanton) -- unified any-to-any CIP-56 swap engine.
// Mirrors the /api/dvp/* choreography but over the generalized UmbraSwap
// templates. Assets are {admin, symbol}; any asset swaps for any other.
// ===========================================================================

// helper: build an AssetId object from {admin, symbol}
function assetId(a) {
  if (!a || !a.symbol) throw new Error("asset must be {admin, symbol}");
  return { admin: a.admin, symbol: a.symbol };
}

// ===== UMBRA SWAP ENDPOINTS (spliced) =====
// ============================================================================
// UMBRA SWAP — backend API for the unified any-to-any engine (UmbraSwap.daml)
//
// INSERTION: paste this whole block into backend/server.js immediately BEFORE
// the line `const PORT = process.env.PORT || 4000;`.
//
// It reuses the existing helpers unchanged: act, submit, pollNewCid, idSet-style
// snapshots, queryActive, partyIdFor, roleOfParty, ledgerFetch, PKGN, PARTIES,
// SIGNED_MODE. Template ids resolve by package name as `#${PKGN}:UmbraSwap:...`.
//
// Two surfaces, by design:
//   * GRANULAR (production venue): each RFQ / invite / quote / accept / commit /
//     execute step is its own endpoint, hit by its own party. This is the real
//     multi-party, multi-session venue and is what makes the privacy provable —
//     a judge can query quotes as dealer1 vs dealer2 and see each is blind.
//   * /api/swap/award (demo/video): walks the entire choreography server-side in
//     one call, for a clean end-to-end demo. Convenience, not the product.
//
// Asset shape used across the API (JSON):  { admin: <partyId>, symbol: "cBTC" }
// where `admin` is the issuer/registry party id for that asset.
// ============================================================================

// Resolve an asset descriptor from the request. Accepts either an explicit
// {admin, symbol} or a known symbol looked up against env-configured issuers.
// Env (optional) lets the demo name assets without passing admin each time:
//   ASSET_CBTC_ADMIN, ASSET_CETH_ADMIN, ASSET_CC_ADMIN
async function resolveAsset(a) {
  if (a && a.admin && a.symbol) return { admin: a.admin, symbol: String(a.symbol) };
  const raw = String((a && a.symbol) || a || "").toUpperCase();
  const table = {
    CBTC: { symbol: "cBTC", admin: process.env.ASSET_CBTC_ADMIN },
    CETH: { symbol: "cETH", admin: process.env.ASSET_CETH_ADMIN },
    CC:   { symbol: "CC",   admin: process.env.ASSET_CC_ADMIN },
  };
  const hit = table[raw];
  if (!hit || !hit.admin) throw new Error(`unknown asset '${JSON.stringify(a)}' — pass {admin,symbol} or set ASSET_${raw}_ADMIN`);
  return { admin: hit.admin, symbol: hit.symbol };
}

// Which signing role is this asset's admin? (funding needs the admin to co-sign)
async function adminRoleOf(asset) {
  for (const r of SIGNING_ROLES) {
    if ((await partyIdFor(r)) === asset.admin) return r;
  }
  return null;
}

const idSetSwap = async (party, tmpl) =>
  new Set((await queryActive(party, tmpl)).map((c) => c.contractId));

// ---- registry: seed / read -------------------------------------------------

// Create (or re-list into) the on-ledger AssetRegistry. Operator-authorised.
app.post("/api/swap/registry/seed", async (req, res) => {
  try {
    const operator = await partyIdFor("requester"); // venue/operator-namespaced
    const participants = [
      await partyIdFor("requester"),
      await partyIdFor("dealer1"),
      await partyIdFor("dealer2"),
      await partyIdFor("public"),
    ];
    const assets = [];
    for (const a of (req.body.assets || [])) assets.push(await resolveAsset(a));

    // one registry per operator: reuse if present, else create
    let regs = await queryActive(operator, "UmbraSwap:AssetRegistry");
    let regCid;
    if (regs.length === 0) {
      const before = await idSetSwap(operator, "UmbraSwap:AssetRegistry");
      await act("requester", "swap-reg-create", [{
        CreateCommand: { templateId: `#${PKGN}:UmbraSwap:AssetRegistry`,
          createArguments: { operator, participants, assets: [] } } }]);
      regCid = await pollNewCid(operator, "UmbraSwap:AssetRegistry", before);
    } else {
      regCid = regs[0].contractId;
    }

    // list each asset (idempotent on-ledger)
    for (const asset of assets) {
      const before = await idSetSwap(operator, "UmbraSwap:AssetRegistry");
      await act("requester", "swap-reg-list", [{
        ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:AssetRegistry`,
          contractId: regCid, choice: "ListAsset", choiceArgument: { asset } } }]);
      regCid = await pollNewCid(operator, "UmbraSwap:AssetRegistry", before);
    }
    res.json({ ok: true, regCid, listed: assets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/swap/registry", async (req, res) => {
  try {
    const role = req.query.role || "requester";
    const regs = await queryActive(await partyIdFor(role), "UmbraSwap:AssetRegistry");
    res.json({ ok: true, role, count: regs.length,
      assets: regs[0] ? regs[0].payload.assets : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- funding helper (dev): mint an AssetHolding for a role+asset ------------
// In production, holdings are issued by the real cBTC/cETH registries (faucets);
// this endpoint is for demo/testing with operator-controlled parties.
app.post("/api/swap/fund", async (req, res) => {
  try {
    const role = String(req.body.role || "requester").toLowerCase();
    const owner = await partyIdFor(role);
    const asset = await resolveAsset(req.body.asset);
    const amount = String(req.body.amount);
    const before = await idSetSwap(owner, "UmbraSwap:AssetHolding");
    // AssetHolding signatory = owner (observer asset.admin), so only the owner's
    // authority is needed. Use act() so SIGNED_MODE routes through prepare->sign.
    const adminRole = await adminRoleOf(asset);
    if (!adminRole) throw new Error(
      "asset admin " + asset.admin + " is not a signing role \u2014 it cannot co-sign an issuance. " +
      "Set ASSET_" + asset.symbol.toUpperCase() + "_ADMIN to a party this venue holds a key for, " +
      "or fund from the issuer's own faucet.");
    await actMulti([role, adminRole], "swap-fund", [{
      CreateCommand: { templateId: `#${PKGN}:UmbraSwap:AssetHolding`,
        createArguments: { owner, asset, amount } } }]);
    const cid = await pollNewCid(owner, "UmbraSwap:AssetHolding", before);
    res.json({ ok: true, holdingCid: cid, owner: role, asset, amount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/swap/holdings", async (req, res) => {
  try {
    const role = req.query.role || "requester";
    const party = await partyIdFor(role);
    const hs = await queryActive(party, "UmbraSwap:AssetHolding");
    // Only holdings this party OWNS. An asset `admin` also SEES (observer)
    // everyone's holdings of that asset; without this filter `pick` could select
    // a holding owned by someone else and the CIP-56 allocation would revert with
    // "allocation sender is not the holding owner".
    const owned = hs.filter(h => h.payload && h.payload.owner === party);
    res.json({ ok: true, role, count: owned.length, holdings: owned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- READ-ONLY: real CIP-56 token holdings (Amulet/CC, CBTC, cETH, ...) -----
// Queries the standard Splice Holding INTERFACE (not Umbra's AssetHolding) so we
// can see the real assets a party holds. includeInterfaceView gives us the view
// with owner, instrumentId {admin,id}, and amount.
async function queryRealHoldings(party) {
  const offset = await ledgerEnd();
  const body = {
    filter: { filtersByParty: { [party]: { cumulative: [{
      identifierFilter: { InterfaceFilter: { value: {
        interfaceId: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
        includeInterfaceView: true,
        includeCreatedEventBlob: false,
      } } },
    }] } } },
    verbose: false,
    activeAtOffset: offset,
  };
  const r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(humanize(`${r.status} ${text}`));
  let items;
  try { items = JSON.parse(text); }
  catch { items = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  const arr = Array.isArray(items) ? items : [items];
  const out = [];
  for (const x of arr) {
    const ce = x?.contractEntry?.JsActiveContract?.createdEvent || x?.activeContract?.createdEvent || x?.createdEvent;
    if (!ce) continue;
    // Each contract yields one interface view per interface-package version; the
    // package-name 'umbra' view fails to render (viewValue null). Use the first
    // view that actually rendered.
    const gv = (ce.interfaceViews || []).find(v => v && v.viewValue && (!v.viewStatus || v.viewStatus.code === 0));
    if (gv) {
      const vv = gv.viewValue;
      const inst = vv.instrumentId || {};
      out.push({ contractId: ce.contractId, owner: vv.owner, admin: inst.admin, id: inst.id, amount: vv.amount, lock: vv.lock || null });
    }
  }
  return out;
}

app.get("/api/real/holdings", async (req, res) => {
  try {
    const party = req.query.party || await partyIdFor(req.query.role || "requester");
    const hs = await queryRealHoldings(party);
    const byInst = {};
    for (const h of hs) {
      const k = (h.id || "?") + "@" + (h.admin || "?");
      if (!byInst[k]) byInst[k] = { id: h.id, admin: h.admin, total: 0, utxos: 0 };
      byInst[k].total += Number(h.amount || 0);
      byInst[k].utxos += 1;
    }
    res.json({ ok: true, party, instruments: Object.values(byInst), raw: hs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- READ-ONLY: pending incoming CIP-56 transfer offers --------------------
// The faucet's cBTC arrives as a TransferInstruction the receiver must accept.
async function queryPendingTransfers(party) {
  const offset = await ledgerEnd();
  const body = {
    filter: { filtersByParty: { [party]: { cumulative: [{
      identifierFilter: { InterfaceFilter: { value: {
        interfaceId: "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        includeInterfaceView: true,
        includeCreatedEventBlob: false,
      } } },
    }] } } },
    verbose: false,
    activeAtOffset: offset,
  };
  const r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(humanize(`${r.status} ${text}`));
  let items;
  try { items = JSON.parse(text); }
  catch { items = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  const arr = Array.isArray(items) ? items : [items];
  const out = [];
  for (const x of arr) {
    const ce = x?.contractEntry?.JsActiveContract?.createdEvent || x?.activeContract?.createdEvent || x?.createdEvent;
    if (!ce) continue;
    const gv = (ce.interfaceViews || []).find(v => v && v.viewValue && (!v.viewStatus || v.viewStatus.code === 0));
    if (gv) {
      const vv = gv.viewValue;
      const t = vv.transfer || {};
      const inst = t.instrumentId || {};
      out.push({
        contractId: ce.contractId,
        status: (vv.status && (vv.status.tag || vv.status)) || null,
        sender: t.sender, receiver: t.receiver, amount: t.amount,
        instrument: inst.id, admin: inst.admin, executeBefore: t.executeBefore,
      });
    }
  }
  return out;
}

app.get("/api/real/raw", async (req, res) => {
  try {
    const party = req.query.party || await partyIdFor(req.query.role || "requester");
    const offset = await ledgerEnd();
    const body = {
      filter: { filtersByParty: { [party]: { cumulative: [{
        identifierFilter: { InterfaceFilter: { value: {
          interfaceId: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
          includeInterfaceView: true,
          includeCreatedEventBlob: false,
        } } },
      }] } } },
      verbose: false,
      activeAtOffset: offset,
    };
    const r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(humanize(`${r.status} ${text}`));
    let items;
    try { items = JSON.parse(text); }
    catch { items = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
    const arr = Array.isArray(items) ? items : [items];
    const out = [];
    for (const x of arr) {
      const ce = x?.contractEntry?.JsActiveContract?.createdEvent || x?.activeContract?.createdEvent || x?.createdEvent;
      if (!ce) continue;
      out.push({ contractId: ce.contractId, templateId: ce.templateId, interfaceViews: ce.interfaceViews });
    }
    const only = req.query.cid ? out.filter(o => o.contractId === req.query.cid) : out;
    res.json({ ok: true, party, count: out.length, holdings: only });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/real/pending", async (req, res) => {
  try {
    const party = req.query.party || await partyIdFor(req.query.role || "requester");
    const offers = await queryPendingTransfers(party);
    res.json({ ok: true, party, count: offers.length, offers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- ACCEPT a pending CIP-56 transfer (lands real cBTC/cETH) ----------------
const REGISTRY_URL_DEFAULT = process.env.REGISTRY_URL || "https://api.utilities.digitalasset-dev.com";
const TI_IFACE = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

// Ask the registrar (the instrument admin) for the accept choice-context: the
// context values + disclosed contracts the TransferInstruction_Accept choice needs.
async function acceptContext(registryUrl, registrar, offerCid) {
  const url = regPath(registryUrl, registrar,
    "transfer-instruction/v1/" + offerCid + "/choice-contexts/accept");
  const r = await regFetch(registryUrl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: {} }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error("registry " + r.status + ": " + text.slice(0, 300));
  return JSON.parse(text);
}

app.post("/api/real/pending/:cid/accept", async (req, res) => {
  try {
    const role = req.query.role || (req.body && req.body.role) || "requester";
    const party = await partyIdFor(role);
    const cid = req.params.cid;
    // Confirm the offer exists for this party and get its registrar (instrument admin).
    const offers = await queryPendingTransfers(party);
    const offer = offers.find(o => o.contractId === cid);
    if (!offer) return res.status(404).json({ error: "no pending offer '" + cid + "' for " + role });
    if (!offer.admin) return res.status(400).json({ error: "offer has no instrument admin (registrar)" });

    // Resolve the registry from the instrument's admin, the way /api/real/send does.
    // Defaulting to REGISTRY_URL_DEFAULT asked the wrong registry about the offer and
    // came back "Transfer offer not found" -- which reads like a missing contract but
    // is really a question posed to the wrong registrar (e.g. Amulet lives on the DSO
    // scan-proxy, not the default registry).
    const registryUrl = req.query.registry || registryForAdmin(offer.admin) || REGISTRY_URL_DEFAULT;

    const ctx = await acceptContext(registryUrl, offer.admin, cid);
    const disclosed = (ctx.disclosedContracts || []).map(d => ({
      templateId: d.templateId, contractId: d.contractId,
      createdEventBlob: d.createdEventBlob, synchronizerId: d.synchronizerId || "",
    }));

    const body = {
      commandId: "accept-" + Date.now(),
      actAs: [party],
      commands: [{
        ExerciseCommand: {
          templateId: TI_IFACE,
          contractId: cid,
          choice: "TransferInstruction_Accept",
          choiceArgument: { extraArgs: {
            context: ctx.choiceContextData || { values: {} },
            meta: { values: {} },
          } },
        },
      }],
      disclosedContracts: disclosed,
    };
    // BUILD MODE. Registry choices need a choice-context and disclosed contracts that
    // only the server can assemble, but signing them is the party's business. With
    // build=1 we hand back the commands and disclosures and submit nothing -- the
    // wallet feeds them to /api/ext/prepare, signs, and posts to /api/ext/execute.
    if (req.query.build === "1" || (req.body && req.body.build)) {
      return res.json({ ok: true, build: true, party, commands: body.commands,
        disclosedContracts: disclosed,
        note: "POST { party, commands, disclosedContracts } to /api/ext/prepare, sign the hash, then /api/ext/execute" });
    }
    await realSubmit(body, "raccept");
    res.json({ ok: true, accepted: cid, instrument: offer.instrument, amount: offer.amount, disclosed: disclosed.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- ALLOCATE a real Holding via the registry AllocationFactory --------------
const AF_IFACE = "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory";

async function allocationFactory(registryUrl, registrar, choiceArguments) {
  const url = regPath(registryUrl, registrar, "allocation-instruction/v1/allocation-factory");
  const r = await regFetch(registryUrl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choiceArguments, excludeDebugFields: true }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error("registry " + r.status + ": " + text.slice(0, 400));
  return JSON.parse(text);
}

app.post("/api/real/allocate", async (req, res) => {
  try {
    const b = req.body || {};
    const senderRole = b.senderRole || req.query.role || "requester";
    const sender = (b.sender && String(b.sender).includes("::")) ? b.sender : await partyIdFor(senderRole);
    const receiver = (b.receiver && String(b.receiver).includes("::")) ? b.receiver : await partyIdFor(b.receiverRole || "dealer1");
    const executor = (b.executor && String(b.executor).includes("::")) ? b.executor : await partyIdFor(b.executorRole || senderRole);
    const admin = b.admin, id = b.id, amount = b.amount;
    const holdingCids = b.holdingCids || [];
    // Resolve the registry from the instrument's admin when the caller doesn't name one.
    // REAL_REGISTRY maps cBTC and cETH to REGISTRY_URL_DEFAULT, so those worked by
    // coincidence -- but Amulet lives on the DSO scan-proxy, and asking the default
    // registry about a DSO holding gets "Given holdings are invalid", which reads like
    // a bad holding rather than a question put to the wrong registrar. allocateRealLeg
    // always passes `registry` so the trading path was unaffected; a direct caller
    // (a wallet, a script) hits this.
    const registryUrl = b.registry || req.query.registry || registryForAdmin(admin) || REGISTRY_URL_DEFAULT;
    if (!admin || !id || !amount || !holdingCids.length) {
      return res.status(400).json({ error: "need admin, id, amount, holdingCids[]" });
    }

    const now = new Date();
    const iso = (d) => d.toISOString();
    const mkArgs = (ctx) => ({
      expectedAdmin: admin,
      allocation: {
        settlement: {
          executor,
          settlementRef: { id: b.settleId || ("umbra-" + Date.now()), cid: null },
          requestedAt: iso(now),
          allocateBefore: iso(new Date(now.getTime() + 15 * 60000)),
          settleBefore: iso(new Date(now.getTime() + 30 * 60000)),
          meta: { values: {} },
        },
        transferLegId: b.legId || "leg-1",
        transferLeg: {
          sender, receiver, amount,
          instrumentId: { admin, id },
          meta: { values: {} },
        },
      },
      requestedAt: iso(now),
      inputHoldingCids: holdingCids,
      extraArgs: { context: ctx || { values: {} }, meta: { values: {} } },
    });

    // 1. factory + choice-context (validates the body; stub context ok here)
    const fc = await allocationFactory(registryUrl, admin, mkArgs({ values: {} }));
    const ctx = (fc.choiceContext && fc.choiceContext.choiceContextData) || { values: {} };
    const disclosed = ((fc.choiceContext && fc.choiceContext.disclosedContracts) || []).map(d => ({
      templateId: d.templateId, contractId: d.contractId,
      createdEventBlob: d.createdEventBlob, synchronizerId: d.synchronizerId || "",
    }));

    // PROBE (opt-in: DISCLOSE_INPUT_HOLDING=1). Also forward the INPUT HOLDINGS'
    // own createdEventBlobs as disclosed contracts. Hypothesis: after the
    // synchronizer recovery, the cETH registrar needs the input holding disclosed
    // for external-party allocations (cBTC does not). Fail-safe: on ANY error, or
    // when the flag is unset, the command is byte-identical to current behaviour,
    // so the working cBTC/CC path is never at risk.
    if (process.env.DISCLOSE_INPUT_HOLDING === "1") {
      try {
        const _off = await ledgerEnd();
        const _q = { filter: { filtersByParty: { [sender]: { cumulative: [{
          identifierFilter: { InterfaceFilter: { value: {
            interfaceId: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
            includeInterfaceView: false, includeCreatedEventBlob: true,
          } } } }] } } }, verbose: false, activeAtOffset: _off };
        const _r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(_q) });
        const _t = await _r.text();
        let _items; try { _items = JSON.parse(_t); }
        catch { _items = _t.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
        const _arr = Array.isArray(_items) ? _items : [_items];
        const _want = new Set(holdingCids);
        let _added = 0;
        for (const _x of _arr) {
          const _jac = _x && _x.contractEntry && _x.contractEntry.JsActiveContract;
          const _ce = (_jac && _jac.createdEvent) || (_x && _x.createdEvent);
          if (!_ce || !_want.has(_ce.contractId) || !_ce.createdEventBlob) continue;
          if (disclosed.some(d => d.contractId === _ce.contractId)) continue;
          disclosed.push({
            templateId: _ce.templateId, contractId: _ce.contractId,
            createdEventBlob: _ce.createdEventBlob,
            synchronizerId: (_jac && _jac.synchronizerId) || _ce.synchronizerId || "",
          });
          _added++;
        }
        console.log("[ALLOC-PROBE] input-holding disclosures added:", _added, "of", holdingCids.length, "for", id);
      } catch (_e) { console.log("[ALLOC-PROBE] holding-disclosure probe failed (ignored):", _e.message); }
    }

    // 2. exercise AllocationFactory_Allocate with the REAL context + disclosures
    const cmd = {
      commandId: "allocate-" + Date.now(),
      actAs: [sender],
      commands: [{ ExerciseCommand: {
        templateId: AF_IFACE,
        contractId: fc.factoryId,
        choice: "AllocationFactory_Allocate",
        choiceArgument: mkArgs(ctx),
      } }],
      disclosedContracts: disclosed,
    };
    // BUILD MODE (see /api/real/pending/:cid/accept): return the assembled command so
    // the sender's own wallet can sign it. This is how a party allocates its own leg
    // without Umbra holding its key -- settle-real then adopts that allocation.
    if (req.query.build === "1" || b.build) {
      return res.json({ ok: true, build: true, party: sender, commands: cmd.commands,
        disclosedContracts: disclosed, settleId: b.settleId || null, legId: b.legId || null,
        note: "POST { party, commands, disclosedContracts } to /api/ext/prepare, sign the hash, then /api/ext/execute" });
    }
    // Capture the offset BEFORE submitting so the caller can scan completions from
    // here; commandId + sender are what allocateRealLeg needs to read the verdict.
    const offBefore = await ledgerEnd();
    const subRes = await realSubmit(cmd, "rallocate");
    res.json({ ok: true, allocated: { id, amount, sender: senderRole, receiver, executor },
      factoryId: fc.factoryId, disclosed: disclosed.length,
      commandId: (subRes && subRes.commandId) || null, senderParty: sender, offBefore });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- SEND a real CIP-56 token via the registry TransferFactory --------------
const TF_FACTORY_IFACE = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";

async function transferFactory(registryUrl, registrar, choiceArguments) {
  const url = regPath(registryUrl, registrar, "transfer-instruction/v1/transfer-factory");
  const r = await regFetch(registryUrl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choiceArguments, excludeDebugFields: true }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error("registry " + r.status + ": " + text.slice(0, 400));
  return JSON.parse(text);
}

app.post("/api/real/send", async (req, res) => {
  try {
    const b = req.body || {};
    const senderRole = b.senderRole || req.query.role || "requester";
    const sender = (b.sender && String(b.sender).includes("::")) ? b.sender : await partyIdFor(senderRole);
    const receiver = b.receiver;  // full party id (e.g. a wallet party)
    const admin = b.admin, id = b.id, amount = b.amount;
    const holdingCids = b.holdingCids || [];
    const registryUrl = b.registry || registryForAdmin(admin) || REGISTRY_URL_DEFAULT;
    if (!receiver || !String(receiver).includes("::")) return res.status(400).json({ error: "need receiver (full party id)" });
    if (!admin || !id || !amount || !holdingCids.length) return res.status(400).json({ error: "need admin, id, amount, holdingCids[]" });

    const now = new Date();
    const iso = (d) => d.toISOString();
    const mkArgs = (ctx) => ({
      expectedAdmin: admin,
      transfer: {
        sender, receiver, amount,
        instrumentId: { admin, id },
        requestedAt: iso(now),
        executeBefore: iso(new Date(now.getTime() + 60 * 60000)),
        inputHoldingCids: holdingCids,
        meta: { values: {} },
      },
      extraArgs: { context: ctx || { values: {} }, meta: { values: {} } },
    });

    const fc = await transferFactory(registryUrl, admin, mkArgs({ values: {} }));
    const ctx = (fc.choiceContext && fc.choiceContext.choiceContextData) || { values: {} };
    const disclosed = ((fc.choiceContext && fc.choiceContext.disclosedContracts) || []).map(d => ({
      templateId: d.templateId, contractId: d.contractId,
      createdEventBlob: d.createdEventBlob, synchronizerId: d.synchronizerId || "",
    }));

    const cmd = {
      commandId: "send-" + Date.now(),
      actAs: [sender],
      commands: [{ ExerciseCommand: {
        templateId: TF_FACTORY_IFACE,
        contractId: fc.factoryId,
        choice: "TransferFactory_Transfer",
        choiceArgument: mkArgs(ctx),
      } }],
      disclosedContracts: disclosed,
    };
    await realSubmit(cmd, "rsend");
    res.json({ ok: true, sent: { id, amount, from: senderRole, to: receiver },
      note: "receiver must accept via /api/real/pending/:cid/accept", disclosed: disclosed.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- READ-ONLY: registry Allocations (locked legs awaiting execution) --------
const ALLOC_IFACE = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";
// The utility registry's DvpLegAllocation implements AllocationV1 at THIS exact
// package hash (proven by interface-view probe). The #-name resolves to a different
// version on this participant, causing CONTRACT_DOES_NOT_IMPLEMENT_INTERFACE. Pin it.
const ALLOC_IFACE_VER = "93c942ae2b4c2ba674fb152fe38473c507bda4e82b4e4c5da55a552a9d8cce1d:Splice.Api.Token.AllocationV1:Allocation";

async function queryAllocations(party) {
  const offset = await ledgerEnd();
  const body = {
    filter: { filtersByParty: { [party]: { cumulative: [{
      identifierFilter: { InterfaceFilter: { value: {
        interfaceId: ALLOC_IFACE,
        includeInterfaceView: true,
        includeCreatedEventBlob: false,
      } } },
    }] } } },
    verbose: false,
    activeAtOffset: offset,
  };
  const r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(humanize(`${r.status} ${text}`));
  let items;
  try { items = JSON.parse(text); }
  catch { items = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  const arr = Array.isArray(items) ? items : [items];
  const out = [];
  for (const x of arr) {
    const ce = x?.contractEntry?.JsActiveContract?.createdEvent || x?.activeContract?.createdEvent || x?.createdEvent;
    if (!ce) continue;
    const gv = (ce.interfaceViews || []).find(v => v && v.viewValue && (!v.viewStatus || v.viewStatus.code === 0));
    if (!gv) continue;
    const vv = gv.viewValue;
    const al = vv.allocation || {};
    const leg = al.transferLeg || {};
    const st = al.settlement || {};
    const inst = leg.instrumentId || {};
    out.push({
      contractId: ce.contractId,
      instrument: inst.id, admin: inst.admin,
      sender: leg.sender, receiver: leg.receiver, amount: leg.amount,
      executor: st.executor,
      settlementRef: st.settlementRef, settleBefore: st.settleBefore,
      transferLegId: al.transferLegId,
    });
  }
  return out;
}

app.get("/api/real/allocations", async (req, res) => {
  try {
    const party = req.query.party || await partyIdFor(req.query.role || "requester");
    const allocs = await queryAllocations(party);
    res.json({ ok: true, party, count: allocs.length, allocations: allocs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- WITHDRAW a registry Allocation (unlock the Holding) --------------------
async function withdrawContext(registryUrl, registrar, allocationCid) {
  const url = regPath(registryUrl, registrar, "allocations/v1/" + allocationCid + "/choice-contexts/withdraw");
  const r = await regFetch(registryUrl, url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: {} }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error("registry " + r.status + ": " + text.slice(0, 300));
  return JSON.parse(text);
}

app.post("/api/real/withdraw/:cid", async (req, res) => {
  try {
    const b = req.body || {};
    const cid = req.params.cid;
    const role = b.role || req.query.role || "requester";
    const party = await partyIdFor(role);

    const allocs = await queryAllocations(party);
    const al = allocs.find(a => a.contractId === cid);
    if (!al) return res.status(404).json({ error: "allocation '" + cid + "' not visible to " + role });

    // Derived after the lookup so it can key off the allocation's own admin (see the
    // note in /api/real/allocate); the default registry is wrong for DSO/Amulet.
    const registryUrl = b.registry || req.query.registry || registryForAdmin(al.admin) || REGISTRY_URL_DEFAULT;
    const ctx = await withdrawContext(registryUrl, al.admin, cid);
    const cdata = ctx.choiceContextData || { values: {} };
    const disclosed = (ctx.disclosedContracts || []).map(d => ({
      templateId: d.templateId, contractId: d.contractId,
      createdEventBlob: d.createdEventBlob, synchronizerId: d.synchronizerId || "",
    }));

    const actAs = b.actAs || [...new Set([al.sender, al.executor].filter(Boolean))];
    const cmd = {
      commandId: "withdraw-" + Date.now(),
      actAs,
      commands: [{ ExerciseCommand: {
        templateId: ALLOC_IFACE_VER,
        contractId: cid,
        choice: "Allocation_Withdraw",
        choiceArgument: { extraArgs: { context: cdata, meta: { values: {} } } },
      } }],
      disclosedContracts: disclosed,
    };
    // Allocation_Withdraw is the OWNER's choice. For a party that brought its own
    // wallet the venue has no key, and withdrawLeg() already skips those legs on the
    // rollback path -- so without this branch such a party could not unlock its own
    // funds by any route, and a settlement that died on the counterparty left it
    // locked with no way out. Hand the command back to be signed in the wallet.
    const walletActor = actAs.find(isWalletParty);
    if (req.query.build === "1" || b.build || walletActor) {
      return res.json({ ok: true, build: true, party: walletActor || actAs[0],
        commands: cmd.commands, disclosedContracts: disclosed,
        instrument: al.instrument, amount: al.amount,
        note: "sign via /api/ext/prepare + /api/ext/execute to unlock this holding" });
    }
    // SIGNED-aware submit: in signed mode the wallet party owns the allocation, so an
    // operator submit-and-wait is rejected (PERMISSION_DENIED / "security-sensitive
    // error"). realSubmit party-signs (prepareSignExecuteMulti) in signed mode and does
    // an operator submit in demo mode.
    try {
      await realSubmit(cmd, "rwithdraw");
    } catch (subErr) {
      return res.status(500).json({ error: humanize(String(subErr.message || subErr)),
        hint_disclosed_templateIds: disclosed.map(d => d.templateId),
        hint_context_keys: Object.keys((cdata.values) || {}) });
    }
    res.json({ ok: true, withdrawn: cid, instrument: al.instrument, amount: al.amount, unlocked: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- EXECUTE a registry Allocation (settle the locked token) ----------------
async function executeContext(registryUrl, registrar, allocationCid) {
  const url = registryUrl +
    "/api/token-standard/v0/registrars/" + encodeURIComponent(registrar) +
    "/registry/allocations/v1/" + allocationCid + "/choice-contexts/execute-transfer";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: {} }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error("registry " + r.status + ": " + text.slice(0, 300));
  return JSON.parse(text);
}

app.post("/api/real/execute/:cid", async (req, res) => {
  try {
    const b = req.body || {};
    const cid = req.params.cid;
    const role = b.role || req.query.role || "requester";
    const party = await partyIdFor(role);

    const allocs = await queryAllocations(party);
    const al = allocs.find(a => a.contractId === cid);
    if (!al) return res.status(404).json({ error: "allocation '" + cid + "' not visible to " + role });

    // Derived after the lookup so it can key off the allocation's own admin (see the
    // note in /api/real/allocate); the default registry is wrong for DSO/Amulet.
    const registryUrl = b.registry || req.query.registry || registryForAdmin(al.admin) || REGISTRY_URL_DEFAULT;

    const ctx = await executeContext(registryUrl, al.admin, cid);
    const cdata = ctx.choiceContextData || { values: {} };
    const disclosed = (ctx.disclosedContracts || []).map(d => ({
      templateId: d.templateId, contractId: d.contractId,
      createdEventBlob: d.createdEventBlob, synchronizerId: d.synchronizerId || "",
    }));

    const actAs = b.actAs || [...new Set([al.executor, al.sender, al.receiver].filter(Boolean))];
    const cmd = {
      commandId: "execute-" + Date.now(),
      actAs,
      commands: [{ ExerciseCommand: {
        templateId: ALLOC_IFACE_VER,
        contractId: cid,
        choice: "Allocation_ExecuteTransfer",
        choiceArgument: { extraArgs: { context: cdata, meta: { values: {} } } },
      } }],
      disclosedContracts: disclosed,
    };
    await realSubmit(cmd, "rexecute");
    res.json({ ok: true, executed: cid, instrument: al.instrument, amount: al.amount,
      from: al.sender, to: al.receiver, disclosed: disclosed.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- EXECUTE a registry Allocation (settle the locked token) ----------------
async function executeContext(registryUrl, registrar, allocationCid) {
  const url = registryUrl +
    "/api/token-standard/v0/registrars/" + encodeURIComponent(registrar) +
    "/registry/allocations/v1/" + allocationCid + "/choice-contexts/execute-transfer";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: {} }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error("registry " + r.status + ": " + text.slice(0, 300));
  return JSON.parse(text);
}

// ---- ATOMIC SETTLEMENT: execute N real allocations in one transaction -------
// scan-proxy-aware execute-transfer choice-context (unlike executeContext, this
// routes CC/scan-proxy correctly and carries the ledger token).
// Fetch specific allocation contracts WITH their createdEventBlob, so a single-party
// (requester) interactive prepare can DISCLOSE + reference contracts it owns or not
// (e.g. the dealer's want-leg allocation). Without this the ExecuteRealSwap prepare
// fails CONTRACT_NOT_FOUND on the dealer's allocation.
async function allocDisclosure(cids, anyParty) {
  const want = new Set(cids.filter(Boolean));
  if (!want.size) return [];
  const offset = await ledgerEnd();
  const body = {
    filter: { filtersByParty: { [anyParty]: { cumulative: [{
      identifierFilter: { InterfaceFilter: { value: {
        interfaceId: ALLOC_IFACE,
        includeInterfaceView: false,
        includeCreatedEventBlob: true,
      } } },
    }] } } },
    verbose: false,
    activeAtOffset: offset,
  };
  const r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(humanize(`${r.status} ${text}`));
  let items;
  try { items = JSON.parse(text); }
  catch { items = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  const arr = Array.isArray(items) ? items : [items];
  const out = [];
  for (const x of arr) {
    const ce = x?.contractEntry?.JsActiveContract?.createdEvent || x?.activeContract?.createdEvent || x?.createdEvent;
    if (!ce || !want.has(ce.contractId)) continue;
    if (!ce.createdEventBlob) continue;
    out.push({
      templateId: ce.templateId,
      contractId: ce.contractId,
      createdEventBlob: ce.createdEventBlob,
      synchronizerId: ce.synchronizerId || "",
    });
  }
  return out;
}

// Fetch a specific Umbra template contract WITH its createdEventBlob so a single-party
// prepare can disclose+reference it (e.g. the SwapSettlement created by the dealer's accept,
// which the requester's participant would otherwise not have disclosed).
async function templateDisclosure(templateSuffix, wantCid, anyParty) {
  const offset = await ledgerEnd();
  const body = {
    filter: { filtersByParty: { [anyParty]: { cumulative: [{
      identifierFilter: { TemplateFilter: { value: {
        templateId: `#${PKGN}:${templateSuffix}`,
        includeCreatedEventBlob: true,
      } } },
    }] } } },
    verbose: false,
    activeAtOffset: offset,
  };
  const r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(humanize(`${r.status} ${text}`));
  let items;
  try { items = JSON.parse(text); }
  catch { items = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  const arr = Array.isArray(items) ? items : [items];
  for (const x of arr) {
    const ce = x?.contractEntry?.JsActiveContract?.createdEvent || x?.activeContract?.createdEvent || x?.createdEvent;
    if (!ce || ce.contractId !== wantCid || !ce.createdEventBlob) continue;
    return { templateId: ce.templateId, contractId: ce.contractId,
      createdEventBlob: ce.createdEventBlob, synchronizerId: ce.synchronizerId || "" };
  }
  return null;
}

async function execTransferContext(registryUrl, registrar, allocationCid) {
  const url = regPath(registryUrl, registrar, "allocations/v1/" + allocationCid + "/choice-contexts/execute-transfer");
  const r = await regFetch(registryUrl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: {} }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error("registry " + r.status + ": " + text.slice(0, 300));
  return JSON.parse(text);
}

app.post("/api/real/settle", async (req, res) => {
  try {
    const b = req.body || {};
    const legs = b.legs || [];
    if (!legs.length) return res.status(400).json({ error: "need legs:[{cid, registry?}]" });

    // Index every allocation visible to any of our parties, so we can resolve
    // each leg's admin/executor/sender/receiver regardless of which role sees it.
    const seen = {};
    for (const role of ["requester", "dealer1", "dealer2"]) {
      try {
        const party = await partyIdFor(role);
        for (const a of await queryAllocations(party)) seen[a.contractId] = a;
      } catch (e) { /* skip */ }
    }

    const cmds = [];
    let disclosed = [];
    const dseen = {};
    const actAsSet = new Set();
    const summary = [];
    for (const leg of legs) {
      const al = seen[leg.cid];
      if (!al) return res.status(404).json({ error: "allocation not found / not visible: " + leg.cid });
      const registryUrl = leg.registry || REGISTRY_URL_DEFAULT;
      const ctx = await execTransferContext(registryUrl, al.admin, leg.cid);
      const cdata = ctx.choiceContextData || { values: {} };
      for (const d of (ctx.disclosedContracts || [])) {
        if (dseen[d.contractId]) continue;
        dseen[d.contractId] = true;
        disclosed.push({ templateId: d.templateId, contractId: d.contractId,
          createdEventBlob: d.createdEventBlob, synchronizerId: d.synchronizerId || "" });
      }
      [al.executor, al.sender, al.receiver].filter(Boolean).forEach(p => actAsSet.add(p));
      cmds.push({ ExerciseCommand: {
        templateId: ALLOC_IFACE_VER,
        contractId: leg.cid,
        choice: "Allocation_ExecuteTransfer",
        choiceArgument: { extraArgs: { context: cdata, meta: { values: {} } } },
      } });
      summary.push({ cid: leg.cid, instrument: al.instrument, amount: al.amount, from: al.sender, to: al.receiver });
    }

    const cmd = {
      commandId: "settle-" + Date.now(),
      actAs: b.actAs || [...actAsSet],
      commands: cmds,                 // ALL legs -> ONE transaction -> atomic
      disclosedContracts: disclosed,
    };
    await realSubmit(cmd, "rsettle");
    res.json({ ok: true, atomic: true, legs: summary, actAs: cmd.actAs, disclosed: disclosed.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GRANULAR VENUE FLOW ---------------------------------------------------

// requester creates a swap RFQ (offer asset -> want asset), then invites the
// dealers. One private SwapInvitation per dealer -- no dealer sees another's.
//
// expiresAt is MANDATORY on SwapRfq and is enforced BY THE LEDGER:
// SubmitSwapQuote asserts `now < expiresAt`, so a late quote is refused by
// Canton, not merely hidden by the UI (see swapRejectsLateQuote).
// Default 15 min; override with body.expiresAt (ISO-8601) or body.ttlMins.
app.post("/api/swap/rfq", async (req, res) => {
  try {
    // The requester may be any party, including one that signs for itself. The OPERATOR
    // stays the venue either way -- it is an observer on the RFQ and its children, which
    // is what lets Umbra coordinate a trade it cannot sign for.
    const requester = req.body.requester
      ? await partyIdFor(req.body.requester)
      : await partyIdFor("requester");
    const operator = await partyIdFor("requester");
    const offerAsset = await resolveAsset(req.body.offerAsset);
    const wantAsset = await resolveAsset(req.body.wantAsset);
    const roles = req.body.invited || req.body.dealers || ["dealer1", "dealer2"];
    const invited = [];
    for (const r of roles) invited.push(await partyIdFor(r));
    const expiresAt = req.body.expiresAt ||
      new Date(Date.now() + Number(req.body.ttlMins || 15) * 60000).toISOString();

    const createCmd = [{
      CreateCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
        createArguments: {
          requester, operator,
          offerAsset, offerAmount: String(req.body.offerAmount),
          wantAsset, invited, expiresAt } } }];
    // A wallet requester signs the create itself, then invites via
    // /api/swap/rfqs/:cid/invite?build=1 once it knows the rfq cid.
    if (req.query.build === "1" || req.body.build || isWalletParty(requester)) {
      return res.json({ ok: true, build: true, party: requester, commands: createCmd,
        invited, expiresAt,
        note: "sign via /api/ext/prepare + /api/ext/execute, then invite each dealer " +
              "with POST /api/swap/rfqs/<rfqCid>/invite?build=1" });
    }

    const rfqBefore = await idSetSwap(requester, "UmbraSwap:SwapRfq");
    await act("requester", "swap-rfq", createCmd);
    const rfqCid = await pollNewCid(requester, "UmbraSwap:SwapRfq", rfqBefore);

    const invitations = [];
    for (let i = 0; i < roles.length; i++) {
      const invBefore = await idSetSwap(requester, "UmbraSwap:SwapInvitation");
      await act("requester", "swap-invite", [{
        ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
          contractId: rfqCid, choice: "InviteDealer",
          choiceArgument: { dealer: invited[i] } } }]);
      const invitationCid = await pollNewCid(requester, "UmbraSwap:SwapInvitation", invBefore);
      invitations.push({ dealer: roles[i], invitationCid });
    }
    res.json({ ok: true, signed: SIGNED_MODE, rfqCid, expiresAt, invitations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- history: settled + expired swaps for a party (queries the update stream) ----
// Active-contract queries drop archived contracts. Settled/expired RFQs live in
// the transaction history, so we read /v2/updates/flats over the full offset
// range and pull the archive/create events for the party's swap contracts.
async function queryHistory(party, templateModuleEntity) {
  const end = (await (await ledgerFetch("/v2/state/ledger-end")).json()).offset;
  const body = {
    beginExclusive: 0,
    endInclusive: end,
    filter: {
      filtersByParty: {
        [party]: {
          cumulative: [
            { identifierFilter: { TemplateFilter: { value: {
              templateId: `#${PKGN}:${templateModuleEntity}`,
              includeCreatedEventBlob: false } } } }
          ]
        }
      }
    },
    verbose: false
  };
  const r = await ledgerFetch("/v2/updates/flats", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(humanize(`${r.status} ${text}`));
  let items;
  try { items = JSON.parse(text); }
  catch { items = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  return Array.isArray(items) ? items : [];
}

// GET settled + expired swap history for a role.
// Returns the raw update entries; the UI derives outcome (settled/expired) from
// whether a SwapSettlement was created. Empty until a real swap completes.
// /v2/updates/flats returns UPDATE ENVELOPES, not contracts:
//   { update: { Transaction: { value: { events: [ { CreatedEvent: {...} } ] } } } }
// Flatten them into the same { contractId, payload } shape the rest of the app
// already speaks, and carry the ledger coordinates (offset, createdAt) through --
// those ARE the proof a trade happened, and the book shows them.
function flattenUpdates(items) {
  const out = [];
  for (const it of (items || [])) {
    const tx = it && it.update && it.update.Transaction && it.update.Transaction.value;
    if (!tx) continue;
    for (const ev of (tx.events || [])) {
      const ce = ev && ev.CreatedEvent;
      if (!ce) continue;                       // archives carry no createArgument
      out.push({
        contractId: ce.contractId,
        offset: ce.offset,
        createdAt: ce.createdAt,
        updateId: tx.updateId,
        payload: ce.createArgument
      });
    }
  }
  return out.sort((a, b) => (Number(b.offset) || 0) - (Number(a.offset) || 0));
}

app.get("/api/swap/history", async (req, res) => {
  try {
    const role = req.query.role || "requester";
    const party = await partyIdFor(role);
    const [settlements, rfqs] = await Promise.all([
      queryHistory(party, "UmbraSwap:SwapSettlement").catch(() => []),
      queryHistory(party, "UmbraSwap:SwapRfq").catch(() => [])
    ]);
    // A SwapSettlement only represents a COMPLETED trade if it was consumed by
    // ExecuteSwap / ExecuteRealSwap (both consuming). A settlement that was created but
    // never executed (swap failed -> rolled back) stays ACTIVE and must NOT appear in
    // "Your book" as a completed trade. The archive events ride along in the same
    // updates stream, so collect them here -- no extra ledger query.
    const _archived = new Set();
    for (const it of (settlements || [])) {
      const _tx = it && it.update && it.update.Transaction && it.update.Transaction.value;
      for (const ev of ((_tx && _tx.events) || [])) {
        const ae = ev && ev.ArchivedEvent;
        if (ae && ae.contractId) _archived.add(ae.contractId);
      }
    }
    const _allSettlements = flattenUpdates(settlements);
    const _done = _allSettlements.filter(x => _archived.has(x.contractId));
    const _showAll = String(req.query.all || "") === "1";
    res.json({ ok: true, role,
      settlements: _showAll ? _allSettlements : _done,
      settlementsCreated: _allSettlements.length,
      settlementsExecuted: _done.length,
      rfqs: flattenUpdates(rfqs) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/swap/rfqs", async (req, res) => {
  try {
    const rfqs = await queryActive(await partyIdFor("requester"), "UmbraSwap:SwapRfq");
    res.json({ ok: true, count: rfqs.length, rfqs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// requester invites a dealer to an RFQ
app.post("/api/swap/rfqs/:cid/invite", async (req, res) => {
  try {
    const dealer = await partyIdFor(req.body.dealer);
    const cmds = [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
        contractId: req.params.cid, choice: "InviteDealer",
        choiceArgument: { dealer } } }];
    // InviteDealer is controller `requester`. If the requester signs for itself, hand
    // the command back instead of signing it here.
    const asParty = req.body.requester || req.query.requester;
    if (req.query.build === "1" || req.body.build || isWalletParty(asParty)) {
      return res.json({ ok: true, build: true, party: asParty || await partyIdFor("requester"),
        commands: cmds, note: "sign via /api/ext/prepare + /api/ext/execute" });
    }
    const result = await act("requester", "swap-invite", cmds);
    res.json({ ok: true, signed: SIGNED_MODE, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// a dealer sees only its own invitations (role-scoped — privacy)
app.get("/api/swap/invitations", async (req, res) => {
  try {
    const role = req.query.role || "dealer1";
    const invs = await queryActive(await partyIdFor(role), "UmbraSwap:SwapInvitation");
    res.json({ ok: true, role, count: invs.length, invitations: invs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// a dealer submits a private quote (price denominated in the want asset)
app.post("/api/swap/invitations/:cid/quote", async (req, res) => {
  try {
    // A wallet dealer is addressed by its full party id, which is case-sensitive:
    // lowercasing it corrupts the namespace. Only short role names fold.
    const dealerRaw = String(req.body.dealer || "");
    const dealerRole = dealerRaw.includes("::") ? dealerRaw : dealerRaw.toLowerCase();
    const dealerParty = await partyIdFor(dealerRole); // validate
    // validUntil is MANDATORY on SubmitSwapQuote: how long this dealer's price
    // stays firm. AcceptSwapQuote asserts `now < validUntil`, so a stale price
    // cannot be lifted (see swapRejectsStaleQuote).
    // DEFAULT to the invitation's expiresAt (== the RFQ's close time): a firm
    // price should not lapse while the buyer is still able to accept. An explicit
    // validUntil/validMins in the body still wins (a dealer may quote SHORTER
    // firmness), but the default must never be shorter than the RFQ window.
    let invExpiry = null;
    try {
      const inv = (await queryActive(dealerParty, "UmbraSwap:SwapInvitation"))
        .find(c => c.contractId === req.params.cid);
      if (inv && inv.payload && inv.payload.expiresAt) invExpiry = inv.payload.expiresAt;
    } catch (e) {}
    // Default firmness = the RFQ's close time, CAPPED. That default was written when
    // every RFQ ran 15 minutes; now that a buyer can open a 1-day request, inheriting it
    // would silently commit a dealer to holding a price firm for a day. A dealer may
    // still quote longer deliberately via validUntil/validMins -- the cap only bounds
    // what it is signed up to by saying nothing.
    const FIRMNESS_CAP_MINS = Number(process.env.UMBRA_QUOTE_FIRMNESS_CAP_MINS || 30);
    const capAt = Date.now() + FIRMNESS_CAP_MINS * 60000;
    const defaultFirm = invExpiry
      ? new Date(Math.min(Date.parse(invExpiry), capAt)).toISOString()
      : new Date(Math.min(Date.now() + 5 * 60000, capAt)).toISOString();
    const validUntil = req.body.validUntil ||
      (req.body.validMins
        ? new Date(Date.now() + Number(req.body.validMins) * 60000).toISOString()
        : defaultFirm);
    const cmds = [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapInvitation`,
        contractId: req.params.cid, choice: "SubmitSwapQuote",
        choiceArgument: { price: String(req.body.price), validUntil } } }];
    // SubmitSwapQuote is controller `dealer`. A dealer trading from its own wallet
    // signs for itself, so hand the command back instead of failing inside act().
    if (req.query.build === "1" || req.body.build || isWalletParty(dealerParty)) {
      return res.json({ ok: true, build: true, party: dealerParty, commands: cmds, validUntil,
        note: "sign via /api/ext/prepare + /api/ext/execute" });
    }
    const result = await act(dealerRole, "swap-quote", cmds);
    res.json({ ok: true, signed: SIGNED_MODE, validUntil, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// role-scoped quote view — THE PRIVACY PROOF.
//   ?role=requester -> sees ALL quotes on its RFQs
//   ?role=dealer1   -> sees ONLY its own quotes (dealer2's are invisible)
//   ?role=public    -> sees NOTHING
app.get("/api/swap/quotes", async (req, res) => {
  try {
    const role = req.query.role || "requester";
    const quotes = await queryActive(await partyIdFor(role), "UmbraSwap:SwapQuote");
    res.json({ ok: true, role, count: quotes.length, quotes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Awarded-but-unsettled proposals. There was no way to list these, so anything
// driving a trade programmatically (a wallet client, a test) could not find the
// SwapProposal it had just created.
app.get("/api/swap/proposals", async (req, res) => {
  try {
    const role = req.query.role || "requester";
    const proposals = await queryActive(await partyIdFor(role), "UmbraSwap:SwapProposal");
    res.json({ ok: true, role, count: proposals.length, proposals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Proposed-but-unaccepted real swaps, the state between ProposeRealSwap and
// AcceptRealSwap. Without this a trade is invisible during exactly the window in which
// it is waiting on a counterparty's signature.
app.get("/api/swap/pending-real", async (req, res) => {
  try {
    const role = req.query.role || "requester";
    const pending = await queryActive(await partyIdFor(role), "UmbraSwap:RealSwapPending");
    res.json({ ok: true, role, count: pending.length, pending });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recorded-but-unexecuted settlements. AcceptRealSwap CONSUMES the SwapProposal, so
// after it a caller has no handle on the trade; this is how it finds one.
app.get("/api/swap/settlements", async (req, res) => {
  try {
    const role = req.query.role || "requester";
    const settlements = await queryActive(await partyIdFor(role), "UmbraSwap:SwapSettlement");
    res.json({ ok: true, role, count: settlements.length, settlements });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// requester accepts a quote -> SwapProposal
// cid-returning swap endpoints
app.post("/api/swap/quotes/:cid/accept", async (req, res) => {
  try {
    const operator = await partyIdFor("requester");
    // AcceptSwapQuote is controller `requester`. The caller must say who it is, because
    // the OPERATOR CANNOT SEE QUOTES: SwapQuote is `signatory dealer, observer requester`
    // and the venue is deliberately not on it -- that is the blind auction working. So
    // there is no server-side lookup to fall back on; an unnamed caller is the demo party.
    const requester = req.body && req.body.requester
      ? await partyIdFor(req.body.requester)
      : operator;
    // The venue CANNOT read the quote -- SwapQuote deliberately excludes the operator,
    // which is the blind auction working -- so for a wallet requester the terms have to
    // come from the caller. That is not a trust hole: the operator re-derives the fee
    // and refuses to execute a settlement that understates it (see executeRealSettlement),
    // and ExecuteRealSwap is the one step the venue controls.
    let quote = null;
    try {
      quote = (await queryActive(requester, "UmbraSwap:SwapQuote"))
        .find(c => c.contractId === req.params.cid);
    } catch (e) { /* a wallet requester's quotes are not ours to read */ }
    const qp = (quote && quote.payload) || {};
    const feePrice = qp.price != null ? qp.price : (req.body && req.body.price);
    const feeWantSym = (qp.wantAsset && qp.wantAsset.symbol) || (req.body && req.body.wantSymbol);
    const venueFeeAmount = (feePrice != null && feeWantSym) ? feeFor(feeWantSym, feePrice) : null;

    const cmds = [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapQuote`,
        contractId: req.params.cid, choice: "AcceptSwapQuote",
        choiceArgument: {
          venueFeeParty: venueFeeAmount ? FEE_PARTY : null,
          venueFeeAmount: venueFeeAmount,
        } } }];
    if (req.query.build === "1" || (req.body && req.body.build) || isWalletParty(requester)) {
      return res.json({ ok: true, build: true, party: requester, commands: cmds,
        fee: venueFeeAmount ? { party: FEE_PARTY, amount: venueFeeAmount, bps: FEE_BPS,
                                symbol: feeWantSym } : null,
        note: "sign via /api/ext/prepare + /api/ext/execute" });
    }
    const before = await idSetSwap(requester, "UmbraSwap:SwapProposal");
    await act("requester", "swap-accept", cmds);
    const proposalCid = await pollNewCid(requester, "UmbraSwap:SwapProposal", before);
    res.json({ ok: true, signed: SIGNED_MODE, proposalCid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// requester commits its offer leg (supplies a backing AssetHolding cid)
// ---- OPTION B: settle the awarded proposal with REAL tokens -----------------
// Runs the real allocate-both-legs -> RecordRealSwap -> atomic settle chain on the
// EXISTING proposal the UI awarded (settles the actual quote, no internal re-auction).
// Best-effort: release an allocation back to free holdings (used to roll back a
// failed settlement so funds are never stranded/locked).
async function withdrawLeg(leg, adminHint) {
  try {
    if (!leg || !leg.cid) return;
    // A leg the sender allocated with their own wallet is not ours to unwind: we have
    // no authority over it, and undoing someone's own commitment is theirs to do. The
    // allocation's allocateBefore/settleBefore deadline releases it if the trade dies.
    if (leg.external) {
      console.log("[withdrawLeg] skipping externally-allocated leg", String(leg.cid).slice(0, 16),
                  "- owner must withdraw it (or let it expire)");
      return;
    }
    const party = leg.senderParty; // may be undefined; withdraw resolves via role too
    const body = { registry: leg.registry };
    // find which role owns it (sender) so withdraw can actAs it
    const r = await fetch("http://localhost:" + (process.env.PORT || 4000) +
      "/api/real/withdraw/" + leg.cid + "?registry=" + encodeURIComponent(leg.registry || ""), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: leg.senderRole || "requester" }),
    });
    await r.text();
  } catch (e) { /* best-effort rollback */ }
}

// On settlement failure: archive the orphaned SwapProposal and re-invite the dealer
// so it can quote again (its invitation+quote were consumed by quote+accept). This
// makes the failure path symmetric -- the dealer that quoted isn't silently frozen out.
// Dealer-facing alerts for failed swaps. In-memory (resets on restart) -- enough to tell
// a dealer "your trade failed, please re-quote". Read via GET /api/swap/alerts?role=...
const SWAP_ALERTS = [];
let SWAP_ALERT_SEQ = 0;
// Alerts used to live forever: no id, no expiry, no way to acknowledge one. The
// dealer's Close button only set a local flag, and the 8s poll re-showed the same
// alert immediately -- so a failed trade sat on the dealer desk until the server
// was restarted. Now each alert has an id, can be acknowledged, and ages out.
const SWAP_ALERT_TTL_MS = Number(process.env.SWAP_ALERT_TTL_MS || 30 * 60000);
function pushSwapAlert(dealerRole, offerAsset, wantAsset, reason, opts) {
  SWAP_ALERTS.push({
    id: ++SWAP_ALERT_SEQ,
    at: new Date().toISOString(),
    dealer: String(dealerRole || "").toLowerCase(),
    kind: "swap-failed",
    pair: `${(offerAsset && offerAsset.symbol) || "?"}/${(wantAsset && wantAsset.symbol) || "?"}`,
    reason: String(reason || "settlement failed"),
    // Whether the RFQ was actually re-opened. The banner used to promise "you can
    // re-quote" unconditionally, including when no live RFQ was found to re-invite
    // on -- which is why it pointed at a quote that was not there.
    reinvited: !!(opts && opts.reinvited),
    dismissed: false,
  });
  while (SWAP_ALERTS.length > 50) SWAP_ALERTS.shift();
}
function liveSwapAlerts(role) {
  const cutoff = Date.now() - SWAP_ALERT_TTL_MS;
  return SWAP_ALERTS.filter(a =>
    !a.dismissed &&
    new Date(a.at).getTime() >= cutoff &&
    (!role || a.dealer === role));
}

async function recoverFailedSwap(requester, proposalCid, dealerRole, offerAsset, wantAsset, reason) {
  let reinvited = false;

  // 1. Archive the dead proposal. NOTE: SwapProposal.Archive needs ALL signatories
  //    (requester AND dealer). act() is single-party, so in SIGNED mode this cannot
  //    succeed -- that is expected, not fatal. Log it; never let it block step 2.
  try {
    await act("requester", "swap-prop-archive", [{ ExerciseCommand: {
      templateId: `#${PKGN}:UmbraSwap:SwapProposal`, contractId: proposalCid,
      choice: "Archive", choiceArgument: {} } }]);
  } catch (e) {
    console.log("[recoverFailedSwap] proposal archive failed (expected in signed mode):",
                e && e.message);
  }

  // 2. Re-invite the dealer on the still-live RFQ so it can quote again. InviteDealer is
  //    controlled by the requester alone, so this DOES work single-party in signed mode.
  try {
    const rfqs = await queryActive(requester, "UmbraSwap:SwapRfq");
    const rfq = rfqs.find(r => r.payload &&
      r.payload.offerAsset && r.payload.offerAsset.symbol === offerAsset.symbol &&
      r.payload.wantAsset && r.payload.wantAsset.symbol === wantAsset.symbol);
    if (!rfq) {
      console.log("[recoverFailedSwap] no live RFQ for", offerAsset && offerAsset.symbol,
                  "/", wantAsset && wantAsset.symbol, "- cannot re-invite");
    } else {
      const dealerParty = await partyIdFor(dealerRole);
      const invs = await queryActive(requester, "UmbraSwap:SwapInvitation");
      const has = invs.some(iv => iv.payload && iv.payload.rfqCid === rfq.contractId &&
        iv.payload.dealer === dealerParty);
      if (has) {
        reinvited = true;                     // dealer can already quote again
      } else {
        await act("requester", "swap-reinvite", [{ ExerciseCommand: {
          templateId: `#${PKGN}:UmbraSwap:SwapRfq`, contractId: rfq.contractId,
          choice: "InviteDealer", choiceArgument: { dealer: dealerParty } } }]);
        reinvited = true;
        console.log("[recoverFailedSwap] re-invited", dealerRole, "on rfq",
                    String(rfq.contractId).slice(0, 16));
      }
    }
  } catch (e) {
    console.log("[recoverFailedSwap] re-invite FAILED:", e && e.message);
  }

  // 3. Always leave the dealer a signal, even if the re-invite failed -- but say
  //    which of the two happened, so the banner never promises a re-quote that
  //    isn't actually available.
  try { pushSwapAlert(dealerRole, offerAsset, wantAsset, reason, { reinvited }); } catch (e) {}

  return reinvited;
}

// Dealer polls this to learn a swap it quoted on failed (and that it may re-quote).
app.get("/api/swap/alerts", async (req, res) => {
  try {
    const role = String(req.query.role || "").toLowerCase();
    const since = req.query.since ? String(req.query.since) : null;
    let out = liveSwapAlerts(role);
    if (since) out = out.filter(a => a.at > since);
    res.json({ ok: true, role: role || null, alerts: out.slice(-10).reverse() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dealer acknowledges an alert (or all of theirs). Without this the only way to
// clear a failed-swap banner was to restart the backend.
app.post("/api/swap/alerts/ack", async (req, res) => {
  try {
    const b = req.body || {};
    const role = String(b.role || "").toLowerCase();
    const id = b.id === undefined || b.id === null ? null : Number(b.id);
    let n = 0;
    for (const a of SWAP_ALERTS) {
      if (role && a.dealer !== role) continue;
      if (id !== null && a.id !== id) continue;
      if (!a.dismissed) { a.dismissed = true; n++; }
    }
    res.json({ ok: true, dismissed: n, remaining: liveSwapAlerts(role).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// EXTERNAL WALLET SIGNING -- the venue coordinates, the wallet signs.
//
// Everywhere else in this file the backend signs on a party's behalf, which it can
// only do because ext-parties.local.txt holds that party's private key. A user
// arriving with their own Canton wallet must never hand that key over, so these two
// endpoints expose the outer steps of interactive submission and leave the middle
// one -- the signature -- entirely to the wallet.
//
//   POST /api/ext/prepare  -> { commandId, preparedTransaction, preparedTransactionHash, hashingSchemeVersion }
//   wallet signs preparedTransactionHash with its ed25519 key
//   POST /api/ext/execute  -> submits it, and reports the LEDGER'S verdict
//
// Authority note: /prepare grants nothing. A prepared transaction is inert without a
// signature, and the ledger checks that signature against the party's registered key,
// so a caller holding no key can do nothing with either endpoint.
// ---------------------------------------------------------------------------
// Onboard a party from a public key the wallet supplies. Two steps, because only the
// middle one (signing the topology multiHash) needs the private key.
//   POST /api/ext/onboard/prepare  { publicKey, partyHint? } -> { partyId, fingerprint, multiHash, topologyTransactions }
//   wallet signs multiHash
//   POST /api/ext/onboard/confirm  { partyId, fingerprint, topologyTransactions, multiHashSignature }
app.post("/api/ext/onboard/prepare", async (req, res) => {
  try {
    const b = req.body || {};
    const out = await onboardWalletPrepare(b.publicKey, b.partyHint);
    res.json(Object.assign({ ok: true }, out, {
      note: "sign multiHash (base64, ed25519) with the wallet's key, then POST /api/ext/onboard/confirm",
    }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/ext/onboard/confirm", async (req, res) => {
  try {
    const b = req.body || {};
    for (const k of ["partyId", "fingerprint", "topologyTransactions", "multiHashSignature"]) {
      if (!b[k]) return res.status(400).json({ error: "need " + k });
    }
    const rec = await onboardWalletConfirm(b);
    res.json({ ok: true, party: rec, privateKeyHeldByServer: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Parties onboarded this way, and the point of the exercise: none of them has a key here.
// ---- DEV WALLET (a test double, never a product feature) --------------------
//
// The browser signing path cannot be exercised without a CIP-0103 wallet, and on
// DevNet there isn't one to hand: the SDK's default gateway list points at a
// Splice Wallet Gateway on localhost:3030 that nobody is running. This endpoint
// stands in for that wallet so the APP's plumbing can be proven.
//
// It proves nothing about custody -- it reads a private key off this machine, by
// construction. The custody property is proven elsewhere, by the wallet_*_demo
// scripts. Keep the two claims apart.
//
// OFF unless UMBRA_DEV_WALLET=1 and a key source is named: UMBRA_DEV_WALLET_KEY for a
// single key file, or UMBRA_DEV_WALLET_KEYDIR for a directory of them. The directory
// form exists because the venue needs THREE parties on screen at once (a requester and
// two competing dealers); one key can only ever act as one of them.
const DEV_WALLET = process.env.UMBRA_DEV_WALLET === "1";
const DEV_WALLET_KEY = process.env.UMBRA_DEV_WALLET_KEY || "";
const DEV_WALLET_KEYDIR = process.env.UMBRA_DEV_WALLET_KEYDIR || "";

// Find the key file that owns `party`. Keyfiles record their own partyId (written by
// wallet_onboard_demo.js), so this matches rather than guesses.
function devKeyFor(party) {
  const fsx = require("fs"), pathx = require("path");
  const tryFile = (f) => {
    try {
      const k = JSON.parse(fsx.readFileSync(f, "utf8"));
      return k && k.privDer && (!k.partyId || k.partyId === party) ? k : null;
    } catch (e) { return null; }
  };
  if (DEV_WALLET_KEYDIR) {
    for (const f of fsx.readdirSync(DEV_WALLET_KEYDIR)) {
      if (!f.endsWith(".json")) continue;
      const k = tryFile(pathx.join(DEV_WALLET_KEYDIR, f));
      if (k && k.partyId === party) return k;
    }
  }
  return DEV_WALLET_KEY ? tryFile(DEV_WALLET_KEY) : null;
}
const DEV_WALLET_READY = () => DEV_WALLET && !!(DEV_WALLET_KEY || DEV_WALLET_KEYDIR);

app.post("/api/dev/wallet/submit", async (req, res) => {
  if (!DEV_WALLET_READY()) {
    return res.status(404).json({ error: "dev wallet is disabled (set UMBRA_DEV_WALLET=1 and UMBRA_DEV_WALLET_KEY or UMBRA_DEV_WALLET_KEYDIR)" });
  }
  try {
    const b = req.body || {};
    const party = b.party;
    if (!party || !String(party).includes("::")) return res.status(400).json({ error: "need party" });
    const rec = loadWallets()[party];
    if (!rec) return res.status(404).json({ error: "not an onboarded wallet party: " + party });
    const key = devKeyFor(party);
    if (!key) return res.status(404).json({ error: "no dev key file holds " + String(party).slice(0, 28) + "…" });

    const offBefore = await ledgerEnd();
    const prep = await prepareInteractive(party, b.commands || [], b.tag || "devwallet",
      b.disclosedContracts || []);
    const sig = require("crypto").sign(null,
      Buffer.from(prep.preparedTransactionHash, "base64"),
      require("crypto").createPrivateKey({ key: Buffer.from(key.privDer, "base64"), format: "der", type: "pkcs8" })
    ).toString("base64");
    await executeSigned({ partyId: party, commandId: prep.commandId,
      preparedTransaction: prep.preparedTransaction,
      hashingSchemeVersion: prep.hashingSchemeVersion,
      signature: sig, signedBy: rec.fingerprint });
    const v = await awaitCompletion(party, prep.commandId, offBefore);
    if (v.found && !v.ok) return res.status(400).json({ error: v.message || ("code " + v.code) });
    res.json({ ok: true, commandId: prep.commandId, committed: !!v.found });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dev-wallet ledger proxy. A real CIP-0103 wallet sends ledgerApi() to the USER's
// validator; this forwards to Umbra's, which is exactly the part a stub cannot
// imitate. It exists so the UI's read path can be exercised, not to prove anything
// about a foreign-hosted party. Same double gate as the signing endpoint.
app.post("/api/dev/wallet/ledger", async (req, res) => {
  if (!DEV_WALLET_READY()) {
    return res.status(404).json({ error: "dev wallet is disabled" });
  }
  try {
    const resource = String(req.query.resource || "");
    const method = String(req.query.method || "get").toUpperCase();
    if (!resource.startsWith("/v2/")) return res.status(400).json({ error: "resource must start with /v2/" });
    const body = (req.body && req.body.body) || null;
    const r = await ledgerFetch(resource, method === "GET"
      ? undefined
      : { method, body: JSON.stringify(body || {}) });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text.slice(0, 300) });
    try { return res.json(JSON.parse(text)); }
    catch { return res.json(text.trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/ext/wallets", async (req, res) => {
  try {
    const s = loadWallets();
    res.json({ ok: true, count: Object.keys(s).length,
      wallets: Object.values(s).map(w => ({ partyId: w.partyId, fingerprint: w.fingerprint,
        onboardedAt: w.onboardedAt, privateKeyHeldByServer: false })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/ext/prepare", async (req, res) => {
  try {
    const b = req.body || {};
    const party = (b.party && String(b.party).includes("::"))
      ? b.party : await partyIdFor(b.role || "requester");
    if (!Array.isArray(b.commands) || !b.commands.length) {
      return res.status(400).json({ error: "need commands[] (JSON Ledger API command objects)" });
    }
    const out = await prepareInteractive(party, b.commands, b.tag || "wallet",
      b.disclosedContracts || []);
    res.json(Object.assign({ ok: true }, out, {
      note: "sign preparedTransactionHash (base64, ed25519) with the party's own key, " +
            "then POST the signature to /api/ext/execute",
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/ext/execute", async (req, res) => {
  try {
    const b = req.body || {};
    const party = (b.party && String(b.party).includes("::"))
      ? b.party : await partyIdFor(b.role || "requester");
    for (const k of ["preparedTransaction", "hashingSchemeVersion", "signature", "signedBy"]) {
      if (!b[k]) return res.status(400).json({ error: "need " + k });
    }
    const offBefore = await ledgerEnd();
    await executeSigned({
      partyId: party, commandId: b.commandId,
      preparedTransaction: b.preparedTransaction,
      hashingSchemeVersion: b.hashingSchemeVersion,
      signature: b.signature, signedBy: b.signedBy, submissionId: b.submissionId,
    });
    // execute is async-accepted, so a bare 200 says only "admitted". Report what the
    // ledger actually decided -- the same lesson the settlement path had to learn.
    let verdict = { found: false };
    if (b.commandId) verdict = await awaitCompletion(party, b.commandId, offBefore);
    if (verdict.found && !verdict.ok) {
      return res.status(400).json({ ok: false, commandId: b.commandId,
        error: verdict.message || ("code " + verdict.code) });
    }
    res.json({ ok: true, commandId: b.commandId || null, committed: !!verdict.found,
      note: verdict.found ? "committed on-ledger"
        : "admitted; no verdict read (set UMBRA_COMPLETIONS=1 to confirm commits)" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The atomic registry execute, as ONE on-ledger choice.
//
// Extracted from settle-real so it can also be reached with nothing but a settlement
// cid. That matters because AcceptRealSwap CONSUMES the SwapProposal: once a
// counterparty signs its accept, settle-real can no longer find the trade by proposal
// cid, and the execute step became unreachable. (The older
// /api/swap/settlements/:cid/execute exercises stand-in ExecuteSwap, which the ledger
// refuses for real legs: "ExecuteSwap is for stand-in settlements".)
//
// Throws on failure; rollback is the caller's decision, since a standalone execute
// must not unilaterally withdraw a counterparty's allocation.
async function executeRealSettlement(o) {
  const { requester, dealerParty, settlementCid, offLeg, wantLeg, feeLeg,
          offAdmin, wantAdmin, feeAdmin } = o;
  // ExecuteRealSwap is `controller operator`. That was indistinguishable from the
  // requester while the venue WAS the requester; with a wallet requester they differ,
  // and submitting as the requester would be submitting as the wrong party.
  const operator = o.operator || requester;
  const offerCtx = await execTransferContext(offLeg.registry, offAdmin, offLeg.cid);
  const wantCtx  = await execTransferContext(wantLeg.registry, wantAdmin, wantLeg.cid);
  // The fee leg is a third registry allocation and needs its own choice context, or the
  // nested Allocation_ExecuteTransfer inside ExecuteRealSwap has nothing to execute with.
  const feeCtx = feeLeg
    ? await execTransferContext(feeLeg.registry, feeAdmin || wantAdmin, feeLeg.cid)
    : null;
  const _dseen = {}; const disclosed = [];
  for (const ctx of [offerCtx, wantCtx, feeCtx].filter(Boolean)) {
    for (const d of (ctx.disclosedContracts || [])) {
      if (_dseen[d.contractId]) continue; _dseen[d.contractId] = true;
      disclosed.push({ templateId: d.templateId, contractId: d.contractId,
        createdEventBlob: d.createdEventBlob, synchronizerId: d.synchronizerId || "" });
    }
  }
  // Disclose both allocations. The WANT leg belongs to the dealer, so it must be read
  // from the DEALER's view -- querying it as requester silently returns nothing and the
  // prepare then fails with CONTRACT_NOT_FOUND.
  try {
    const offDiscs  = await allocDisclosure([offLeg.cid], requester);
    const wantDiscs = await allocDisclosure([wantLeg.cid], dealerParty);
    // The fee leg is the DEALER's allocation too, so it reads from the dealer's view for
    // the same reason the want leg does.
    const feeDiscs  = feeLeg ? await allocDisclosure([feeLeg.cid], dealerParty) : [];
    for (const d of [...offDiscs, ...wantDiscs, ...feeDiscs]) {
      if (_dseen[d.contractId]) continue; _dseen[d.contractId] = true;
      disclosed.push(d);
    }
    if (!wantDiscs.length) console.error("[exec-real] WARN: want-leg blob not found even in dealer view for", wantLeg.cid);
  } catch (adErr) { console.error("[exec-real] allocDisclosure failed (continuing):", adErr && adErr.message); }
  // And the SwapSettlement itself: it was created by the dealer's AcceptRealSwap, so
  // the requester's participant has no copy to exercise against without this.
  try {
    const setDisc = await templateDisclosure("UmbraSwap:SwapSettlement", settlementCid, operator);
    if (setDisc && !_dseen[setDisc.contractId]) { _dseen[setDisc.contractId] = true; disclosed.push(setDisc); }
    else if (!setDisc) console.error("[exec-real] settlement blob not found for", settlementCid);
  } catch (sdErr) { console.error("[exec-real] settlement disclosure failed (continuing):", sdErr && sdErr.message); }

  // ExecuteRealSwap is `controller operator`, and here operator == requester. Authority
  // for the nested Allocation_ExecuteTransfer comes from the SwapSettlement signatories
  // (gathered via propose/accept), not from actAs -- so a single-party submission works.
  const execCmd = {
    commandId: "execreal-" + Date.now(),
    actAs: [operator],
    commands: [{ ExerciseCommand: {
      templateId: `#${PKGN}:UmbraSwap:SwapSettlement`,
      contractId: settlementCid,
      choice: "ExecuteRealSwap",
      choiceArgument: {
        offerArgs: { context: offerCtx.choiceContextData || { values: {} }, meta: { values: {} } },
        wantArgs:  { context: wantCtx.choiceContextData  || { values: {} }, meta: { values: {} } },
        feeArgs: feeCtx
          ? { context: feeCtx.choiceContextData || { values: {} }, meta: { values: {} } }
          : null,
      },
    } }],
    disclosedContracts: disclosed,
  };
  dbg("[CTXDBG] settlementCid:", (settlementCid || "").slice(0, 24));
  dbg("[CTXDBG] FINAL disclosed set:", JSON.stringify(disclosed.map(d => ({ t: (d.templateId || "").split(":").pop(), c: (d.contractId || "").slice(0, 20) }))));
  await realSubmit(execCmd, "rexecreal");
}

// Accept a pending real swap. ProposeRealSwap is CONSUMING: it archives the
// SwapProposal and leaves a RealSwapPending, so once the requester has proposed there
// is no proposal left for settle-real to resume from. This is the rung between them.
// AcceptRealSwap is `controller dealer`, so a wallet dealer gets the command to sign.
app.post("/api/swap/pending/:cid/accept-real", async (req, res) => {
  try {
    const operator = await partyIdFor("requester");   // observer on RealSwapPending
    const pend = (await queryActive(operator, "UmbraSwap:RealSwapPending"))
      .find(c => c.contractId === req.params.cid);
    if (!pend) return res.status(404).json({ error: "pending swap not found: " + req.params.cid });
    const dealerParty = pend.payload.dealer;
    const cmds = [{ ExerciseCommand: {
      templateId: `#${PKGN}:UmbraSwap:RealSwapPending`, contractId: req.params.cid,
      choice: "AcceptRealSwap", choiceArgument: {} } }];
    if (req.query.build === "1" || (req.body && req.body.build) || isWalletParty(dealerParty)) {
      return res.json({ ok: true, build: true, party: dealerParty, commands: cmds,
        note: "sign via /api/ext/prepare + /api/ext/execute, then POST /api/swap/settlements/<cid>/execute-real" });
    }
    let dealerRole = await roleOfParty(dealerParty);
    if (!dealerRole) dealerRole = String(dealerParty).split("::")[0].toLowerCase();
    const before = await idSetSwap(operator, "UmbraSwap:SwapSettlement");
    const accBefore = await ledgerEnd();
    const accRes = await act(dealerRole, "swap-accept-real", cmds);
    const committed = await confirmCommitted(dealerParty, accRes, accBefore, "AcceptRealSwap");
    const settlementCid = await pollNewCid(operator, "UmbraSwap:SwapSettlement", before,
      committed ? POLL_TRIES_COMMITTED : POLL_TRIES);
    res.json({ ok: true, settlementCid,
      note: "now POST /api/swap/settlements/" + settlementCid + "/execute-real" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Execute a settlement that already exists on-ledger. This is the step that actually
// moves the assets; both parties have already committed by allocating and accepting.
app.post("/api/swap/settlements/:cid/execute-real", async (req, res) => {
  try {
    // Read as the OPERATOR (observer on every SwapSettlement) and take the parties from
    // the payload: with a wallet requester the venue is not the requester, and querying
    // as the demo party found neither the settlement nor the requester's allocation.
    const operator = await partyIdFor("requester");
    const setl = (await queryActive(operator, "UmbraSwap:SwapSettlement"))
      .find(c => c.contractId === req.params.cid);
    if (!setl) return res.status(404).json({ error: "settlement not found: " + req.params.cid });
    const p = setl.payload || {};
    if (p.settledVia !== "real") {
      return res.status(400).json({ error: "settledVia=" + p.settledVia + "; use /execute for stand-in settlements" });
    }
    // Rebuild each leg from the allocation it points at -- the registry and admin come
    // off the allocation itself, so no proposal is needed.
    const requester = p.requester || operator;
    const dealerParty = p.dealer;
    const allocs = [...await queryAllocations(requester), ...await queryAllocations(dealerParty)];
    const findAl = cid => allocs.find(a => a.contractId === cid);
    const offAl = findAl(p.offerAllocCid), wantAl = findAl(p.wantAllocCid);
    if (!offAl) return res.status(409).json({ error: "offer allocation is gone (withdrawn or already executed): " + p.offerAllocCid });
    if (!wantAl) return res.status(409).json({ error: "want allocation is gone (withdrawn or already executed): " + p.wantAllocCid });

    // Re-derive the fee from the settlement's own terms and refuse to execute if the
    // trade shortchanges it. The requester assembles AcceptSwapQuote, so the amount on
    // the proposal is only as honest as whoever signed it; this is the venue's check,
    // at the one step the venue controls.
    const wantSymbol = (p.wantAsset && p.wantAsset.symbol) || "";
    const expectFee = feeFor(wantSymbol, p.price);
    if (expectFee && Number(p.feeAmount || 0) < Number(expectFee) - 1e-12) {
      return res.status(409).json({
        error: "settlement understates the venue fee: carries " + (p.feeAmount || "none") +
               " " + wantSymbol + ", expected " + expectFee + " (" + FEE_BPS + " bps or floor)",
      });
    }
    const feeAl = p.feeAllocCid ? findAl(p.feeAllocCid) : null;
    if (p.feeAllocCid && !feeAl) {
      return res.status(409).json({ error: "fee allocation is gone (withdrawn or already executed): " + p.feeAllocCid });
    }

    await executeRealSettlement({
      requester, dealerParty, operator, settlementCid: req.params.cid,
      offLeg: { cid: p.offerAllocCid, registry: registryForAdmin(offAl.admin) },
      wantLeg: { cid: p.wantAllocCid, registry: registryForAdmin(wantAl.admin) },
      feeLeg: feeAl ? { cid: p.feeAllocCid, registry: registryForAdmin(feeAl.admin) } : null,
      offAdmin: offAl.admin, wantAdmin: wantAl.admin,
      feeAdmin: feeAl ? feeAl.admin : null,
    });
    res.json({ ok: true, executed: req.params.cid,
      offer: p.offerAmount + " " + (p.offerAsset && p.offerAsset.symbol),
      want: p.price + " " + (p.wantAsset && p.wantAsset.symbol) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/swap/proposals/:cid/settle-real", async (req, res) => {
  const steps = [];
  try {
    // Read the proposal AS THE OPERATOR (the venue), which is an observer on every
    // SwapProposal, then take the requester from the payload. Hardcoding the demo
    // requester here meant a proposal raised by a wallet party was invisible, and the
    // isWalletParty(requester) branch below could never fire.
    const operator = await partyIdFor("requester");
    const prop = (await queryActive(operator, "UmbraSwap:SwapProposal"))
      .find(c => c.contractId === req.params.cid);
    if (!prop) return res.status(404).json({ error: "proposal not found: " + req.params.cid });
    const p = prop.payload;
    const requester = p.requester || operator;
    let dealerRole = await roleOfParty(p.dealer);
    if (!dealerRole) dealerRole = String(p.dealer).split("::")[0].toLowerCase(); // hint fallback
    const offerAsset = p.offerAsset, wantAsset = p.wantAsset;
    const offerAmount = p.offerAmount, wantAmount = p.price;

    // The settlement reference and leg names MUST match what the AllocationRequest view
    // advertises, or a leg allocated by an external wallet can never be matched to this
    // trade. The view uses the proposal's tradeId and the leg keys "offer"/"want".
    // v8 proposals have no tradeId, so fall back to the previous generated id.
    const settleId = p.tradeId || ("umbra-uiswap-" + Date.now());
    const dealerPartyId = await partyIdFor(dealerRole);

    // Look for ALREADY-ALLOCATED legs before looking for spendable holdings. Allocating
    // a leg locks the holding, so on a resumed call the sender legitimately has no free
    // balance left -- checking holdings first reported "has no real cETH" about a party
    // that had just committed exactly that cETH.
    const offInstrExp = instrumentIdForSymbol(offerAsset.symbol);
    const wantInstrExp = instrumentIdForSymbol(wantAsset.symbol);
    const offPre = await findExistingAllocation(requester, settleId, "offer", offInstrExp, offerAmount);
    const wantPre = await findExistingAllocation(dealerPartyId, settleId, "want", wantInstrExp, wantAmount);

    // Instrument + admin come off the allocation when there is one, off a spendable
    // holding otherwise, and off the proposal as a last resort (a wallet that has not
    // allocated yet may have nothing free for us to inspect).
    let offAdmin = offerAsset.admin, offInstr = offInstrExp;
    if (offPre) { offAdmin = offPre.admin || offAdmin; offInstr = offPre.instrument || offInstr; }
    else {
      const offCands = await realHoldingBySymbol("requester", offerAsset.symbol, offerAmount);
      const offPick = offCands.length ? offCands[0] : (offCands.combo && offCands.combo[0]);
      if (offPick) { offAdmin = offPick.admin; offInstr = offPick.id; }
      else if (!isWalletParty(requester)) {
        throw new Error("requester has no real " + offerAsset.symbol + " totalling >= " + offerAmount);
      }
    }
    let wantAdmin = wantAsset.admin, wantInstr = wantInstrExp;
    if (wantPre) { wantAdmin = wantPre.admin || wantAdmin; wantInstr = wantPre.instrument || wantInstr; }
    else {
      const wantCands = await realHoldingBySymbol(dealerRole, wantAsset.symbol, wantAmount);
      const wantPick = wantCands.length ? wantCands[0] : (wantCands.combo && wantCands.combo[0]);
      if (wantPick) { wantAdmin = wantPick.admin; wantInstr = wantPick.id; }
      else if (!isWalletParty(dealerPartyId)) {
        throw new Error(dealerRole + " has no real " + wantAsset.symbol + " totalling >= " + wantAmount);
      }
    }

    // Prefer a leg the sender allocated with their OWN wallet; allocate on their behalf
    // only when they haven't. This is what lets a party bring their own Canton wallet:
    // Umbra stops needing their key for the leg they already committed themselves.
    // A leg whose sender signs for itself must be allocated BY that party. If it has
    // not done so yet, stop and say what is needed rather than trying to sign for it.
    const needAlloc = (party, instr) => res.status(202).json({
      ok: false, status: "awaiting-allocation",
      awaiting: instr, proposalCid: req.params.cid, settleId, steps,
      note: "This leg belongs to a party that signs for itself. Allocate it with that " +
            "party's own key, then call settle-real again -- it resumes from here.",
    });

    let offLeg;
    if (offPre) {
      offLeg = { cid: offPre.contractId, registry: registryForAdmin(offAdmin), senderRole: "requester", senderParty: requester, external: true };
      steps.push("offer leg was already allocated by the requester's own wallet (" + offerAmount + " " + offerAsset.symbol + ")");
    } else if (isWalletParty(requester)) {
      return needAlloc(requester, allocationInstruction(requester, dealerPartyId, offAdmin, offInstr, offerAmount, settleId, "offer"));
    } else {
      // Pass the actual party ids, not the literal role "requester": with a wallet
      // requester that string resolves to the DEMO party, and the want leg was paid to
      // the venue instead of to the party that raised the RFQ.
      offLeg = await allocateRealLeg(requester, dealerPartyId, offAdmin, offInstr,
        offerAsset.symbol, offerAmount, settleId, "offer");
      steps.push("allocated real offer leg (" + offerAmount + " " + offerAsset.symbol + ")");
    }

    let wantLeg;
    if (wantPre) {
      wantLeg = { cid: wantPre.contractId, registry: registryForAdmin(wantAdmin), senderRole: dealerRole, senderParty: dealerPartyId, external: true };
      steps.push("want leg was already allocated by the dealer's own wallet (" + wantAmount + " " + wantAsset.symbol + ")");
    } else if (isWalletParty(dealerPartyId)) {
      return needAlloc(dealerPartyId, allocationInstruction(dealerPartyId, requester, wantAdmin, wantInstr, wantAmount, settleId, "want"));
    } else {
      wantLeg = await allocateRealLeg(dealerRole, requester, wantAdmin, wantInstr,
        wantAsset.symbol, wantAmount, settleId, "want");
      steps.push("allocated real want leg (" + wantAmount + " " + wantAsset.symbol + ")");
    }

    // Third leg: the venue's fee, sent by the DEALER in the want asset. Treated exactly
    // like the other two -- a dealer that signs for itself must allocate this one too,
    // so the fee cannot be imposed on it without its own signature.
    let feeLeg = null;
    const feeAmt = p.feeAmount, feeParty = p.feeParty;
    const feeDue = !!(feeParty && feeAmt && Number(feeAmt) > 0);
    if (feeDue) {
      const feePre = await findExistingAllocation(dealerPartyId, settleId, "fee", wantInstr, feeAmt);
      if (feePre) {
        feeLeg = { cid: feePre.contractId, registry: registryForAdmin(wantAdmin),
                   senderRole: dealerRole, senderParty: dealerPartyId, external: true };
        steps.push("fee leg already allocated by the dealer's own wallet (" + feeAmt + " " + wantAsset.symbol + ")");
      } else if (isWalletParty(dealerPartyId)) {
        return needAlloc(dealerPartyId, allocationInstruction(dealerPartyId, feeParty,
          wantAdmin, wantInstr, feeAmt, settleId, "fee"));
      } else {
        feeLeg = await allocateRealLeg(dealerRole, feeParty, wantAdmin, wantInstr,
          wantAsset.symbol, feeAmt, settleId, "fee");
        steps.push("allocated venue fee leg (" + feeAmt + " " + wantAsset.symbol + ")");
      }
    }

    // record the real settlement on the awarded proposal (both principals authorize)
    let refMid = null;
    try { refMid = await refMidFor(offerAsset.symbol, wantAsset.symbol); } catch (e) {}
    const b = await idSetSwap(requester, "UmbraSwap:SwapSettlement");
    let settlementCid;
    if (SIGNED_MODE) {
      // single-party propose/accept (interactive-submission is single-party only):
      // requester proposes (signs), dealer accepts (signs) -> SwapSettlement.
      const pb = await idSetSwap(requester, "UmbraSwap:RealSwapPending");
      // Tracks whether ProposeRealSwap actually reached the ledger. If it did, rolling
      // back the allocations would strand a LIVE RealSwapPending pointing at withdrawn
      // allocations -- that is precisely how the orphaned pending contracts were made.
      let proposeCommitted = false;
      // Who signs for themselves? A wallet party has no key here, so we must hand it
      // the command instead of calling act() -- which would (correctly) refuse.
      const requesterIsWallet = isWalletParty(requester);
      const dealerIsWallet = isWalletParty(dealerPartyId);
      const proposeCmd = [{ ExerciseCommand: {
        templateId: `#${PKGN}:UmbraSwap:SwapProposal`, contractId: req.params.cid,
        choice: "ProposeRealSwap",
        choiceArgument: { realOfferAllocCid: offLeg.cid, realWantAllocCid: wantLeg.cid,
          realRefMid: refMid, realFeeAllocCid: feeLeg ? feeLeg.cid : null } } }];
      const awaitSig = (step, party, commands) => res.status(202).json({
        ok: false, status: "awaiting-signature",
        awaiting: { step, party, commands },
        proposalCid: req.params.cid, settleId, steps,
        note: "This party signs for itself. POST { party, commands } to /api/ext/prepare, " +
              "sign preparedTransactionHash, POST to /api/ext/execute, then call settle-real " +
              "again -- it resumes from where it stopped.",
      });

      try {
        // --- step 1: ProposeRealSwap (controller: requester) ---
        let pendingCid = null;
        const prevPending = await findPendingForLegs(requester, offLeg.cid, wantLeg.cid);
        if (prevPending) {
          pendingCid = prevPending.contractId;
          proposeCommitted = true;
          steps.push("resumed: RealSwapPending for these legs already exists");
        } else if (requesterIsWallet) {
          return awaitSig("ProposeRealSwap", requester, proposeCmd);
        } else {
          const offBefore = await ledgerEnd();
          const propRes = await act("requester", "swap-propose-real", proposeCmd);
          // Ask the ledger what happened instead of guessing from a 14.4s poll. A
          // rejection now throws with its real reason; a slow commit is waited out.
          proposeCommitted = await confirmCommitted(requester, propRes, offBefore, "ProposeRealSwap");
          pendingCid = await pollNewCid(requester, "UmbraSwap:RealSwapPending", pb,
            proposeCommitted ? POLL_TRIES_COMMITTED : POLL_TRIES);
          steps.push("requester proposed real settlement (party-signed)");
        }

        // --- step 2: AcceptRealSwap (controller: dealer) ---
        const prevSettlement = await findSettlementForLegs(requester, offLeg.cid, wantLeg.cid);
        if (prevSettlement) {
          settlementCid = prevSettlement.contractId;
          steps.push("resumed: SwapSettlement for these legs already exists");
        } else {
          const acceptCmd = [{ ExerciseCommand: {
            templateId: `#${PKGN}:UmbraSwap:RealSwapPending`, contractId: pendingCid,
            choice: "AcceptRealSwap", choiceArgument: {} } }];
          if (dealerIsWallet) return awaitSig("AcceptRealSwap", dealerPartyId, acceptCmd);
          const accBefore = await ledgerEnd();
          const accRes = await act(dealerRole, "swap-accept-real", acceptCmd);
          const accCommitted = await confirmCommitted(dealerPartyId, accRes, accBefore, "AcceptRealSwap");
          settlementCid = await pollNewCid(requester, "UmbraSwap:SwapSettlement", b,
            accCommitted ? POLL_TRIES_COMMITTED : POLL_TRIES);
          steps.push("dealer accepted -> on-ledger SwapSettlement (settledVia=real, party-signed)");
        }
      } catch (paErr) {
        console.error("[settle-real][SIGNED][propose/accept] FAILED:", paErr && (paErr.stack || paErr.message || paErr));
        if (proposeCommitted) {
          // The propose IS on the ledger. Withdrawing the legs would orphan it and
          // strand the trade; leave everything intact so it stays recoverable.
          console.error("[settle-real][SIGNED] propose COMMITTED - not rolling back (would orphan the pending swap)");
          steps.push("propose committed but the follow-up failed \u2014 allocations left intact for recovery");
          throw paErr;
        }
        // propose never landed -> roll back so the real cBTC/CC don't strand locked
        // (same protection the execute step has).
        await withdrawLeg(offLeg); await withdrawLeg(wantLeg);
        await recoverFailedSwap(requester, req.params.cid, dealerRole, offerAsset, wantAsset,
          paErr && paErr.message);
        steps.push("propose/accept failed \u2014 rolled back allocations + re-opened the request for " + dealerRole);
        throw paErr;
      }
    } else {
      await actMulti(["requester", dealerRole], "swap-record-real", [{
        ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapProposal`,
          contractId: req.params.cid, choice: "RecordRealSwap",
          choiceArgument: { realOfferAllocCid: offLeg.cid, realWantAllocCid: wantLeg.cid, realRefMid: refMid } } }]);
      settlementCid = await pollNewCid(requester, "UmbraSwap:SwapSettlement", b);
      steps.push("recorded on-ledger SwapSettlement (settledVia=real)");
    }

    // Atomic settle. Two paths, chosen by mode:
    //  DEMO   -> /api/real/settle: two Allocation_ExecuteTransfer in one tx. Robust:
    //            it RE-QUERIES each allocation by cid right before executing, so it
    //            tolerates registry lag / change-holding churn from combo allocations.
    //  SIGNED -> SwapSettlement.ExecuteRealSwap: ONE on-ledger command, so an external
    //            wallet can sign it (interactive-submission is one-command-only).
    if (SIGNED_MODE) {
      try {
        await executeRealSettlement({
          requester, dealerParty: dealerPartyId, operator, settlementCid,
          offLeg, wantLeg, feeLeg, offAdmin, wantAdmin, feeAdmin: wantAdmin,
        });
      } catch (execErr) {
        console.error("[settle-real][SIGNED][execute] FAILED:", execErr && (execErr.stack || execErr.message || execErr));
        await withdrawLeg(offLeg); await withdrawLeg(wantLeg);
        await recoverFailedSwap(requester, req.params.cid, dealerRole, offerAsset, wantAsset);
        steps.push("settlement failed \u2014 rolled back allocations + re-opened the request for " + dealerRole);
        throw execErr;
      }
      steps.push("executed REAL atomic swap via ExecuteRealSwap (one on-ledger choice, party-signed)");
    } else {
      const sr = await fetch("http://localhost:" + (process.env.PORT || 4000) + "/api/real/settle", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legs: [
          { cid: offLeg.cid, registry: offLeg.registry },
          { cid: wantLeg.cid, registry: wantLeg.registry },
        ] }),
      });
      const sj = await sr.json();
      if (!sj.ok) {
        // roll back: withdraw both allocations so the funds return to free holdings
        await withdrawLeg(offLeg); await withdrawLeg(wantLeg);
        await recoverFailedSwap(requester, req.params.cid, dealerRole, offerAsset, wantAsset);
        steps.push("settlement failed \u2014 rolled back allocations + re-opened the request for " + dealerRole);
        throw new Error("atomic settle failed: " + (sj.error || JSON.stringify(sj)));
      }
      steps.push("executed REAL atomic swap: " + offerAmount + " " + offerAsset.symbol +
        " <-> " + wantAmount + " " + wantAsset.symbol + " (both legs, one tx)");
    }

    // Close the RFQ + ALL its invitations so no invited dealer is left with a stale
    // live countdown. The SwapProposal has no rfqCid, so derive it: prefer the body,
    // else find a live SwapInvitation for this trade's pair and use its rfqCid.
    try {
      let rfqCid = (req.body && req.body.rfqCid) || null;
      if (!rfqCid) {
        const invs = await queryActive(requester, "UmbraSwap:SwapInvitation");
        const match = invs.find(iv => iv.payload &&
          iv.payload.offerAsset && iv.payload.offerAsset.symbol === offerAsset.symbol &&
          iv.payload.wantAsset && iv.payload.wantAsset.symbol === wantAsset.symbol);
        if (match) rfqCid = match.payload.rfqCid;
      }
      if (rfqCid) { const cr = await cleanupSwapRfq(rfqCid); steps.push("closed RFQ (+" + cr.invitations + " invitations)"); }
    } catch (e) {}

    res.json({ ok: true, real: true, atomic: true, settlementCid,
      offerSym: offerAsset.symbol, offerAmount, wantSym: wantAsset.symbol, wantAmount,
      signed: SIGNED_MODE, steps });
  } catch (e) {
    console.error("[settle-real][OUTER] FAILED:", e && (e.stack || e.message || e));
    console.error("[settle-real][OUTER] steps so far:", JSON.stringify(steps));
    res.status(500).json({ error: e.message, steps });
  }
});

app.post("/api/swap/proposals/:cid/commit-offer", async (req, res) => {
  try {
    const requester = await partyIdFor("requester");
    const before = await idSetSwap(requester, "UmbraSwap:SwapDealerPending");
    await act("requester", "swap-commit-offer", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapProposal`,
        contractId: req.params.cid, choice: "CommitRequesterLeg",
        choiceArgument: { requesterHoldingCid: req.body.holdingCid } } }]);
    const pendingCid = await pollNewCid(requester, "UmbraSwap:SwapDealerPending", before);
    res.json({ ok: true, signed: SIGNED_MODE, pendingCid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// dealer commits its want leg
app.post("/api/swap/pending/:cid/commit-want", async (req, res) => {
  try {
    const dealerRole = String(req.body.dealer || "").toLowerCase();
    const dealer = await partyIdFor(dealerRole);
    // Read the pending contract to learn its own pair. The SERVER stamps the
    // mark from its own price feed -- the client never supplies the number.
    const pend = (await queryActive(dealer, "UmbraSwap:SwapDealerPending"))
      .find(c => c.contractId === req.params.cid);
    const refMid = pend
      ? await refMidFor(pend.payload.offerAsset.symbol, pend.payload.wantAsset.symbol)
      : null;
    const before = await idSetSwap(dealer, "UmbraSwap:SwapSettlement");
    await act(dealerRole, "swap-commit-want", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapDealerPending`,
        contractId: req.params.cid, choice: "CommitDealerLeg",
        choiceArgument: { dealerHoldingCid: req.body.holdingCid, refMid } } }]);
    const settlementCid = await pollNewCid(dealer, "UmbraSwap:SwapSettlement", before);
    res.json({ ok: true, signed: SIGNED_MODE, settlementCid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// operator fires the atomic swap. Same authority model as ExecuteDvP:
// SIGNED mode -> executor submits alone (external parties' authority is already
// gathered onto SwapSettlement via their signed commits); DEMO mode -> operator
// actAs all three (it holds CanActAs). readAs is implied by actAs here.
app.post("/api/swap/settlements/:cid/execute", async (req, res) => {
  try {
    const requester = await partyIdFor("requester");
    const dealer = await partyIdFor(String(req.body.dealer || "dealer1").toLowerCase());
    const executor = await partyIdFor("requester");
    if (SIGNED_MODE) {
      await act("requester", "swap-execute", [{
        ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapSettlement`,
          contractId: req.params.cid, choice: "ExecuteSwap", choiceArgument: {} } }]);
      return res.json({ ok: true, signed: true });
    }
    const execActAs = [requester, dealer, executor];
    const body = { commandId: `swap-execute-${Date.now()}`,
      actAs: execActAs,
      commands: [{ ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapSettlement`,
        contractId: req.params.cid, choice: "ExecuteSwap", choiceArgument: {} } }] };
    const r = await ledgerFetch("/v2/commands/submit-and-wait", { method: "POST", body: JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`ExecuteSwap failed: ${r.status} ${t}`);
    res.json({ ok: true, signed: SIGNED_MODE });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- close a settled/expired RFQ (archive it + its invitations) -----------
// SwapRfq and SwapInvitation are both signatory=requester, so the requester can
// archive them directly. Settlement never consumed the RFQ, which is why a done
// deal kept showing as "live". Best-effort: a missing/already-archived contract
// is ignored. Works in demo (operator acts) and signed (requester signs) mode.
async function cleanupSwapRfq(rfqCid) {
  if (!rfqCid) return { rfq: false, invitations: 0 };
  const requester = await partyIdFor("requester");
  let rfq = false;
  try {
    await act("requester", "swap-rfq-close", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
        contractId: rfqCid, choice: "Archive", choiceArgument: {} } }]);
    rfq = true;
  } catch (e) { /* already archived / not found */ }
  let invitations = 0, invs = [];
  try { invs = await queryActive(requester, "UmbraSwap:SwapInvitation"); } catch {}
  for (const iv of invs) {
    if (!iv.payload || iv.payload.rfqCid !== rfqCid) continue;
    try {
      await act("requester", "swap-inv-close", [{
        ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapInvitation`,
          contractId: iv.contractId, choice: "Archive", choiceArgument: {} } }]);
      invitations++;
    } catch (e) { /* best-effort */ }
  }
  return { rfq, invitations };
}

app.post("/api/swap/rfqs/:cid/close", async (req, res) => {
  try {
    const closed = await cleanupSwapRfq(req.params.cid);
    res.json({ ok: true, closed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- ONE-CALL DEMO PATH: /api/swap/award ----------------------------------
// Walks the whole choreography server-side for a clean end-to-end demo/video.
// Body: { dealer: "dealer1", offerAsset, offerAmount, wantAsset, wantAmount,
//         fund: true }  (fund=true mints backing holdings for both sides)
app.post("/api/swap/award", async (req, res) => {
  try {
    const dealerRole = String(req.body.dealer || "dealer1").toLowerCase();
    const requester = await partyIdFor("requester");
    const dealer = await partyIdFor(dealerRole);
    const operator = await partyIdFor("requester");
    const offerAsset = await resolveAsset(req.body.offerAsset);
    const wantAsset = await resolveAsset(req.body.wantAsset);
    const offerAmount = String(req.body.offerAmount);
    const wantAmount = String(req.body.wantAmount);
    const expiresAt = req.body.expiresAt ||
      new Date(Date.now() + Number(req.body.ttlMins || 15) * 60000).toISOString();
    const validUntil = req.body.validUntil ||
      new Date(Date.now() + Number(req.body.validMins || 5) * 60000).toISOString();
    const steps = [];

    // (0) optionally fund both legs (demo)
    let reqHoldingCid, dealerHoldingCid;
    if (req.body.fund !== false) {
      let b = await idSetSwap(requester, "UmbraSwap:AssetHolding");
      const offerAdmin = await adminRoleOf(offerAsset);
      if (!offerAdmin) throw new Error(
        offerAsset.symbol + " is issued by " + offerAsset.admin + ", which this venue cannot " +
        "co-sign for. Fund it from the issuer's faucet instead of minting.");
      await actMulti(["requester", offerAdmin], "swap-fund-req", [{
        CreateCommand: { templateId: `#${PKGN}:UmbraSwap:AssetHolding`,
          createArguments: { owner: requester, asset: offerAsset, amount: offerAmount } } }]);
      reqHoldingCid = await pollNewCid(requester, "UmbraSwap:AssetHolding", b);
      steps.push(`funded requester ${offerAmount} ${offerAsset.symbol}`);

      b = await idSetSwap(dealer, "UmbraSwap:AssetHolding");
      const wantAdmin = await adminRoleOf(wantAsset);
      if (!wantAdmin) throw new Error(
        wantAsset.symbol + " is issued by " + wantAsset.admin + ", which this venue cannot " +
        "co-sign for. Fund it from the issuer's faucet instead of minting.");
      await actMulti([dealerRole, wantAdmin], "swap-fund-dlr", [{
        CreateCommand: { templateId: `#${PKGN}:UmbraSwap:AssetHolding`,
          createArguments: { owner: dealer, asset: wantAsset, amount: wantAmount } } }]);
      dealerHoldingCid = await pollNewCid(dealer, "UmbraSwap:AssetHolding", b);
      steps.push(`funded ${dealerRole} ${wantAmount} ${wantAsset.symbol}`);
    } else {
      reqHoldingCid = req.body.requesterHoldingCid;
      dealerHoldingCid = req.body.dealerHoldingCid;
    }

    // (1) RFQ
    let b = await idSetSwap(requester, "UmbraSwap:SwapRfq");
    await act("requester", "swap-rfq", [{
      CreateCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
        createArguments: { requester, operator, offerAsset, offerAmount,
          wantAsset, invited: [dealer], expiresAt } } }]);
    const rfqCid = await pollNewCid(requester, "UmbraSwap:SwapRfq", b);
    steps.push("created swap RFQ");

    // (2) invite dealer
    b = await idSetSwap(dealer, "UmbraSwap:SwapInvitation");
    await act("requester", "swap-invite", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
        contractId: rfqCid, choice: "InviteDealer", choiceArgument: { dealer } } }]);
    const invCid = await pollNewCid(dealer, "UmbraSwap:SwapInvitation", b);
    steps.push(`invited ${dealerRole}`);

    // (3) dealer quotes
    b = await idSetSwap(dealer, "UmbraSwap:SwapQuote");
    await act(dealerRole, "swap-quote", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapInvitation`,
        contractId: invCid, choice: "SubmitSwapQuote",
        choiceArgument: { price: wantAmount, validUntil } } }]);
    const quoteCid = await pollNewCid(dealer, "UmbraSwap:SwapQuote", b);
    steps.push(`${dealerRole} quoted ${wantAmount} ${wantAsset.symbol}`);

    // (4) requester accepts -> proposal
    b = await idSetSwap(requester, "UmbraSwap:SwapProposal");
    await act("requester", "swap-accept", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapQuote`,
        contractId: quoteCid, choice: "AcceptSwapQuote", choiceArgument: {} } }]);
    const propCid = await pollNewCid(requester, "UmbraSwap:SwapProposal", b);
    steps.push("requester accepted quote");

    // (5) requester commits offer leg
    b = await idSetSwap(requester, "UmbraSwap:SwapDealerPending");
    await act("requester", "swap-commit-offer", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapProposal`,
        contractId: propCid, choice: "CommitRequesterLeg",
        choiceArgument: { requesterHoldingCid: reqHoldingCid } } }]);
    const pendingCid = await pollNewCid(requester, "UmbraSwap:SwapDealerPending", b);
    steps.push("requester committed offer leg");

    // (6) dealer commits want leg -> settlement
    b = await idSetSwap(dealer, "UmbraSwap:SwapSettlement");
    const awardRefMid = await refMidFor(offerAsset.symbol, wantAsset.symbol);
    await act(dealerRole, "swap-commit-want", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapDealerPending`,
        contractId: pendingCid, choice: "CommitDealerLeg",
        choiceArgument: { dealerHoldingCid, refMid: awardRefMid } } }]);
    const settlementCid = await pollNewCid(dealer, "UmbraSwap:SwapSettlement", b);
    steps.push("dealer committed want leg");

    // (7) operator executes atomic swap
    // ExecuteSwap is `controller operator`, and operator == requester. In SIGNED
    // mode the operator is an external party, so it must SIGN, not actAs.
    if (SIGNED_MODE) {
      await act("requester", "swap-execute", [{
        ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapSettlement`,
          contractId: settlementCid, choice: "ExecuteSwap", choiceArgument: {} } }]);
      steps.push(`executed atomic ${offerAsset.symbol}->${wantAsset.symbol} swap (CIP-56, both legs, self-signed)`);
      try { await cleanupSwapRfq(rfqCid); steps.push("closed RFQ"); } catch (e) {}
      return res.json({ ok: true, signed: true, steps });
    }
    const execActAs = [requester, dealer, operator];
    const body = { commandId: `swap-execute-${Date.now()}`, actAs: execActAs,
      commands: [{ ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapSettlement`,
        contractId: settlementCid, choice: "ExecuteSwap", choiceArgument: {} } }] };
    const r = await ledgerFetch("/v2/commands/submit-and-wait", { method: "POST", body: JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`ExecuteSwap failed: ${r.status} ${t}`);
    steps.push(`executed atomic ${offerAsset.symbol}->${wantAsset.symbol} swap (CIP-56, both legs)`);
    try { await cleanupSwapRfq(rfqCid); steps.push("closed RFQ"); } catch (e) {}

    res.json({ ok: true, signed: SIGNED_MODE, steps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// ===== v6 REAL AWARD (blind auction -> real registry settlement) =====
// Registry URLs per issuer. cBTC = DA utility registry (public). CC/Amulet & cETH
// = the 5North validator scan-proxy (auth'd). Extend here as new real assets arrive.
const REAL_REGISTRY = {
  "cbtc-network": REGISTRY_URL_DEFAULT,
  "DSO": "https://wallet.validator.devnet.sandbox.fivenorth.io/api/validator/v0/scan-proxy",
  "rails-cethMain-1-dev": REGISTRY_URL_DEFAULT,
};
function registryForAdmin(admin) {
  const prefix = String(admin || "").split("::")[0];
  return REAL_REGISTRY[prefix] || null;
}

// find a party's real Holding record for a symbol. queryRealHoldings returns
// {contractId, owner, admin, id, amount}. We match on `id` (the instrument symbol)
// and take the admin straight off the holding -- so the real issuer is whatever the
// ledger says, never a hardcoded guess. Returns the full record (or null).
async function realHoldingBySymbol(role, sym, need) {
  const party = await partyIdFor(role);
  const hs = await queryRealHoldings(party);
  // A holding is REAL iff its issuer is a known external registry issuer
  // (cbtc-network / DSO / rails-cethMain). This excludes ALL self-issued stand-ins -
  // both the demo parties AND the external WALLET parties (which mint their own fakes
  // in signed mode). registryForAdmin() returns non-null only for real issuers.
  const isReal = h => registryForAdmin(h.admin) != null;
  const target = instrumentIdForSymbol(sym);
  const want = Number(need);
  // Real, externally-issued holdings of this instrument only (skip stand-ins).
  let cands = hs.filter(h =>
    isReal(h) && String(h.id).toUpperCase() === String(target).toUpperCase()
    && !h.lock);   // skip LOCKED holdings: the registry rejects a locked holding as
                   // "Given holdings are invalid"; only free coin can be allocated.
  if (!cands.length) return [];
  // Return ALL covering candidates, smallest-first (exact match first). The caller
  // tries them in order: queryRealHoldings does NOT expose lock status, so a holding
  // may look available but be locked in a stale allocation -> the registry rejects it
  // as "invalid". Trying the next candidate makes allocation resilient to that.
  const covering = cands
    .filter(h => Number(h.amount) >= want - 1e-12)
    .sort((a, b) => Number(a.amount) - Number(b.amount));
  // Single-holding candidates first (cheapest path). If NONE covers alone, build a
  // multi-holding combo: CIP-56 allocate accepts multiple inputHoldingCids and merges
  // them atomically inside the choice (returns change). Greedy largest-first to keep
  // the input count small; cap at 10 UTXOs (Canton recommends <=10, hard max 100).
  if (covering.length) {
    covering.combo = null; // signal: single holdings available, try them individually
    return covering;
  }
  const byBig = cands.slice().sort((a, b) => Number(b.amount) - Number(a.amount));
  const combo = []; let sum = 0;
  for (const h of byBig) {
    if (combo.length >= 10) break;
    combo.push(h); sum += Number(h.amount);
    if (sum >= want - 1e-12) break;
  }
  if (sum >= want - 1e-12) { const out = []; out.combo = combo; return out; }
  return [];  // genuinely insufficient total
}

// Locate the allocation an /api/real/allocate call just produced.
//
// The old code polled 12 x 400ms = 4.8s and, on a miss, set "allocated but could
// not locate new allocation cid" and RETRIED the whole allocation. When the first
// submission had in fact committed, that retry referenced a now-spent holding and
// came back LOCAL_VERDICT_INACTIVE_CONTRACTS -- turning one slow commit into a
// cascade of failures. cETH commits slower than cBTC, which is why it was hit and
// cBTC was not. So: get the verdict first, then poll proportionately.
//   returns a cid, or null to let the caller retry
//   throws  if the ledger REJECTED the allocation (retrying cannot help)
async function locateAllocation(j, senderParty, beforeIds, instrId, amount, label) {
  let committed = false;
  if (j && j.commandId) {
    const v = await awaitCompletion(senderParty, j.commandId,
      j.offBefore !== undefined ? j.offBefore : 0, ALLOC_COMPLETION_TIMEOUT_MS);
    if (v.found && !v.ok) {
      throw new Error(humanize(`allocation rejected by the ledger: ${v.message || "code " + v.code}`));
    }
    committed = !!v.found;
  }
  const tries = committed ? POLL_TRIES_COMMITTED : ALLOC_POLL_TRIES;
  for (let i = 0; i < tries; i++) {
    const now = await queryAllocations(senderParty);
    const fresh = now.find(a => !beforeIds.has(a.contractId) &&
      a.instrument === instrId && Math.abs(parseFloat(a.amount) - Number(amount)) < 1e-6);
    if (fresh) return fresh.contractId;
    await new Promise(z => setTimeout(z, committed ? 1200 : 400));
  }
  if (committed) {
    // Committed but invisible: retrying would double-allocate, so refuse loudly.
    throw new Error(`${label} committed on the ledger but its allocation never became ` +
      `visible - do NOT retry (would double-allocate). Check /v2/state/active-contracts.`);
  }
  return null;
}

// Has the sender ALREADY allocated this leg themselves?
//
// A wallet that reads the CIP-56 AllocationRequest view off a SwapProposal allocates
// its own leg, keyed by the settlementRef id (the proposal's tradeId) and the leg name
// the view advertises ("offer"/"want"). If such an allocation exists, Umbra must USE it
// rather than allocate on the party's behalf -- that is the whole difference between a
// venue that holds your signing key and one that merely coordinates.
//
// Matching is deliberately strict: same sender, same leg, same settlement reference,
// same instrument and amount. A near-miss must NOT be adopted, because executing the
// wrong allocation moves real assets.
async function findExistingAllocation(senderParty, settleId, legId, instrId, amount) {
  if (!senderParty || !settleId) return null;
  let allocs;
  try { allocs = await queryAllocations(senderParty); }
  catch (e) { dbg("[wallet-alloc] query failed:", e.message); return null; }
  const want = Number(amount);
  return allocs.find(a =>
    a.sender === senderParty &&
    a.transferLegId === legId &&
    a.settlementRef && a.settlementRef.id === settleId &&
    a.instrument === instrId &&
    isFinite(parseFloat(a.amount)) &&
    Math.abs(parseFloat(a.amount) - want) < 1e-6
  ) || null;
}

// UI symbol -> the instrument id the registry actually uses. "CC" is Canton Coin's
// display symbol; the ledger calls the instrument "Amulet".
const INSTRUMENT_ALIAS = { CBTC: "CBTC", CETH: "cETH", CC: "Amulet", AMULET: "Amulet" };
function instrumentIdForSymbol(sym) {
  return INSTRUMENT_ALIAS[String(sym).toUpperCase()] || sym;
}

// Resumability. When a counterparty signs with its own wallet, settle-real cannot run
// to completion in one request: it has to stop, let the wallet sign, and be called
// again. So each step must be able to recognise its own output from a previous call.
//
// Matching is on the ALLOCATION CIDS, not on amounts. Amount matching would happily
// adopt one of the dead orphans from an earlier attempt -- same parties, same pair,
// same price -- and settle against allocations that were long since withdrawn.
async function findPendingForLegs(requester, offerAllocCid, wantAllocCid) {
  const list = await queryActive(requester, "UmbraSwap:RealSwapPending").catch(() => []);
  return list.find(c => c.payload &&
    c.payload.offerAllocCid === offerAllocCid &&
    c.payload.wantAllocCid === wantAllocCid) || null;
}
async function findSettlementForLegs(requester, offerAllocCid, wantAllocCid) {
  const list = await queryActive(requester, "UmbraSwap:SwapSettlement").catch(() => []);
  return list.find(c => c.payload &&
    c.payload.offerAllocCid === offerAllocCid &&
    c.payload.wantAllocCid === wantAllocCid) || null;
}

// What a wallet must allocate for a leg it owns. We describe the leg rather than
// building the command: choosing which holdings to spend is the owner's business, not
// ours, and it is the same information the CIP-56 AllocationRequest view publishes.
function allocationInstruction(senderParty, receiverParty, admin, instrId, amount, settleId, legId) {
  return {
    step: "AllocateLeg", party: senderParty, legId,
    allocate: { admin, instrument: instrId, amount, receiver: receiverParty,
                settlementRef: settleId, registry: registryForAdmin(admin) },
    how: "POST { build:true, senderRole:<party>, receiver, admin, id, amount, holdingCids:[...yours], " +
         "settleId, legId } to /api/real/allocate?build=1, sign via /api/ext/prepare + /api/ext/execute, " +
         "then call settle-real again.",
  };
}

// allocate one real leg via the existing endpoint's logic, then return the new alloc cid
async function allocateRealLeg(senderRole, receiverRole, admin, instrId, sym, amount, settleId, legId) {
  const registry = registryForAdmin(admin);
  if (!registry) throw new Error("no registry mapped for issuer " + admin);
  const senderParty = await partyIdFor(senderRole);
  let lastErr = "no attempt made";
  // The registry validates the input holding against ITS current ledger view. A cid
  // read even moments earlier can be superseded (the blind auction and prior legs
  // advance the ledger), yielding "Given holdings are invalid". So we RE-FETCH the
  // holding fresh on each attempt and retry a few times until the cid the registry
  // sees is the one we send.
  // The external registry (esp. the scan-proxy) lags a moment behind recent ledger
  // writes. On the first attempt, pause briefly so the registry's view catches up to
  // the holdings the participant already sees; otherwise a fresh, valid holding is
  // transiently rejected as "Given holdings are invalid".
  await new Promise(z => setTimeout(z, 2500));
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidates = await realHoldingBySymbol(senderRole, sym, amount);
    // combo = a covering SET (no single holding sufficed). Allocate from all of them
    // in one call; the registry merges + returns change.
    if (candidates.combo && candidates.combo.length) {
      const cids = candidates.combo.map(h => h.contractId);
      const before = await queryAllocations(senderParty);
      const beforeIds = new Set(before.map(a => a.contractId));
      const r = await fetch("http://localhost:" + (process.env.PORT || 4000) + "/api/real/allocate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderRole, receiverRole, admin, id: instrId, amount,
          holdingCids: cids, settleId, legId, registry }),
      });
      const j = await r.json();
      if (!j.ok) {
        lastErr = "combo(" + cids.length + "): " + (j.error || JSON.stringify(j));
        await new Promise(z => setTimeout(z, 2000 + attempt * 1000)); continue;
      }
      const comboCid = await locateAllocation(j, senderParty, beforeIds, instrId, amount,
        "combo allocation of " + sym);
      if (comboCid) return { cid: comboCid, registry, senderRole, senderParty };
      lastErr = "combo allocated but could not locate new allocation cid";
      continue;
    }
    if (!candidates.length) { lastErr = senderRole + " has no free real " + sym + " >= " + amount; await new Promise(z=>setTimeout(z,1500)); continue; }
    let advanced = false;
    for (const h of candidates) {
      const before = await queryAllocations(senderParty);
      const beforeIds = new Set(before.map(a => a.contractId));
      const r = await fetch("http://localhost:" + (process.env.PORT || 4000) + "/api/real/allocate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderRole, receiverRole, admin, id: instrId, amount,
          holdingCids: [h.contractId], settleId, legId, registry }),
      });
      const j = await r.json();
      if (!j.ok) {
        lastErr = "cid " + h.contractId.slice(0,20) + " (amt " + h.amount + "): " + (j.error || JSON.stringify(j));
        // "invalid holdings" = stale cid; break to re-fetch fresh. Other errors: try next candidate.
        if (/invalid|not found|unlocked/i.test(lastErr)) { advanced = true; break; }
        continue;
      }
      const singleCid = await locateAllocation(j, senderParty, beforeIds, instrId, amount,
        "allocation of " + sym);
      if (singleCid) return { cid: singleCid, registry, senderRole, senderParty };
      lastErr = "allocated but could not locate new allocation cid";
    }
    if (advanced) await new Promise(z => setTimeout(z, 2000 + attempt * 1000)); // registry lag: back off longer each time
  }
  throw new Error("allocate " + instrId + " failed after retries: " + lastErr);
}

app.post("/api/real/award", async (req, res) => {
  try {
    const dealerRole = String(req.body.dealer || "dealer1").toLowerCase();
    const requester = await partyIdFor("requester");
    const dealer = await partyIdFor(dealerRole);
    const operator = await partyIdFor("requester");
    const offerSym = String((req.body.offerAsset && req.body.offerAsset.symbol) || req.body.offerAsset || "");
    const wantSym = String((req.body.wantAsset && req.body.wantAsset.symbol) || req.body.wantAsset || "");
    const offerAmount = String(req.body.offerAmount);
    const wantAmount = String(req.body.wantAmount);
    const expiresAt = req.body.expiresAt ||
      new Date(Date.now() + Number(req.body.ttlMins || 15) * 60000).toISOString();
    const validUntil = req.body.validUntil ||
      new Date(Date.now() + Number(req.body.validMins || 5) * 60000).toISOString();
    const steps = [];

    // Resolve each asset from the REAL holding the party actually owns -- the admin
    // comes straight off the on-ledger Holding, so there are no hardcoded issuer ids
    // to get wrong, and a self-issued stand-in (admin = one of our parties) is rejected.
    const OURS = new Set(["Requester","Dealer1","Dealer2","Observer"]);
    const offCands = await realHoldingBySymbol("requester", offerSym, offerAmount);
    const offPick = offCands.length ? offCands[0] : (offCands.combo && offCands.combo[0]);
    if (!offPick) throw new Error("requester has no real " + offerSym + " totalling >= " + offerAmount);
    const wantCands = await realHoldingBySymbol(dealerRole, wantSym, wantAmount);
    const wantPick = wantCands.length ? wantCands[0] : (wantCands.combo && wantCands.combo[0]);
    if (!wantPick) throw new Error(dealerRole + " has no real " + wantSym + " totalling >= " + wantAmount);
    const offAdmin = offPick.admin, wantAdmin = wantPick.admin;
    if (OURS.has(String(offAdmin).split("::")[0]))
      throw new Error(offerSym + " resolved to a self-issued stand-in (issuer " + offAdmin + "); this endpoint settles real tokens only");
    if (OURS.has(String(wantAdmin).split("::")[0]))
      throw new Error(wantSym + " resolved to a self-issued stand-in (issuer " + wantAdmin + ")");
    if (!registryForAdmin(offAdmin)) throw new Error("no registry mapped for " + offerSym + " issuer " + offAdmin);
    if (!registryForAdmin(wantAdmin)) throw new Error("no registry mapped for " + wantSym + " issuer " + wantAdmin);
    // AssetId objects for the on-ledger records (real admin + symbol)
    const offerAsset = { admin: offAdmin, symbol: offerSym };
    const wantAsset = { admin: wantAdmin, symbol: wantSym };

    // ---- allocate the real legs FIRST, while the ledger is quiet ----
    // The registry validates each input holding against its own (slightly lagged)
    // view of the ledger. If the blind auction's transactions run first, that churn
    // makes the registry transiently reject the holding as "invalid" (the same cid
    // allocates fine when nothing precedes it). Allocating up front avoids that: the
    // allocations lock the holdings, the blind auction below is the on-ledger trade
    // record, and the settle at the end executes these pre-made allocations.
    const settleId = "umbra-real-" + Date.now();
    const offLeg = await allocateRealLeg("requester", dealerRole, offAdmin, (offPick ? offPick.id : offCands[0].id),
      offerSym, offerAmount, settleId, "offer-leg");
    steps.push("allocated real offer leg (" + offerAmount + " " + offerAsset.symbol + ")");
    const wantLeg = await allocateRealLeg(dealerRole, "requester", wantAdmin, (wantPick ? wantPick.id : wantCands[0].id),
      wantSym, wantAmount, settleId, "want-leg");
    steps.push("allocated real want leg (" + wantAmount + " " + wantAsset.symbol + ")");

    // ---- blind auction choreography (on-ledger, identical to stand-in) ----
    let b = await idSetSwap(requester, "UmbraSwap:SwapRfq");
    await act("requester", "raward-rfq", [{ CreateCommand: {
      templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
      createArguments: { requester, operator, offerAsset, offerAmount, wantAsset,
        invited: [dealer], expiresAt } } }]);
    const rfqCid = await pollNewCid(requester, "UmbraSwap:SwapRfq", b);
    steps.push("created swap RFQ");

    b = await idSetSwap(dealer, "UmbraSwap:SwapInvitation");
    await act("requester", "raward-invite", [{ ExerciseCommand: {
      templateId: `#${PKGN}:UmbraSwap:SwapRfq`, contractId: rfqCid,
      choice: "InviteDealer", choiceArgument: { dealer } } }]);
    const invCid = await pollNewCid(dealer, "UmbraSwap:SwapInvitation", b);
    steps.push("invited " + dealerRole);

    b = await idSetSwap(dealer, "UmbraSwap:SwapQuote");
    await act(dealerRole, "raward-quote", [{ ExerciseCommand: {
      templateId: `#${PKGN}:UmbraSwap:SwapInvitation`, contractId: invCid,
      choice: "SubmitSwapQuote", choiceArgument: { price: wantAmount, validUntil } } }]);
    const quoteCid = await pollNewCid(dealer, "UmbraSwap:SwapQuote", b);
    steps.push(dealerRole + " quoted " + wantAmount + " " + wantAsset.symbol);

    b = await idSetSwap(requester, "UmbraSwap:SwapProposal");
    await act("requester", "raward-accept", [{ ExerciseCommand: {
      templateId: `#${PKGN}:UmbraSwap:SwapQuote`, contractId: quoteCid,
      choice: "AcceptSwapQuote", choiceArgument: {} } }]);
    const propCid = await pollNewCid(requester, "UmbraSwap:SwapProposal", b);
    steps.push("requester accepted quote (blind auction complete)");

    // record the trade on-ledger (blind-auction result + real allocation pointers)
    const awardRefMid = await refMidFor(offerAsset.symbol, wantAsset.symbol);
    b = await idSetSwap(requester, "UmbraSwap:SwapSettlement");
    await actMulti(["requester", dealerRole], "raward-record", [{ ExerciseCommand: {
      templateId: `#${PKGN}:UmbraSwap:SwapProposal`, contractId: propCid,
      choice: "RecordRealSwap", choiceArgument: {
        realOfferAllocCid: offLeg.cid, realWantAllocCid: wantLeg.cid, realRefMid: awardRefMid } } }]);
    const settlementCid = await pollNewCid(requester, "UmbraSwap:SwapSettlement", b);
    steps.push("recorded on-ledger SwapSettlement (settledVia=real)");

    // fire both real legs atomically via the proven settle endpoint
    const sr = await fetch("http://localhost:" + (process.env.PORT || 4000) + "/api/real/settle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legs: [
        { cid: offLeg.cid, registry: offLeg.registry },
        { cid: wantLeg.cid, registry: wantLeg.registry },
      ] }),
    });
    const sj = await sr.json();
    if (!sj.ok) throw new Error("atomic settle failed: " + (sj.error || JSON.stringify(sj)));
    steps.push("executed REAL atomic swap: " + offerAmount + " " + offerAsset.symbol +
      " <-> " + wantAmount + " " + wantAsset.symbol + " (both legs, one tx)");
    try { await cleanupSwapRfq(rfqCid); steps.push("closed RFQ"); } catch (e) {}

    res.json({ ok: true, real: true, settlementCid, atomic: sj.atomic,
      disclosed: sj.disclosed, legs: sj.legs, steps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===== LEDGER PROOF =====
// GET /api/ledger/contract/:cid?role=requester
// Reads a contract back off the Canton ledger. There is no public explorer for
// a private ledger, so this IS the proof: the record, as the ledger holds it.
app.get("/api/ledger/contract/:cid", async (req, res) => {
  try {
    const role = String(req.query.role || "requester").toLowerCase();
    const party = await partyIdFor(role);
    const cid = req.params.cid;

    // Look through the templates this venue creates.
    const TEMPLATES = [
      "UmbraSwap:SwapSettlement",
      "UmbraSwap:SwapDealerPending",
      "UmbraSwap:SwapProposal",
      "UmbraSwap:AssetHolding",
      "UmbraSwap:SwapQuote",
      "UmbraSwap:SwapRfq",
    ];

    for (const tmpl of TEMPLATES) {
      const rows = await queryActive(party, tmpl).catch(() => []);
      const hit = rows.find(r => r.contractId === cid);
      if (hit) {
        return res.json({
          ok: true, found: true, archived: false,
          contractId: cid, template: tmpl, payload: hit.payload,
          note: "Active on the Canton ledger.",
        });
      }
    }

    // Not active. For a settled swap that is EXPECTED: executing the settlement
    // consumes the contract. Say that plainly instead of reporting a failure.
    const le = await ledgerFetch("/v2/state/ledger-end").then(r => r.json()).catch(() => null);
    res.json({
      ok: true, found: false, archived: true,
      contractId: cid,
      ledgerEnd: le ? le.offset : null,
      note: "Not active \u2014 this contract has been consumed. A settled swap " +
            "archives its settlement contract by design: the trade executed and " +
            "the holdings moved. The record remains in the ledger's transaction " +
            "history, visible to its stakeholders.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== MARKET REFERENCE RATE =====
// cBTC := BTC 1:1, cETH := ETH 1:1. The honest reference for a pair is the real
// spot cross. No synthetic prices: if the feed fails we return null and the UI
// shows "--". A fabricated mid in a trading venue is worse than none.
// Price the ACTUAL bridged assets where they are listed, not proxies:
//   cBTC -> BitSafe's own CoinGecko listing (it trades at a small premium to BTC)
//   CC   -> canton-network
//   cETH -> no Canton listing exists, so we use ETH (it is 1:1 wrapped)
const CG = "https://api.coingecko.com/api/v3/simple/price?ids=bitsafe-bridged-wrapped-bitcoin-canton,canton-network,ethereum,bitcoin&vs_currencies=usd";
const mkt = { usd: null, at: 0, series: [] };

// The mid for a pair AT THIS MOMENT, as a Daml Decimal string -- or null (Daml
// None) when there is no public price. Stamped onto a settlement so the book can
// later show a TRUE mark. CoinGecko only ever gives us "now"; without recording
// this at commit time, historical USD value is simply not recoverable.
async function refMidFor(baseSym, quoteSym) {
  try {
    // One retry. A cold cache or a blipped fetch would otherwise stamp `None`
    // onto an IMMUTABLE record -- claiming "no market reference existed" when
    // really we just asked at a bad moment. A false absence is still false.
    let usd;
    try { usd = await marketUsd(); }
    catch (e1) { await new Promise(r => setTimeout(r, 600)); usd = await marketUsd(); }
    const b = usd[baseSym], q = usd[quoteSym];
    if (!b || !q) return null;
    // Daml Decimal is Numeric 10 -- at most 10 decimal places. A raw float
    // ratio has ~14 and the ledger REFUSES it ("cannot represent ... without
    // loss of precision") rather than silently rounding. So we round here,
    // deliberately and visibly, to the precision the ledger accepts.
    return (b / q).toFixed(10);
  } catch (e) { return null; }
}
const MKT_TTL = 30000;

async function marketUsd() {
  if (mkt.usd && Date.now() - mkt.at < MKT_TTL) return mkt.usd;
  const r = await fetch(CG, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("price feed " + r.status);
  const j = await r.json();
  const CB = j["bitsafe-bridged-wrapped-bitcoin-canton"];
  const usd = {
    cBTC: (CB && CB.usd) || (j.bitcoin && j.bitcoin.usd),   // real cBTC, else BTC
    cETH: j.ethereum && j.ethereum.usd,                     // no cETH listing; 1:1 wrapped
    CC:   j["canton-network"] && j["canton-network"].usd,
  };
  if (!usd.cBTC || !usd.cETH) throw new Error("incomplete price feed");
  mkt.usd = usd; mkt.at = Date.now();
  mkt.series.push(usd.cBTC / usd.cETH);
  if (mkt.series.length > 60) mkt.series.shift();
  return usd;
}

// per-pair price history so the sparkline follows the pair actually being traded
const seriesFor = {};
function pushSeries(pair, v) {
  if (!seriesFor[pair]) seriesFor[pair] = [];
  const a = seriesFor[pair];
  if (!a.length || a[a.length - 1] !== v) a.push(v);
  if (a.length > 60) a.shift();
  return a;
}

app.get("/api/market/rate", async (req, res) => {
  const base = String(req.query.base || "cBTC");
  const quote = String(req.query.quote || "cETH");
  const pair = base + "/" + quote;
  try {
    const usd = await marketUsd();
    const b = usd[base], q = usd[quote];
    // If either asset is missing from the feed, we return a null mid and say which -- rather than invent a number.
    if (!b || !q) {
      return res.json({
        ok: true, base, quote, mid: null, usd, series: [], at: mkt.at,
        note: "No market reference for " + pair + " \u2014 " +
              (!usd[base] ? base : quote) + " has no price on the feed right now."
      });
    }
    const mid = b / q;
    res.json({ ok: true, base, quote, mid, usd, series: pushSeries(pair, mid).slice(), at: mkt.at });
  } catch (e) {
    res.json({ ok: false, base, quote, mid: null, usd: null, series: [], error: e.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`[umbra-backend] listening on ${PORT} | mode=${SIGNED_MODE ? "SIGNED (trust-no-operator)" : "DEMO (operator)"}`));