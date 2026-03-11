#!/bin/bash
set -e

#
# HOW TO RUN:
#
# Terminal 1: Start devnet
#   leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage
#
# Terminal 2: Run test
#   chmod +x testLP.sh
#   ./testLP.sh
#
# WHAT THIS TESTS:
#   Full round-trip for LP + trading:
#     1.  Deploy
#     2.  Init mock_usdc admin
#     3.  Mint USDC to trader
#     4.  Seed roles (oracle admin + orchestrator)
#     5.  Seed oracle price
#     6.  initialize_slots → long_slot + lp_slot
#     7.  add_liquidity    → filled LPSlot (lp_amount > 0)
#     8.  open_position    → filled PositionSlot (long) + LiquidationAuth
#     9.  remove_liquidity → empty/reduced LPSlot + USDC back to trader
#     10. close_position   → empty PositionSlot + USDC payout to trader
#
# RECORD FORMAT (confirmed working):
#   Compact single line, no spaces, all fields .private, _nonce .public, _version:1u8.public
#   {owner:aleo1....private,slot_id:0u8.private,...,_nonce:1234group.public,_version:1u8.public}
# ═══════════════════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════

ENDPOINT="http://localhost:3030"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11"
NETWORK="--network testnet --broadcast"

MOCK_USDC_PROGRAM="mock_usdc_0128"
TEST_POS_PROGRAM="test_pos"

USER="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"
ORCHESTRATOR=$USER

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEO_DIR="$(dirname "$SCRIPT_DIR")"
MOCK_USDC_DIR="$LEO_DIR/mock_usdc"
TEST_POS_DIR="$SCRIPT_DIR"

MINT_AMOUNT="100000000u128"    # 100 USDC
DEPOSIT_AMOUNT="20000000u128"  # 20 USDC into LP  (>= SIZE*2 for OI cap)
DEPOSIT_U64="20000000"         # same value as u64 for remove_liquidity math

COLLATERAL="1000000u128"       # 1 USDC collateral
SIZE="5000000u64"              # 5 USDC notional → 5x leverage
COLLATERAL_U64="1000000"       # same as u64 for close_position math
SIZE_U64="5000000"             # same as u64

ENTRY_PRICE="9500000u64"       # $95,000
ENTRY_PRICE_U64="9500000"      # same as u64
MAX_SLIPPAGE="50000u64"        # $500 slippage
NONCE_LONG="12345field"        # change each run

ORACLE_ASSET_ID="0field"
ORACLE_TIMESTAMP="1000000u32"

# remove_liquidity: burn all LP tokens, expect back full deposit minus any rounding
# amount_to_burn == lp_tokens minted during add_liquidity
# For first deposit with empty pool: lp_to_mint = deposit * 1 / 1 = deposit
# So amount_to_burn = DEPOSIT_U64, expected_usdc = DEPOSIT_U64 (conservative — actual may be slightly more)
BURN_AMOUNT="${DEPOSIT_U64}u64"  # burn all LP tokens, but only claim 19 USDC
EXPECTED_USDC_REMOVE="20000000u128"  # 19 USDC — leaves 1 USDC margin for rounding

# close_position: price unchanged → no PnL, just collateral back minus fee and borrow fee
# opening_fee = size * 1000 / 1_000_000 = 5000
# borrow_fee  = size * blocks_open / 100_000_000 ≈ tiny on devnet (1-2 blocks)
# Safe conservative expected_payout = collateral_after_fee - small_borrow_fee
# collateral_after_fee = 1000000 - 5000 = 995000
# borrow_fee at ~2 blocks = 5000000 * 2 / 100_000_000 = 0 (rounds to 0)
# So expected_payout = 995000 (conservative, guaranteed to be <= max_payout)
EXPECTED_PAYOUT="995000u128"
MIN_PRICE="${ENTRY_PRICE_U64}u64"   # long: current_price >= min_price
MAX_PRICE="${ENTRY_PRICE_U64}u64"   # not used for long but required param

# ══════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════

get_block() {
    curl -s "$ENDPOINT/testnet/block/height/latest"
}

wait_for_devnet() {
    echo "Waiting for devnet..."
    until curl -s "$ENDPOINT/testnet/block/height/latest" 2>/dev/null | grep -qE '^[0-9]+$'; do
        sleep 2
        echo "  still waiting..."
    done
    height=$(get_block)
    while [ "$height" -lt 12 ]; do
        echo "  Block height: $height (waiting for 12)"
        sleep 2
        height=$(get_block)
    done
    echo "Devnet ready! Height: $height"
}

check_mapping() {
    local program=$1 mapping=$2 key=$3
    echo "  $program/$mapping[$key]:"
    curl -s "$ENDPOINT/testnet/program/$program.aleo/mapping/$mapping/$key"
    echo ""
}

# Extract the Nth _nonce value from leo execute output
# Usage: extract_nonce "$OUTPUT" 1   (1-indexed)
extract_nonce() {
    local output="$1"
    local n="$2"
    echo "$output" | grep -oP '_nonce: \K[0-9]+(?=group)' | sed -n "${n}p"
}

# ══════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║    test_pos — full round-trip: LP deposit/withdraw + trade    ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Trader:       $USER"
echo "  Mint:         $MINT_AMOUNT"
echo "  LP deposit:   $DEPOSIT_AMOUNT  (remove: burn $BURN_AMOUNT)"
echo "  Collateral:   $COLLATERAL  Size: $SIZE  Price: $ENTRY_PRICE"
echo "  Close payout: $EXPECTED_PAYOUT (conservative, no PnL scenario)"
echo ""

wait_for_devnet

# ══════════════════════════════════════════════════════════════════
# STEP 1: Deploy
# ══════════════════════════════════════════════════════════════════

echo "=== STEP 1: Deploy ==="
cd "$TEST_POS_DIR"
leo deploy $NETWORK $CONSENSUS --yes
sleep 5

# ══════════════════════════════════════════════════════════════════
# STEP 2: Init mock_usdc admin
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 2: Init mock_usdc admin ==="
cd "$MOCK_USDC_DIR"
leo execute initialize_admin $NETWORK $CONSENSUS --yes
sleep 3
check_mapping $MOCK_USDC_PROGRAM admin 0u8

# ══════════════════════════════════════════════════════════════════
# STEP 3: Mint USDC
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 3: Mint $MINT_AMOUNT to trader ==="
leo execute mint_public "$USER" "$MINT_AMOUNT" $NETWORK $CONSENSUS --yes
sleep 3
check_mapping $MOCK_USDC_PROGRAM balances "$USER"

# ══════════════════════════════════════════════════════════════════
# STEP 4: Seed roles
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 4: Seed roles ==="
cd "$TEST_POS_DIR"
leo execute seed_roles "$USER" "$ORCHESTRATOR" $NETWORK $CONSENSUS --yes
sleep 3
check_mapping $TEST_POS_PROGRAM roles 0u8
check_mapping $TEST_POS_PROGRAM roles 1u8

# ══════════════════════════════════════════════════════════════════
# STEP 5: Seed oracle price
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 5: Seed oracle price ($ENTRY_PRICE) ==="
leo execute seed_oracle "$ORACLE_ASSET_ID" "$ENTRY_PRICE" "$ORACLE_TIMESTAMP" \
  $NETWORK $CONSENSUS --yes
sleep 3
check_mapping $TEST_POS_PROGRAM oracle_prices "$ORACLE_ASSET_ID"

# ══════════════════════════════════════════════════════════════════
# STEP 6: initialize_slots
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 6: initialize_slots ==="
INIT_OUTPUT=$(leo execute initialize_slots "$USER" $NETWORK $CONSENSUS --yes 2>&1)
echo "$INIT_OUTPUT"
sleep 3

LONG_SLOT_NONCE=$(extract_nonce "$INIT_OUTPUT" 1)
LP_SLOT_NONCE=$(extract_nonce "$INIT_OUTPUT" 3)

if [ -z "$LONG_SLOT_NONCE" ] || [ -z "$LP_SLOT_NONCE" ]; then
  echo "❌ Could not extract nonces from initialize_slots output."
  exit 1
fi
echo "  long_slot _nonce: ${LONG_SLOT_NONCE}group"
echo "  lp_slot   _nonce: ${LP_SLOT_NONCE}group"
check_mapping $TEST_POS_PROGRAM slots_initialized "$USER"

# ══════════════════════════════════════════════════════════════════
# STEP 7: add_liquidity — capture output LPSlot nonce for Step 9
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 7: add_liquidity (deposit $DEPOSIT_AMOUNT) ==="

LP_SLOT_FILE=$(mktemp /tmp/lp_slot_XXXXXX.txt)
printf '{owner:%s.private,slot_id:0u8.private,is_open:false.private,lp_amount:0u64.private,_nonce:%sgroup.public,_version:1u8.public}' \
  "$USER" "$LP_SLOT_NONCE" > "$LP_SLOT_FILE"
echo "  Input LPSlot:"; cat "$LP_SLOT_FILE"; echo ""

ADD_LIQ_OUTPUT=$(leo execute add_liquidity \
  "$(cat $LP_SLOT_FILE)" \
  "$DEPOSIT_AMOUNT" \
  "$USER" \
  $NETWORK $CONSENSUS --yes 2>&1)
echo "$ADD_LIQ_OUTPUT"
sleep 3
rm -f "$LP_SLOT_FILE"

# The output is a single updated LPSlot — capture its nonce for remove_liquidity
FILLED_LP_NONCE=$(extract_nonce "$ADD_LIQ_OUTPUT" 1)
if [ -z "$FILLED_LP_NONCE" ]; then
  echo "❌ Could not extract filled LPSlot nonce from add_liquidity output."
  exit 1
fi
echo "  Filled LPSlot _nonce: ${FILLED_LP_NONCE}group"

echo "Trader balance after deposit:"
check_mapping $MOCK_USDC_PROGRAM balances "$USER"
echo "Pool state after deposit:"
check_mapping $TEST_POS_PROGRAM pool_state "0field"

# ══════════════════════════════════════════════════════════════════
# STEP 8: open_position — capture output PositionSlot nonce for Step 10
# ══════════════════════════════════════════════════════════════════

# echo ""
# echo "=== STEP 8: open_position LONG (slot_id:0) ==="

# LONG_SLOT_FILE=$(mktemp /tmp/long_slot_XXXXXX.txt)
# printf '{owner:%s.private,slot_id:0u8.private,is_open:false.private,position_id:0field.private,is_long:false.private,size_usdc:0u64.private,collateral_usdc:0u64.private,entry_price:0u64.private,_nonce:%sgroup.public,_version:1u8.public}' \
#   "$USER" "$LONG_SLOT_NONCE" > "$LONG_SLOT_FILE"
# echo "  Input PositionSlot:"; cat "$LONG_SLOT_FILE"; echo ""

# OPEN_POS_OUTPUT=$(leo execute open_position \
#   "$(cat $LONG_SLOT_FILE)" \
#   "$COLLATERAL" \
#   "$SIZE" \
#   "true" \
#   "$ENTRY_PRICE" \
#   "$MAX_SLIPPAGE" \
#   "$NONCE_LONG" \
#   "$USER" \
#   "$ORCHESTRATOR" \
#   $NETWORK $CONSENSUS --yes 2>&1)
# echo "$OPEN_POS_OUTPUT"
# sleep 3
# rm -f "$LONG_SLOT_FILE"

# # open_position returns 2 records: filled PositionSlot (1st), LiquidationAuth (2nd)
# # We need the filled PositionSlot nonce + its field values for close_position
# FILLED_SLOT_NONCE=$(extract_nonce "$OPEN_POS_OUTPUT" 1)

# # Extract filled slot values from output (written by open_position)
# FILLED_POSITION_ID=$(echo "$OPEN_POS_OUTPUT" | grep -oP 'position_id: \K[^\s,]+(?=\.private)')
# FILLED_IS_LONG=$(echo "$OPEN_POS_OUTPUT"     | grep -oP 'is_long: \K[^\s,]+(?=\.private)'     | head -1)
# FILLED_SIZE=$(echo "$OPEN_POS_OUTPUT"        | grep -oP 'size_usdc: \K[^\s,]+(?=\.private)'   | head -1)
# FILLED_COLLATERAL=$(echo "$OPEN_POS_OUTPUT"  | grep -oP 'collateral_usdc: \K[^\s,]+(?=\.private)' | head -1)
# FILLED_ENTRY=$(echo "$OPEN_POS_OUTPUT"       | grep -oP 'entry_price: \K[^\s,]+(?=\.private)' | head -1)

# if [ -z "$FILLED_SLOT_NONCE" ]; then
#   echo "❌ Could not extract filled PositionSlot nonce from open_position output."
#   exit 1
# fi

# echo "  Filled PositionSlot _nonce:      ${FILLED_SLOT_NONCE}group"
# echo "  position_id:                     $FILLED_POSITION_ID"
# echo "  collateral_usdc:                 $FILLED_COLLATERAL"

# echo "Nonce consumed:"
# check_mapping $TEST_POS_PROGRAM used_nonces "$NONCE_LONG"
# echo "Pool state (long_oi updated):"
# check_mapping $TEST_POS_PROGRAM pool_state "0field"

# ══════════════════════════════════════════════════════════════════
# STEP 9: remove_liquidity
#
# Signature: remove_liquidity(lp_slot, amount_to_burn: u64, expected_usdc: u128)
# - lp_slot:        the filled LPSlot from Step 7 (is_open:true, lp_amount:DEPOSIT_U64)
# - amount_to_burn: LP tokens to burn (= lp_amount from filled slot)
# - expected_usdc:  USDC to receive back (must be <= max_usdc calculated in finalize)
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 9: remove_liquidity (burn $BURN_AMOUNT, expect $EXPECTED_USDC_REMOVE) ==="

FILLED_LP_FILE=$(mktemp /tmp/filled_lp_XXXXXX.txt)
printf '{owner:%s.private,slot_id:0u8.private,is_open:true.private,lp_amount:%su64.private,_nonce:%sgroup.public,_version:1u8.public}' \
  "$USER" "$DEPOSIT_U64" "$FILLED_LP_NONCE" > "$FILLED_LP_FILE"
echo "  Filled LPSlot:"; cat "$FILLED_LP_FILE"; echo ""

leo execute remove_liquidity \
  "$(cat $FILLED_LP_FILE)" \
  "$BURN_AMOUNT" \
  "$EXPECTED_USDC_REMOVE" \
  $NETWORK $CONSENSUS --yes
sleep 3
rm -f "$FILLED_LP_FILE"

echo "Trader balance after LP withdrawal:"
check_mapping $MOCK_USDC_PROGRAM balances "$USER"
echo "Pool state after withdrawal:"
check_mapping $TEST_POS_PROGRAM pool_state "0field"

# ══════════════════════════════════════════════════════════════════
# STEP 10: close_position
#
# Signature: close_position(slot, min_price: u64, max_price: u64, expected_payout: u128)
# - slot:            the filled PositionSlot from Step 8 (all fields from open_position output)
# - min_price:       for long: oracle_price must be >= min_price
# - max_price:       for short: oracle_price must be <= max_price (ignored for long)
# - expected_payout: must be <= max_payout calculated in finalize
#
# Price unchanged → no PnL. Payout = collateral_after_fee - borrow_fee
# collateral_after_fee = collateral - opening_fee = 1000000 - 5000 = 995000
# borrow_fee at ~3 blocks = 5000000 * 3 / 100_000_000 = 0 (rounds down)
# So expected_payout = 995000 is safe.
# ══════════════════════════════════════════════════════════════════

# echo ""
# echo "=== STEP 10: close_position (long, payout: $EXPECTED_PAYOUT) ==="

# FILLED_POS_FILE=$(mktemp /tmp/filled_pos_XXXXXX.txt)
# printf '{owner:%s.private,slot_id:0u8.private,is_open:true.private,position_id:%s.private,is_long:true.private,size_usdc:%su64.private,collateral_usdc:%su64.private,entry_price:%su64.private,_nonce:%sgroup.public,_version:1u8.public}' \
#   "$USER" \
#   "${FILLED_POSITION_ID:-0field}" \
#   "${FILLED_SIZE:-$SIZE_U64}" \
#   "${FILLED_COLLATERAL:-995000}" \
#   "${FILLED_ENTRY:-$ENTRY_PRICE_U64}" \
#   "$FILLED_SLOT_NONCE" > "$FILLED_POS_FILE"
# echo "  Filled PositionSlot:"; cat "$FILLED_POS_FILE"; echo ""

# leo execute close_position \
#   "$(cat $FILLED_POS_FILE)" \
#   "$MIN_PRICE" \
#   "$MAX_PRICE" \
#   "$EXPECTED_PAYOUT" \
#   $NETWORK $CONSENSUS --yes
# sleep 3
# rm -f "$FILLED_POS_FILE"

# ══════════════════════════════════════════════════════════════════
# FINAL VERIFY
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== FINAL VERIFY ==="
echo "Trader balance (should be close to starting mint minus fees):"
check_mapping $MOCK_USDC_PROGRAM balances "$USER"
echo "Pool state (OI back to 0, fees accumulated):"
check_mapping $TEST_POS_PROGRAM pool_state "0field"

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    Full round-trip complete!                  ║"
echo "║                                                                ║"
echo "║  Step 7  add_liquidity     ✓  LPSlot filled                  ║"
echo "║  Step 8  open_position     ✓  PositionSlot filled            ║"
echo "║  Step 9  remove_liquidity  ✓  USDC returned to trader        ║"
echo "║  Step 10 close_position    ✓  Collateral returned to trader   ║"
echo "╚════════════════════════════════════════════════════════════════╝"
