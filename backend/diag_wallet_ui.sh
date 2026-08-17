#!/usr/bin/env bash
# Read-only probe of the endpoint shapes the wallet UI now depends on. Every call
# is either a GET or a build=1 POST, and build=1 submits NOTHING -- it hands back
# the commands a wallet would sign.
set -u
API=${UMBRA_API:-http://127.0.0.1:4200}
W=$(curl -s -m 20 "$API/api/ext/wallets" | sed -n 's/.*"partyId":"\([^"]*\)".*/\1/p')
echo "wallet party: $W"
echo

echo "--- isWalletParty routing: POST /api/swap/rfq with build=1 ---"
curl -s -m 30 -X POST "$API/api/swap/rfq?build=1" -H 'Content-Type: application/json' \
  -d "{\"requester\":\"$W\",\"offerAsset\":\"cBTC\",\"offerAmount\":\"0.001\",\"wantAsset\":\"cETH\",\"invited\":[\"dealer1\",\"dealer2\"]}" \
  | head -c 900
echo; echo

echo "--- GET /api/swap/proposals as the wallet party ---"
curl -s -m 30 "$API/api/swap/proposals?role=$W" | head -c 300
echo; echo

echo "--- GET /api/real/holdings as the wallet party ---"
curl -s -m 30 "$API/api/real/holdings?role=$W" | head -c 300
echo
