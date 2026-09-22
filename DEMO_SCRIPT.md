# Demo script

Five minutes, recorded, in this order. The old version of this file described a
cash-versus-instrument flow against a sandbox that no longer exists; none of it
applied to the current engine.

**Build for the demo you record, not for the architecture diagram.** Each beat
below is one claim and the evidence for it. Say the limitation out loud at the
end — an unstated limitation a judge discovers themselves costs more than the
feature was worth.

---

## Before recording

```bash
daml build && daml test          # 63 scripts; a green run is beat 0
cd backend && node --test test/*.test.js   # 21 tests
```

Running stack, all on the one host, reached by SSH port-forward:

| localhost | what |
|---|---|
| `:4000` | Umbra |
| `:8081` `:8082` `:8083` | the three Decentralization Manager operators |

```bash
ssh -i ~/.ssh/umbra_vps -L 4000:127.0.0.1:4000 -L 8081:127.0.0.1:8081 \
    -L 8082:127.0.0.1:8082 -L 8083:127.0.0.1:8083 root@<host>
```

`UMBRA_DEMO_ROLES=1` must be set for the venue's sample parties to be usable.
Say so on camera when you use them; it is off by default for a reason.

Check the fee is configured, or the settlement shows two legs instead of three
and the headline claim is wrong on screen:

```bash
grep UMBRA_FEE_PARTY backend/.env      # unset = fee-free
```

---

## Beat 1 — privacy, and the part that is easy to fake

A buyer opens a request; two dealers price it blind.

- `GET /api/swap/quotes` as **dealer A** → one quote, its own.
- as **dealer B** → one quote, its own.
- as the **buyer** → both. *That is the reveal.*

Then the beat most demos skip, and the one a sharp judge will try:

```bash
# dealer A, authenticated, asking for the buyer's view
curl -sS "localhost:4000/api/swap/quotes?role=<buyer party>" \
  -H "Authorization: Bearer $DEALER_A_TOKEN"
# -> 403  "a session may only read its own view"

# and with no session at all
curl -sS "localhost:4000/api/swap/quotes?role=<buyer party>"
# -> 401  "this view is party-scoped"
```

Say plainly: **the ledger withholds a rival's quote, and the application
refuses to hand it over either.** Filtering is not access control; show both.

## Beat 2 — one request, one winner

The buyer awards one quote. Then try to award the other.

- second acceptance → **refused**, the request is gone
- a dealer who had not yet priced tries to quote → **refused**, the auction closed
- `RfqAward` names the winner, the price, and the filled amount

## Beat 3 — settlement, all three legs, or none

Award, commit both legs, execute.

- both principal legs **and the venue fee** move in one transaction
- reconcile balances on screen before and after
- show the `SettlementReceipt` — it is what proves the trade *executed*, as
  opposed to merely stopping existing

Then break it on purpose:

- a settlement whose fee context is omitted → **refused** (it used to settle and
  silently skip the fee)
- an allocation for the wrong amount → **refused**
- confirm **nothing moved** in either case

## Beat 4 — governance, across three operators

One governed action — listing an asset is the clearest.

- propose it
- confirm on operator **1** → tally 1 of 3, not executed
- confirm on operator **2** → threshold met, the asset is listed
- show the proposal's own sentence in the manager UI, not a contract id

Then the honest half: order flow is **not** governed. Opening an RFQ and
quoting need no vote, because a venue that needs a committee to accept a price
is not a venue.

## Beat 5 — what this is not

Say all of it, in your own voice, and do not rush it:

- **The three operators run on one host.** This demonstrates the mechanism, not
  operator independence. Real independence is three organisations on three
  nodes.
- **These are DevNet assets** issued by real registries through
  production-shaped interfaces — not mainnet value, and no cross-chain
  redemption.
- **The contracts are not audited.** Not booked, not quoted.
- **One dealer fills the whole block.** Partial fills across several dealers are
  designed — `RfqAward.filledAmount` is the hook — and not built.
- **The KMS keystore backend is not implemented.** The interface is defined and
  the file backend encrypts at rest; a remote signer is the MainNet step.

---

## What not to do

- Do not narrate the architecture over a slide. Show the request, the refusal,
  the balances.
- Do not claim "no information leakage": an invited dealer can see the
  invitation roster on the `SwapRfq`. Prices are private; the guest list is not.
- Do not demonstrate governance over settlement as if it were routine. It is
  available and deliberately not on the hot path.
