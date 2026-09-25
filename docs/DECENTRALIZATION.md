# No single point of failure

How Umbra keeps trading when one of its nodes goes down, and how to reproduce it
from a clean machine.

A Canton party lives on the participants that host it. Umbra's venue party and every
user's party used to live on one participant, so that participant going down stopped the
venue, however healthy the rest of the network was. Umbra now hosts parties on more than
one participant through BitSafe's Decentralization Manager (DecMan), and its server fails
over between them.

This is a different job from the network's super validators. The SVs run the global
synchronizer; whether our node is admitted to it (the 10-of-14 allowlist) decides whether
**our node** can reach the network. It says nothing about where **Umbra's parties** live.
Both are needed. This document is about the second.

For what is proven, what runs on one machine, and what is still to do, read
[HONESTY.md](HONESTY.md).

---

## What happens

| Piece | What it does | Where |
|---|---|---|
| Hosting | A party is hosted on every configured node. New wallets land on all of them; an existing wallet adds a backup node from Settings | `backend/hosts.js`, DecMan's tenant API |
| One signature | Every node prepares the same topology; the server refuses unless they agree byte for byte; the owner's wallet signs it once; every node co-signs | `hosts.js` `agreeOn` |
| Contracts follow | Adding a node copies the party's contracts to it, one block at a time, through the server | `hosts.js` `confirmAddHosts` |
| Failover | The server keeps a list of nodes, probes each for a live synchronizer connection, and sends requests to the first healthy one. Reads are retried on the next node; a submission is never replayed | `backend/token.js` |
| Venue party | The venue's own party is hosted the same way, signed inside the isolated venue signer | `POST /api/admin/venue-hosts`, `backend/signer-daemon.js` |

Nobody's key leaves them. DecMan only ever sees public keys and signatures over hashes it
computed.

### What is checked before anything is signed

| Where | Check |
|---|---|
| The server | Every hosting node prepared identical bytes (`agreeOn`). Every signature verifies against the wallet's registered key before it is submitted |
| The user's browser | The hash is the hash of the topology (Canton purpose 11, recomputed with Canton's own `core-tx-visualizer`), the change is for this party, and it names only the nodes the venue listed (`tx-verify.js` `verifyTopology`) |
| The venue signer | The same three checks for the venue's party, against its own allowlist `UMBRA_SIGNER_HOSTS` (`judgeTopology`) |

### Numbers worth knowing

- Onboarding a party onto two nodes is **one** topology transaction, so one signature.
- Adding a node to an existing party is one signature, then about a minute while the new
  node takes the contracts and Canton activates it.
- DecMan rejects a confirmation threshold equal to the number of hosts. **Two hosts give
  failover (threshold 1). Co-validation, where two nodes must both confirm, needs three.**

---

## Part 1 — reproduce it on LocalNet

Everything here runs on one machine, so it proves the mechanics, not operator
independence.

### Prerequisites

- Docker with Compose v2.1.1+, 12 GB of memory and 4 CPUs available to it
- Node.js 20+, git, curl
- `dpm` for Daml SDK 3.4.11 (to build Umbra's package)

### 1. The DecMan sandbox, on v1.12

```bash
git clone https://github.com/DLC-link/decentralization-manager
cd decentralization-manager && git checkout hackathon
sed -i 's#^DECMAN_IMAGE=.*#DECMAN_IMAGE=public.ecr.aws/dlc-link/decentralization-manager:v1.12.0#' hackathon/versions.env
./hackathon/up.sh
curl -s localhost:8081/participants-status    # three nodes, "Connected"
```

Node A is `decman-1` on the app-provider participant (JSON API 3975, admin API 3902);
node B is `decman-2` on the app-user participant (JSON API 2975).

### 2. Umbra's package

```bash
cd umbra
dpm build                       # -> .daml/dist/umbra-v9-0.13.0.dar
```

### 3. The mechanics, without Umbra's server

```bash
cd ops/decman && npm install
docker cp canton:/app/protobuf ./proto       # admin API protos, for the failover step
node multihost-demo.js all
```

Expected:

```
Umbra's package is on both nodes
onboard: 1 signature -> host_count 2, threshold 1
single: a party on node A only, holding [42]
addhost: 1 signature, 2 block(s) relayed; on node B now: [42]
failover: node A is OFF the synchronizer
          the party transacted through node B alone: [42,7]
          node A back, caught up: [42,7]
```

### 4. The same through Umbra's server

```bash
node ops/decman/localnet-env.js               # -> backend/.env.localnet (sandbox only)
cp backend/.env.localnet backend/.env
cd backend && npm install
```

First run the server **without** hosts, to make a wallet the way Umbra did before:

```bash
DECMAN_HOSTS='[]' node server.js &            # then:
node ../ops/decman/umbra-flow.js legacy       # a wallet on one node
kill %1
```

Then with both hosts:

```bash
node server.js &
node ../ops/decman/umbra-flow.js new          # a new wallet lands on both nodes
node ../ops/decman/umbra-flow.js backup       # the legacy wallet adds node B
node ../ops/decman/umbra-flow.js venue        # needs UMBRA_OPERATOR_TOKEN from .env
```

Expected, roughly:

```
new wallet: wallet-...::1220... -> [{"name":"A","hosted":true},{"name":"B","hosted":true}] backup=true
before: [{"name":"A","hosted":true},{"name":"B","hosted":false}]
forged signature refused: /api/ext/hosts/confirm 400 the signatures do not verify ...
backup node added in 67458ms: [{"host":"B","blocks":2,"complete":true,"live":true}] backup=true
```

### 5. Watch Umbra fail over

```bash
node ../ops/decman/umbra-flow.js trade                  # via node A
node ../ops/decman/multihost-demo.js down; sleep 15
node ../ops/decman/umbra-flow.js trade                  # via node B, A is DOWN
node ../ops/decman/multihost-demo.js up; sleep 15
node ../ops/decman/umbra-flow.js trade                  # back on A
```

```
transacted through Umbra via node A | nodes: A=up B=up
node A is OFF the synchronizer
transacted through Umbra via node B | nodes: A=DOWN B=up
node A is back on the synchronizer
transacted through Umbra via node A | nodes: A=up B=up
```

`GET /api/status` shows the same thing at any time.

---

## Part 2 — deploy it on DevNet

Node A is your own validator's participant. Node B belongs to a second operator.

### Your node

1. **DecMan v1.12, beside the participant, with real login.** No insecure mode. It reaches
   the participant over the Docker network (Admin API 5002, Ledger API 5001) and listens
   on localhost only:

   ```bash
   docker run -d --name decman-devnet --restart unless-stopped \
     --network <the validator's compose network> -p 127.0.0.1:8090:8090 \
     -v /opt/decman-devnet/data:/data/data -e DECPM_DIR=/data \
     --env-file /opt/decman-devnet/.env \
     public.ecr.aws/dlc-link/decentralization-manager:v1.12.0
   ```

   `/opt/decman-devnet/.env` (mode 600) sets `DECPM_CANTON_ADMIN_HOST=participant`,
   `DECPM_CANTON_ADMIN_PORT=5002`, `DECPM_CANTON_LEDGER_HOST=participant`,
   `DECPM_CANTON_LEDGER_PORT=5001`, `DECPM_CANTON_NETWORK=devnet`,
   `DECPM_CANTON_SYNCHRONIZER=global`, the `DECPM_KEYCLOAK_*` settings of a Keycloak
   realm, `DECPM_ADMIN_ROLE`, `DECPM_TENANT_API_KEYS` and `DECPM_DB_ENCRYPTION_KEY`.
   Check: `GET /v0/tenant/{your executor party}/state` with a tenant key answers
   `host_count: 1`, and the same call without one answers 401.

2. **Umbra's server** lists its node and its DecMan by name:

   ```
   LEDGER_NODES=[{"name":"umbra","url":"<your JSON API>",...}]
   DECMAN_HOSTS=[{"name":"umbra","url":"http://127.0.0.1:8090","apiKey":"<tenant key>","participantId":"<your participant id>"}]
   ```

   With one host, everything in this document stays off.

3. **The venue signer** allows your node: `UMBRA_SIGNER_HOSTS=<your participant id>` in its
   own env file.

Your node exposes nothing new: Umbra's server drives both DecMans itself, so your DecMan
never needs to be reachable from outside.

### What the second operator provides

1. Their DecMan tenant API URL, a tenant key, and their participant id, reachable from
   your server's address.
2. Umbra's package (the DAR with its dependencies) vetted on their participant **before**
   anything is copied to it. A missing package fails the import after their node has
   disconnected.
3. Ledger API access to their node for your server (URL and credentials), with a ledger
   user that can read and submit for the parties they host for you.

### Turn it on

1. Append their entries to `LEDGER_NODES`, `DECMAN_HOSTS` and `UMBRA_SIGNER_HOSTS`, and
   restart the server and the signer.
2. Put the venue's party on both nodes:
   `POST /api/admin/venue-hosts` with the operator token.
3. New wallets now land on both nodes. Existing users open Settings, "Backup node", and
   approve once.
4. Prove it: a real trade settles while your participant is off the synchronizer.

---

## Reference

| Endpoint | Who | What |
|---|---|---|
| `GET /api/ext/hosts` | the party | which configured nodes host it, and whether it has a backup |
| `POST /api/ext/hosts/prepare` | the party | the topology to sign, agreed by every node |
| `POST /api/ext/hosts/confirm` | the party | submit the signed topology, copy the contracts, go live |
| `POST /api/admin/venue-hosts` | operator | the same for the venue's party, signed by the venue signer |
| `GET /api/status` | anyone | every node, whether it is healthy, and which one is in use |

| Variable | Where | Meaning |
|---|---|---|
| `LEDGER_NODES` | server | nodes in order of preference, each with its URL, credentials and ledger user |
| `DECMAN_HOSTS` | server | one DecMan per hosting node: URL, tenant key, participant id. Two or more turn hosting on |
| `UMBRA_SIGNER_HOSTS` | venue signer | the participants the venue's party may be hosted on |
| `LEDGER_PROBE_MS` | server | how often each node is probed (default 5000) |
