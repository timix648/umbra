const express = require("express");
const { ledgerFetch } = require("./token");
require("dotenv").config();

const app = express();
app.use(express.json());

const PKG = process.env.PACKAGE_ID;
const PKGN = process.env.PACKAGE_NAME;
const PARTIES = {
  requester: process.env.REQUESTER,
  dealer1: process.env.DEALER1,
  dealer2: process.env.DEALER2,
};

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
  if (!r.ok) throw new Error(`${r.status} ${text}`);
  // response is a stream of JSON objects (one per line) or an array; handle both
  let items;
  try {
    items = JSON.parse(text);
  } catch {
    items = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  const arr = Array.isArray(items) ? items : [items];
  // pull out the created-event payload + contractId where present
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

// Resolve a role name (requester/dealer1/dealer2) to a party id.
function partyOf(role) {
  const p = PARTIES[String(role || "").toLowerCase()];
  if (!p) throw new Error(`unknown role '${role}'. use requester|dealer1|dealer2`);
  return p;
}

// --- create an RFQ as the requester ---
app.post("/api/rfqs", async (req, res) => {
  try {
    const { rfqId, instrument, quantity, currency, expiresAt } = req.body;
    const command = {
      commandId: `rfq-${Date.now()}`,
      actAs: [PARTIES.requester],
      commands: [
        {
          CreateCommand: {
            templateId: `#${PKGN}:Umbra:Rfq`,
            createArguments: {
              requester: PARTIES.requester,
              rfqId, instrument, quantity: String(quantity),
              side: "Buy", currency, expiresAt,
            },
          },
        },
      ],
    };
    const r = await ledgerFetch("/v2/commands/submit-and-wait", {
      method: "POST", body: JSON.stringify(command),
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text });
    res.json({ ok: true, result: JSON.parse(text) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- list active RFQs as the requester (gives us contract IDs) ---
app.get("/api/rfqs", async (req, res) => {
  try {
    const rfqs = await queryActive(PARTIES.requester, "Umbra:Rfq");
    res.json({ ok: true, count: rfqs.length, rfqs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- list quotes, scoped to whichever role asks (this is P1 in action) ---
// e.g. GET /api/quotes?role=dealer1  vs  ?role=requester
app.get("/api/quotes", async (req, res) => {
  try {
    const party = partyOf(req.query.role || "requester");
    const quotes = await queryActive(party, "Umbra:Quote");
    res.json({ ok: true, role: req.query.role || "requester", count: quotes.length, quotes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// --- invite a dealer to an RFQ (exercise Invite as the requester) ---
// body: { rfqContractId, dealer: "dealer1" | "dealer2" }
app.post("/api/rfqs/:cid/invite", async (req, res) => {
  try {
    const cid = req.params.cid;
    const dealer = partyOf(req.body.dealer);
    const command = {
      commandId: `invite-${Date.now()}`,
      actAs: [PARTIES.requester],
      commands: [
        {
          ExerciseCommand: {
            templateId: `#${PKGN}:Umbra:Rfq`,
            contractId: cid,
            choice: "Invite",
            choiceArgument: { dealer },
          },
        },
      ],
    };
    const r = await ledgerFetch("/v2/commands/submit-and-wait", {
      method: "POST", body: JSON.stringify(command),
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text });
    res.json({ ok: true, result: JSON.parse(text) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- list a dealer's invitations (scoped to that dealer) ---
app.get("/api/invitations", async (req, res) => {
  try {
    const party = partyOf(req.query.role || "dealer1");
    const invs = await queryActive(party, "Umbra:RfqInvitation");
    res.json({ ok: true, role: req.query.role || "dealer1", count: invs.length, invitations: invs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- submit a quote (exercise SubmitQuote as the dealer) ---
// body: { dealer: "dealer1"|"dealer2", price: number }
app.post("/api/invitations/:cid/quote", async (req, res) => {
  try {
    const cid = req.params.cid;
    const dealer = partyOf(req.body.dealer);
    const command = {
      commandId: `quote-${Date.now()}`,
      actAs: [dealer],
      commands: [
        {
          ExerciseCommand: {
            templateId: `#${PKGN}:Umbra:RfqInvitation`,
            contractId: cid,
            choice: "SubmitQuote",
            choiceArgument: { price: String(req.body.price) },
          },
        },
      ],
    };
    const r = await ledgerFetch("/v2/commands/submit-and-wait", {
      method: "POST", body: JSON.stringify(command),
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text });
    res.json({ ok: true, result: JSON.parse(text) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ---- helper: submit a command set as a given party ----
async function submit(commandId, actAsParty, commands) {
  const body = { commandId: `${commandId}-${Date.now()}`, actAs: [actAsParty], commands };
  const r = await ledgerFetch("/v2/commands/submit-and-wait", {
    method: "POST", body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text}`);
  return JSON.parse(text);
}

// --- fund the requester with cash (creates a CashHolding) ---
// body: { issuer?: party, currency, amount }
app.post("/api/fund/cash", async (req, res) => {
  try {
    const { currency = "USD", amount } = req.body;
    const issuer = req.body.issuer || PARTIES.requester; // self-issued placeholder cash
    const result = await submit("fund-cash", PARTIES.requester, [
      {
        CreateCommand: {
          templateId: `#${PKGN}:Umbra:CashHolding`,
          createArguments: {
            owner: PARTIES.requester,
            issuer,
            currency,
            amount: String(amount),
          },
        },
      },
    ]);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- fund a dealer with an instrument (creates an InstrumentHolding) ---
// body: { dealer: "dealer1"|"dealer2", registry?: party, instrument, quantity }
app.post("/api/fund/instrument", async (req, res) => {
  try {
    const dealer = partyOf(req.body.dealer);
    const { instrument = "UST-2030", quantity } = req.body;
    const registry = req.body.registry || dealer; // self-registered placeholder
    const result = await submit("fund-inst", dealer, [
      {
        CreateCommand: {
          templateId: `#${PKGN}:Umbra:InstrumentHolding`,
          createArguments: {
            owner: dealer,
            registry,
            instrument,
            quantity: String(quantity),
          },
        },
      },
    ]);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- list a party's holdings (cash + instruments) ---
app.get("/api/holdings", async (req, res) => {
  try {
    const party = partyOf(req.query.role || "requester");
    const cash = await queryActive(party, "Umbra:CashHolding");
    const inst = await queryActive(party, "Umbra:InstrumentHolding");
    res.json({ ok: true, role: req.query.role || "requester", cash, instruments: inst });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STEP 1: requester accepts a quote (locks cash, makes SettlementInstruction) ---
// body: { quoteContractId, requesterCashCid }
app.post("/api/quotes/:cid/accept", async (req, res) => {
  try {
    const cid = req.params.cid;
    const { requesterCashCid } = req.body;
    const result = await submit("accept", PARTIES.requester, [
      {
        ExerciseCommand: {
          templateId: `#${PKGN}:Umbra:Quote`,
          contractId: cid,
          choice: "AcceptQuote",
          choiceArgument: { requesterCashCid },
        },
      },
    ]);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- list settlement instructions (scoped) ---
app.get("/api/settlements", async (req, res) => {
  try {
    const party = partyOf(req.query.role || "requester");
    const si = await queryActive(party, "Umbra:SettlementInstruction");
    res.json({ ok: true, role: req.query.role || "requester", count: si.length, settlements: si });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STEP 2: dealer settles (delivers instrument, atomic DvP) ---
// body: { dealer: "dealer1"|"dealer2", settlementCid, dealerInstrumentCid }
app.post("/api/settlements/:cid/settle", async (req, res) => {
  try {
    const cid = req.params.cid;
    const dealer = partyOf(req.body.dealer);
    const { dealerInstrumentCid } = req.body;
    const result = await submit("settle", dealer, [
      {
        ExerciseCommand: {
          templateId: `#${PKGN}:Umbra:SettlementInstruction`,
          contractId: cid,
          choice: "Settle",
          choiceArgument: { dealerInstrumentCid },
        },
      },
    ]);
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`[umbra-backend] listening on ${PORT}`));
