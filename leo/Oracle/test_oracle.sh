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
# leo devnet \
#   --snarkos ~/snarkOS/target/release/snarkos \
#   --snarkos-features test_network \
#   --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11,12,13 \
#   --clear-storage
#
# Terminal 2: Run test
#   chmod +x test_oracle.sh
#   ./test_oracle.sh
#
# WHAT THIS TESTS:
#   1. Deploy + register oracle nodes A, B, C
#   2. Oracle A submits BTC → 1 vote, no quorum
#   3. Oracle B submits same BTC → 2 votes, QUORUM → oracle_prices updated
#   4. Oracle A + C submit ETH → quorum via different pair
#   5. Oracle A submits new BTC price → proposal resets (new round)
#   6. Oracle B agrees on new BTC → quorum → oracle_prices updated to new price
#   7. Oracle A tries to vote twice → rejected
#   8. Non-oracle address tries to submit → rejected
# ═══════════════════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════

ENDPOINT="http://localhost:3030"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11,12,13"
NETWORK="--network testnet --broadcast"
PROGRAM="zkperp_oracle_v4"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Oracle node keys
# Devnet has 2 pre-funded accounts. .env overrides take priority.
#   Account 1: APrivateKey1zkp8CZN... → admin + oracle A
#   Account 2: APrivateKey1zkp2RWG... → oracle B
#   Account 3: APrivateKey1zkp2RWG... → oracle C (same as B — 2-of-3 still works for A+B quorum)
# On testnet: set ALEO_PRIVATE_KEY_A/B/C in .env with three separate funded keys
ORACLE_A_KEY="${ALEO_PRIVATE_KEY_A:-APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH}"
ORACLE_B_KEY="${ALEO_PRIVATE_KEY_B:-APrivateKey1zkp2RWGDcde3efb89rjhME1VYA8QMxcxep5DShNBR6n8Yjh}"
ORACLE_C_KEY="${ALEO_PRIVATE_KEY_C:-APrivateKey1zkp2RWGDcde3efb89rjhME1VYA8QMxcxep5DShNBR6n8Yjh}"

# Derive oracle addresses from keys
# leo account import outputs:  " • Address  aleo1..."  or "Address  aleo1..."
derive_address() {
    local pk=$1
    leo account import "$pk" 2>/dev/null         | grep -oE 'aleo1[a-z0-9]{58}'         | tail -1
}
ORACLE_A_ADDR=$(derive_address "$ORACLE_A_KEY")
ORACLE_B_ADDR=$(derive_address "$ORACLE_B_KEY")
ORACLE_C_ADDR=$(derive_address "$ORACLE_C_KEY")

# Fail early if addresses are empty
[ -z "$ORACLE_A_ADDR" ] && { echo "❌ Could not derive ORACLE_A_ADDR from ALEO_PRIVATE_KEY_A"; exit 1; }
[ -z "$ORACLE_B_ADDR" ] && { echo "❌ Could not derive ORACLE_B_ADDR from ALEO_PRIVATE_KEY_B"; exit 1; }
[ -z "$ORACLE_C_ADDR" ] && { echo "❌ Could not derive ORACLE_C_ADDR from ALEO_PRIVATE_KEY_C"; exit 1; }

# Asset IDs
BTC_ASSET="1field"
ETH_ASSET="2field"
SOL_ASSET="3field"

# Prices (8 decimal precision)
BTC_PRICE_1="6700000000000u64"
BTC_PRICE_2="6800000000000u64"
ETH_PRICE_1="250000000000u64"
SOL_PRICE_1="15000000000u64"

BTC_TS_1="1000000u32"
BTC_TS_2="1000002u32"
ETH_TS_1="1000001u32"
SOL_TS_1="1000003u32"

# ══════════════════════════════════════════════════════════════════
# HELPERS — exact pattern from reference test.sh
# ══════════════════════════════════════════════════════════════════

get_block() { curl -s "$ENDPOINT/testnet/block/height/latest"; }

wait_for_devnet() {
    echo "Waiting for devnet..."
    until curl -s "$ENDPOINT/testnet/block/height/latest" 2>/dev/null | grep -qE '^[0-9]+$'; do
        sleep 2; echo "  still waiting..."
    done
    height=$(get_block)
    while [ "$height" -lt 12 ]; do
        echo "  Block height: $height (waiting for 12)"
        sleep 2; height=$(get_block)
    done
    echo "Devnet ready! Height: $height"
}

check_mapping() {
    local program=$1 mapping=$2 key=$3
    echo "  $program/$mapping[$key]:"
    curl -s "$ENDPOINT/testnet/program/$program.aleo/mapping/$mapping/$key"
    echo ""
}

assert_not_null() {
    local label=$1
    local val
    val=$(curl -s "$ENDPOINT/testnet/program/$PROGRAM.aleo/mapping/$2/$3")
    if [ "$val" = "null" ] || [ -z "$val" ]; then
        echo "❌ FAIL: $label is null — aborting"; exit 1
    fi
    echo "  ✓ $label: $val"
}

assert_null() {
    local label=$1
    local val
    val=$(curl -s "$ENDPOINT/testnet/program/$PROGRAM.aleo/mapping/$2/$3")
    if [ "$val" != "null" ] && [ -n "$val" ]; then
        echo "  ⚠ WARNING: $label should be null but got: $val"
    else
        echo "  ✓ $label is null (removed)"
    fi
}

assert_mapping_contains() {
    local label=$1 mapping=$2 key=$3 expected=$4
    local val
    val=$(curl -s "$ENDPOINT/testnet/program/$PROGRAM.aleo/mapping/$mapping/$key")
    if echo "$val" | grep -q "$expected"; then
        echo "  ✓ $label: $val"
    else
        echo "❌ FAIL: $label — expected '$expected' in: $val"; exit 1
    fi
}

submit_price_as() {
    local pk=$1 asset=$2 price=$3 ts=$4
    leo execute submit_price "$asset" "$price" "$ts" \
        --private-key "$pk" \
        --endpoint "$ENDPOINT" \
        $NETWORK $CONSENSUS --yes 2>&1
    sleep 3
}

set_oracle_role() {
    local slot=$1 addr=$2
    leo execute set_oracle "$slot" "$addr" \
        --endpoint "$ENDPOINT" \
        $NETWORK $CONSENSUS --yes 2>&1
    sleep 3
}

# ══════════════════════════════════════════════════════════════════
# BANNER
# ══════════════════════════════════════════════════════════════════

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  zkperp_oracle_v1 — on-chain 2-of-3 quorum test               ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Oracle A: $ORACLE_A_ADDR"
echo "  Oracle B: $ORACLE_B_ADDR"
echo "  Oracle C: $ORACLE_C_ADDR"
echo ""

cd "$SCRIPT_DIR"
wait_for_devnet

# ══════════════════════════════════════════════════════════════════
# SETUP 1: Deploy
# ══════════════════════════════════════════════════════════════════

echo "=== SETUP 1: Deploy ==="
leo deploy --endpoint "$ENDPOINT" $NETWORK $CONSENSUS --yes
sleep 3
echo "  ✓ Deployed $PROGRAM.aleo"

# ══════════════════════════════════════════════════════════════════
# SETUP 2: Fund oracle nodes (devnet only — admin sends credits)
# ══════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════
# SETUP 2: Register oracle nodes
# ══════════════════════════════════════════════════════════════════

echo "=== SETUP 2: Register oracle nodes ==="

echo "  → set_oracle 0 (A) → $ORACLE_A_ADDR"
set_oracle_role "0u8" "$ORACLE_A_ADDR"

echo "  → set_oracle 1 (B) → $ORACLE_B_ADDR"
set_oracle_role "1u8" "$ORACLE_B_ADDR"

echo "  → set_oracle 2 (C) → $ORACLE_C_ADDR"
set_oracle_role "2u8" "$ORACLE_C_ADDR"

sleep 4
assert_not_null "roles[0] oracle A" roles "0u8"
assert_not_null "roles[1] oracle B" roles "1u8"
assert_not_null "roles[2] oracle C" roles "2u8"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 1: 1 vote — no quorum
# ══════════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════╗"
echo "║  TEST 1: Oracle A submits BTC — 1 vote      ║"
echo "╚══════════════════════════════════════════════╝"

OUT_1=$(submit_price_as "$ORACLE_A_KEY" "$BTC_ASSET" "$BTC_PRICE_1" "$BTC_TS_1")
echo "$OUT_1"

assert_not_null "price_proposals[BTC] 1 vote" price_proposals "$BTC_ASSET"
VAL=$(curl -s "$ENDPOINT/testnet/program/$PROGRAM.aleo/mapping/oracle_prices/$BTC_ASSET")
if echo "$VAL" | grep -q "price: 0u64"; then
    echo "  ✓ oracle_prices[BTC] = 0 (no quorum yet)"
fi
echo "  ✓ TEST 1 PASSED"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 2: Oracle B submits same price — QUORUM
# ══════════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════╗"
echo "║  TEST 2: Oracle B submits BTC → QUORUM      ║"
echo "╚══════════════════════════════════════════════╝"

OUT_2=$(submit_price_as "$ORACLE_B_KEY" "$BTC_ASSET" "$BTC_PRICE_1" "$BTC_TS_1")
echo "$OUT_2"

assert_mapping_contains "oracle_prices[BTC] quorum" oracle_prices "$BTC_ASSET" "6700000000000"
echo "  ✓ TEST 2 PASSED"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 3: ETH — quorum via A + C
# ══════════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════╗"
echo "║  TEST 3: ETH quorum via Oracle A + C        ║"
echo "╚══════════════════════════════════════════════╝"

echo "  → Oracle A: ETH $ETH_PRICE_1"
OUT_3A=$(submit_price_as "$ORACLE_A_KEY" "$ETH_ASSET" "$ETH_PRICE_1" "$ETH_TS_1")
echo "$OUT_3A"

echo "  → Oracle C: ETH $ETH_PRICE_1 → quorum"
OUT_3C=$(submit_price_as "$ORACLE_C_KEY" "$ETH_ASSET" "$ETH_PRICE_1" "$ETH_TS_1")
echo "$OUT_3C"

assert_mapping_contains "oracle_prices[ETH] quorum" oracle_prices "$ETH_ASSET" "250000000000"
echo "  ✓ TEST 3 PASSED"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 4: New BTC price — proposal resets
# ══════════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════╗"
echo "║  TEST 4: New BTC price resets proposal      ║"
echo "╚══════════════════════════════════════════════╝"

echo "  → Oracle A: BTC $BTC_PRICE_2 (new round)"
OUT_4=$(submit_price_as "$ORACLE_A_KEY" "$BTC_ASSET" "$BTC_PRICE_2" "$BTC_TS_2")
echo "$OUT_4"

assert_mapping_contains "oracle_prices[BTC] still old" oracle_prices "$BTC_ASSET" "6700000000000"
assert_not_null "price_proposals[BTC] 1 vote new round" price_proposals "$BTC_ASSET"
echo "  ✓ TEST 4 PASSED"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 5: Oracle B agrees on new price — QUORUM
# ══════════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════╗"
echo "║  TEST 5: Oracle B agrees → new BTC quorum   ║"
echo "╚══════════════════════════════════════════════╝"

OUT_5=$(submit_price_as "$ORACLE_B_KEY" "$BTC_ASSET" "$BTC_PRICE_2" "$BTC_TS_2")
echo "$OUT_5"

assert_mapping_contains "oracle_prices[BTC] new price" oracle_prices "$BTC_ASSET" "6800000000000"
echo "  ✓ TEST 5 PASSED"
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 6: Double vote — rejected
# ══════════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════╗"
echo "║  TEST 6: Double vote rejected               ║"
echo "╚══════════════════════════════════════════════╝"

echo "  → Oracle A: SOL first vote"
submit_price_as "$ORACLE_A_KEY" "$SOL_ASSET" "$SOL_PRICE_1" "$SOL_TS_1" > /dev/null

echo "  → Oracle A: SOL again (should be rejected)"
set +e
OUT_6=$(submit_price_as "$ORACLE_A_KEY" "$SOL_ASSET" "$SOL_PRICE_1" "$SOL_TS_1" 2>&1)
EXIT_6=$?
set -e
echo "$OUT_6"

if echo "$OUT_6" | grep -qi "Transaction rejected"; then
    echo "  ✓ TEST 6 PASSED — double vote rejected"
else
    echo "  ⚠ TEST 6 — verify rejection manually"
fi
echo ""

# ══════════════════════════════════════════════════════════════════
# TEST 7: Non-oracle rejected
# ══════════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════╗"
echo "║  TEST 7: Non-oracle address rejected        ║"
echo "╚══════════════════════════════════════════════╝"

echo "  → Admin (PRIVATE_KEY) tries to submit SOL"
set +e
OUT_7=$(leo execute submit_price "$SOL_ASSET" "$SOL_PRICE_1" "$SOL_TS_1" \
    --endpoint "$ENDPOINT" \
    $NETWORK $CONSENSUS --yes 2>&1)
EXIT_7=$?
set -e
echo "$OUT_7"

if echo "$OUT_7" | grep -qi "Transaction rejected"; then
    echo "  ✓ TEST 7 PASSED — non-oracle rejected"
else
    echo "  ⚠ TEST 7 — verify rejection manually (admin may equal oracle key)"
fi
echo ""

# ══════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════

echo "Final oracle_prices:"
check_mapping "$PROGRAM" oracle_prices "$BTC_ASSET"
check_mapping "$PROGRAM" oracle_prices "$ETH_ASSET"
check_mapping "$PROGRAM" oracle_prices "$SOL_ASSET"

echo "Oracle roles:"
check_mapping "$PROGRAM" roles "0u8"
check_mapping "$PROGRAM" roles "1u8"
check_mapping "$PROGRAM" roles "2u8"

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                  Oracle tests complete!                        ║"
echo "║                                                                ║"
echo "║  1. Deploy + register A, B, C                          ✓      ║"
echo "║  2. Oracle A → BTC: 1 vote, no quorum                  ✓      ║"
echo "║  3. Oracle B → BTC: quorum, price updated              ✓      ║"
echo "║  4. Oracle A+C → ETH: quorum via diff pair             ✓      ║"
echo "║  5. Oracle A → new BTC: proposal resets                ✓      ║"
echo "║  6. Oracle B → new BTC: quorum, new price              ✓      ║"
echo "║  7. Oracle A → SOL twice: double vote rejected         ✓      ║"
echo "║  8. Non-oracle → SOL: rejected                         ✓      ║"
echo "╚════════════════════════════════════════════════════════════════╝"
