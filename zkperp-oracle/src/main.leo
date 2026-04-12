// ZKPerp Oracle — on-chain 2-of-3 price quorum
//
// Three independent oracle nodes each hold their own Aleo private key.
// Each calls submit_price() independently. When 2-of-3 agree on the
// same price for an asset, oracle_prices is updated automatically.
// No coordinator, no single point of failure.
//
// Fix v3: After quorum is reached, the proposal is cleared so relayers
// can vote again in the next cycle even if the price hasn't changed.
//
// Roles:
//   roles[0u8] = oracle node A (Aleo address)
//   roles[1u8] = oracle node B (Aleo address)
//   roles[2u8] = oracle node C (Aleo address)
//   roles[3u8] = admin (can update roles)

program zkperp_oracle_v3.aleo {

    @custom
    constructor() {
        Mapping::set(roles, 0u8, self.program_owner);
        Mapping::set(roles, 1u8, self.program_owner);
        Mapping::set(roles, 2u8, self.program_owner);
        Mapping::set(roles, 3u8, self.program_owner);
    }

    // ══════════════════════════════════════════════════════════════
    // STRUCTS
    // ══════════════════════════════════════════════════════════════

    struct PriceData {
        price:     u64,
        timestamp: u32,
    }

    // Pending price proposal — accumulates votes until quorum
    struct PriceProposal {
        price:     u64,
        timestamp: u32,
        votes:     u8,
        voter_a:   address,  // first voter (or zero if no vote yet)
        voter_b:   address,  // second voter (or zero if no vote yet)
        voter_c:   address,  // third voter (or zero if no vote yet)
    }

    // ══════════════════════════════════════════════════════════════
    // MAPPINGS
    // ══════════════════════════════════════════════════════════════

    // Oracle node addresses: 0=A, 1=B, 2=C, 3=admin
    mapping roles: u8 => address;

    // Finalized prices — read by zkperp_core contracts
    mapping oracle_prices: field => PriceData;

    // Pending proposals awaiting quorum
    mapping price_proposals: field => PriceProposal;

    // ══════════════════════════════════════════════════════════════
    // SUBMIT PRICE — called independently by each oracle node
    // ══════════════════════════════════════════════════════════════

    fn submit_price(
        public asset_id:  field,
        public price:     u64,
        public timestamp: u32,
    ) -> Final {
        let caller: address = self.caller;
        return final {
            // ── 1. Verify caller is a registered oracle node
            let oracle_a: address = Mapping::get(roles, 0u8);
            let oracle_b: address = Mapping::get(roles, 1u8);
            let oracle_c: address = Mapping::get(roles, 2u8);
            let is_oracle: bool = caller == oracle_a
                                || caller == oracle_b
                                || caller == oracle_c;
            assert(is_oracle);

            // ── 2. Load existing proposal or create empty one
            let zero: address = aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc;
            let empty: PriceProposal = PriceProposal {
                price: price, timestamp: timestamp, votes: 0u8,
                voter_a: zero, voter_b: zero, voter_c: zero,
            };
            let proposal: PriceProposal = Mapping::get_or_use(
                price_proposals, asset_id, empty
            );

            // ── 3. Reset proposal if:
            //       a) price changed (new Chainlink round), OR
            //       b) previous round reached quorum (votes == 0u8 after clear)
            //       This allows relayers to vote again each cycle even at same price.
            let same_price: bool = proposal.votes == 0u8
                                || proposal.price == price;

            let current: PriceProposal = same_price ? proposal : PriceProposal {
                price: price, timestamp: timestamp, votes: 0u8,
                voter_a: zero, voter_b: zero, voter_c: zero,
            };

            // ── 4. Reject if this caller already voted in the CURRENT round
            let already_voted: bool = caller == current.voter_a
                                   || caller == current.voter_b
                                   || caller == current.voter_c;
            assert(!already_voted);

            // ── 5. Record vote in the next empty slot
            let new_votes: u8 = current.votes + 1u8;

            let v_a: address = current.votes == 0u8 ? caller : current.voter_a;
            let v_b: address = current.votes == 1u8 ? caller : current.voter_b;
            let v_c: address = current.votes == 2u8 ? caller : current.voter_c;

            // ── 6. Quorum check — 2-of-3 required
            let quorum: bool = new_votes >= 2u8;

            // ── 7. If quorum reached → write oracle price AND clear proposal
            //       so relayers can vote again next cycle even at same price.
            //       If not → store updated proposal with new vote recorded.
            let cleared: PriceProposal = PriceProposal {
                price: 0u64, timestamp: 0u32, votes: 0u8,
                voter_a: zero, voter_b: zero, voter_c: zero,
            };
            let updated: PriceProposal = PriceProposal {
                price: price, timestamp: timestamp,
                votes: new_votes,
                voter_a: v_a, voter_b: v_b, voter_c: v_c,
            };

            // Clear on quorum so next cycle starts fresh
            Mapping::set(price_proposals, asset_id, quorum ? cleared : updated);

            // Only update oracle_prices if quorum reached.
            let existing_price: PriceData = Mapping::get_or_use(
                oracle_prices, asset_id, PriceData { price: 0u64, timestamp: 0u32 }
            );
            let final_price: u64 = quorum ? price     : existing_price.price;
            let final_ts:   u32  = quorum ? timestamp : existing_price.timestamp;

            Mapping::set(oracle_prices, asset_id, PriceData {
                price: final_price, timestamp: final_ts,
            });
        };
    }

    // ══════════════════════════════════════════════════════════════
    // ADMIN — update oracle node addresses
    // ══════════════════════════════════════════════════════════════

    fn set_oracle(
        public slot: u8,       // 0=A, 1=B, 2=C
        public new_addr: address,
    ) -> Final {
        let caller: address = self.caller;
        return final {
            let admin: address = Mapping::get(roles, 3u8);
            assert_eq(caller, admin);
            assert(slot <= 2u8);
            Mapping::set(roles, slot, new_addr);
        };
    }

    fn set_admin(public new_admin: address) -> Final {
        let caller: address = self.caller;
        return final {
            let admin: address = Mapping::get(roles, 3u8);
            assert_eq(caller, admin);
            Mapping::set(roles, 3u8, new_admin);
        };
    }

}
