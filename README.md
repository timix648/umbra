# Umbra

**A private, non-custodial OTC venue for institutional block trades — built on Canton.**

Umbra is a dark request-for-quote (RFQ) venue. A buyer privately asks several dealers to
price a block. The dealers are **cryptographically blind to one another** — a rival's quote
is never *sent* to a competing dealer; Canton's sub-transaction privacy withholds it at the
ledger, not the frontend. The winning trade settles as a single **atomic delivery-versus-payment
swap of real registry-issued assets**: both legs move, or neither does.

> Every public blockchain leaks block trades. Order flow, counterparties, and size are visible
> to anyone — which is precisely why institutions cannot use them for real size. Canton was
> built to fix exactly this. **Umbra is the proof.**

**HackCanton League S2** · Financial Applications: DeFi, Exchanges & Prediction Markets
Targeting the **cBTC** (BitSafe) and **cETH** (onRails) asset challenges with a single venue.

---

## Links

- **Live app:** https://um-bra.app/
- **Contact:** https://x.com/UmbraOnCanton
- **Demo:** https://youtu.be/bclZUlSeiE0?si=w7SfAyIYbb5juLzF
- **Presentation Deck:** https://docs.google.com/presentation/d/1WoZ2BQWhdrjZlP-PPh5HQ4Jc2g2BCceG/edit?usp=sharing&ouid=111114609282721158539&rtpof=true&sd=true

---

## The headline: real assets, atomically, wallet-signed — on live DevNet

This is not a mock. On the live 5North Canton DevNet, Umbra settles **real registry-issued
assets across three different issuers, atomically, driven from the UI**:

- **cBTC** issued by BitSafe (`cbtc-network`)
- **cETH** issued by onRails (`rails-cethMain-1-dev`)
- **Canton Coin** issued by the DSO (`DSO`, via the 5North scan-proxy)

A full trade — RFQ → blind dealer quotes → award → allocate both real legs → atomic execute →
on-ledger settlement contract → live balances crossing — runs end to end against these three
real registries. The settlement is a single indivisible CIP-56 transaction: both legs move or
neither does. Underfunded trades are refused by the ledger; fragmented balances are coin-selected
and merged by the registry; a failed settlement rolls back cleanly with nothing stranded.

**And it is wallet-signed.** In signed mode, every step — RFQ, quote, accept, and the atomic
settlement itself — is authorized by each party's own external Ed25519 key via Canton's
interactive submission (prepare → sign → execute). The venue coordinates; it never holds a
party's authority. The settlement receipt reads **TRUST: each party self-signed**. This is
proven on-ledger with balances crossing, not asserted as a design property.

---

## What works today

Everything below runs against the live 5North Canton DevNet. Nothing here is mocked.

**Working, end to end, from the UI:**
- A full RFQ trade: create request -> invite dealers -> private quotes -> award -> allocate
  both real legs -> atomic settle -> on-ledger receipt -> balances cross.
- **Real cross-issuer settlement** of cBTC (BitSafe), cETH (onRails) and Canton Coin (DSO) --
  three separate registries, one settlement path, no per-asset branches.
- **Atomic DvP**: both legs move in one indivisible CIP-56 transaction, or neither does.
- **Blind quoting**: a dealer cannot see a rival's price, count, or existence -- enforced by
  Canton's disclosure rules, verifiable with the role-scoped `curl` calls above.
- **Ledger-enforced expiry**: a late quote and a stale price are refused by Daml, not the UI.
- **Fragmented balances**: multi-holding coin-selection; the registry merges and returns change.
- **Clean failure**: an underfunded or failed settlement rolls back both allocations, re-opens
  the request, and alerts the dealer to re-quote. Nothing is left stranded.
- **Wallet-signed mode**: every step -- RFQ, quote, accept, and the atomic settlement -- is
  signed by that party's own Ed25519 key via interactive submission. Receipt reads
  *TRUST: each party self-signed*.

**Honest limits:**
- Signed mode holds each party's external key **server-side** and signs on their behalf. The
  signatures are real and party-specific -- the venue cannot forge a party's authority -- but
  a user does not yet approve in their own wallet app. Connecting a third-party Canton wallet
  (dApp SDK / CIP-0103) is the next step, not a shipped feature; see Roadmap.
- Runs on DevNet, which resets periodically; balances are re-funded from the issuers' faucets.
- The market reference is a real spot mid. Umbra shows no bid/ask spread, because a public
  feed does not provide one and inventing it would be dishonest.

---

## What makes this different

Umbra began as a single-asset RFQ venue with atomic CIP-56 settlement. For HackCanton it was
rebuilt around a **unified any-to-any settlement engine**, and four things were added that most
venues do not have:

**1. Any asset for any asset.** cBTC, cETH and CC are all ordinary CIP-56 assets. There is no
"cash leg" and no "instrument leg" — a swap is `leg A ↔ leg B`, whatever they are. So
**cBTC ↔ cETH settles directly**, with no stablecoin in the middle. One code path, no per-asset
branches. The `swapCbtcForCeth` proof exercises exactly this cross-pair.

**2. Expiry the ledger actually enforces.** An RFQ has an `expiresAt`; a quote has a
`validUntil`. A dealer who quotes after the window closes is **refused by the ledger**, and a
requester cannot lift a price that is no longer firm. This is not a greyed-out button — it is a
Daml `assertMsg` against `getTime()`, and there are tests that prove it.

**3. Privacy you can verify yourself.** Every read endpoint is role-scoped. Run these against a
live venue with two dealers quoting:

```bash
curl "$UMBRA/api/swap/quotes?role=dealer1"   # only dealer1's own quote
curl "$UMBRA/api/swap/quotes?role=dealer2"   # only dealer2's own quote
curl "$UMBRA/api/swap/quotes?role=public"    # nothing at all
```

The claim is testable, not asserted.

**4. Honest numbers, or none.** The market reference is a real BTC/ETH cross from a live price
feed. There is **no bid/ask spread shown**, because a public spot feed gives a mid only and
fabricating a spread in a trading venue is worse than showing nothing. Any pair involving CC
returns `—` with a stated reason: CC has no reliable public price. If a value is not real, Umbra
says so.

---

## Why this can only work on Canton

1. **Sub-transaction privacy.** A `SwapQuote` is disclosed only to its stakeholders — the
   requester and the quoting dealer. Dealer 1's price is not merely hidden from Dealer 2; it is
   **never sent to them**. On a transparent chain this venue cannot exist.

2. **Atomic multi-party settlement.** Both legs move in one indivisible transaction. No
   settlement risk, no escrow, no moment where one side has delivered and the other has not.

3. **Self-custody, no trusted operator.** In signed mode each party signs with its own external
   key. The venue coordinates; it can never forge a party's authority or move their assets.
   Umbra is a venue, never a custodian.

---

## The eight guarantees

| # | Guarantee | How it is enforced |
|---|-----------|--------------------|
| P1 | **No information leakage** — dealers are blind to each other | Canton signatory/observer rules; a rival's quote is never disclosed to a competing dealer's ledger view |
| P2 | **Atomic DvP** — both legs settle or neither does | `ExecuteRealSwap` fires `Allocation_ExecuteTransfer` on both real legs in a single transaction |
| P3 | **External-party signing** — no trusted operator | Parties onboarded with their own keys; prepare/sign/execute under each party's own authority. Proven on-ledger: TRUST reads "each party self-signed" |
| P4 | **CIP-56 Holding interface** | Settlement runs against the registry's real `Holding` interface (package `93c942ae…`) |
| P5 | **CIP-56 allocation-based atomic DvP** | Each party allocates its own real leg (signatory = sender); a jointly-signed settlement fires one atomic transfer across both legs |
| P6 | **Sound settlement** — underfunded trades are refused, not silently minted | Each allocation asserts the holder genuinely holds enough; the registry refuses underfunded transfers |
| **P7** | **Expiry is ledger-enforced** — a late quote is refused | `SubmitSwapQuote` asserts `now < rfq.expiresAt`. Not a UI timer — a protocol rule |
| **P8** | **Firmness is ledger-enforced** — a stale price cannot be lifted | `AcceptSwapQuote` asserts `now < quote.validUntil` |

Every guarantee has a headless test. `daml test` proves the engine without a network:

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

The tests prove the engine's logic offline; the live DevNet deployment proves the same engine
settling **real** cBTC, cETH and CC across three real registries.

---

## How a trade flows

```
Requester                    Umbra                  Dealer 1        Dealer 2
    |                          |                        |               |
    |-- SwapRfq -------------->|                        |               |
    |   (offer cBTC, want cETH, expires in 15m)         |               |
    |-- invite ---------------->---- invitation ------->|               |
    |                          |---- invitation ------------------------>|
    |                          |<--- private quote -----|               |
    |                          |<--- private quote --------------------- |
    |   sees BOTH              |   D1 cannot see D2's quote. Or that it exists.
    |-- award (hold 1.5s) ---->|                        |               |
    |                          |==== atomic real swap ==|               |
    |   real cBTC -> dealer,  real cETH -> requester,  ONE indivisible transaction
    |                          |   each leg signed by its own party's key (signed mode)
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
    external.js          External-party onboarding, prepare/sign/execute (multi-party)
    public/
      landing.html       /
      index.html         /app  — the terminal (React via CDN, no build step)
      assets/            Official cBTC, cETH and Canton Coin marks
  vendor/
    registry-matched/    The registry's own CIP-56 packages, matched by package-id
                         (allocation 93c942ae, holding 718a0f77, metadata 4ded6b66)
```

### The engine — `daml/UmbraSwap.daml`

| Template | Role |
|---|---|
| `AssetId {admin, symbol}` | An asset is an issuer plus a symbol. Nothing else. |
| `AssetRegistry` | Operator-curated tradeable set, **on-ledger**, not backend config |
| `AssetHolding {owner, asset, amount}` | A generic stand-in holding for offline proofs. Implements CIP-56 `Holding` |
| `SwapRfq` → `SwapInvitation` → `SwapQuote` | The private RFQ chain. Carries `expiresAt` / `validUntil` |
| `SwapProposal` → `SwapSettlement` | The awarded trade and the jointly-signed settlement |
| `RecordRealSwap` (on `SwapProposal`) | Records a real-asset settlement — **demo mode** (operator submits, two-party) |
| `ProposeRealSwap` → `RealSwapPending` → `AcceptRealSwap` | **Signed mode** single-party choreography: requester proposes, dealer accepts, each signing alone |
| `ExecuteRealSwap` (on `SwapSettlement`) | The one-command atomic execute — fires `Allocation_ExecuteTransfer` on both real legs |

**The hard part — matching the registry's interface, and single-party signing.** Two walls,
both solved:

*Interface identity.* `Allocation_ExecuteTransfer` on a real registry allocation resolves the
`AllocationV1` interface **by compiled package-id**. Umbra's own build has to reference the exact
package the registry implements (`93c942ae…`), not a vendored copy at a different hash — otherwise
the ledger reports `CONTRACT_DOES_NOT_IMPLEMENT_INTERFACE`. Umbra is compiled against the
registry's own packages, pulled from the participant and matched by package-id.

*Single-party authority.* Canton's interactive submission is **one-party-only**, but a two-leg
DvP needs both parties' authority. Umbra solves it with a propose/accept choreography
(`ProposeRealSwap` → `AcceptRealSwap`): the requester proposes under its own signature, the dealer
accepts under its own, and the resulting `SwapSettlement` carries **both** signatories — so its
`ExecuteRealSwap` choice, submitted single-party, still has the authority to fire both legs. The
executing party discloses the counterparty's allocation from the counterparty's own ledger view,
so the single-party prepare can reference it. This is the wall every wallet-signed CIP-56 DvP
hits; Umbra is through it.

### Backend

The venue speaks the Canton JSON Ledger API v2. The blind auction runs over `/api/swap/*`; the
real-asset settlement the UI actually drives runs over `/api/real/*`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/swap/rfq` | Create a swap RFQ (offer asset → want asset, with a window) |
| POST | `/api/swap/rfqs/:cid/invite` | Invite a dealer |
| GET | `/api/swap/invitations?role=` | **Role-scoped** — a dealer sees only its own |
| POST | `/api/swap/invitations/:cid/quote` | Submit a private, time-limited price |
| GET | `/api/swap/quotes?role=` | **Role-scoped — this is the privacy proof** |
| POST | `/api/swap/quotes/:cid/accept` | Award — begins the choreography |
| POST | `/api/swap/proposals/:cid/settle-real` | **The real-asset atomic settlement the UI drives** (mode-aware: demo or signed) |
| GET | `/api/real/holdings?role=` | Real registry-issued balances |
| POST | `/api/real/allocate` | Allocate a real leg (CIP-56, multi-holding coin-selection) |
| POST | `/api/real/settle` | Multi-leg atomic execute over real allocations |
| POST | `/api/real/withdraw/:cid` | Release a real allocation (party-signed in signed mode) |
| POST | `/api/real/send` | Move real assets to a party (TransferFactory) |
| GET | `/api/market/rate?base=X&quote=Y` | Real BTC/ETH cross. `null` + a reason when there is no honest price |
| GET | `/api/ledger/contract/:cid` | Read a contract back off Canton — the proof it happened |

### Frontend

Three surfaces, one file, no build step.

**Dealer desk.** A request queue, and one focal ask: *"The buyer gives cBTC. What do you pay, in
cETH?"* Quick-fill pricing off the real mid (`Ref` / `±0.10%`), implied rate, and a panel —
**"The ledger withholds"** — where a rival's price, count and existence render as pulsing
redaction bars. *Blind by construction. Quote freely.*

**Requester desk.** The blind block auction. Quotes arrive ranked, priced in **basis points
against the live mid**, each with its own firmness countdown. Awarding requires **pressing and
holding** — settlement is irreversible, and the interface makes you feel it.

**The settlement vault.** Two leaves, one per asset, close **equal and opposite on an identical
curve** — that *is* atomicity. They weld at the seam; the door thunks home. One piece now. And if
the ledger **refuses** the trade, the door is rejected at contact and both leaves recoil.
*Nothing moved.* The receipt carries the real contract ID and ledger offset — click it and Umbra
reads the record back off Canton.

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
PACKAGE_NAME=umbra-v8

REQUESTER=Requester::1220...
DEALER1=Dealer1::1220...
DEALER2=Dealer2::1220...
OBSERVER=Observer::1220...

PORT=4000
SIGNED_MODE=false
```

### 2. Build and prove

```bash
export PATH="$HOME/.daml/bin:$PATH"
daml build          # -> .daml/dist/umbra-v8-0.1.1.dar
daml test           # 8 swap proofs + the legacy suites
```

### 3. Deploy the package

The build is compiled against the registry's real CIP-56 packages (in `vendor/registry-matched/`,
matched by package-id). Upload the DAR to the participant over the JSON API:

```bash
curl -X POST "$LEDGER_API/v2/packages" \
  -H "Content-Type: application/octet-stream" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary @.daml/dist/umbra-v8-0.1.1.dar
```

### 4. Run

```bash
cd backend && npm install && node server.js
```

- Terminal: `http://localhost:4000/app`
- Two dealers, two windows: `?role=dealer1` and `?role=dealer2` — separate sessions, and
  neither can see the other's price.
- Signed mode (wallet-signed): `POST /api/mode -d '{"signed":true}'` — parties become their
  external-key wallet parties, and every step is signed with each party's own key.

---

## Asset integration status

The settlement engine is **issuer-agnostic by design**: settlement runs against the CIP-56
`Holding` / `AllocationV1` interfaces, and the engine does not know or care which registry minted
an asset. That is deliberate — it is what makes the same code path settle cBTC, cETH and CC
without a single per-asset branch.

**Integration status — done and proven on live DevNet:**

| Step | Status |
|---|---|
| CIP-56 `Holding` interface implemented | done |
| Engine settles any asset against any other | done, 8 tests green |
| On-ledger `AssetRegistry` listing cBTC / cETH / CC | done |
| Compiled against the registry's real CIP-56 packages (allocation `93c942ae`) | done |
| Real BitSafe cBTC + onRails cETH + DSO Canton Coin settling atomically from the UI | **done — proven on 5North DevNet** |
| Wallet-signed settlement (each party's own key; TRUST "self-signed") | **done — proven on-ledger, balances crossing** |

Real cBTC (BitSafe / `cbtc-network`), real cETH (onRails / `rails-cethMain-1-dev`) and real
Canton Coin (DSO, via the scan-proxy) settle atomically across issuers, driven from the UI,
with fragmented-balance coin-selection and clean rollback on failure. The privacy, the
atomicity, the soundness guards, and the ledger-enforced expiry each additionally have headless
tests that pass under `daml test`.

## Roadmap

- **Front-door wallet connection.** Signed mode already gives the trust property — each party
  signs with its own key and the venue holds no one's authority. The next step is letting a
  dealer connect an external wallet through a hosted Wallet Gateway / dApp SDK, so the keys live
  on the dealer's device rather than being managed for them. Umbra is CIP-0103-compatible and
  positioned for this.
- **Standing balances** — settlement is funded per-trade today; bind it to persistent balances.
- **Quote history with outcomes** — won / passed / expired, derived from settlement records.

---

## License

MIT