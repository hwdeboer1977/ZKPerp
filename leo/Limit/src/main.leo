// ZKPerp Limit Orders v26 — limit order placement and execution
//
// Separate program from core to keep the 32-call-per-transaction limit manageable.
// Traders place limit orders here; the orchestrator bot executes them when price
// crosses the trigger. Price reads come from zkperp_oracle_v2.aleo.
//
// Flow:
//   1. Trader calls place_limit_order — records intent, reserves PositionSlot
//   2. Bot monitors oracle price; when triggered, calls execute_limit_order
//   3. execute_limit_order opens the position in the target core program
//      (zkperp_core_v26 / zkperp_eth_v26 / zkperp_sol_v26)
//   4. Trader can cancel_limit_order before execution
//
// Compliance required on place and cancel. Execution is orchestrator-only.

import test_usdcx_stablecoin.aleo;
import zkperp_compliance_v7.aleo;
import zkperp_oracle_v2.aleo;

struct LimitOrderIdInput {
    trader: address,
    nonce: field,
    trigger_price: u64,
    asset_id: field,
}

program zkperp_limit_v26.aleo {

    @custom
    constructor() {
        Mapping::set(roles, 0u8, self.program_owner); // admin
        Mapping::set(roles, 1u8, self.program_owner); // orchestrator
    }

    const MAX_PRICE_AGE_BLOCKS: u32 = 150u32; // ≈ 5 min staleness limit
    const OPENING_FEE_BPS: u64      = 1_000u64;

    mapping roles: u8 => address;
    // order_id => true (active), removed on execution or cancellation
    mapping pending_limit_orders: field => bool;
    // order_id => trader address (for cancel auth)
    mapping limit_order_traders: field => address;
    // nonce dedup
    mapping used_nonces: field => bool;

    // Issued to the orchestrator on place_limit_order.
    // Bot executes this when oracle price crosses trigger_price.
    record ExecLimitAuth {
        owner: address,       // orchestrator
        order_id: field,
        trader: address,
        slot_id: u8,
        asset_id: field,      // 1field=BTC, 2field=ETH, 3field=SOL
        is_long: bool,
        trigger_price: u64,   // execute when price <= trigger (long) or >= trigger (short)
        size_usdc: u64,
        collateral_usdc: u64, // after opening fee
        nonce: field,
    }

    // Issued to the trader as proof of their pending limit order.
    record LimitOrderReceipt {
        owner: address,
        order_id: field,
        asset_id: field,
        is_long: bool,
        trigger_price: u64,
        size_usdc: u64,
        collateral_usdc: u64,
        nonce: field,
    }

    // ══════════════════════════════════════════════════════════════
    // PLACE LIMIT ORDER
    // ══════════════════════════════════════════════════════════════

    fn place_limit_order(
        cr: zkperp_compliance_v7.aleo::ZKPerpComplianceRecord,
        token: test_usdcx_stablecoin.aleo::Token,
        public asset_id: field,
        private is_long: bool,
        private trigger_price: u64,
        private size_usdc: u64,
        collateral: u128,
        merkle_proof: [test_usdcx_stablecoin.aleo::MerkleProof; 2],
        private orchestrator: address,
        nonce: field,
    ) -> (zkperp_compliance_v7.aleo::ZKPerpComplianceRecord, LimitOrderReceipt, ExecLimitAuth, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert(size_usdc >= 100u64);
        let collateral_u64: u64 = collateral as u64;
        let leverage_scaled: u64 = (size_usdc * 100u64) / collateral_u64;
        assert(leverage_scaled <= 2000u64);

        let opening_fee: u64 = (size_usdc * OPENING_FEE_BPS) / 1_000_000u64;
        let collateral_after_fee: u64 = collateral_u64 - opening_fee;

        let cr_issued_under: field = cr.issued_under;
        let cr_expires_at: u32 = cr.expires_at;
        let caller: address = self.signer;

        // Lock collateral into the program vault
        let (usdcx_compliance, change_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_private_to_public(
                self.address, collateral, token, merkle_proof,
            );

        let id_input: LimitOrderIdInput = LimitOrderIdInput {
            trader: self.signer, nonce: nonce,
            trigger_price: trigger_price, asset_id: asset_id,
        };
        let order_id: field = BHP256::hash_to_field(id_input);

        let slot_id: u8 = is_long ? 0u8 : 1u8;

        let auth: ExecLimitAuth = ExecLimitAuth {
            owner:            orchestrator,
            order_id:         order_id,
            trader:           self.signer,
            slot_id:          slot_id,
            asset_id:         asset_id,
            is_long:          is_long,
            trigger_price:    trigger_price,
            size_usdc:        size_usdc,
            collateral_usdc:  collateral_after_fee,
            nonce:            nonce,
        };

        let receipt: LimitOrderReceipt = LimitOrderReceipt {
            owner:           self.signer,
            order_id:        order_id,
            asset_id:        asset_id,
            is_long:         is_long,
            trigger_price:   trigger_price,
            size_usdc:       size_usdc,
            collateral_usdc: collateral_after_fee,
            nonce:           nonce,
        };

        return (cr, receipt, auth, usdcx_compliance, change_token, final {
            // ── Compliance check ──
            let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
            assert_eq(cr_issued_under, active_root);
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            transfer_final.run();
            let nonce_used: bool = Mapping::get_or_use(used_nonces, nonce, false);
            assert(!nonce_used);
            Mapping::set(used_nonces, nonce, true);
            let expected_orch: address = Mapping::get(roles, 1u8);
            assert_eq(orchestrator, expected_orch);
            // ── Oracle staleness check ──
            let price_data: zkperp_oracle_v2.aleo::PriceData =
                Mapping::get(zkperp_oracle_v2.aleo::oracle_prices, asset_id);
            assert(block.height - price_data.timestamp <= MAX_PRICE_AGE_BLOCKS);
            // ── End oracle check ──
            Mapping::set(pending_limit_orders, order_id, true);
            Mapping::set(limit_order_traders, order_id, caller);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // EXECUTE LIMIT ORDER
    // Called by orchestrator when oracle price crosses trigger.
    // Refunds collateral to trader (position opened in core program
    // by the orchestrator using the ExecLimitAuth + PositionSlot).
    // ══════════════════════════════════════════════════════════════

    fn execute_limit_order(
        auth: ExecLimitAuth,
        private execution_nonce: field,
    ) -> (test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert_eq(self.caller, auth.owner);

        let order_id: field = auth.order_id;

        // Transfer collateral to trader so they can use it in open_position
        let (usdcx_compliance, collateral_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(
                auth.trader, auth.collateral_usdc as u128
            );

        return (usdcx_compliance, collateral_token, final {
            transfer_final.run();
            // ── Oracle price trigger check ──
            let price_data: zkperp_oracle_v2.aleo::PriceData =
                Mapping::get(zkperp_oracle_v2.aleo::oracle_prices, auth.asset_id);
            assert(block.height - price_data.timestamp <= MAX_PRICE_AGE_BLOCKS);
            // Long limit: execute when price <= trigger (buying the dip)
            // Short limit: execute when price >= trigger (selling the top)
            let triggered: bool = auth.is_long
                ? price_data.price <= auth.trigger_price
                : price_data.price >= auth.trigger_price;
            assert(triggered);
            // ── End oracle check ──
            let is_active: bool = Mapping::get(pending_limit_orders, order_id);
            assert(is_active);
            let exec_nonce_used: bool = Mapping::get_or_use(used_nonces, execution_nonce, false);
            assert(!exec_nonce_used);
            Mapping::set(used_nonces, execution_nonce, true);
            Mapping::remove(pending_limit_orders, order_id);
            Mapping::remove(limit_order_traders, order_id);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // CANCEL LIMIT ORDER
    // Trader cancels before execution — collateral returned.
    // ══════════════════════════════════════════════════════════════

    fn cancel_limit_order(
        cr: zkperp_compliance_v7.aleo::ZKPerpComplianceRecord,
        receipt: LimitOrderReceipt,
    ) -> (zkperp_compliance_v7.aleo::ZKPerpComplianceRecord, test_usdcx_stablecoin.aleo::ComplianceRecord, test_usdcx_stablecoin.aleo::Token, Final) {
        assert_eq(self.signer, receipt.owner);

        let cr_issued_under: field = cr.issued_under;
        let cr_expires_at: u32 = cr.expires_at;
        let caller: address = self.signer;
        let order_id: field = receipt.order_id;

        let (usdcx_compliance, refund_token, transfer_final):
            (test_usdcx_stablecoin.aleo::ComplianceRecord,
             test_usdcx_stablecoin.aleo::Token, Final) =
            test_usdcx_stablecoin.aleo::transfer_public_to_private(
                self.signer, receipt.collateral_usdc as u128
            );

        return (cr, usdcx_compliance, refund_token, final {
            // ── Compliance check ──
            let active_root: field = Mapping::get(zkperp_compliance_v7.aleo::compliance_root, 0u8);
            assert_eq(cr_issued_under, active_root);
            let is_revoked: bool = Mapping::get_or_use(zkperp_compliance_v7.aleo::revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= cr_expires_at);
            // ── End compliance ──
            transfer_final.run();
            let stored_trader: address = Mapping::get(limit_order_traders, order_id);
            assert_eq(caller, stored_trader);
            let is_active: bool = Mapping::get(pending_limit_orders, order_id);
            assert(is_active);
            Mapping::remove(pending_limit_orders, order_id);
            Mapping::remove(limit_order_traders, order_id);
        });
    }

    // ══════════════════════════════════════════════════════════════
    // BURN STALE RECEIPT — if order executed but receipt not consumed
    // ══════════════════════════════════════════════════════════════

    fn burn_limit_receipt(receipt: LimitOrderReceipt) -> Final {
        assert_eq(receipt.owner, self.signer);
        let order_id: field = receipt.order_id;
        return final {
            let still_pending: bool = Mapping::contains(pending_limit_orders, order_id);
            assert(!still_pending);
        };
    }

}
