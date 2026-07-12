# Umbra

**A private, non-custodial OTC venue for institutional block trades — built on Canton.**

Umbra is a dark request-for-quote (RFQ) venue where a buyer privately solicits competing
quotes from multiple dealers and settles the winning trade as a single, atomic
delivery-versus-payment (DvP) swap. Competing dealers are **cryptographically blind to one
another** — not by application logic, but by Canton's sub-transaction privacy and signatory
rules. No dealer can see whether a rival was even invited, let alone what they quoted.

> Every public blockchain leaks block trades. Order flow, counterparties, and size are
> visible to anyone — which is precisely why institutions cannot use them for real size.
> Canton was built to fix exactly this. **Umbra is the proof.**

**Challenge track:** Private DeFi & Capital Markets
**Network:** Canton DevNet (Seaport validator)
**Status:** Live end-to-end on DevNet — privacy, atomic settlement, external-party signing,
and CIP-56 standard settlement all working against real ledger infrastructure.

---

## Links

- **Demo video:** _link_
- **Live app:** _link_
- **Landing page:** _link_
- **Submission:** _link_
- **Contact / socials:** _link_

---

## Why this can only work on Canton

Umbra is not a trading app that happens to be on Canton. It is a venue that **cannot
meaningfully exist anywhere else**, because it depends on three Canton-native properties:

1. **Sub-transaction privacy.** On a transparent chain, every quote is public to all
   participants. On Canton, a `Quote` contract is only disclosed to its stakeholders
   (the requester and the quoting dealer). Dealer 1's quote is invisible to Dealer 2 at the
   ledger level — the data is never sent to them. This is enforced by the protocol, not hidden
   by a frontend.

2. **Atomic, multi-party settlement.** The cash leg and the asset leg move in one indivisible
   transaction, or neither moves. There is no settlement risk, no escrow intermediary, and no
   moment where one party has delivered and the other has not.

3. **Self-custody with no trusted operator.** In signed mode, each party signs with its own
   external key. The venue operator coordinates the workflow but **cannot forge a party's
   authority or move their assets**. Umbra is a venue, never a custodian.

A public-orderbook DEX clone fights the chain it runs on. Umbra uses the one thing Canton
uniquely offers.

---

## The five guarantees (all proven live on DevNet)

| # | Guarantee | How it's enforced |
|---|-----------|-------------------|
| P1 | **No information leakage** — dealers are blind to each other | Canton signatory/observer rules; rival quotes are never disclosed to the ledger query of a competing dealer |
| P2 | **Atomic DvP** — both legs settle or neither does | Custom settlement engine: cash is locked on accept, then swapped against the asset in a single transaction |
| P3 | **External-party signing** — no trusted operator | Parties onboarded with their own keys; transactions assembled, signed, and executed under each party's own authority |
| P4 | **CIP-56 Holding interface** — standards-compliant assets | Holdings implement the Splice `Holding` interface, rendering a standard `HoldingView` |
| P5 | **CIP-56 allocation-based atomic DvP** — settlement via the token standard | Each party creates its own `Allocation` (signatory = sender); the executor assembles a fully-signed settlement and fires a single atomic `ExecuteTransfer` across both legs |

The headline engineering result is **P5**: a working CIP-56 allocation-based atomic swap, in
both operator mode and trust-no-operator signed mode, on live DevNet.

---

## How a trade flows

```
Requester                 Umbra venue                Dealer 1        Dealer 2
    |                          |                          |              |
    |-- create RFQ ----------->|                          |              |
    |-- invite D1, D2 -------->|---- invitation --------->|              |
    |                          |---- invitation -------------------------->|
    |                          |<--- private quote -------|              |
    |                          |<--- private quote --------------------------|
    |   (sees BOTH quotes)     |   (D1 cannot see D2's quote, or vice versa)
    |-- award / CIP-56 ------->|                          |              |
    |                          |==== atomic DvP swap =====|              |
    |   cash --> dealer,  asset --> requester,  in ONE indivisible transaction
```

The requester chooses which dealers to invite — this is relationship-based block trading, by
design. The privacy that matters is **dealer-to-dealer blindness**: it stops inter-dealer
information leakage, which is what gives the requester honest, competitive pricing.

---

## Architecture

```
umbra/
  daml/
    Umbra.daml         Core market contracts + custom atomic settlement engine
    UmbraDvP.daml      CIP-56 allocation-based atomic DvP (standards-compliant path)
    UmbraTest.daml     Demo init script
  backend/
    server.js          Express API over the Canton JSON Ledger API v2
    token.js           OAuth client-credentials auth + ledger fetch with 401 retry
    external.js        External-party onboarding + prepare/sign/execute (signed mode)
    public/
      landing.html     Marketing landing page  (/)
      index.html       The live trading terminal (React via CDN)  (/app)
  vendor/              Vendored Splice CIP-56 interface DARs (v1.0.99)
```

### On-ledger model (Daml)

**`Umbra.daml`** — the core venue and the custom settlement engine:

- `CashHolding`, `InstrumentHolding` — tokenized cash and securities, implementing the CIP-56 `Holding` interface (P4).
- `Rfq` — a request for quote, signed by the requester.
- `RfqInvitation` — a dealer's invitation to quote (`Invite` / `DeclineInvitation`).
- `Quote` — a dealer's private bid (`SubmitQuote`), visible only to requester + that dealer (P1).
- `SettlementInstruction` — created on `AcceptQuote` (which locks the requester's cash by archiving it); `Settle` then performs the atomic swap (P2).

**`UmbraDvP.daml`** — the CIP-56 allocation-based settlement path (P5):

- `CashAllocation`, `InstrumentAllocation` — each implements the Splice `Allocation` interface, with **signatory = the sending party**, so each party authorizes its own leg. The operator never forges authority.
- `DvPProposal` -> `DvPDealerAccepted` -> `DvPSettlement` — a propose/accept choreography. Because the final `DvPSettlement` is signed by requester, dealer, **and** executor, its `ExecuteDvP` choice carries enough authority to drive the nested `Allocation_ExecuteTransfer` on both legs atomically. This solves the authority-propagation wall that a naive flat multi-party submission hits.

> **Why the choreography matters:** `Allocation_ExecuteTransfer` requires the authority of executor, sender, **and** receiver. A flat `actAs: [a, b, c]` submission does **not** propagate that authority through a nested interface exercise. The propose/accept flow gathers each party's signature onto a single jointly-signed contract whose choice then carries all the authority required for the atomic transfer.

### Backend (`server.js`)

A thin Express layer over the Canton JSON Ledger API v2. It does not hold keys to user assets and is non-custodial by design. Selected endpoints:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/mode` | Toggle operator / signed (trust-no-operator) mode |
| POST | `/api/rfqs` | Create an RFQ |
| POST | `/api/rfqs/:cid/invite` | Invite a dealer |
| POST | `/api/invitations/:cid/quote` | Submit a private quote |
| GET  | `/api/quotes?role=...` | Role-scoped quote view (proves P1: dealers see only their own) |
| POST | `/api/quotes/:cid/accept` | Lock cash, create settlement instruction |
| POST | `/api/settlements/:cid/settle` | Custom atomic DvP swap (P2) |
| POST | `/api/award` | One-call custom atomic settlement |
| POST | `/api/dvp/award` | One-call CIP-56 allocation-based atomic settlement (P5) |
| GET  | `/api/holdings?role=...` | Holdings / balances per party |

Key helpers: `cleanupRfq` (archives an RFQ and its quotes/invitations after settlement), `pollNewCid` (handles asynchronous signed-mode commits), and `partyIdFor` / `roleOfParty` (operator- vs. external-party identity mapping).

### Frontend (`backend/public/index.html`)

A single-file React terminal (loaded via CDN — no build step) that renders all four party views side by side so the privacy asymmetry is visible: the requester sees every quote, each dealer sees only its own (rival quotes show as redaction bars), and a public observer sees nothing. A settlement overlay animates the atomic swap as the climax of a trade.

---

## Running locally

### Prerequisites

- Node.js v20+
- Daml SDK 3.4.11
- Access credentials for a Canton DevNet validator (ledger-API scope)

### 1. Configure environment

Create `backend/.env` (never commit this):

```
AUTH_URL=https://auth.sandbox.fivenorth.io/application/o/token/
CLIENT_ID=validator-devnet-m2m
CLIENT_SECRET=your_secret_here
AUDIENCE=validator-devnet-m2m
SCOPE=daml_ledger_api
LEDGER_API=https://ledger-api.validator.devnet.sandbox.fivenorth.io
SYNCHRONIZER_ID=global-domain::1220...
REQUESTER=Requester::1220...
DEALER1=Dealer1::1220...
DEALER2=Dealer2::1220...
```

### 2. Build the Daml model

```
export PATH="$HOME/.daml/bin:$PATH"
daml build
```

### 3. Run the backend (serves the API and the UI)

```
cd backend
npm install
node server.js
```

### 4. Open the app

- Landing page: http://localhost:4000/
- Trading terminal: http://localhost:4000/app
- Health check: http://localhost:4000/health

---

## Design decisions and honest limitations

These are deliberate scoping choices for the hackathon, documented plainly:

- **Demo holdings are minted as stand-ins.** In production the cash leg would be bank-issued tokenized cash and the asset a tokenized security from a real registry; here we mint test holdings to demonstrate the swap mechanics. The atomic-settlement logic is identical either way.
- **The CIP-56 path re-funds fresh holdings per settlement** rather than settling against the exact pre-funded holdings quoted. The next production step is settling against pre-funded, quote-bound holdings — the settlement primitive is already proven; this is a workflow addition.
- **Instruments are free-text labels**, not validated against an on-chain securities registry.
- **Deadlines on allocations are not enforced** in this flow (a fixed settlement reference is used to keep `mkSpec` pure).
- **Single asset class** demonstrated end-to-end; the model generalizes to multiple.

## Roadmap

- Settle against pre-funded, quote-bound holdings (close the re-mint gap).
- Full multi-party external-signer execution via a dedicated executor party.
- Real tokenized-cash and tokenized-security registries as issuer parties.
- Loop Wallet / Canton Coin onboarding for end-to-end self-custody UX.
- Configurable dealer panels and persistent settlement history.

---

## License

MIT
