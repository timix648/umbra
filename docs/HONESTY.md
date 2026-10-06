# What is real, what is simulated, what comes next

Written so a reviewer can tell a proof from a claim. Where something ran on one machine,
it says so. Dates are 2026.

---

## Real, on Canton DevNet

These run on our own DevNet validator (Splice 0.8.3) against the real network and the
real token registries.

| | Evidence |
|---|---|
| Atomic settlement of real CBTC and Canton Coin | Settlement receipts on-ledger; one transaction moves the payment, the offer and the venue fee, or none of them |
| One signature per side per trade (firm quotes, umbra-v9 0.12) | The dealer's quote locks its payment and fee in the same signature; the requester's award locks its side in one; the venue settles |
| The venue cannot see losing quotes | Queried on the ledger as the venue's party: 0 firm quotes, 0 of their locks. The fee receiver is not shown the fee lock either |
| Non-custodial | Every lock sits in its owner's wallet at the registry and can only execute as the signed deal or go back to its owner (100 Daml tests) |
| Transactions checked before a wallet signs | The page recomputes each hash with Canton's own code and checks the acting party, the actions and the user's numbers. Tested on real quote, request, transfer and cancel transactions and in a browser |
| The venue's keys isolated | A separate signer process, as its own OS user, holds the keys and passphrase and signs only settlement, cancel, resize and listing actions. The app runs unprivileged and holds neither |
| The venue signer refuses by default | Enforce mode: it will not sign a bare hash, recomputes the prepared transaction's hash itself, requires the transaction to act for its own role, and refuses any root choice outside that role's allowlist. The demo dealer roles hold keys but have no policy entry, so they are refused everything |
| Monitoring | `/api/status`, local-only Prometheus metrics, and a watchdog every two minutes |
| Our validator on BFT | Moved from trust-single to BFT on 30 Sep: 14 of 14 Scan HTTP checks and 14 sequencer TLS checks passed at the switch, scan initialised 14 endpoints. Reachability is a live measurement, not a permanent count, so recheck it before quoting a number |
| DecMan v1.12 on our DevNet node | Running beside our participant with Keycloak login and an admin role; the tenant API reads our executor party (`host_count 1`, has its own signing key) and refuses unauthenticated calls |

- **A trade settled with our node switched off.** On 6 October, with
  `splice-validator-participant-1` stopped for 1h 52m, BitSafe's node committed every step
  for our co-hosted parties and the value moved: 10,000 Amulet against 0.0143694 CBTC plus
  the venue fee, all three legs in one transaction. Update
  `1220fa44b5a8d37a942be4d7039ad6925d7ee8246172b09261e7a72c575d52b1c6eb`, settled
  13:21:50Z. Reconciled on our own participant afterwards: five balances exact, zero locked
  holdings. It was a manual relay with one counterparty, not automatic failover.

## Proven, but on one machine (LocalNet)

The multi-node work ran on BitSafe's DecMan LocalNet sandbox, which runs three participants
**in one Canton container on one machine**. It proves the mechanics and the code paths.
It does **not** prove that separate operators can keep Umbra running, and we do not
claim it does.

| | How it was shown |
|---|---|
| A new wallet onboards onto two nodes with one signature | `ops/decman/umbra-flow.js new`, through Umbra's server |
| An existing wallet adds a backup node with one signature; its contracts follow | `umbra-flow.js backup`: contracts relayed, live on node B in about a minute |
| The venue's party gains a backup node, signed by the venue signer | `umbra-flow.js venue` |
| Node A cut off the synchronizer: Umbra switches to node B, a user trade and a venue signature both commit, Umbra switches back | `multihost-demo.js down/up` with `umbra-flow.js trade`, and the admin route |
| A forged signature and a topology naming an unlisted node are refused | `umbra-flow.js backup`; `verifyTopology` |
| Governance: propose, confirm, execute across three DecMan instances | The DecMan sandbox, three members on one box (see [GOVERNANCE.md](GOVERNANCE.md)) |

## Simulated or test-only

- **Test wallets.** Several DevNet and LocalNet parties in our tests are driven by scripts
  holding throwaway keys, not by people's wallets.
- **LocalNet auth.** The sandbox runs Canton's unsafe dev auth; the scripts mint tokens with
  its public secret. That never happens against DevNet.
- **Test coin.** DevNet CC comes from the DevNet tap (our faucet). It has no value.
- **Prices.** The market reference is CoinGecko's, supplied by the venue; it is shown, not
  enforced.

## Not done yet

- **Co-validation.** Two hosts give failover only: DecMan will not let the threshold equal
  the number of hosts. Two nodes both confirming every transaction needs a third host.
- **Governance with real independent members.** The governed-action module is proven on the
  sandbox's three instances on one box. Real shared control needs members on separate
  operators' nodes.
- **A second copy of the app.** The server runs on the same machine as our node. A copy on
  separate hardware is planned for when the app is production-ready.
- **Node-level privacy.** Our validator hosts every user's party, so whoever runs it can read
  their contracts. The contract-level privacy (the venue party sees no losing quote) holds;
  the node-level one does not, and only users running their own nodes would change that.
- **Readable wallet approvals.** Wallets still show a hash, not the trade. Our page checks the
  hash before the wallet is asked, but the wallet itself does not.
- **Key storage.** The venue's signing key sits in an encrypted file read by the signer
  process, with the passphrase in that process's own env. Adequate for DevNet; a remote
  signer or KMS backend is the step before real value. The interface for it is defined and
  `UMBRA_KEYSTORE=remote` is supported, but no KMS backend is implemented.
- **No external audit** of the contracts or the server.

## What comes next

1. Co-hosting that happens at onboarding rather than party by party. The code is already
   written and already runs: every configured node prepares the same topology, the server
   refuses unless they agree byte for byte, and the user signs once. It is switched off by
   configuration, because it needs a DecMan tenant endpoint for a second host and BitSafe's
   is VPN-only today. Until that changes, each party is co-hosted by a manual signature.
2. A third host, for co-validation and for governance with independent members.
3. Alerts from the signer to a channel people read.
4. The app on a second machine.
