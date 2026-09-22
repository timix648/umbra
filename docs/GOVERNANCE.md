# Governed actions

Multi-sig for a Daml application's privileged choices, built on BitSafe's
Decentralization Manager.

This document is the reference for `daml/UmbraGovernance.daml` and
`daml/UmbraGovernanceTest.daml`. It is written to be read by someone who wants
to do the same thing to a different application, not only by someone reading
Umbra.

---

## The problem

Umbra's venue operator can list an asset, delist one, decide who may see the
registry, and fire the execution path of a settled trade. In `UmbraSwap.daml`
every one of those is `controller operator`. One key decides all of them.

That key can also decline. It can hold a settled trade hostage, or pick which
counterparty gets filled, or quietly cut a member off from the venue. Nothing in
the model prevents it, and nothing in the model records that it happened. For a
venue that intends to carry institutional block trades, that is the single point
of control a decentralized party exists to remove.

Making the operator a decentralized party fixes *who holds the key*. It does not,
on its own, give anyone a way to **propose** an action and have a threshold of
operators agree to it. That is what this module adds.

---

## The shape

Each privileged choice is wrapped as a proposal template implementing BitSafe's
`GovernableAction` interface:

```
proposer signs a proposal   ->   nothing happens
operators confirm           ->   manager exercises GovernableAction_Execute
                                 with the governance party's authority
                            ->   executeImpl runs the real choice
```

A proposal is **inert**. It is `signatory proposer`, so anyone can create one
with their own key, and creating one changes nothing. `GovernableAction_Execute`
is `controller governanceParty`, so the proposer who signed it cannot execute it
and neither can a bystander. The proposer may withdraw their own proposal alone,
via `GovernableAction_ProposerCancel`.

That single property — *a proposal confers no authority* — is what everything
else rests on, and it is the first thing the test suite proves.

---

## The one constraint that decides whether this works

> `executeImpl` runs with the governance party's authority **and nothing else.**

So the application's privileged party must **be** the governance party. In
Umbra's case `AssetRegistry.operator` and `governanceParty` are the same
`Party`. Point a proposal at a registry owned by someone else and the exercise
fails for want of authority.

This is the failure custom actions hit first, and it is not obvious from the
interface signature. If you are adapting this module, check that alignment
before you write anything else.

The corollary is the bootstrap problem. `AssetRegistry` is `signatory operator`;
once the operator is decentralized, nobody holds a key that can create it. The
Decentralization Manager's own contract-deployment API cannot create it either —
its field encoding has no list type at all (single parties, scalars, `Set`,
record, optional; `party_set` is a `DA.Set.Types:Set`, not a list), so a template
carrying `participants : [Party]` and `assets : [AssetId]` is inexpressible
there. `CreateRegistryProposal` sidesteps both: it is signed by the proposer's
own key, and the registry it creates is signed by the governance party, because
`executeImpl` runs with that authority. The registry is therefore governed from
the moment it exists, rather than being created by one key and handed over
afterwards.

---

## The actions

| Template | `actionLabel` | Governs |
|---|---|---|
| `CreateRegistryProposal` | `CreateAssetRegistry` | Bringing the registry into existence, already governed |
| `ListAssetProposal` | `ListAsset` | Making a pair tradeable |
| `DelistAssetProposal` | `DelistAsset` | Removing one — strands anyone mid-trade, so as privileged as listing |
| `SetParticipantsProposal` | `SetParticipants` | Who may see the venue at all |
| `ExecuteRealSwapProposal` | `ExecuteRealSwap` | **Settlement itself** — both allocation legs plus the fee, one transaction |

The first four govern configuration. The last one governs money moving, and is
the reason the module is worth having.

### Why the trade is written on the proposal

`ExecuteRealSwapProposal` carries `offerSymbol`, `offerAmount` and `wantSymbol`
as plain fields, duplicating what is already on the settlement. That looks like
denormalisation for its own sake. It is not.

The interface `view` is a pure function. It cannot `fetch`. A proposal that
carried only a `ContractId` would show each operator an opaque hash and ask them
to approve it — which is not approval, it is a rubber stamp. So the trade is
summarised where the view can reach it, and that summary is what crosses into
the manager's UI.

The summary is not taken on trust. `executeImpl` fetches the settlement and
asserts the summary matches before exercising anything:

```daml
s <- fetch settlementCid
assertMsg "the settlement does not match the approved summary"
  (s.offerAsset.symbol == offerSymbol
    && s.offerAmount == offerAmount
    && s.wantAsset.symbol == wantSymbol)
```

A proposer who describes a small trade and points at a large one fails at
execution rather than succeeding quietly. **The operators approve what they
read.**

---

## What is deliberately *not* governed

Order flow. Creating an RFQ, inviting a dealer, submitting a quote, accepting
one — none of it touches this module.

Putting a threshold in front of a quote would not make the venue safer; it would
make it unusable, and it would hand every operator a view of order flow that the
venue's whole privacy claim says they must not have. Governance belongs on the
actions where one key would otherwise be able to decide unilaterally and
permanently. It does not belong on the hot path.

---

## Build

Requires Daml SDK **3.4.11**. Builds from a clean clone with no extra fetch step:

```bash
daml build
```

The BitSafe governance interface is vendored as
`vendor/governance/governance-action-v1-48acd500.dalf`, extracted from the
published release DAR (`decentralization-manager`, hackathon branch,
`releases/v1/governance-action-v1-0.1.0.dar`). It is kept as a `.dalf` rather
than a `.dar` because `.gitignore` excludes `vendor/**/*.dar` as build output,
and a submission has to build from a clean checkout.

A `.dalf` ships without the metadata a `.dar` carries, so the package must be
exposed explicitly or its module stays hidden and the import fails:

```yaml
data-dependencies:
  - vendor/governance/governance-action-v1-48acd500.dalf
build-options:
  - --package=governance-action-v1-0.1.0
```

That pair is the whole trick, and it is the part that works locally and breaks
on a fresh clone if you get it wrong.

---

## Test

```bash
daml test
```

Seven scripts in `daml/UmbraGovernanceTest.daml`, all passing. They run
**without** a Decentralization Manager: the manager decides *when* the threshold
is met, and these prove what is true on either side of that moment, which is the
part that lives in Daml.

| Script | Proves |
|---|---|
| `proposalConfersNoAuthority` | The proposer who signed it cannot execute it; nor can a bystander; the registry is untouched |
| `governanceListsTheAsset` | The governance party executes and the asset is actually listed — authority flows through the exercise chain |
| `proposalDescribesItself` | `actionLabel` and `description` render the venue's own sentence, not a contract id |
| `proposerRetractsAlone` | A proposer may withdraw their own proposal; nobody else may; withdrawing lists nothing |
| `governanceDelists` | Delisting is as privileged as listing and goes the same route |
| `governanceSetsParticipants` | Membership changes are governed too |
| `registryIsBornGoverned` | The bootstrap case: no key can make the registry directly, and the one governance makes is correct |

`proposalDescribesItself` exists because that text is the only thing that reaches
a human operator before they confirm. Empty it and no other test would notice.

### Not covered here

`ExecuteRealSwapProposal`'s summary guard. Exercising it needs a
`SwapSettlement` holding two registry-issued `Allocation` contracts, and nothing
in this package can mint those — the same reason `UmbraSwapTest` proves
settlement through the stand-in `ExecuteSwap` rather than `ExecuteRealSwap`.
That guard is exercised against a real registry, not in the test suite.

---

## Wiring it to a Decentralization Manager

Umbra's backend surfaces pending proposals to *this venue's own* operator, in the
place where they can already see the trade, rather than in a separate admin
console. These variables turn it on; without `DECMAN_URL` and `DEC_PARTY` the
governance endpoints return 404 and the panel stays invisible:

```bash
DECMAN_URL=http://127.0.0.1:8081     # THIS operator's manager node
DEC_PARTY=<the decentralized party>
DEC_RULES_CID=<the governance rules contract id>
```

| Endpoint | Does |
|---|---|
| `GET /api/governance/pending` | Lists proposals with `description`, the confirmation tally, and `canExecute` |
| `POST /api/governance/confirm` | Confirms as **this** operator, against this operator's node only |

This is deliberately **not** the approval surface for the other operators. They
are separate organisations on their own nodes, and they must never depend on
Umbra's frontend to exercise their own judgement — which is also why each
proposal carries its own human-readable summary rather than relying on a UI to
render one.

---

## Adapting this to your own application

1. **Find the choices that are `controller <single party>`** and that are
   permanent, unilateral, or about money. Those are your candidates. The hot
   path is not.
2. **Make that party the governance party.** This is the constraint above and it
   is the step that fails silently if skipped.
3. **Write one template per choice**, `signatory proposer`,
   `observer governanceParty`, with an `interface instance GovernableAction`.
4. **Write a real `description`.** It is the entire basis on which a human
   approves. If it renders a contract id, you have built a rubber stamp.
5. **If the view has to show data it cannot `fetch`,** copy that data onto the
   proposal *and assert it against the source in `executeImpl`*. A summary that
   cannot be checked is worse than no summary.
6. **If the governed template's signatory is the governed party,** you need a
   creation proposal too, or the thing can never be created at all.
7. **Test the negative case first.** `submitMustFail` for the proposer and for a
   bystander is the property that would silently disappear the day someone
   changed `GovernableAction_Execute` to `controller proposer`.

---

## The venue has two keys, and they must not be the same key

Encrypting the operator key protects it **at rest**. It does not reduce what
that key can *do* once it is loaded, and the backend has to hold something hot
enough to drive a trade at trade speed. So the question that decides whether
this is safe for real money is not *"is the key safe"* but **"what is the worst
a stolen hot key can do"**.

### Why not simply govern everything

Because a 2-of-3 human vote in front of opening an RFQ makes the venue
unusable, and it hands every operator a view of order flow the privacy claim
says they must not have. The split is the design, not a compromise.

| | Governance party (decentralized) | Executor (hot key) |
|---|---|---|
| List / delist an asset | ✅ threshold | ❌ |
| Change who may see the venue | ✅ threshold | ❌ |
| Settle — `ExecuteSwap`, `ExecuteRealSwap` | ✅ threshold | ❌ |
| Suspend or reinstate a dealer | ✅ threshold | ❌ |
| Open an RFQ under a mandate | — | ✅ |
| Propose / accept a settlement the parties already allocated for | — | ✅ |

The executor can **sequence actions the counterparties have already
authorised, and nothing else.** It cannot change what is tradeable, it cannot
change who may see the venue, and it cannot move value.

### It needs no new schema

`TradingMandate` carries its **own** `operator` field, chosen by the granting
party. A desk grants the mandate to the venue's *executor* while the registry
stays owned by the *governance* party. The separation is already expressible;
what matters is that a deployment actually uses two parties.

### The deployment requirement that makes governance binding

> `ExecuteRealSwap` is `controller operator`.

Read that carefully: the governance proposal is a **route**, not a gate. If
`operator` is an ordinary single key, that key can settle any real swap
directly and the threshold is advisory. **The governance module only binds when
`operator` IS the decentralized party.**

That is the single most important line in this document. `AssetRegistry.operator`,
`SwapSettlement.operator` and `governanceParty` must all be the same
decentralized party, and the executor must be a different party from all of
them.

### Proofs

`daml/UmbraTrustBoundaryTest.daml`, 7 scripts:

| Script | Proves |
|---|---|
| `hotKeyCannotTouchTheRegistry` | list, delist and participant changes all refused |
| `hotKeyCannotSettle` | neither `ExecuteSwap` nor `ExecuteRealSwap`; nor can either counterparty settle unilaterally |
| `hotKeyRunsTheMandate` | what it *is* for — and the RFQ still belongs to the granting party |
| `aMandateConfersNoVenuePower` | holding a live mandate widens nothing; the registry and settlement stay closed |
| `theGovernedPartyHoldsThePrivilegedPowers` | the positive control — without it the suite would pass if *nobody* could act |
| `theTwoKeysAreDistinct` | the deployment mistake that would silently collapse the whole separation |

