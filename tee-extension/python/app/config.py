"""Extension configuration constants."""

VERSION = "0.1.0"

# OPType and OPCommand constants — must match the bytes32 constants in XrpWalletSender.sol.
OP_TYPE_XRP = "XRP"
OP_COMMAND_ADDRESS = "ADDR"
OP_COMMAND_AWARD = "AWARD"

# XRP Ledger testnet public JSON-RPC endpoint.
# https://xrpl.org/docs/references/http-websocket-apis#public-servers
XRPL_JSON_RPC_URL = "https://s.altnet.rippletest.net:51234/"

# Fraction of the current balance paid out per award() call (10%).
AWARD_NUMERATOR = 1
AWARD_DENOMINATOR = 10

# Flat XRP payment fee (in drops). The network minimum is ~10 drops; this
# overpays generously to avoid an extra fee-lookup round trip, keeping the
# handler fast enough to respond before the TEE router's call times out.
FLAT_FEE_DROPS = "20"
