const express = require("express");
const { ledgerFetch } = require("./token");
const { onboardExternalParty, prepareSignExecute } = require("./external");
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`[umbra-backend] listening on ${PORT} | mode=${SIGNED_MODE ? "SIGNED (trust-no-operator)" : "DEMO (operator)"}`));
