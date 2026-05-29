// zkperp_compliance_v2.aleo — Leo 4.0
// Private KYC compliance for ZKPerp.
//
// ZKPerpComplianceRecord is issued once per user after KYC.
// expires_at is passed as public input — finalize validates it is reasonable.
// zkperp_core reads issued_under and expires_at directly from the record.

struct FieldPair {
    left:  field,
    right: field,
}

struct MerkleNode {
    sibling: field,
    is_left: bool,
}

struct MerkleProof {
    path: [MerkleNode; 10],
}

program zkperp_compliance_v8b.aleo {

    record ZKPerpComplianceRecord {
        owner:        address,
        issued_under: field,
        expires_at:   u32,
    }

    mapping compliance_root: u8 => field;
    mapping revoked: address => bool;
    mapping admin: u8 => address;
    mapping issued_nullifiers: field => bool;

    @custom
    constructor() {
        Mapping::set(admin, 0u8, self.program_owner);
    }

    fn update_root(public new_root: field) -> Final {
        let caller: address = self.caller;
        return final {
            let current_admin: address = Mapping::get(admin, 0u8);
            assert_eq(caller, current_admin);
            Mapping::set(compliance_root, 0u8, new_root);
        };
    }

    fn revoke_user(public user: address) -> Final {
        let caller: address = self.caller;
        return final {
            let current_admin: address = Mapping::get(admin, 0u8);
            assert_eq(caller, current_admin);
            Mapping::set(revoked, user, true);
        };
    }

    fn unrevoke_user(public user: address) -> Final {
        let caller: address = self.caller;
        return final {
            let current_admin: address = Mapping::get(admin, 0u8);
            assert_eq(caller, current_admin);
            Mapping::set(revoked, user, false);
        };
    }

    // issue_compliance:
    // expires_at passed as public input from backend (current_block + window).
    // Finalize validates it is within allowed range (max 90 days).
    fn issue_compliance(
        proof: MerkleProof,
        public expires_at: u32,
    ) -> (ZKPerpComplianceRecord, Final) {

        let leaf: field = BHP256::hash_to_field(self.caller);
        let current: field = leaf;

        let n0: MerkleNode = proof.path[0u32];
        current = n0.is_left
            ? BHP256::hash_to_field(FieldPair { left: n0.sibling, right: current })
            : BHP256::hash_to_field(FieldPair { left: current, right: n0.sibling });
        let n1: MerkleNode = proof.path[1u32];
        current = n1.is_left
            ? BHP256::hash_to_field(FieldPair { left: n1.sibling, right: current })
            : BHP256::hash_to_field(FieldPair { left: current, right: n1.sibling });
        let n2: MerkleNode = proof.path[2u32];
        current = n2.is_left
            ? BHP256::hash_to_field(FieldPair { left: n2.sibling, right: current })
            : BHP256::hash_to_field(FieldPair { left: current, right: n2.sibling });
        let n3: MerkleNode = proof.path[3u32];
        current = n3.is_left
            ? BHP256::hash_to_field(FieldPair { left: n3.sibling, right: current })
            : BHP256::hash_to_field(FieldPair { left: current, right: n3.sibling });
        let n4: MerkleNode = proof.path[4u32];
        current = n4.is_left
            ? BHP256::hash_to_field(FieldPair { left: n4.sibling, right: current })
            : BHP256::hash_to_field(FieldPair { left: current, right: n4.sibling });
        let n5: MerkleNode = proof.path[5u32];
        current = n5.is_left
            ? BHP256::hash_to_field(FieldPair { left: n5.sibling, right: current })
            : BHP256::hash_to_field(FieldPair { left: current, right: n5.sibling });
        let n6: MerkleNode = proof.path[6u32];
        current = n6.is_left
            ? BHP256::hash_to_field(FieldPair { left: n6.sibling, right: current })
            : BHP256::hash_to_field(FieldPair { left: current, right: n6.sibling });
        let n7: MerkleNode = proof.path[7u32];
        current = n7.is_left
            ? BHP256::hash_to_field(FieldPair { left: n7.sibling, right: current })
            : BHP256::hash_to_field(FieldPair { left: current, right: n7.sibling });
        let n8: MerkleNode = proof.path[8u32];
        current = n8.is_left
            ? BHP256::hash_to_field(FieldPair { left: n8.sibling, right: current })
            : BHP256::hash_to_field(FieldPair { left: current, right: n8.sibling });
        let n9: MerkleNode = proof.path[9u32];
        current = n9.is_left
            ? BHP256::hash_to_field(FieldPair { left: n9.sibling, right: current })
            : BHP256::hash_to_field(FieldPair { left: current, right: n9.sibling });

        let computed_root: field = current;
        let nullifier: field = Poseidon2::hash_to_field(FieldPair { left: leaf, right: computed_root });
        let caller: address = self.caller;

        let cr: ZKPerpComplianceRecord = ZKPerpComplianceRecord {
            owner:        self.caller,
            issued_under: computed_root,
            expires_at:   expires_at,
        };

        return (cr, final {
            // Root must match
            let active_root: field = Mapping::get(compliance_root, 0u8);
            assert_eq(computed_root, active_root);

            // Not revoked
            let is_revoked: bool = Mapping::get_or_use(revoked, caller, false);
            assert(!is_revoked);

            // Not already issued under this root
            let already_issued: bool = Mapping::get_or_use(issued_nullifiers, nullifier, false);
            assert(!already_issued);

            // Expiry must be in the future and within 90 days (~7,776,000 blocks)
            assert(expires_at > block.height);
            assert(expires_at <= block.height + 7776000u32);

            Mapping::set(issued_nullifiers, nullifier, true);
        });
    }

    fn verify_compliance(cr: ZKPerpComplianceRecord) -> (ZKPerpComplianceRecord, Final) {
        let caller: address = self.caller;
        let issued_under: field = cr.issued_under;
        let expires_at: u32 = cr.expires_at;
        return (cr, final {
            let active_root: field = Mapping::get(compliance_root, 0u8);
            assert_eq(issued_under, active_root);
            let is_revoked: bool = Mapping::get_or_use(revoked, caller, false);
            assert(!is_revoked);
            assert(block.height <= expires_at);
        });
    }
}
