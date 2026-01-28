// Mock USDC Token with Allowance System
// Supports approve/transferFrom for vault integration
// UPDATED: Admin stored in mapping (configurable after deploy)

// DEPLOYMENT STEPS:
// 1. leo build
// 2. leo deploy --network testnet --broadcast
// 3. Initialize admin (first caller becomes admin):
//    leo execute initialize_admin --network testnet --broadcast
// 4. Mint tokens:
//    leo execute mint_public <recipient> <amount>u128 --network testnet --broadcast

program mock_usdc_0128.aleo {

    // The constructor is configured to prevent upgrades.
    @noupgrade
    async constructor() {}

    // ──────────────────────────────────────────────
    //  Constants
    // ──────────────────────────────────────────────

    const DECIMALS: u8 = 6u8;

    // ──────────────────────────────────────────────
    //  State (Mappings)
    // ──────────────────────────────────────────────

    // Admin address - stored in mapping so it can be set after deploy
    // Key 0u8 = admin address
    mapping admin: u8 => address;

    // Public balances: address => balance
    mapping balances: address => u128;

    // Total supply
    mapping total_supply: u8 => u128;

    // Allowances: hash(owner, spender) => amount
    // This allows spender to transfer up to `amount` from owner
    mapping allowances: field => u128;

    // ──────────────────────────────────────────────
    //  Records (for private transfers)
    // ──────────────────────────────────────────────

    record Token {
        owner: address,
        amount: u128,
    }

    // ──────────────────────────────────────────────
    //  Helper: compute allowance key
    // ──────────────────────────────────────────────

    inline get_allowance_key(owner: address, spender: address) -> field {
        return BHP256::hash_to_field(owner) + BHP256::hash_to_field(spender);
    }

    // ──────────────────────────────────────────────
    //  Admin Functions
    // ──────────────────────────────────────────────

    /// Initialize admin - can only be called once (when no admin is set)
    /// First caller becomes the admin
    async transition initialize_admin() -> Future {
        return finalize_initialize_admin(self.caller);
    }

    async function finalize_initialize_admin(caller: address) {
        // Check if admin already exists by trying to get it
        // If it doesn't exist, set the caller as admin
        let admin_exists: bool = Mapping::contains(admin, 0u8);
        assert(!admin_exists); // Can only initialize once
        Mapping::set(admin, 0u8, caller);
    }

    /// Transfer admin role to a new address
    /// Only current admin can call this
    async transition transfer_admin(new_admin: address) -> Future {
        return finalize_transfer_admin(self.caller, new_admin);
    }

    async function finalize_transfer_admin(caller: address, new_admin: address) {
        let current_admin: address = Mapping::get(admin, 0u8);
        assert_eq(caller, current_admin);
        Mapping::set(admin, 0u8, new_admin);
    }

    // ──────────────────────────────────────────────
    //  Mint Functions
    // ──────────────────────────────────────────────

    async transition mint_public(
        public recipient: address,
        public amount: u128,
    ) -> Future {
        return finalize_mint_public(self.caller, recipient, amount);
    }

    async function finalize_mint_public(
        caller: address,
        recipient: address,
        amount: u128,
    ) {
        // Check caller is admin
        let current_admin: address = Mapping::get(admin, 0u8);
        assert_eq(caller, current_admin);

        let current: u128 = Mapping::get_or_use(balances, recipient, 0u128);
        Mapping::set(balances, recipient, current + amount);

        let supply: u128 = Mapping::get_or_use(total_supply, 0u8, 0u128);
        Mapping::set(total_supply, 0u8, supply + amount);
    }

    async transition mint_private(
        recipient: address,
        amount: u128,
    ) -> (Token, Future) {
        let token: Token = Token { owner: recipient, amount: amount };
        return (token, finalize_mint_private(self.caller));
    }

    async function finalize_mint_private(caller: address) {
        // Check caller is admin
        let current_admin: address = Mapping::get(admin, 0u8);
        assert_eq(caller, current_admin);
    }

    // ──────────────────────────────────────────────
    //  Transfer Functions
    // ──────────────────────────────────────────────

    async transition transfer_public(
        public recipient: address,
        public amount: u128,
    ) -> Future {
        return finalize_transfer_public(self.caller, recipient, amount);
    }

    async function finalize_transfer_public(
        sender: address,
        recipient: address,
        amount: u128,
    ) {
        let sender_bal: u128 = Mapping::get(balances, sender);
        assert(sender_bal >= amount);
        Mapping::set(balances, sender, sender_bal - amount);

        let recipient_bal: u128 = Mapping::get_or_use(balances, recipient, 0u128);
        Mapping::set(balances, recipient, recipient_bal + amount);
    }

    transition transfer_private(
        input_token: Token,
        recipient: address,
        amount: u128,
    ) -> (Token, Token) {
        assert(input_token.amount >= amount);

        let to_recipient: Token = Token {
            owner: recipient,
            amount: amount,
        };

        let change: Token = Token {
            owner: input_token.owner,
            amount: input_token.amount - amount,
        };

        return (to_recipient, change);
    }

    // ──────────────────────────────────────────────
    //  Allowance Functions (ERC-20 style)
    // ──────────────────────────────────────────────

    /// Approve spender to transfer up to `amount` from caller
    async transition approve(
        public spender: address,
        public amount: u128,
    ) -> Future {
        return finalize_approve(self.caller, spender, amount);
    }

    async function finalize_approve(
        owner: address,
        spender: address,
        amount: u128,
    ) {
        let key: field = BHP256::hash_to_field(owner) + BHP256::hash_to_field(spender);
        Mapping::set(allowances, key, amount);
    }

    /// Transfer from owner to recipient (caller must have allowance)
    async transition transfer_from(
        public owner: address,
        public recipient: address,
        public amount: u128,
    ) -> Future {
        return finalize_transfer_from(self.caller, owner, recipient, amount);
    }

    async function finalize_transfer_from(
        spender: address,
        owner: address,
        recipient: address,
        amount: u128,
    ) {
        // Check allowance
        let key: field = BHP256::hash_to_field(owner) + BHP256::hash_to_field(spender);
        let allowed: u128 = Mapping::get(allowances, key);
        assert(allowed >= amount);

        // Reduce allowance
        Mapping::set(allowances, key, allowed - amount);

        // Transfer
        let owner_bal: u128 = Mapping::get(balances, owner);
        assert(owner_bal >= amount);
        Mapping::set(balances, owner, owner_bal - amount);

        let recipient_bal: u128 = Mapping::get_or_use(balances, recipient, 0u128);
        Mapping::set(balances, recipient, recipient_bal + amount);
    }

    // ──────────────────────────────────────────────
    //  Burn Functions
    // ──────────────────────────────────────────────

    async transition burn_public(
        public amount: u128,
    ) -> Future {
        return finalize_burn_public(self.caller, amount);
    }

    async function finalize_burn_public(
        owner: address,
        amount: u128,
    ) {
        let current: u128 = Mapping::get(balances, owner);
        assert(current >= amount);
        Mapping::set(balances, owner, current - amount);

        let supply: u128 = Mapping::get(total_supply, 0u8);
        Mapping::set(total_supply, 0u8, supply - amount);
    }

    // ──────────────────────────────────────────────
    //  Public/Private Conversions
    // ──────────────────────────────────────────────

    async transition transfer_pub_to_priv(
        public recipient: address,
        public amount: u128,
    ) -> (Token, Future) {
        let token: Token = Token {
            owner: recipient,
            amount: amount,
        };
        return (token, finalize_pub_to_priv(self.caller, amount));
    }

    async function finalize_pub_to_priv(
        sender: address,
        amount: u128,
    ) {
        let current: u128 = Mapping::get(balances, sender);
        assert(current >= amount);
        Mapping::set(balances, sender, current - amount);
    }

    async transition transfer_priv_to_pub(
        input_token: Token,
        public recipient: address,
        public amount: u128,
    ) -> (Token, Future) {
        assert(input_token.amount >= amount);

        let change: Token = Token {
            owner: input_token.owner,
            amount: input_token.amount - amount,
        };

        return (change, finalize_priv_to_pub(recipient, amount));
    }

    async function finalize_priv_to_pub(
        recipient: address,
        amount: u128,
    ) {
        let current: u128 = Mapping::get_or_use(balances, recipient, 0u128);
        Mapping::set(balances, recipient, current + amount);
    }
}
