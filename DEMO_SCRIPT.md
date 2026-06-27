# Umbra live demo sequence (Seaport DevNet)
# Server: cd backend && node server.js  (port 4000)
#
# P1 — privacy:
#   POST /api/rfqs                      create RFQ as requester
#   POST /api/rfqs/:cid/invite          invite dealer1, dealer2
#   POST /api/invitations/:cid/quote    each dealer quotes
#   GET  /api/quotes?role=dealer1       -> count 1 (own only)
#   GET  /api/quotes?role=dealer2       -> count 1 (own only)
#   GET  /api/quotes?role=requester     -> count 2 (both)   <-- THE REVEAL
#
# P2 — atomic DvP:
#   POST /api/fund/cash {amount:10000}          fund requester
#   POST /api/fund/instrument {dealer,qty:100}  fund dealer1
#   POST /api/quotes/:cid/accept {cashCid}      step 1: lock cash
#   POST /api/settlements/:cid/settle {instCid} step 2: atomic swap
#   -> requester holds bonds+change, dealer holds cash
#
# P2 — abort: fund only 5000, accept 9850 quote -> "insufficient cash" rejection
