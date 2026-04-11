
// ============================================================
// zkdarkpool_v5.aleo — Leo 4.0
// Privacy-preserving batch auction dark pool
// ============================================================
//
// KEY CHANGE v4 → v5:
//   Operator-auth record pattern (from ZKPerp LiquidationAuth)
//
//   submit_order now issues three records:
//     1. OrderCommitment    → user wallet   (user's copy)
//     2. OperatorOrderRef   → operator      (nonce + direction metadata)
//     3. OrderAuth          → operator      (ALL fields needed to settle)
//
//   deposit_asset now issues four records:
//     1. AssetRecord[escrowed] → user wallet  (user's copy)
//     2. AssetRecord[change]   → user wallet  (remainder)
//     3. AssetEscrowReceipt    → user wallet  (receipt)
//     4. DepositAuth           → operator     (escrowed amount, no nonce)
//
//   settle_match signature changes:
//     BEFORE: (OrderCommitment, OrderCommitment, Token, Credentials, AssetRecord, ...)
//     AFTER:  (OrderAuth, OrderAuth, DepositAuth, Token, Credentials, ...)
//
//   This eliminates the need for any off-chain record transfer.
//   The operator gets everything on-chain at order/deposit time.
//   No JSON files, no ECIES, no API calls.
//
//   TRUST MODEL UNCHANGED:
//     - Operator CANNOT settle outside limit prices (ZK enforced)
//     - Operator CANNOT steal funds (escrow enforced)
//     - Operator CAN censor — mitigated by expiry + cancel_order
//
// ============================================================

const MIN_FILL_SIZE: u64 = 1_000_000u64;
const MAX_PRICE:     u64 = 1_000_000_000u64;
const FEE_BPS:       u64 = 10u64;
const BPS_DENOM:     u64 = 10_000u64;
const CLAIM_AMOUNT:  u64 = 10_000_000u64;

const ROLE_ADMIN:    u8 = 0u8;
const ROLE_OPERATOR: u8 = 1u8;


final fn consume_nonces(buy_nonce: field, sell_nonce: field) {
    let buy_consumed:  bool = Mapping::get_or_use(order_consumed, buy_nonce,  false);
    let sell_consumed: bool = Mapping::get_or_use(order_consumed, sell_nonce, false);
    assert(!buy_consumed);
    assert(!sell_consumed);
    Mapping::set(order_consumed, buy_nonce,  true);
    Mapping::set(order_consumed, sell_nonce, true);
}

final fn accrue_fee(fee: u64) {
    let current: u64 = Mapping::get_or_use(fee_vault, 0u8, 0u64);
    Mapping::set(fee_vault, 0u8, current + fee);
}


import test_usdcx_stablecoin.aleo;


program zkdarkpool_v8.aleo {


    // --------------------------------------------------------
    // Records — User-owned
    // --------------------------------------------------------

    record AssetRecord {
        owner:    address,
        asset_id: u8,
        amount:   u64,
    }

    // User's private copy of their order — consumed at settle_match
    // NOTE: settle_match v5 does NOT consume this. It consumes OrderAuth.
    // Users keep their OrderCommitment as proof-of-order.
    record OrderCommitment {
        owner:       address,
        asset_id:    u8,
        direction:   bool,   // true = buy, false = sell
        size:        u64,
        limit_price: u64,
        salt:        field,
        expiry:      u32,
        nonce:       field,
    }

    record FillReceipt {
        owner:          address,
        asset_id:       u8,
        direction:      bool,
        filled_size:    u64,
        clearing_price: u64,
        fee_paid:       u64,
        batch_root:     field,
    }

    record AssetEscrowReceipt {
        owner:       address,
        asset_id:    u8,
        amount:      u64,
        order_nonce: field,
    }


    // --------------------------------------------------------
    // Records — Operator-owned (LiquidationAuth pattern)
    // --------------------------------------------------------

    // Lightweight ref — direction + expiry for order book scanning
    record OperatorOrderRef {
        owner:       address,   // operator
        user:        address,
        order_nonce: field,
        asset_id:    u8,
        direction:   bool,
        expiry:      u32,
    }

    // Full order details — operator uses this in settle_match
    // Mirrors LiquidationAuth from ZKPerp: all fields needed to execute
    record OrderAuth {
        owner:       address,   // operator
        user:        address,   // trader who placed the order
        order_nonce: field,     // unique order ID — consumed on settlement
        asset_id:    u8,
        direction:   bool,      // true = buy, false = sell
        size:        u64,
        limit_price: u64,
        expiry:      u32,
    }

    // Operator's copy of escrowed asset — used in settle_match sell side
    record DepositAuth {
        owner:    address,   // operator
        user:     address,   // seller (asset owner)
        asset_id: u8,
        amount:   u64,       // escrowed amount
    }


    // --------------------------------------------------------
    // Mappings
    // --------------------------------------------------------

    mapping order_consumed: field => bool;
    mapping roles:          u8    => address;
    mapping fee_vault:      u8    => u64;
    mapping claimed_asset:  field => bool;


    // --------------------------------------------------------
    // Constructor
    // --------------------------------------------------------
    @custom
    constructor() {
        Mapping::set(roles, ROLE_ADMIN,    self.program_owner);
        Mapping::set(roles, ROLE_OPERATOR, self.program_owner);
    }


    // --------------------------------------------------------
    // set_operator
    // --------------------------------------------------------
    fn set_operator(new_operator: address) -> Final {
        let caller: address = self.caller;
        return final {
            let admin: address = Mapping::get(roles, ROLE_ADMIN);
            assert_eq(caller, admin);
            Mapping::set(roles, ROLE_OPERATOR, new_operator);
        };
    }


    // --------------------------------------------------------
    // deposit_asset
    // Issues DepositAuth to operator — no off-chain handoff needed
    // --------------------------------------------------------
    fn deposit_asset(
        input:            AssetRecord,
        amount:           u64,
        salt:             field,
        operator_address: address,
    ) -> (AssetRecord, AssetRecord, AssetEscrowReceipt, DepositAuth) {
        let caller: address = self.caller;
        assert(amount > 0u64);
        assert(input.amount >= amount);
        assert_eq(input.owner, caller);

        // Escrowed portion — user keeps this as their asset record
        let collateral: AssetRecord = AssetRecord {
            owner:    caller,
            asset_id: input.asset_id,
            amount,
        };

        // Change — remainder back to user
        let change: AssetRecord = AssetRecord {
            owner:    caller,
            asset_id: input.asset_id,
            amount:   input.amount - amount,
        };

        // User's receipt — salt used as nonce for cancel_and_refund_asset
        let receipt: AssetEscrowReceipt = AssetEscrowReceipt {
            owner:       caller,
            asset_id:    input.asset_id,
            amount,
            order_nonce: salt,
        };

        // Operator's auth — no order_nonce, matched by user+asset_id at settle time
        let deposit_auth: DepositAuth = DepositAuth {
            owner:    operator_address,
            user:     caller,
            asset_id: input.asset_id,
            amount,
        };

        return (collateral, change, receipt, deposit_auth);
    }


    // --------------------------------------------------------
    // submit_order
    // Issues OrderAuth to operator — all fields for settlement
    // --------------------------------------------------------
    fn submit_order(
        recipient:        address,
        operator_address: address,
        asset_id:         u8,
        direction:        bool,
        size:             u64,
        limit_price:      u64,
        salt:             field,
        expiry:           u32,
        nonce:            field,
    ) -> (OrderCommitment, OperatorOrderRef, OrderAuth) {
        assert(size >= MIN_FILL_SIZE);
        assert(limit_price > 0u64);
        assert(limit_price <= MAX_PRICE);

        // User's private copy — kept as proof of order
        let order: OrderCommitment = OrderCommitment {
            owner: recipient,
            asset_id,
            direction,
            size,
            limit_price,
            salt,
            expiry,
            nonce,
        };

        // Lightweight scan ref for order book
        let op_ref: OperatorOrderRef = OperatorOrderRef {
            owner:       operator_address,
            user:        recipient,
            order_nonce: nonce,
            asset_id,
            direction,
            expiry,
        };

        // Full auth — operator uses this in settle_match
        // Contains all fields needed: size, limit_price, expiry, nonce
        let order_auth: OrderAuth = OrderAuth {
            owner:       operator_address,
            user:        recipient,
            order_nonce: nonce,
            asset_id,
            direction,
            size,
            limit_price,
            expiry,
        };

        return (order, op_ref, order_auth);
    }


    // --------------------------------------------------------
    // cancel_order
    // User cancels their order using their OrderCommitment
    // --------------------------------------------------------
    fn cancel_order(order: OrderCommitment) -> Final {
        assert_eq(order.owner, self.caller);
        let nonce: field = order.nonce;
        return final {
            let consumed: bool = Mapping::get_or_use(order_consumed, nonce, false);
            assert(!consumed);
            Mapping::set(order_consumed, nonce, true);
        };
    }


    // --------------------------------------------------------
    // cancel_and_refund_asset
    // User cancels sell order and reclaims escrowed asset
    // --------------------------------------------------------
    fn cancel_and_refund_asset(
        asset:   AssetRecord,
        receipt: AssetEscrowReceipt,
    ) -> (AssetRecord, Final) {
        assert_eq(receipt.owner,    self.caller);
        assert_eq(asset.amount,     receipt.amount);
        assert_eq(asset.asset_id,   receipt.asset_id);

        let refund: AssetRecord = AssetRecord {
            owner:    self.caller,
            asset_id: asset.asset_id,
            amount:   asset.amount,
        };

        let nonce: field = receipt.order_nonce;
        return (refund, final {
            let consumed: bool = Mapping::get_or_use(order_consumed, nonce, false);
            assert(!consumed);
            Mapping::set(order_consumed, nonce, true);
        });
    }


    // --------------------------------------------------------
    // cancel_and_refund_token
    // Buyer cancels their buy order — no escrowed asset to refund
    // (USDCx is only transferred at settle time, never escrowed)
    // Just marks the order nonce as consumed so it cannot be settled
    // --------------------------------------------------------
    fn cancel_buy_order(order: OrderCommitment) -> Final {
        assert_eq(order.owner, self.caller);
        assert(order.direction == true);  // must be a buy order
        let nonce: field = order.nonce;
        return final {
            let consumed: bool = Mapping::get_or_use(order_consumed, nonce, false);
            assert(!consumed);
            Mapping::set(order_consumed, nonce, true);
        };
    }


    // --------------------------------------------------------
    // settle_match  ← KEY CHANGE
    // Operator passes OrderAuth + DepositAuth instead of
    // user's OrderCommitment + AssetRecord
    // --------------------------------------------------------
    fn settle_match(
        buy_auth:       OrderAuth,         // operator's buy order auth
        sell_auth:      OrderAuth,         // operator's sell order auth
        deposit_auth:   DepositAuth,       // operator's deposit auth (sell side asset)
        buyer_token:    test_usdcx_stablecoin.aleo::Token,
        buyer_creds:    test_usdcx_stablecoin.aleo::Credentials,
        clearing_price: u64,
        fill_size:      u64,
        batch_root:     field,
    ) -> (
        FillReceipt,
        FillReceipt,
        test_usdcx_stablecoin.aleo::ComplianceRecord,
        test_usdcx_stablecoin.aleo::Token,
        test_usdcx_stablecoin.aleo::Token,
        test_usdcx_stablecoin.aleo::Credentials,
        AssetRecord,   // buyer receives asset
        AssetRecord,   // seller receives remainder
        Final
    ) {
        // Auth ownership — operator must own both auths
        assert_eq(buy_auth.owner,     self.caller);
        assert_eq(sell_auth.owner,    self.caller);
        assert_eq(deposit_auth.owner, self.caller);

        // Order pairing checks
        assert_eq(buy_auth.asset_id,  sell_auth.asset_id);
        assert_eq(buy_auth.asset_id,  deposit_auth.asset_id);
        assert(buy_auth.direction  == true);
        assert(sell_auth.direction == false);

        // Deposit auth must match sell order nonce
        assert_eq(deposit_auth.user,     sell_auth.user);

        // Price constraints — operator cannot violate limit prices
        assert(clearing_price <= buy_auth.limit_price);
        assert(clearing_price >= sell_auth.limit_price);
        assert(clearing_price > 0u64);
        assert(clearing_price <= MAX_PRICE);

        // Fill size constraints
        assert(fill_size >= MIN_FILL_SIZE);
        assert(fill_size <= buy_auth.size);
        assert(fill_size <= sell_auth.size);
        assert(fill_size <= deposit_auth.amount);

        // Token ownership — buyer's token must belong to buyer
        assert_eq(buyer_token.owner, buy_auth.user);

        // Cost and fee calculation
        // Scale: fill_size and clearing_price both have 6 decimals
        // gross_cost in USDCx micro-units = fill_size * clearing_price / 1_000_000
        let gross_cost: u64 = (fill_size * clearing_price) / 1_000_000u64;
        let fee:        u64 = (gross_cost * FEE_BPS) / BPS_DENOM;

        assert(buyer_token.amount >= gross_cost as u128);

        // USDCx transfer: buyer pays seller (private, with compliance)
        let (
            compliance_out,
            seller_token_out,
            buyer_change_out,
            creds_out,
            transfer_future
        ): (
            test_usdcx_stablecoin.aleo::ComplianceRecord,
            test_usdcx_stablecoin.aleo::Token,
            test_usdcx_stablecoin.aleo::Token,
            test_usdcx_stablecoin.aleo::Credentials,
            Final
        ) = test_usdcx_stablecoin.aleo::transfer_private_with_creds(
            sell_auth.user,
            gross_cost as u128,
            buyer_token,
            buyer_creds,
        );

        // Asset transfer: seller's escrowed asset goes to buyer
        let buyer_asset: AssetRecord = AssetRecord {
            owner:    buy_auth.user,
            asset_id: buy_auth.asset_id,
            amount:   fill_size,
        };

        // Remainder of escrowed asset back to seller
        let seller_asset_remainder: AssetRecord = AssetRecord {
            owner:    sell_auth.user,
            asset_id: sell_auth.asset_id,
            amount:   deposit_auth.amount - fill_size,
        };

        // Fill receipts — proof of execution for both parties
        let buy_receipt: FillReceipt = FillReceipt {
            owner:          buy_auth.user,
            asset_id:       buy_auth.asset_id,
            direction:      true,
            filled_size:    fill_size,
            clearing_price,
            fee_paid:       fee,
            batch_root,
        };

        let sell_receipt: FillReceipt = FillReceipt {
            owner:          sell_auth.user,
            asset_id:       sell_auth.asset_id,
            direction:      false,
            filled_size:    fill_size,
            clearing_price,
            fee_paid:       0u64,
            batch_root,
        };

        let buy_nonce:   field = buy_auth.order_nonce;
        let sell_nonce:  field = sell_auth.order_nonce;
        let buy_expiry:  u32   = buy_auth.expiry;
        let sell_expiry: u32   = sell_auth.expiry;

        return (
            buy_receipt,
            sell_receipt,
            compliance_out,
            seller_token_out,
            buyer_change_out,
            creds_out,
            buyer_asset,
            seller_asset_remainder,
            final {
                transfer_future.run();
                assert(block.height <= buy_expiry);
                assert(block.height <= sell_expiry);
                consume_nonces(buy_nonce, sell_nonce);
                accrue_fee(fee);
            }
        );
    }


    // --------------------------------------------------------
    // partial_fill
    // Operator passes OrderAuth records — same pattern as settle_match
    // --------------------------------------------------------
    fn partial_fill(
        buy_auth:       OrderAuth,
        sell_auth:      OrderAuth,
        deposit_auth:   DepositAuth,
        buyer_token:    test_usdcx_stablecoin.aleo::Token,
        buyer_creds:    test_usdcx_stablecoin.aleo::Credentials,
        clearing_price: u64,
        fill_size:      u64,
        batch_root:     field,
        new_buy_nonce:  field,
        new_sell_nonce: field,
        new_buy_salt:   field,
        new_sell_salt:  field,
        operator_address: address,
    ) -> (
        FillReceipt,
        FillReceipt,
        test_usdcx_stablecoin.aleo::ComplianceRecord,
        test_usdcx_stablecoin.aleo::Token,
        test_usdcx_stablecoin.aleo::Token,
        test_usdcx_stablecoin.aleo::Credentials,
        AssetRecord,        // buyer receives asset
        AssetRecord,        // seller remainder
        OrderCommitment,    // residual buy (user copy)
        OrderCommitment,    // residual sell (user copy)
        OrderAuth,          // residual buy auth (operator)
        OrderAuth,          // residual sell auth (operator)
        DepositAuth,        // residual deposit auth (operator)
        Final
    ) {
        assert_eq(buy_auth.owner,     self.caller);
        assert_eq(sell_auth.owner,    self.caller);
        assert_eq(deposit_auth.owner, self.caller);
        assert_eq(buy_auth.asset_id,  sell_auth.asset_id);
        assert_eq(buy_auth.asset_id,  deposit_auth.asset_id);
        assert(buy_auth.direction  == true);
        assert(sell_auth.direction == false);
        assert_eq(deposit_auth.user,     sell_auth.user);
        assert(clearing_price <= buy_auth.limit_price);
        assert(clearing_price >= sell_auth.limit_price);
        assert(clearing_price > 0u64);
        assert(clearing_price <= MAX_PRICE);
        assert(fill_size >= MIN_FILL_SIZE);
        assert(fill_size < buy_auth.size);
        assert(fill_size < sell_auth.size);
        assert(fill_size <= deposit_auth.amount);
        assert_eq(buyer_token.owner, buy_auth.user);

        // Scale: fill_size and clearing_price both have 6 decimals
        let gross_cost: u64 = (fill_size * clearing_price) / 1_000_000u64;
        let fee:        u64 = (gross_cost * FEE_BPS) / BPS_DENOM;

        assert(buyer_token.amount >= gross_cost as u128);

        let (
            compliance_out,
            seller_token_out,
            buyer_change_out,
            creds_out,
            transfer_future
        ): (
            test_usdcx_stablecoin.aleo::ComplianceRecord,
            test_usdcx_stablecoin.aleo::Token,
            test_usdcx_stablecoin.aleo::Token,
            test_usdcx_stablecoin.aleo::Credentials,
            Final
        ) = test_usdcx_stablecoin.aleo::transfer_private_with_creds(
            sell_auth.user,
            gross_cost as u128,
            buyer_token,
            buyer_creds,
        );

        // Residual user copies (OrderCommitment goes back to user)
        let residual_buy_commitment: OrderCommitment = OrderCommitment {
            owner:       buy_auth.user,
            asset_id:    buy_auth.asset_id,
            direction:   true,
            size:        buy_auth.size - fill_size,
            limit_price: buy_auth.limit_price,
            salt:        new_buy_salt,
            expiry:      buy_auth.expiry,
            nonce:       new_buy_nonce,
        };

        let residual_sell_commitment: OrderCommitment = OrderCommitment {
            owner:       sell_auth.user,
            asset_id:    sell_auth.asset_id,
            direction:   false,
            size:        sell_auth.size - fill_size,
            limit_price: sell_auth.limit_price,
            salt:        new_sell_salt,
            expiry:      sell_auth.expiry,
            nonce:       new_sell_nonce,
        };

        // Residual operator auths — bot auto-tracks without off-chain handoff
        let residual_buy_auth: OrderAuth = OrderAuth {
            owner:       operator_address,
            user:        buy_auth.user,
            order_nonce: new_buy_nonce,
            asset_id:    buy_auth.asset_id,
            direction:   true,
            size:        buy_auth.size - fill_size,
            limit_price: buy_auth.limit_price,
            expiry:      buy_auth.expiry,
        };

        let residual_sell_auth: OrderAuth = OrderAuth {
            owner:       operator_address,
            user:        sell_auth.user,
            order_nonce: new_sell_nonce,
            asset_id:    sell_auth.asset_id,
            direction:   false,
            size:        sell_auth.size - fill_size,
            limit_price: sell_auth.limit_price,
            expiry:      sell_auth.expiry,
        };

        // Residual deposit auth — remaining escrowed amount
        let residual_deposit_auth: DepositAuth = DepositAuth {
            owner:    operator_address,
            user:     sell_auth.user,
            asset_id: deposit_auth.asset_id,
            amount:   deposit_auth.amount - fill_size,
        };

        let buyer_asset: AssetRecord = AssetRecord {
            owner:    buy_auth.user,
            asset_id: buy_auth.asset_id,
            amount:   fill_size,
        };

        let seller_asset_remainder: AssetRecord = AssetRecord {
            owner:    sell_auth.user,
            asset_id: sell_auth.asset_id,
            amount:   0u64,   // fully consumed in partial fill
        };

        let buy_receipt: FillReceipt = FillReceipt {
            owner:          buy_auth.user,
            asset_id:       buy_auth.asset_id,
            direction:      true,
            filled_size:    fill_size,
            clearing_price,
            fee_paid:       fee,
            batch_root,
        };

        let sell_receipt: FillReceipt = FillReceipt {
            owner:          sell_auth.user,
            asset_id:       sell_auth.asset_id,
            direction:      false,
            filled_size:    fill_size,
            clearing_price,
            fee_paid:       0u64,
            batch_root,
        };

        let buy_nonce:   field = buy_auth.order_nonce;
        let sell_nonce:  field = sell_auth.order_nonce;
        let buy_expiry:  u32   = buy_auth.expiry;
        let sell_expiry: u32   = sell_auth.expiry;

        return (
            buy_receipt,
            sell_receipt,
            compliance_out,
            seller_token_out,
            buyer_change_out,
            creds_out,
            buyer_asset,
            seller_asset_remainder,
            residual_buy_commitment,
            residual_sell_commitment,
            residual_buy_auth,
            residual_sell_auth,
            residual_deposit_auth,
            final {
                transfer_future.run();
                assert(block.height <= buy_expiry);
                assert(block.height <= sell_expiry);
                consume_nonces(buy_nonce, sell_nonce);
                accrue_fee(fee);
            }
        );
    }


    // --------------------------------------------------------
    // withdraw_fees (operator only)
    // --------------------------------------------------------
    fn withdraw_fees(amount: u64) -> Final {
        let caller: address = self.caller;
        return final {
            let op: address = Mapping::get(roles, ROLE_OPERATOR);
            assert_eq(caller, op);
            let available: u64 = Mapping::get_or_use(fee_vault, 0u8, 0u64);
            assert(available >= amount);
            Mapping::set(fee_vault, 0u8, available - amount);
        };
    }


    // --------------------------------------------------------
    // claim_test_asset — testnet faucet, one per address per asset
    // --------------------------------------------------------
    fn claim_test_asset(asset_id: u8) -> (AssetRecord, Final) {
        let caller: address = self.caller;

        let asset: AssetRecord = AssetRecord {
            owner:    caller,
            asset_id,
            amount:   CLAIM_AMOUNT,
        };

        let caller_field: field = BHP256::hash_to_field(caller);
        let asset_field:  field = asset_id as field;

        return (asset, final {
            let claim_key: field = BHP256::hash_to_field(caller_field + asset_field);
            let already:   bool  = Mapping::get_or_use(claimed_asset, claim_key, false);
            assert(!already);
            Mapping::set(claimed_asset, claim_key, true);
        });
    }


    // --------------------------------------------------------
    // mint_test_asset — admin only
    // --------------------------------------------------------
    fn mint_test_asset(
        recipient:    address,
        asset_id:     u8,
        asset_amount: u64,
    ) -> (AssetRecord, Final) {
        let caller: address = self.caller;

        let asset: AssetRecord = AssetRecord {
            owner:    recipient,
            asset_id,
            amount:   asset_amount,
        };

        return (asset, final {
            let admin: address = Mapping::get(roles, ROLE_ADMIN);
            assert_eq(caller, admin);
        });
    }

}
