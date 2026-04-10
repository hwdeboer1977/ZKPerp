#!/usr/bin/env bash
# =============================================================================
# ZK Dark Pool v1 — Full Local Devnet Test
#
# Usage:
#   Terminal 1 (devnet):
#     leo devnet --snarkos $(which snarkos) --snarkos-features test_network \
#       --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage
#
#   Terminal 2 (tests):
#     chmod +x test_darkpool.sh && ./test_darkpool.sh
#
#   Single scenario:
#     TEST_SCENARIO=debug ./test_darkpool.sh
#
#   Scenarios:
#     1     = Deploy + initialize
#     2     = Submit buy + sell orders
#     3     = Full settle_match (exact fill)
#     4     = Partial fill
#     5     = Cancel order
#     6     = Operator withdraw fees
#     debug = Deploy + orders + debug_settle (diagnose assert failures)
#     all   = Run all (default)
# =============================================================================

set -uo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERR]${NC}   $*"; exit 1; }

section() {
  echo ""
  echo -e "${YELLOW}══════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}  $*${NC}"
  echo -e "${YELLOW}══════════════════════════════════════════════════════════════${NC}"
}

# ── Config ────────────────────────────────────────────────────────────────────
ENDPOINT="http://localhost:3030"
CONSENSUS="--consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11"
NETWORK="--network testnet --broadcast"
PROGRAM="zkdarkpool_v2.aleo"
DARKPOOL_DIR="${DARKPOOL_DIR:-$HOME/ZK_Darkpool}"

#OPERATOR="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"
OPERATOR="aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0"
BUYER=$OPERATOR
SELLER=$OPERATOR

BTC=0u8
ETH=1u8

BUY_LIMIT=50000u64
SELL_LIMIT=49000u64
CLEARING_PRICE=49500u64

ORDER_SIZE=10000000u64
FILL_SIZE=10000000u64
PARTIAL_FILL_SIZE=5000000u64

EXPIRY=9999u32

BUY_NONCE=111111field
SELL_NONCE=222222field
CANCEL_NONCE=333333field
RESIDUAL_BUY_NONCE=444444field
RESIDUAL_SELL_NONCE=555555field
BATCH_ROOT=999999field

BUY_SALT=777777field
SELL_SALT=888888field

FEE_WITHDRAW=100u64

# ── Runtime-captured _nonce values ───────────────────────────────────────────
BUY_ORDER_NONCE=""
SELL_ORDER_NONCE=""
CANCEL_ORDER_NONCE=""

# ── Temp file cleanup ─────────────────────────────────────────────────────────
TMPFILES=()
cleanup() {
  for f in "${TMPFILES[@]:-}"; do [[ -f "$f" ]] && rm -f "$f"; done
}
trap cleanup EXIT

tmpfile() {
  local f; f=$(mktemp /tmp/darkpool_XXXXXX.txt)
  TMPFILES+=("$f")
  echo "$f"
}

# ── Core helpers ──────────────────────────────────────────────────────────────
get_block() {
  curl -s "$ENDPOINT/testnet/block/height/latest" 2>/dev/null || echo "0"
}

check_mapping() {
  local mapping=$1 key=$2
  local val
  val=$(curl -s "$ENDPOINT/testnet/program/$PROGRAM/mapping/$mapping/$key")
  echo -e "  ${CYAN}$mapping${NC}[$key] = ${GREEN}$val${NC}"
}

# Run leo execute with retry on broadcast 500 errors (devnet instability)
execute_capture() {
  local transition=$1; shift
  local out; out=$(tmpfile)
  local attempts=0 max_attempts=3

  info "leo execute $transition" >&2
  cd "$DARKPOOL_DIR"

  while true; do
    (( attempts++ )) || true
    > "$out"
    leo execute "$transition" "$@" $NETWORK $CONSENSUS --yes 2>&1 \
      | tee "$out" >&2
    local exit_code=${PIPESTATUS[0]}

    if grep -q "http status: 500" "$out" 2>/dev/null; then
      if [[ $attempts -lt $max_attempts ]]; then
        warn "Broadcast 500 on $transition (attempt $attempts/$max_attempts) -- retrying in 5s..." >&2
        sleep 5
        continue
      else
        die "transition $transition failed after $max_attempts attempts (broadcast 500)"
      fi
    fi

    [[ $exit_code -ne 0 ]] && die "transition $transition failed (exit $exit_code)"
    break
  done

  # Extra wait for finalize-heavy transitions (settle_match, partial_fill)
  # These write to 4 mappings and need time for all 4 validators to sync
  case "$transition" in
    settle_match|partial_fill) sleep 10 ;;
    *) sleep 3 ;;
  esac
  echo "$out"
}

# Extract the _nonce group value from the Nth record block (0-indexed)
# in a leo execute output file.
parse_nonce() {
  local file=$1
  local idx=${2:-0}
  local target=$((idx + 1))
  awk -v target="$target" '
    /• \{/ { block++ }
    block == target && /_nonce:/ {
      gsub(/.*_nonce: /, "")
      gsub(/\.public.*/, "")
      gsub(/[[:space:]]/, "")
      print
      exit
    }
  ' "$file"
}

# Record builders — include _version:1u8.public required by Leo 3.4+
build_order_record() {
  local nonce_val=$1 owner=$2 asset_id=$3 direction=$4
  local size=$5 limit_price=$6 salt=$7 expiry=$8 nonce=$9
  printf '{owner:%s.private,asset_id:%s.private,direction:%s.private,size:%s.private,limit_price:%s.private,salt:%s.private,expiry:%s.private,nonce:%s.private,_nonce:%s.public,_version:1u8.public}' \
    "$owner" "$asset_id" "$direction" "$size" "$limit_price" "$salt" "$expiry" "$nonce" "$nonce_val"
}

build_usdcx_record() {
  local nonce_val=$1 owner=$2 amount=$3
  printf '{owner:%s.private,amount:%s.private,_nonce:%s.public,_version:1u8.public}' \
    "$owner" "$amount" "$nonce_val"
}

build_asset_record() {
  local nonce_val=$1 owner=$2 asset_id=$3 amount=$4
  printf '{owner:%s.private,asset_id:%s.private,amount:%s.private,_nonce:%s.public,_version:1u8.public}' \
    "$owner" "$asset_id" "$amount" "$nonce_val"
}

record() {
  local f; f=$(tmpfile)
  printf '%s' "$1" > "$f"
  echo "$f"
}

# Mint USDCxRecord + AssetRecord, return captured nonces via globals
# Usage: mint_records <usdcx_amount> <asset_id> <asset_amount>
# Sets: MINT_COL_NONCE, MINT_ASSET_NONCE
mint_records() {
  local usdcx_amount=$1 asset_id=$2 asset_amount=$3
  info "Minting test records (USDCx=$usdcx_amount, asset=$asset_id, amount=$asset_amount) ..." >&2
  local mint_out
  mint_out=$(execute_capture mint_test_records "$BUYER" "$usdcx_amount" "$asset_id" "$asset_amount")

  MINT_COL_NONCE=$(parse_nonce "$mint_out" 0)
  MINT_ASSET_NONCE=$(parse_nonce "$mint_out" 1)

  info "  Collateral _nonce: $MINT_COL_NONCE" >&2
  info "  Asset      _nonce: $MINT_ASSET_NONCE" >&2

  [[ -z "$MINT_COL_NONCE"   ]] && die "Could not parse collateral _nonce from mint output"
  [[ -z "$MINT_ASSET_NONCE" ]] && die "Could not parse asset _nonce from mint output"
}

MINT_COL_NONCE=""
MINT_ASSET_NONCE=""

# ── Devnet wait ───────────────────────────────────────────────────────────────
wait_for_devnet() {
  section "Waiting for devnet"
  info "Polling $ENDPOINT ..."
  local attempts=0
  until curl -s "$ENDPOINT/testnet/block/height/latest" 2>/dev/null | grep -qE '^[0-9]+$'; do
    (( attempts++ )) || true
    [[ $attempts -gt 60 ]] && die "Devnet not up after 120s — start it in Terminal 1"
    echo -ne "  Waiting... ${attempts}s\r"
    sleep 2
  done
  local height; height=$(get_block)
  while [[ "$height" -lt 12 ]]; do
    info "Block height: $height (waiting for 12+)"
    sleep 2
    height=$(get_block)
  done
  success "Devnet ready at block $height"
}

# ── State snapshot ────────────────────────────────────────────────────────────
print_state() {
  section "On-chain state snapshot"
  check_mapping operator       0u8
  check_mapping fee_vault      0u8
  check_mapping order_consumed "$BUY_NONCE"
  check_mapping order_consumed "$SELL_NONCE"
  check_mapping order_consumed "$CANCEL_NONCE"
  check_mapping batch_volume   "$BATCH_ROOT"
}

# =============================================================================
# SCENARIO 1 — Deploy + Initialize
# =============================================================================
scenario_1() {
  section "SCENARIO 1 — Deploy + Initialize"
  info "Deploying $PROGRAM ..."
  cd "$DARKPOOL_DIR"
  leo deploy $NETWORK $CONSENSUS --yes || die "Deploy failed"
  sleep 5
  success "Deployed — constructor set storage admin = program_owner"

  execute_capture initialize > /dev/null
  success "Operator mapping set"
  check_mapping operator 0u8
}

# =============================================================================
# SCENARIO 2 — Submit Buy + Sell Orders
# =============================================================================
scenario_2() {
  section "SCENARIO 2 — Submit Buy + Sell Orders"

  info "BUY  asset=$BTC  size=$ORDER_SIZE  limit=$BUY_LIMIT  nonce=$BUY_NONCE"
  local buy_out
  buy_out=$(execute_capture submit_order \
    "$BUYER" "$BTC" true "$ORDER_SIZE" "$BUY_LIMIT" "$BUY_SALT" "$EXPIRY" "$BUY_NONCE")
  BUY_ORDER_NONCE=$(parse_nonce "$buy_out" 0)
  [[ -z "$BUY_ORDER_NONCE" ]] && die "Could not parse _nonce from BUY submit_order output"
  success "BUY  _nonce: $BUY_ORDER_NONCE"

  info "SELL  asset=$BTC  size=$ORDER_SIZE  limit=$SELL_LIMIT  nonce=$SELL_NONCE"
  local sell_out
  sell_out=$(execute_capture submit_order \
    "$SELLER" "$BTC" false "$ORDER_SIZE" "$SELL_LIMIT" "$SELL_SALT" "$EXPIRY" "$SELL_NONCE")
  SELL_ORDER_NONCE=$(parse_nonce "$sell_out" 0)
  [[ -z "$SELL_ORDER_NONCE" ]] && die "Could not parse _nonce from SELL submit_order output"
  success "SELL _nonce: $SELL_ORDER_NONCE"

  info "Both orders on-chain."
}

# =============================================================================
# SCENARIO DEBUG — debug_settle
# Runs AFTER scenario_2. Prints every record string before calling debug_settle.
# =============================================================================
scenario_debug() {
  section "SCENARIO DEBUG — debug_settle"

  [[ -z "$BUY_ORDER_NONCE"  ]] && die "BUY_ORDER_NONCE not set — run scenario 2 first"
  [[ -z "$SELL_ORDER_NONCE" ]] && die "SELL_ORDER_NONCE not set — run scenario 2 first"

  # Mint collateral + asset records
  mint_records 500000000000u64 "$BTC" "$ORDER_SIZE"

  # Build all four records
  local buy_rec sell_rec col_rec asset_rec
  buy_rec=$(build_order_record \
    "$BUY_ORDER_NONCE" "$BUYER" "$BTC" true \
    "$ORDER_SIZE" "$BUY_LIMIT" "$BUY_SALT" "$EXPIRY" "$BUY_NONCE")
  sell_rec=$(build_order_record \
    "$SELL_ORDER_NONCE" "$SELLER" "$BTC" false \
    "$ORDER_SIZE" "$SELL_LIMIT" "$SELL_SALT" "$EXPIRY" "$SELL_NONCE")
  col_rec=$(build_usdcx_record  "$MINT_COL_NONCE"   "$BUYER"  500000000000u64)
  asset_rec=$(build_asset_record "$MINT_ASSET_NONCE" "$SELLER" "$BTC" "$ORDER_SIZE")

  # ── Verbose record dump — shows exactly what goes into the transition ────────
  section "Record dump (verify owners + nonces)"
  info "buy_order:"
  echo "  $buy_rec"
  info "sell_order:"
  echo "  $sell_rec"
  info "buyer_collateral:"
  echo "  $col_rec"
  info "seller_asset:"
  echo "  $asset_rec"
  info ""
  info "Constraint reference:"
  info "  [8]  buyer_collateral.owner == buy_order.owner  →  $BUYER == $BUYER"
  info "  [9]  seller_asset.owner     == sell_order.owner →  $SELLER == $SELLER"
  info "  [10] buyer_collateral.amount >= fill*price+fee"
  info "       1000000000 >= $(( 10000000 * 49500 )) ($(( 10000000 * 49500 + 10000000 * 49500 / 1000 )) with fee)"
  info "  [11] seller_asset.amount >= fill_size  →  10000000 >= 10000000"
  info ""
  info "Check codes: 1=asset_id 2=direction 3=buy_price 4=sell_price"
  info "             5=min_fill 6=buy_size  7=sell_size 8=col_owner"
  info "             9=asset_owner 10=col_amount 11=asset_amount 12=ALL OK"

  local buy_f sell_f col_f asset_f
  buy_f=$(record "$buy_rec");   sell_f=$(record "$sell_rec")
  col_f=$(record "$col_rec");   asset_f=$(record "$asset_rec")

  cd "$DARKPOOL_DIR"
  leo execute debug_settle \
    "$(cat "$buy_f")" "$(cat "$sell_f")" \
    "$(cat "$col_f")" "$(cat "$asset_f")" \
    "$CLEARING_PRICE" "$FILL_SIZE" \
    $NETWORK $CONSENSUS --yes \
    && success "debug_settle returned 12u8 — ALL CONSTRAINTS PASS" \
    || die "debug_settle failed — see check codes above to identify which assert failed"
}

# =============================================================================
# SCENARIO 3 — Full Settle Match
# =============================================================================
scenario_3() {
  section "SCENARIO 3 — settle_match (exact full fill)"

  [[ -z "$BUY_ORDER_NONCE"  ]] && die "BUY_ORDER_NONCE not set — run scenario 2 first"
  [[ -z "$SELL_ORDER_NONCE" ]] && die "SELL_ORDER_NONCE not set — run scenario 2 first"

  info "buy_limit=$BUY_LIMIT >= clearing=$CLEARING_PRICE >= sell_limit=$SELL_LIMIT ✓"

  mint_records 500000000000u64 "$BTC" "$ORDER_SIZE"

  local buy_rec sell_rec col_rec asset_rec
  buy_rec=$(build_order_record \
    "$BUY_ORDER_NONCE" "$BUYER" "$BTC" true \
    "$ORDER_SIZE" "$BUY_LIMIT" "$BUY_SALT" "$EXPIRY" "$BUY_NONCE")
  sell_rec=$(build_order_record \
    "$SELL_ORDER_NONCE" "$SELLER" "$BTC" false \
    "$ORDER_SIZE" "$SELL_LIMIT" "$SELL_SALT" "$EXPIRY" "$SELL_NONCE")
  col_rec=$(build_usdcx_record  "$MINT_COL_NONCE"   "$BUYER"  500000000000u64)
  asset_rec=$(build_asset_record "$MINT_ASSET_NONCE" "$SELLER" "$BTC" "$ORDER_SIZE")

  local buy_f sell_f col_f asset_f
  buy_f=$(record "$buy_rec");   sell_f=$(record "$sell_rec")
  col_f=$(record "$col_rec");   asset_f=$(record "$asset_rec")

  cd "$DARKPOOL_DIR"
  leo execute settle_match \
    "$(cat "$buy_f")" "$(cat "$sell_f")" \
    "$(cat "$col_f")" "$(cat "$asset_f")" \
    "$CLEARING_PRICE" "$FILL_SIZE" "$BATCH_ROOT" \
    $NETWORK $CONSENSUS --yes || die "settle_match failed"
  sleep 3

  success "settle_match complete"
  check_mapping order_consumed "$BUY_NONCE"
  check_mapping order_consumed "$SELL_NONCE"
  check_mapping fee_vault      0u8
  check_mapping batch_volume   "$BATCH_ROOT"
}

# =============================================================================
# SCENARIO 4 — Partial Fill
# =============================================================================
scenario_4() {
  section "SCENARIO 4 — partial_fill"

  [[ -z "$BUY_ORDER_NONCE"  ]] && die "BUY_ORDER_NONCE not set — run scenario 2 first"
  [[ -z "$SELL_ORDER_NONCE" ]] && die "SELL_ORDER_NONCE not set — run scenario 2 first"

  info "Buy=$ORDER_SIZE  Sell=$PARTIAL_FILL_SIZE  Fill=$PARTIAL_FILL_SIZE (sell-limited)"

  mint_records 500000000000u64 "$BTC" "$PARTIAL_FILL_SIZE"

  local buy_rec sell_rec col_rec asset_rec
  buy_rec=$(build_order_record \
    "$BUY_ORDER_NONCE" "$BUYER" "$BTC" true \
    "$ORDER_SIZE" "$BUY_LIMIT" "$BUY_SALT" "$EXPIRY" "$BUY_NONCE")
  sell_rec=$(build_order_record \
    "$SELL_ORDER_NONCE" "$SELLER" "$BTC" false \
    "$PARTIAL_FILL_SIZE" "$SELL_LIMIT" "$SELL_SALT" "$EXPIRY" "$SELL_NONCE")
  col_rec=$(build_usdcx_record  "$MINT_COL_NONCE"   "$BUYER"  500000000000u64)
  asset_rec=$(build_asset_record "$MINT_ASSET_NONCE" "$SELLER" "$BTC" "$PARTIAL_FILL_SIZE")

  local buy_f sell_f col_f asset_f
  buy_f=$(record "$buy_rec"); sell_f=$(record "$sell_rec")
  col_f=$(record "$col_rec"); asset_f=$(record "$asset_rec")

  cd "$DARKPOOL_DIR"
  leo execute partial_fill \
    "$(cat "$buy_f")" "$(cat "$sell_f")" \
    "$(cat "$col_f")" "$(cat "$asset_f")" \
    "$CLEARING_PRICE" "$PARTIAL_FILL_SIZE" "$BATCH_ROOT" \
    "$RESIDUAL_BUY_NONCE" "$RESIDUAL_SELL_NONCE" \
    $NETWORK $CONSENSUS --yes || die "partial_fill failed"
  sleep 3

  success "partial_fill complete"
  check_mapping order_consumed "$BUY_NONCE"
  check_mapping order_consumed "$SELL_NONCE"
  info "Residual nonce (should be null — not yet consumed):"
  check_mapping order_consumed "$RESIDUAL_BUY_NONCE"
}

# =============================================================================
# SCENARIO 5 — Cancel Order
# =============================================================================
scenario_5() {
  section "SCENARIO 5 — cancel_order"

  info "Submitting ETH order to cancel (nonce=$CANCEL_NONCE) ..."
  local cancel_out
  cancel_out=$(execute_capture submit_order \
    "$OPERATOR" "$ETH" true "$ORDER_SIZE" "$BUY_LIMIT" "$BUY_SALT" "$EXPIRY" "$CANCEL_NONCE")
  CANCEL_ORDER_NONCE=$(parse_nonce "$cancel_out" 0)
  [[ -z "$CANCEL_ORDER_NONCE" ]] && die "Could not parse _nonce from CANCEL submit_order output"
  success "CANCEL _nonce: $CANCEL_ORDER_NONCE"

  local cancel_rec cancel_f
  cancel_rec=$(build_order_record \
    "$CANCEL_ORDER_NONCE" "$OPERATOR" "$ETH" true \
    "$ORDER_SIZE" "$BUY_LIMIT" "$BUY_SALT" "$EXPIRY" "$CANCEL_NONCE")
  cancel_f=$(record "$cancel_rec")

  cd "$DARKPOOL_DIR"
  leo execute cancel_order "$(cat "$cancel_f")" $NETWORK $CONSENSUS --yes \
    || die "cancel_order failed"
  sleep 3

  success "cancel_order complete"
  check_mapping order_consumed "$CANCEL_NONCE"
}

# =============================================================================
# SCENARIO 6 — Withdraw Fees
# =============================================================================
scenario_6() {
  section "SCENARIO 6 — withdraw_fees (operator only)"

  info "Fee vault before:"
  check_mapping fee_vault 0u8

  execute_capture withdraw_fees "$OPERATOR" "$FEE_WITHDRAW" > /dev/null
  success "Fees withdrawn to $OPERATOR"

  info "Fee vault after:"
  check_mapping fee_vault 0u8
}

# =============================================================================
# MAIN
# =============================================================================

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║      ZK Dark Pool v1 — Devnet Test Suite                    ║${NC}"
echo -e "${GREEN}║      Program: zkdarkpool_v1.aleo                            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
info "Endpoint:   $ENDPOINT"
info "Operator:   $OPERATOR"
info "Directory:  $DARKPOOL_DIR"
echo ""

[[ -d "$DARKPOOL_DIR" ]] || die "DARKPOOL_DIR not found: $DARKPOOL_DIR"

wait_for_devnet

SCENARIO="${TEST_SCENARIO:-all}"
case "$SCENARIO" in
  1)     scenario_1 ;;
  2)     scenario_2 ;;
  3)     scenario_2; scenario_3 ;;
  4)     scenario_2; scenario_4 ;;
  5)     scenario_5 ;;
  6)     scenario_6 ;;
  debug) scenario_1; scenario_2; scenario_debug ;;
  all)
    scenario_1
    scenario_2
    scenario_debug
    scenario_3
    scenario_4
    scenario_5
    scenario_6
    print_state
    ;;
  *) die "Unknown scenario: $SCENARIO — valid: 1 2 3 4 5 6 debug all" ;;
esac

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✓ Done                                                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
info "Manual mapping checks:"
echo "  curl -s $ENDPOINT/testnet/program/$PROGRAM/mapping/operator/0u8"
echo "  curl -s $ENDPOINT/testnet/program/$PROGRAM/mapping/fee_vault/0u8"
echo "  curl -s $ENDPOINT/testnet/program/$PROGRAM/mapping/order_consumed/$BUY_NONCE"
echo "  curl -s $ENDPOINT/testnet/program/$PROGRAM/mapping/batch_volume/$BATCH_ROOT"
echo ""
