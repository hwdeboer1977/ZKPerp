#!/bin/bash
set -e

# ══════════════════════════════════════════════════════════════════
# test_amm_devnet.sh — PATH A: hardened v5 AMM + EXTERNAL mock USDCx
#
# Differs from the v4 script:
#   • Deploys mock_usdcx (named test_usdcx_stablecoin.aleo) FIRST, then the AMM.
#   • USDCx is a Token RECORD from the mock's faucet (not an internal mapping).
#   • mint_position / swap_buy take (Token record, [MerkleProof;2], ...);
#     mint_position / swap_sell take a credits.aleo record.
#   • swaps take NEW args: min_amount_out, deadline.
#   • SINGLE-RANGE: all four steps are EMPTY (sentinel + zero). Amounts live in
#     the totals; the contract verifies them in the terminal segment. (v5 asserts
#     inactive steps are all-zero, so amounts must NOT be put in step0.)
#   • Pool priced at 10 ALEO/USDCx (price >= 1). 0.1 was inverted and breaks the
#     token0 denom (sqrt price < 2^64). Constants computed against v5's exact math.
#
# Records can't be precomputed as static strings — faucet output and the trader's
# credits record are captured at runtime. Steps that need them are marked CAPTURE.
# ══════════════════════════════════════════════════════════════════

SCRIPT_DIR_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR_ENV/.env" ]; then set -a; source "$SCRIPT_DIR_ENV/.env"; set +a
elif [ -f "$SCRIPT_DIR_ENV/../.env" ]; then set -a; source "$SCRIPT_DIR_ENV/../.env"; set +a; fi

ENDPOINT="http://localhost:3030"
TOKEN="test_usdcx_stablecoin"          # the mock, deployed under the real name
PROGRAM="zkperp_amm_devnet"            # your AMM program id
NETWORK="--network testnet --broadcast"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11,12,13"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ADMIN_KEY="${ALEO_PRIVATE_KEY:-APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH}"
TRADER_KEY="${ALEO_PRIVATE_KEY_B:-APrivateKey1zkp2RWGDcde3efb89rjhME1VYA8QMxcxep5DShNBR6n8Yjh}"

derive_address() { leo account import "$1" 2>/dev/null | grep -oE 'aleo1[a-z0-9]{58}' | tail -1; }
ADMIN_ADDR=$(derive_address "$ADMIN_KEY")
TRADER_ADDR=$(derive_address "$TRADER_KEY")
[ -z "$ADMIN_ADDR" ]  && { echo "ERROR: no ADMIN_ADDR";  exit 1; }
[ -z "$TRADER_ADDR" ] && { echo "ERROR: no TRADER_ADDR"; exit 1; }

# ── Pool constants (price 10 ALEO/USDCx; computed against v5's exact integer math) ──
SQRT_PRICE_INIT="58333726687135158849u128"   # sqrt(10)*2^64
TICK_INIT="23027i32"                          # tick_of(sqrt_price_init)

TICK_LO="16080i32"                            # ~price 5
TICK_HI="30000i32"                            # ~price 20
TICK_LO_FIELD="2147499727field"               # 16080 + 2147483647
TICK_HI_FIELD="2147513647field"               # 30000 + 2147483647

LIQUIDITY="1700000u128"
# mint deposits — these are the CEIL-derived minimums; contract asserts actual >= these
AMT_0_MAX="200000u64"; AMT_1_MAX="1700000u64"
AMT_0_ACT="177280u64"                         # USDCx (token0)
AMT_1_ACT="1577442u64"                        # ALEO  (token1)

DEADLINE="4294967295u32"                      # max u32 — never expires (devnet)

# swap_buy: 50000 USDCx -> ALEO (single range)
SWAP_BUY_IN="50000u64"; SWAP_BUY_OUT="434679u64"; SWAP_BUY_FEE="150u64"
SWAP_BUY_MIN="434679u64"                       # = OUT (boundary); loosen to 1u64 if desired
SWAP_BUY_SQRT="53617007038538979776u128"; SWAP_BUY_TICK="21340i32"

# swap_sell: 5000 ALEO -> USDCx (chained from post-buy price)
SWAP_SELL_IN="5000u64"; SWAP_SELL_OUT="857u64"; SWAP_SELL_FEE="15u64"
SWAP_SELL_MIN="857u64"
SWAP_SELL_SQRT="53671099402778651608u128"; SWAP_SELL_TICK="21360i32"

# All steps EMPTY for single-range. Amounts ride in the totals -> terminal segment.
EMPTY_STEP="{tick_next:887221i32,sqrt_price_next:0u128,liquidity_net:0u128,liquidity_net_is_negative:false,amount_in_step:0u64,amount_out_step:0u64,fee_step:0u64}"

# zeroed proof (mock ignores it)
ZERO_PROOF="[{siblings:[0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field],leaf_index:0u32},{siblings:[0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field,0field],leaf_index:0u32}]"

# ══════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════
get_block() { curl -s "$ENDPOINT/testnet/block/height/latest"; }
wait_for_devnet() {
    echo "Waiting for devnet..."
    until curl -s "$ENDPOINT/testnet/block/height/latest" 2>/dev/null | grep -qE '^[0-9]+$'; do sleep 2; done
    local h; h=$(get_block); while [ "$h" -lt 12 ]; do echo "  height $h"; sleep 2; h=$(get_block); done
    echo "Devnet ready (height $h)"
}
amm_map() { curl -s "$ENDPOINT/testnet/program/$PROGRAM.aleo/mapping/$1/$2"; }
tok_map() { curl -s "$ENDPOINT/testnet/program/$TOKEN.aleo/mapping/$1/$2"; }
assert_contains() {
    local label=$1 val=$2 want=$3
    echo "$val" | python3 -c "import sys; exit(0 if '$want' in sys.stdin.read() else 1)" \
      && echo "  OK $label" || { echo "FAIL $label — want '$want' in: $val"; exit 1; }
}
wait_confirmed() {
    for i in $(seq 1 30); do sleep 2
        curl -s "$ENDPOINT/testnet/transaction/$1" 2>/dev/null | grep -qF "accepted" && { echo "  confirmed"; return 0; }
    done; echo "  WARN not confirmed in 60s"
}
# returns full execute output on stdout; caller greps records from it
execute_as() {
    local pk=$1; shift; local fn=$1; shift
    local out; out=$(leo execute "$fn" --private-key "$pk" --endpoint "$ENDPOINT" $NETWORK $CONSENSUS --yes -- "$@" 2>&1)
    echo "$out"
    local tx; tx=$(echo "$out" | grep -oE 'at1[a-z0-9]{58}' | tail -1)
    [ -n "$tx" ] && wait_confirmed "$tx" >&2 || sleep 10
}
# extract the Nth output record plaintext { ... } that belongs to a given owner
record_for_owner() {
    local text=$1 owner=$2
    echo "$text" | grep -oE "\{[^{}]*owner: ${owner}[^{}]*\}" | head -1
}

echo "================================================================"
echo "  zkperp_amm_devnet (v5) + mock USDCx — Path A test suite"
echo "  Admin:  $ADMIN_ADDR"
echo "  Trader: $TRADER_ADDR"
echo "================================================================"
cd "$SCRIPT_DIR"
wait_for_devnet

# ── DEPLOY: mock token FIRST (AMM imports it), then AMM ──────────────
echo "=== DEPLOY mock USDCx ($TOKEN.aleo) ==="
( cd "${MOCK_DIR:-./mock_usdcx}" && leo deploy --private-key "$ADMIN_KEY" --endpoint "$ENDPOINT" $NETWORK $CONSENSUS --yes )
sleep 5
echo "=== DEPLOY AMM ($PROGRAM.aleo) ==="
leo deploy --private-key "$ADMIN_KEY" --endpoint "$ENDPOINT" $NETWORK $CONSENSUS --yes
sleep 5

# ── TEST 1: initialize_pool ─────────────────────────────────────────
echo "=== TEST 1: initialize_pool (price 10) ==="
execute_as "$ADMIN_KEY" initialize_pool "$SQRT_PRICE_INIT" "$TICK_INIT" >/dev/null
assert_contains "pool sqrt_price" "$(amm_map pool_state 0u8)" "58333726687135158849"
assert_contains "pool tick"       "$(amm_map pool_state 0u8)" "23027"
assert_contains "pool liquidity"  "$(amm_map pool_state 0u8)" "liquidity: 0"

# ── TEST 2: faucet USDCx to trader (CAPTURE the Token record) ───────
echo "=== TEST 2: faucet 1000 USDCx to trader ==="
FAUCET_OUT=$(execute_as "$TRADER_KEY" faucet "1000000000u128")   # NOTE: mock's faucet, amount u128
USDCX_REC=$(record_for_owner "$FAUCET_OUT" "$TRADER_ADDR")
echo "  captured USDCx Token record: ${USDCX_REC:0:60}..."
[ -z "$USDCX_REC" ] && { echo "FAIL: could not capture faucet record"; exit 1; }

# ── TEST 3: mint_position ───────────────────────────────────────────
# args: lp_token, merkle_proof, aleo_in, tick_lower, tick_upper, liquidity_desired,
#       amount_0_max, amount_1_max, amount_0_actual, amount_1_actual,
#       sqrt_price_x64, current_tick, fee_growth_inside_0, fee_growth_inside_1
echo "=== TEST 3: mint_position ==="
echo "  NEEDS a credits.aleo record (\$ALEO_RECORD) for aleo_in covering >= $AMT_1_ACT."
echo "  Get one with:  snarkos developer scan --private-key \$TRADER_KEY --endpoint $ENDPOINT ..."
: "${ALEO_RECORD:?set ALEO_RECORD to a trader-owned credits record before running mint}"
MINT_OUT=$(execute_as "$TRADER_KEY" mint_position \
    "$USDCX_REC" "$ZERO_PROOF" "$ALEO_RECORD" \
    "$TICK_LO" "$TICK_HI" "$LIQUIDITY" \
    "$AMT_0_MAX" "$AMT_1_MAX" "$AMT_0_ACT" "$AMT_1_ACT" \
    "$SQRT_PRICE_INIT" "$TICK_INIT" "0u128" "0u128")
LP_RECORD=$(record_for_owner "$MINT_OUT" "$TRADER_ADDR")   # LPPosition (save for burn)
echo "  captured LPPosition record: ${LP_RECORD:0:60}..."
assert_contains "pool liquidity > 0" "$(amm_map pool_state 0u8)" "1700000"
assert_contains "tick_lower init"    "$(amm_map tick_info "$TICK_LO_FIELD")" "initialized: true"
assert_contains "tick_upper init"    "$(amm_map tick_info "$TICK_HI_FIELD")" "initialized: true"
assert_contains "AMM holds USDCx"    "$(tok_map balances "$PROGRAM.aleo")" "177280"

# ── TEST 4: swap_buy (need a fresh USDCx record for usdcx_in) ───────
echo "=== TEST 4: swap_buy 50000 USDCx -> ALEO ==="
FA2=$(execute_as "$TRADER_KEY" faucet "1000000u128")
BUY_USDCX_REC=$(record_for_owner "$FA2" "$TRADER_ADDR")
# args: usdcx_in, merkle_proof, total_in, total_out, total_fee, min_out, deadline,
#       sqrt_final, tick_final, step0..step3
execute_as "$TRADER_KEY" swap_buy \
    "$BUY_USDCX_REC" "$ZERO_PROOF" \
    "$SWAP_BUY_IN" "$SWAP_BUY_OUT" "$SWAP_BUY_FEE" "$SWAP_BUY_MIN" "$DEADLINE" \
    "$SWAP_BUY_SQRT" "$SWAP_BUY_TICK" \
    "$EMPTY_STEP" "$EMPTY_STEP" "$EMPTY_STEP" "$EMPTY_STEP" >/dev/null
assert_contains "price decreased" "$(amm_map pool_state 0u8)" "53617007038538979776"

# ── TEST 5: swap_sell (need a credits record for aleo_in) ───────────
echo "=== TEST 5: swap_sell 5000 ALEO -> USDCx ==="
: "${ALEO_RECORD_2:?set ALEO_RECORD_2 to a trader credits record >= $SWAP_SELL_IN}"
# args: merkle_proof, aleo_in, total_in, total_out, total_fee, min_out, deadline,
#       sqrt_final, tick_final, step0..step3
execute_as "$TRADER_KEY" swap_sell \
    "$ZERO_PROOF" "$ALEO_RECORD_2" \
    "$SWAP_SELL_IN" "$SWAP_SELL_OUT" "$SWAP_SELL_FEE" "$SWAP_SELL_MIN" "$DEADLINE" \
    "$SWAP_SELL_SQRT" "$SWAP_SELL_TICK" \
    "$EMPTY_STEP" "$EMPTY_STEP" "$EMPTY_STEP" "$EMPTY_STEP" >/dev/null
assert_contains "price increased" "$(amm_map pool_state 0u8)" "53671099402778651608"

# ── TEST 6: burn_position (manual — uses LP_RECORD from TEST 3) ─────
echo "=== TEST 6: burn_position (manual) ==="
echo "  Use the captured LPPosition record:"
echo "  leo execute burn_position --private-key \$TRADER_KEY --endpoint $ENDPOINT $NETWORK $CONSENSUS --yes -- \\"
echo "    '$LP_RECORD' <amount_0_out> <amount_1_out> <pool_sqrt_now> <pool_tick_now>"
echo ""
echo "  (amount_0_out / amount_1_out must be <= the liquidity-derived FLOOR at the"
echo "   current price; ask for the burn quote once you know the post-swap pool state.)"

echo "================================================================"
echo "  Done. pool_state: $(amm_map pool_state 0u8)"
echo "================================================================"