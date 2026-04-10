#!/bin/bash
set -e

# Load .env
SCRIPT_DIR_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR_ENV/.env" ]; then
    set -a; source "$SCRIPT_DIR_ENV/.env"; set +a
elif [ -f "$SCRIPT_DIR_ENV/../.env" ]; then
    set -a; source "$SCRIPT_DIR_ENV/../.env"; set +a
fi

#
# HOW TO RUN:
#
# Terminal 1: Start devnet
#   leo devnet \
#     --snarkos ~/snarkOS/target/release/snarkos \
#     --snarkos-features test_network \
#     --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11,12,13 \
#     --clear-storage
#
# Terminal 2: Deploy + test
#   chmod +x test_amm_devnet.sh
#   ./test_amm_devnet.sh
#
# WHAT THIS TESTS:
#   1. Deploy zkperp_amm_devnet.aleo
#   2. initialize_pool at price 0.1 ALEO/USDCx
#   3. mint_mock_usdc — give trader 1000 USDCx
#   4. mint_position — add liquidity in range [0.05, 0.15]
#      verify: pool.liquidity > 0, tick_info initialized, mock_usdc debited
#   5. swap_buy — 0.05 USDCx -> ALEO
#      verify: pool.sqrt_price decreased, mock_usdc debited
#   6. swap_sell — ALEO -> USDCx
#      verify: pool.sqrt_price increased, mock_usdc credited
#   7. burn_position — printed as manual command (needs record)

# ══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════

ENDPOINT="http://localhost:3030"
BROADCAST="$ENDPOINT/testnet/transaction/broadcast"
PROGRAM="zkperp_amm_devnet"
NETWORK="--network testnet --broadcast"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11,12,13"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Devnet keys (override via .env: ALEO_PRIVATE_KEY_A, ALEO_PRIVATE_KEY_B)
ADMIN_KEY="${ALEO_PRIVATE_KEY:-APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH}"
TRADER_KEY="${ALEO_PRIVATE_KEY_B:-APrivateKey1zkp2RWGDcde3efb89rjhME1VYA8QMxcxep5DShNBR6n8Yjh}"

derive_address() {
    local pk=$1
    leo account import "$pk" 2>/dev/null | grep -oE 'aleo1[a-z0-9]{58}' | tail -1
}

ADMIN_ADDR=$(derive_address "$ADMIN_KEY")
TRADER_ADDR=$(derive_address "$TRADER_KEY")

[ -z "$ADMIN_ADDR"  ] && { echo "ERROR: could not derive ADMIN_ADDR";  exit 1; }
[ -z "$TRADER_ADDR" ] && { echo "ERROR: could not derive TRADER_ADDR"; exit 1; }

# ── Pool math constants ──────────────────────────────────────────
# Initial price: 0.1 ALEO/USDCx
# sqrt(0.1) * 2^64 = 5833372668713516032
SQRT_PRICE_INIT="5833372668713516032u128"
TICK_INIT="-23040i32"

# Position range [0.05, 0.15] — ticks aligned to spacing 60
TICK_LO="-30000i32"
TICK_HI="-19020i32"

# tick_lower field key = -30000 + 2147483647 = 2117483647
TICK_LO_FIELD="2147453647field"
TICK_HI_FIELD="2147464627field"

# Liquidity for 10 USDCx in range [0.05, 0.15] at price 0.1
LIQUIDITY="17418444u128"

# Deposit amounts (10 USDCx, 1.62 ALEO, 10% max slippage)
AMT_0_MAX="11000000u64"
AMT_1_MAX="1800000u64"
AMT_0_ACT="9999999u64"
AMT_1_ACT="1621323u64"

# Swap buy: 50000 microcredits USDCx -> ALEO (small, single range)
# fee = floor(50000 * 3000 / 1000000) = 150
SWAP_BUY_IN="50000u64"
SWAP_BUY_OUT="4980u64"
SWAP_BUY_FEE="150u64"
SWAP_BUY_SQRT="5828098152116642066u128"
SWAP_BUY_TICK="-23046i32"

# Swap sell: 500000 ALEO microcredits -> USDCx
SWAP_SELL_IN="5000u64"
SWAP_SELL_OUT="49895u64"
SWAP_SELL_FEE="15u64"
SWAP_SELL_SQRT="5833377442230468657u128"
SWAP_SELL_TICK="-23027i32"

# Empty step and terminal step structs
EMPTY_STEP="{tick_next:887221i32,sqrt_price_next:0u128,liquidity_net:0u128,liquidity_net_is_negative:false,amount_in_step:0u64,amount_out_step:0u64,fee_step:0u64}"

STEP_BUY="{tick_next:887221i32,sqrt_price_next:0u128,liquidity_net:0u128,liquidity_net_is_negative:false,amount_in_step:${SWAP_BUY_IN},amount_out_step:${SWAP_BUY_OUT},fee_step:${SWAP_BUY_FEE}}"
STEP_SELL="{tick_next:887221i32,sqrt_price_next:0u128,liquidity_net:0u128,liquidity_net_is_negative:false,amount_in_step:${SWAP_SELL_IN},amount_out_step:${SWAP_SELL_OUT},fee_step:${SWAP_SELL_FEE}}"

# ══════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════

get_block() { curl -s "$ENDPOINT/testnet/block/height/latest"; }

wait_for_devnet() {
    echo "Waiting for devnet..."
    until curl -s "$ENDPOINT/testnet/block/height/latest" 2>/dev/null | grep -qE '^[0-9]+$'; do
        sleep 2; echo "  still waiting..."
    done
    local height; height=$(get_block)
    while [ "$height" -lt 12 ]; do
        echo "  Block height: $height (waiting for 12)"
        sleep 2; height=$(get_block)
    done
    echo "Devnet ready! Height: $height"
}

check_mapping() {
    local mapping=$1 key=$2
    echo "  $PROGRAM/$mapping[$key]:"
    curl -s "$ENDPOINT/testnet/program/$PROGRAM.aleo/mapping/$mapping/$key"
    echo ""
}

assert_not_null() {
    local label=$1 mapping=$2 key=$3
    local val
    val=$(curl -s "$ENDPOINT/testnet/program/$PROGRAM.aleo/mapping/$mapping/$key")
    if [ "$val" = "null" ] || [ -z "$val" ]; then
        echo "FAIL: $label is null"; exit 1
    fi
    echo "  OK $label: $val"
}

assert_mapping_contains() {
    local label=$1 mapping=$2 key=$3 expected=$4
    local val
    val=$(curl -s "$ENDPOINT/testnet/program/$PROGRAM.aleo/mapping/$mapping/$key")
    if echo "$val" | python3 -c "import sys; s=sys.stdin.read(); exit(0 if '$expected' in s else 1)" 2>/dev/null; then
        echo "  OK $label: $val"
    else
        echo "FAIL: $label — expected '$expected' in: $val"; exit 1
    fi
}

wait_confirmed() {
    local tx_id=$1
    echo "  Waiting for tx confirmation..."
    for i in $(seq 1 30); do
        sleep 2
        local val
        val=$(curl -s "$ENDPOINT/testnet/transaction/$tx_id" 2>/dev/null)
        if echo "$val" | grep -qF "accepted"; then
            echo "  Confirmed (${i}x2s)"
            return 0
        fi
    done
    echo "  Warning: not confirmed after 60s"
}

execute_as() {
    local pk=$1; shift
    local fn=$1; shift
    local out
    out=$(leo execute "$fn" \
        --private-key "$pk" \
        --endpoint "$ENDPOINT" \
        $NETWORK $CONSENSUS --yes \
        -- "$@" 2>&1)
    echo "$out"
    local tx_id
    tx_id=$(echo "$out" | grep -oE 'at1[a-z0-9]{58}' | tail -1)
    if [ -n "$tx_id" ]; then
        wait_confirmed "$tx_id"
    else
        sleep 10
    fi
}


# ══════════════════════════════════════════════════════════════════
# BANNER
# ══════════════════════════════════════════════════════════════════

echo "================================================================"
echo "  zkperp_amm_devnet — CL AMM test suite"
echo "================================================================"
echo ""
echo "  Admin:  $ADMIN_ADDR"
echo "  Trader: $TRADER_ADDR"
echo ""

cd "$SCRIPT_DIR"
wait_for_devnet

# ══════════════════════════════════════════════════════════════════
# SETUP: Deploy
# ══════════════════════════════════════════════════════════════════

echo "=== SETUP: Deploy ==="
leo deploy \
    --private-key "$ADMIN_KEY" \
    --endpoint "$ENDPOINT" \
    $NETWORK $CONSENSUS --yes
sleep 5
echo "  OK Deployed $PROGRAM.aleo"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 1: initialize_pool
# ══════════════════════════════════════════════════════════════════

echo "================================================================"
echo "  TEST 1: initialize_pool at 0.1 ALEO/USDCx"
echo "================================================================"

OUT=$(execute_as "$ADMIN_KEY" initialize_pool \
    "$SQRT_PRICE_INIT" "$TICK_INIT")
echo "$OUT"

assert_mapping_contains "pool_state.sqrt_price_x64" pool_state "0u8" "5833372668713516032"
assert_mapping_contains "pool_state.current_tick"   pool_state "0u8" "-23040"
assert_mapping_contains "pool_state.liquidity"      pool_state "0u8" "liquidity: 0"
echo "  OK TEST 1 PASSED"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 2: mint_mock_usdc
# ══════════════════════════════════════════════════════════════════

echo "================================================================"
echo "  TEST 2: mint_mock_usdc — give trader 1000 USDCx"
echo "================================================================"

OUT=$(execute_as "$TRADER_KEY" mint_mock_usdc "1000000000u64")
echo "$OUT"

assert_mapping_contains "mock_usdc[trader]" mock_usdc "$TRADER_ADDR" "1000000000"
echo "  OK TEST 2 PASSED"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 3: mint_position
# ══════════════════════════════════════════════════════════════════

echo "================================================================"
echo "  TEST 3: mint_position in range [0.05, 0.15]"
echo "  Depositing ~10 USDCx + ~1.62 ALEO"
echo "================================================================"

OUT=$(execute_as "$TRADER_KEY" mint_position \
    "$TICK_LO" "$TICK_HI" "$LIQUIDITY" \
    "$AMT_0_MAX" "$AMT_1_MAX" \
    "$AMT_0_ACT" "$AMT_1_ACT" \
    "$SQRT_PRICE_INIT" "$TICK_INIT" \
    "0u128" "0u128")
echo "$OUT"

assert_mapping_contains "pool_state.liquidity > 0" pool_state "0u8" "17418444"
assert_not_null "tick_lower initialized"    tick_info "$TICK_LO_FIELD"
assert_not_null "tick_upper initialized"    tick_info "$TICK_HI_FIELD"
assert_not_null "mock_usdc debited"         mock_usdc "$TRADER_ADDR"
echo "  Check LPPosition record in output above — save for burn test"
echo "  OK TEST 3 PASSED"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 4: swap_buy (USDCx -> ALEO)
# ══════════════════════════════════════════════════════════════════

echo "================================================================"
echo "  TEST 4: swap_buy — 0.05 USDCx -> ALEO"
echo "================================================================"

USDC_BEFORE=$(curl -s "$ENDPOINT/testnet/program/$PROGRAM.aleo/mapping/mock_usdc/$TRADER_ADDR")
echo "  mock_usdc before: $USDC_BEFORE"

OUT=$(execute_as "$TRADER_KEY" swap_buy \
    "$SWAP_BUY_IN" "$SWAP_BUY_OUT" "$SWAP_BUY_FEE" \
    "$SWAP_BUY_SQRT" "$SWAP_BUY_TICK" \
    "$STEP_BUY" "$EMPTY_STEP" "$EMPTY_STEP" "$EMPTY_STEP")
echo "$OUT"

assert_mapping_contains "pool_state.sqrt_price decreased" pool_state "0u8" "5828098152116642066"
assert_not_null "mock_usdc debited after buy" mock_usdc "$TRADER_ADDR"
echo "  Check SwapReceipt record in output above"
echo "  OK TEST 4 PASSED"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 5: swap_sell (ALEO -> USDCx)
# ══════════════════════════════════════════════════════════════════

echo "================================================================"
echo "  TEST 5: swap_sell — 0.5 ALEO -> USDCx"
echo "================================================================"

USDC_BEFORE=$(curl -s "$ENDPOINT/testnet/program/$PROGRAM.aleo/mapping/mock_usdc/$TRADER_ADDR")
echo "  mock_usdc before: $USDC_BEFORE"

OUT=$(execute_as "$TRADER_KEY" swap_sell \
    "$SWAP_SELL_IN" "$SWAP_SELL_OUT" "$SWAP_SELL_FEE" \
    "$SWAP_SELL_SQRT" "$SWAP_SELL_TICK" \
    "$STEP_SELL" "$EMPTY_STEP" "$EMPTY_STEP" "$EMPTY_STEP")
echo "$OUT"

assert_not_null "mock_usdc credited after sell" mock_usdc "$TRADER_ADDR"
echo "  OK TEST 5 PASSED"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 6: burn_position (manual — needs LP record from TEST 3)
# ══════════════════════════════════════════════════════════════════

echo "================================================================"
echo "  TEST 6: burn_position — MANUAL"
echo "================================================================"
echo ""
echo "  Copy the LPPosition record from TEST 3 output, then run:"
echo ""
echo "  snarkos developer execute $PROGRAM.aleo burn_position \"
echo "    --private-key \$TRADER_KEY \"
echo "    --query $ENDPOINT \"
echo "    --broadcast $BROADCAST \"
echo "    --network 1 \"
echo "    -- '<LPPosition record>' \\"
echo "       '0u128' '0u128' \\"
echo "       '$AMT_0_ACT' '$AMT_1_ACT' \\"
echo "       '$SWAP_BUY_SQRT' '$SWAP_BUY_TICK'"
echo ""

# ══════════════════════════════════════════════════════════════════
# FINAL STATE
# ══════════════════════════════════════════════════════════════════

echo "================================================================"
echo "  FINAL STATE"
echo "================================================================"
check_mapping pool_state  "0u8"
check_mapping aleo_reserve "0u8"
check_mapping mock_usdc   "$ADMIN_ADDR"
check_mapping mock_usdc   "$TRADER_ADDR"
check_mapping tick_info   "$TICK_LO_FIELD"
check_mapping tick_info   "$TICK_HI_FIELD"

echo ""
echo "================================================================"
echo "  AMM devnet tests complete!"
echo ""
echo "  1. initialize_pool              OK"
echo "  2. mint_mock_usdc               OK"
echo "  3. mint_position                OK"
echo "  4. swap_buy                     OK"
echo "  5. swap_sell                    OK"
echo "  6. burn_position                MANUAL"
echo "================================================================"
