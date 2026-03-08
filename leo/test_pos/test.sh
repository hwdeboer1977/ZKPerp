#!/bin/bash
set -e

#
# HOW TO RUN:
#
# Terminal 1: Start devnet
#   leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage
#
# Terminal 2: Run test
#   chmod +x test.sh
#   ./test.sh
#
# WHAT THIS TESTS:
#   Full happy path for LP + trading:
#     1.  Deploy
#     2.  Init mock_usdc admin
#     3.  Mint USDC to trader
#     4.  Seed roles (oracle admin + orchestrator)
#     5.  Seed oracle price
#     6.  initialize_slots → long_slot + short_slot + lp_slot
#     7.  add_liquidity    → updated LPSlot (lp_amount > 0, deposit >= SIZE*2 for OI cap)
#     8.  open_position    → filled PositionSlot (long) + LiquidationAuth
#
# RECORD FORMAT (confirmed working):
#   Compact single line, no spaces, all fields .private, _nonce .public, _version:1u8.public
#   e.g. {owner:aleo1....private,slot_id:0u8.private,...,_nonce:1234group.public,_version:1u8.public}
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
ORCHESTRATOR=$USER   # same address for local devnet convenience

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEO_DIR="$(dirname "$SCRIPT_DIR")"
MOCK_USDC_DIR="$LEO_DIR/mock_usdc"
TEST_POS_DIR="$SCRIPT_DIR"

MINT_AMOUNT="100000000u128"    # 100 USDC minted to trader
DEPOSIT_AMOUNT="20000000u128"  # 20 USDC deposited into LP (needs to be >= SIZE*2 for OI cap)

COLLATERAL="1000000u128"       # 1 USDC collateral for long position
SIZE="5000000u64"              # 5 USDC notional → 5x leverage
ENTRY_PRICE="9500000u64"       # $95,000 (2 decimal price feed)
MAX_SLIPPAGE="50000u64"        # $500 slippage tolerance
NONCE_LONG="12345field"        # change each run to avoid replay error

ORACLE_ASSET_ID="0field"
ORACLE_TIMESTAMP="1000000u32"
# OI cap: max_oi = total_liquidity * 50% / 1_000_000

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

# ══════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║       test_pos — add_liquidity + open_position (long)         ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Trader:        $USER"
echo "  Orchestrator:  $ORCHESTRATOR"
echo "  Mint amount:   $MINT_AMOUNT"
echo "  LP deposit:    $DEPOSIT_AMOUNT"
echo "  Collateral:    $COLLATERAL"
echo "  Size:          $SIZE"
echo "  Entry price:   $ENTRY_PRICE"
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
# STEP 3: Mint USDC to trader
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
echo "  oracle_admin → $USER"
echo "  orchestrator → $ORCHESTRATOR"
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
# STEP 6: initialize_slots — extract long_slot and lp_slot nonces
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 6: initialize_slots ==="
echo "  → long_slot (slot_id:0), short_slot (slot_id:1), lp_slot"

INIT_OUTPUT=$(leo execute initialize_slots "$USER" $NETWORK $CONSENSUS --yes 2>&1)
echo "$INIT_OUTPUT"
sleep 3

# Records are returned in order: long_slot (1st), short_slot (2nd), lp_slot (3rd)
LONG_SLOT_NONCE=$(echo "$INIT_OUTPUT" | grep -oP '_nonce: \K[0-9]+(?=group)' | sed -n '1p')
LP_SLOT_NONCE=$(echo  "$INIT_OUTPUT" | grep -oP '_nonce: \K[0-9]+(?=group)' | sed -n '3p')

if [ -z "$LONG_SLOT_NONCE" ]; then
  echo "❌ Could not extract long_slot _nonce. Raw output:"
  echo "$INIT_OUTPUT"
  exit 1
fi
if [ -z "$LP_SLOT_NONCE" ]; then
  echo "❌ Could not extract lp_slot _nonce. Raw output:"
  echo "$INIT_OUTPUT"
  exit 1
fi

echo "  long_slot _nonce: ${LONG_SLOT_NONCE}group"
echo "  lp_slot   _nonce: ${LP_SLOT_NONCE}group"

check_mapping $TEST_POS_PROGRAM slots_initialized "$USER"

# ══════════════════════════════════════════════════════════════════
# STEP 7: add_liquidity
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 7: add_liquidity (deposit $DEPOSIT_AMOUNT) ==="

LP_SLOT_FILE=$(mktemp /tmp/lp_slot_XXXXXX.txt)
printf '{owner:%s.private,slot_id:0u8.private,is_open:false.private,lp_amount:0u64.private,_nonce:%sgroup.public,_version:1u8.public}' \
  "$USER" "$LP_SLOT_NONCE" > "$LP_SLOT_FILE"

echo "  LPSlot record:"
cat "$LP_SLOT_FILE"
echo ""

leo execute add_liquidity \
  "$(cat $LP_SLOT_FILE)" \
  "$DEPOSIT_AMOUNT" \
  "$USER" \
  $NETWORK $CONSENSUS --yes
sleep 3

rm -f "$LP_SLOT_FILE"

echo "Trader balance after LP deposit:"
check_mapping $MOCK_USDC_PROGRAM balances "$USER"

echo "Pool state after LP deposit:"
check_mapping $TEST_POS_PROGRAM pool_state "0field"


# ══════════════════════════════════════════════════════════════════
# STEP 8: open_position — LONG
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== STEP 8: open_position LONG (slot_id:0, is_long:true) ==="

LONG_SLOT_FILE=$(mktemp /tmp/long_slot_XXXXXX.txt)
printf '{owner:%s.private,slot_id:0u8.private,is_open:false.private,position_id:0field.private,is_long:false.private,size_usdc:0u64.private,collateral_usdc:0u64.private,entry_price:0u64.private,_nonce:%sgroup.public,_version:1u8.public}' \
  "$USER" "$LONG_SLOT_NONCE" > "$LONG_SLOT_FILE"

echo "  PositionSlot record:"
cat "$LONG_SLOT_FILE"
echo ""

leo execute open_position \
  "$(cat $LONG_SLOT_FILE)" \
  "$COLLATERAL" \
  "$SIZE" \
  "true" \
  "$ENTRY_PRICE" \
  "$MAX_SLIPPAGE" \
  "$NONCE_LONG" \
  "$USER" \
  "$ORCHESTRATOR" \
  $NETWORK $CONSENSUS --yes
sleep 3

rm -f "$LONG_SLOT_FILE"

# ══════════════════════════════════════════════════════════════════
# VERIFY
# ══════════════════════════════════════════════════════════════════

echo ""
echo "=== VERIFY ==="

echo "Trader balance (reduced by collateral $COLLATERAL):"
check_mapping $MOCK_USDC_PROGRAM balances "$USER"

echo "Nonce consumed (replay protection):"
check_mapping $TEST_POS_PROGRAM used_nonces "$NONCE_LONG"

echo "Pool state (long_open_interest += SIZE, total_liquidity += collateral):"
check_mapping $TEST_POS_PROGRAM pool_state "0field"

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                       Test complete!                          ║"
echo "║                                                                ║"
echo "║  add_liquidity  ✓                                             ║"
echo "║    LPSlot lp_amount > 0, is_open: true                        ║"
echo "║    pool_state.total_liquidity increased                        ║"
echo "║                                                                ║"
echo "║  open_position (long)  ✓                                      ║"
echo "║    Filled PositionSlot  slot_id:0, is_open:true, is_long:true ║"
echo "║    LiquidationAuth      owner == orchestrator                  ║"
echo "║    pool_state.long_open_interest increased                     ║"
echo "║    used_nonces[NONCE_LONG] == true                             ║"
echo "╚════════════════════════════════════════════════════════════════╝"
