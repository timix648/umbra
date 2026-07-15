// WSL2 has no IPv6 route, but DNS returns AAAA records for coingecko and the
// 5North auth host. Node >=17 resolves `verbatim` -- it tries IPv6 FIRST and
// hangs until timeout. curl survives via Happy Eyeballs; Node does not. This
// produced a full day of phantom "outages": ETIMEDOUT, 405, "fetch failed",
// against hosts that were provably up. Must run before any socket opens.
require("dns").setDefaultResultOrder("ipv4first");

const express = require("express");
const { ledgerFetch } = require("./token");
const { onboardExternalParty, prepareSignExecute, prepareSignExecuteMulti } = require("./external");
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

// Resolve a role name to the party id that is ACTIVE for the current mode.
async function partyIdFor(role) {
  const r = String(role || "").toLowerCase();
  if (r === "public") return PARTIES.public;
  if (SIGNED_MODE && SIGNING_ROLES.includes(r)) return (await recFor(r)).partyId;
  const p = PARTIES[r];
  if (!p) throw new Error(`unknown role '${role}'. use requester|dealer1|dealer2|public`);
  return p;
}

// Reverse lookup: given a party id, which role is it (in the current mode)?
async function roleOfParty(pid) {
  for (const r of SIGNING_ROLES) if ((await partyIdFor(r)) === pid) return r;
  return null;
}

// THE branch point. Same command set, two authorities:
//  - signed mode  -> the party signs it with its own key (operator can't forge)
//  - demo mode    -> operator submits via CanActAs (submit-and-wait)
async function act(role, tag, commands) {
  const r = String(role || "").toLowerCase();
  if (SIGNED_MODE && SIGNING_ROLES.includes(r)) {
    const rec = await recFor(r);
    return prepareSignExecute(rec, commands, tag); // async-accepted ({} on success)
  }
  return submit(tag, PARTIES[r], commands); // synchronous commit
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

async function pollNewCid(party, templateModuleEntity, beforeSet, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const ids = (await queryActive(party, templateModuleEntity)).map((c) => c.contractId);
    const fresh = ids.find((id) => !beforeSet.has(id));
    if (fresh) return fresh;
    await sleep(1200);
  }
  throw new Error(`timed out waiting for new ${templateModuleEntity} for ${party.slice(0, 24)}…`);
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
  res.json({ signedMode: SIGNED_MODE, parties: await activePartyMap() });
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
    for (const v of (ce.interfaceViews || [])) {
      const vv = v.viewValue || v.value || {};
      const inst = vv.instrumentId || {};
      out.push({ contractId: ce.contractId, owner: vv.owner, admin: inst.admin, id: inst.id, amount: vv.amount });
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
    for (const v of (ce.interfaceViews || [])) {
      const vv = v.viewValue || v.value || {};
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

app.get("/api/real/pending", async (req, res) => {
  try {
    const party = req.query.party || await partyIdFor(req.query.role || "requester");
    const offers = await queryPendingTransfers(party);
    res.json({ ok: true, party, count: offers.length, offers });
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
    const requester = await partyIdFor("requester");
    const operator = await partyIdFor("requester");
    const offerAsset = await resolveAsset(req.body.offerAsset);
    const wantAsset = await resolveAsset(req.body.wantAsset);
    const roles = req.body.invited || req.body.dealers || ["dealer1", "dealer2"];
    const invited = [];
    for (const r of roles) invited.push(await partyIdFor(r));
    const expiresAt = req.body.expiresAt ||
      new Date(Date.now() + Number(req.body.ttlMins || 15) * 60000).toISOString();

    const rfqBefore = await idSetSwap(requester, "UmbraSwap:SwapRfq");
    await act("requester", "swap-rfq", [{
      CreateCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
        createArguments: {
          requester, operator,
          offerAsset, offerAmount: String(req.body.offerAmount),
          wantAsset, invited, expiresAt } } }]);
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
    res.json({ ok: true, role,
      settlements: flattenUpdates(settlements),
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
    const result = await act("requester", "swap-invite", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
        contractId: req.params.cid, choice: "InviteDealer",
        choiceArgument: { dealer } } }]);
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
    const dealerRole = String(req.body.dealer || "").toLowerCase();
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
    const validUntil = req.body.validUntil ||
      (req.body.validMins
        ? new Date(Date.now() + Number(req.body.validMins) * 60000).toISOString()
        : (invExpiry || new Date(Date.now() + 5 * 60000).toISOString()));
    const result = await act(dealerRole, "swap-quote", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapInvitation`,
        contractId: req.params.cid, choice: "SubmitSwapQuote",
        choiceArgument: { price: String(req.body.price), validUntil } } }]);
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

// requester accepts a quote -> SwapProposal
// cid-returning swap endpoints
app.post("/api/swap/quotes/:cid/accept", async (req, res) => {
  try {
    const requester = await partyIdFor("requester");
    const before = await idSetSwap(requester, "UmbraSwap:SwapProposal");
    await act("requester", "swap-accept", [{
      ExerciseCommand: { templateId: `#${PKGN}:UmbraSwap:SwapQuote`,
        contractId: req.params.cid, choice: "AcceptSwapQuote", choiceArgument: {} } }]);
    const proposalCid = await pollNewCid(requester, "UmbraSwap:SwapProposal", before);
    res.json({ ok: true, signed: SIGNED_MODE, proposalCid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// requester commits its offer leg (supplies a backing AssetHolding cid)
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
