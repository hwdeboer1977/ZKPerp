struct FieldPair {
    left: field,
    right: field,
}
program test_hashes_v1.aleo {
    fn get_leaf(addr: address) -> field {
        return BHP256::hash_to_field(addr);
    }
    fn get_node(left: field, right: field) -> field {
        return BHP256::hash_to_field(FieldPair { left, right });
    }
}
