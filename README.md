# Umbra

**A private, non-custodial OTC venue for institutional block trades — built on Canton.**

Umbra is a dark request-for-quote (RFQ) venue. A buyer privately asks several dealers to
price a block. The dealers are **cryptographically blind to one another** — a rival's quote
is never *sent* to a competing dealer; Canton's sub-transaction privacy withholds it at the
ledger, not the frontend. The winning trade settles as a single **atomic delivery-versus-payment
swap**: both legs move, or neither does.

> Every public blockchain leaks block trades. Order flow, counterparties, and size are visible
> to anyone — which is precisely why institutions cannot use them for real size. Canton was
> built to fix exactly this. **Umbra is the proof.**

**HackCanton League S2** · Financial Applications: DeFi, Exchanges & Prediction Markets
Targeting the **cBTC** (BitSafe) and **cETH** (onRails) asset challenges with a single venue.

---

## Links

- **Live app:** https://um-bra.app/
- **Contact:** https://x.com/UmbraOnCanton

---

## What makes this different

Umbra already existed as a single-asset RFQ venue with atomic CIP-56 settlement. For
HackCanton it was rebuilt around a **unified any-to-any settlement engine**, and four things
were added that most venues do not have:

**1. Any asset for any asset.** cBTC, cETH and CC are all ordinary CIP-56 assets. There is
no "cash leg" and no "instrument leg" — a swap is `leg A ↔ leg B`, whatever they are. So
**cBTC ↔ cETH settles directly**, with no stablecoin in the middle. One code path, no
per-asset branches.

**2. Expiry the ledger actually enforces.** An RFQ has an `expiresAt`; a quote has a
`validUntil`. A dealer who quotes after the window closes is **refused by the ledger**, and a
requester cannot lift a price that is no longer firm. This is not a greyed-out button — it is
a Daml `assertMsg` against `getTime()`, and there are tests that prove it.

**3. Privacy you can verify yourself.** Every read endpoint is role-scoped. Run these
against a live venue with two dealers quoting:

```bash
curl "$UMBRA/api/swap/quotes?role=dealer1"   # only dealer1's own quote
curl "$UMBRA/api/swap/quotes?role=dealer2"   # only dealer2's own quote
curl "$UMBRA/api/swap/quotes?role=public"    # nothing at all
```

The claim is testable, not asserted.

**4. Honest numbers, or none.** The market reference is a real BTC/ETH cross from a live
price feed. There is **no bid/ask spread shown**, because a public spot feed gives a mid only
and fabricating a spread in a trading venue is worse than showing nothing. Any pair involving
CC returns `—` with a stated reason: CC has no reliable public price. If a value is not real,
Umbra says so.

---

## Why this can only work on Canton

1. **Sub-transaction privacy.** A `SwapQuote` is disclosed only to its stakeholders — the
   requester and the quoting dealer. Dealer 1's price is not merely hidden from Dealer 2; it
   is **never sent to them**. On a transparent chain this venue cannot exist.

2. **Atomic multi-party settlement.** Both legs move in one indivisible transaction. No
   settlement risk, no escrow, no moment where one side has delivered and the other has not.

3. **Self-custody, no trusted operator.** In signed mode each party signs with its own
   external key. The venue coordinates; it can never forge a party's authority or move their
   assets. Umbra is a venue, never a custodian.

---

## The eight guarantees

| # | Guarantee | How it is enforced |
|---|-----------|--------------------|
| P1 | **No information leakage** — dealers are blind to each other | Canton signatory/observer rules; a rival's quote is never disclosed to a competing dealer's ledger view |
| P2 | **Atomic DvP** — both legs settle or neither does | One `ExecuteSwap` fires `Allocation_ExecuteTransfer` on both legs in a single transaction |
| P3 | **External-party signing** — no trusted operator | Parties onboarded with their own keys; prepare/sign/execute under each party's own authority |
| P4 | **CIP-56 Holding interface** | `AssetHolding` implements the Splice `Holding` interface |
| P5 | **CIP-56 allocation-based atomic DvP** | Each party creates its own `AssetAllocation` (signatory = sender); a jointly-signed settlement fires one atomic transfer across both legs |
| P6 | **Sound settlement** — underfunded trades are refused, not silently minted | Each allocation asserts the holder genuinely holds enough before any transfer |
| **P7** | **Expiry is ledger-enforced** — a late quote is refused | `SubmitSwapQuote` asserts `now < rfq.expiresAt`. Not a UI timer — a protocol rule |
| **P8** | **Firmness is ledger-enforced** — a stale price cannot be lifted | `AcceptSwapQuote` asserts `now < quote.validUntil` |

Every guarantee has a headless test. `daml test` proves them without a network:

```
swapCbtcForCeth          ok   <- the headline cross-asset swap
swapCbtcForCc            ok
swapCethForCc            ok
swapReturnsChange        ok
swapRejectsUnderfunded   ok   <- P6
swapRejectsLateQuote     ok   <- P7
swapRejectsStaleQuote    ok   <- P8
registryListsAssets      ok
```

---

## How a trade flows

```
Requester                    Umbra                  Dealer 1        Dealer 2
    |                          |                        |               |
    |-- SwapRfq -------------->|                        |               |
    |   (offer 2 cBTC, want cETH, expires in 15m)       |               |
    |-- invite ---------------->---- invitation ------->|               |
    |                          |---- invitation ------------------------>|
    |                          |<--- private quote -----|               |
    |                          |<--- private quote --------------------- |
    |   sees BOTH              |   D1 cannot see D2's quote. Or that it exists.
    |-- award (hold 1.5s) ---->|                        |               |
    |                          |==== atomic swap =======|               |
    |   2 cBTC -> dealer,  71.3 cETH -> requester,  ONE indivisible transaction
```

A dealer may also **decline** — the requester sees who has not priced, but never why.

---

## Architecture

```
umbra/
  daml/
    UmbraSwap.daml       The unified any-to-any engine  <- the HackCanton build
    UmbraSwapTest.daml   8 headless proofs (P1-P8)
    Umbra.daml           Legacy single-asset engine (Encode; kept as fallback)
    UmbraDvP.daml        Legacy CIP-56 DvP path
    UmbraTest.daml / UmbraDvpTest.daml
  backend/
    server.js            Express over the Canton JSON Ledger API v2
    token.js             OAuth client-credentials + ledger fetch
    external.js          External-party onboarding, prepare/sign/execute
    public/
      landing.html       /
      index.html         /app  — the terminal (React via CDN, no build step)
      assets/            Official cBTC, cETH and Canton Coin marks
  vendor/                Vendored Splice CIP-56 interface DARs
```

### The engine — `daml/UmbraSwap.daml`

| Template | Role |
|---|---|
| `AssetId {admin, symbol}` | An asset is an issuer plus a symbol. Nothing else. |
| `AssetRegistry` | Operator-curated tradeable set, **on-ledger**, not backend config |
| `AssetHolding {owner, asset, amount}` | **One** generic holding. Implements CIP-56 `Holding` |
| `AssetAllocation` | **One** generic allocation. `signatory sender` — each party commits its own leg. Asserts sufficiency before transferring |
| `SwapRfq` → `SwapInvitation` → `SwapQuote` | The private RFQ chain. Carries `expiresAt` / `validUntil` |
| `SwapProposal` → `SwapDealerPending` → `SwapSettlement` | The two-leg choreography |

**The hard part — authority propagation.** `Allocation_ExecuteTransfer` requires the combined
authority of **executor, sender and receiver**. A flat multi-party submission does *not*
propagate that authority through a nested interface exercise. Umbra solves it with a
propose/accept choreography: each party creates its own allocation under its own authority,
then a chain of accepts gathers all three signatures onto a **single jointly-signed
settlement contract**, whose `ExecuteSwap` choice then carries enough authority to fire both
legs at once. This is the wall every CIP-56 DvP implementation hits.

### Backend

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/swap/registry/seed` | List tradeable assets on-ledger |
| POST | `/api/swap/rfq` | Create a swap RFQ (offer asset → want asset, with a window) |
| POST | `/api/swap/rfqs/:cid/invite` | Invite a dealer |
| GET | `/api/swap/invitations?role=` | **Role-scoped** — a dealer sees only its own |
| POST | `/api/swap/invitations/:cid/quote` | Submit a private, time-limited price |
| GET | `/api/swap/quotes?role=` | **Role-scoped — this is the privacy proof** |
| POST | `/api/swap/quotes/:cid/accept` | Award — begins the choreography |
| POST | `/api/swap/proposals/:cid/commit-offer` | Requester commits its leg |
| POST | `/api/swap/pending/:cid/commit-want` | Dealer commits its leg |
| POST | `/api/swap/settlements/:cid/execute` | **The atomic swap** |
| GET | `/api/swap/holdings?role=` | Balances |
| GET | `/api/market/rate?base=X&quote=Y` | Real BTC/ETH cross. `null` + a reason when there is no honest price |
| GET | `/api/ledger/contract/:cid` | Read a contract back off Canton — the proof it happened |

### Frontend

Three surfaces, one file, no build step.

**Dealer desk.** A request queue, and one focal ask: *"The buyer gives 2 cBTC. What do you
pay, in cETH?"* Quick-fill pricing off the real mid (`Ref` / `±0.10%`), implied rate, and a
panel — **"The ledger withholds"** — where a rival's price, count and existence render as
pulsing redaction bars. *Blind by construction. Quote freely.*

**Requester desk.** The blind block auction. Quotes arrive ranked, priced in **basis points
against the live mid**, each with its own firmness countdown. Awarding requires **pressing
and holding** — settlement is irreversible, and the interface makes you feel it.

**The settlement vault.** Two leaves, one per asset, close **equal and opposite on an
identical curve** — that *is* atomicity. They weld at the seam; the door thunks home. One
piece now. And if the ledger **refuses** the trade, the door is rejected at contact and both
leaves recoil. *Nothing moved.* The receipt carries the real contract ID and ledger offset —
click it and Umbra reads the record back off Canton.

---

## Running locally

**Prerequisites:** Node.js 20+, Daml SDK 3.4.11, credentials for a Canton DevNet validator.

### 1. `backend/.env`

```
AUTH_URL=https://auth.sandbox.fivenorth.io/application/o/token/
CLIENT_ID=validator-devnet-m2m
CLIENT_SECRET=...
AUDIENCE=validator-devnet-m2m
SCOPE=daml_ledger_api

LEDGER_API=https://ledger-api.validator.devnet.sandbox.fivenorth.io
LEDGER_USER_ID=...
SYNCHRONIZER_ID=global-domain::1220...

# templates are resolved BY NAME — this must match daml.yaml
PACKAGE_NAME=umbra-v2

REQUESTER=Requester::1220...
DEALER1=Dealer1::1220...
DEALER2=Dealer2::1220...
OBSERVER=Observer::1220...

# asset issuers (see Scope below)
ASSET_CBTC_ADMIN=...
ASSET_CETH_ADMIN=...
ASSET_CC_ADMIN=...

PORT=4000
SIGNED_MODE=false
```

### 2. Build and prove

```bash
export PATH="$HOME/.daml/bin:$PATH"
daml build          # -> .daml/dist/umbra-v2-0.2.0.dar
daml test           # 8 swap proofs + the legacy suites
```

### 3. Run

```bash
cd backend && npm install && node server.js
```

- Terminal: `http://localhost:4000/app`
- Two dealers, two windows: `?role=dealer1` and `?role=dealer2` — separate sessions,
  and neither can see the other's price.

### 4. Seed and swap

```bash
curl -X POST localhost:4000/api/swap/registry/seed -H 'Content-Type: application/json' \
  -d '{"assets":[{"symbol":"cBTC"},{"symbol":"cETH"},{"symbol":"CC"}]}'

curl -X POST localhost:4000/api/swap/award -H 'Content-Type: application/json' \
  -d '{"dealer":"dealer1","offerAsset":{"symbol":"cBTC"},"offerAmount":"2",
       "wantAsset":{"symbol":"cETH"},"wantAmount":"71.3","fund":true}'
```

---

## Scope — what is real, and what is not

**Real:** the engine, the privacy, the atomicity, the soundness guards, the ledger-enforced
expiry, the market reference. All eight guarantees have headless tests that pass without a
network.

**The assets.** The settlement engine is issuer-agnostic — an `AssetHolding` implements the
CIP-56 `Holding` interface and the engine does not know or care who minted it. Today the
`ASSET_*_ADMIN` values point at a venue-controlled party, so the cBTC and cETH in the demo
are **self-issued CIP-56 stand-ins**. Wiring the real assets is a configuration change, not a
code change: fund from the BitSafe cBTC faucet and the onRails cETH registry, point the three
`ASSET_*_ADMIN` values at their real issuer parties, re-seed the registry. **No Daml changes.
No engine changes.** That is the point of building it this way.

We would rather say this plainly than put a sponsor's name under a token they did not issue.

## Roadmap

- **Wire the real BitSafe cBTC and onRails cETH registries** (a config change, as above).
- **Wallet-based signing** via the Canton dApp SDK and a Wallet Gateway, so a dealer connects
  their own wallet rather than the venue acting for them. Signed mode already gives the trust
  property; this gives it a front door.
- **Standing balances** — settlement is funded per-trade today; bind it to persistent balances.
- **Quote history with outcomes** — won / passed / expired, derived from settlement records.

---

## License

MIT
