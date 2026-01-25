// Mock USDC Token ok with Allowance System
// Supports approve/transferFrom for vault integration


// TESTNET
// 1. leo build
// 2. leo deploy --network testnet --broadcast
// 3. leo execute mint_public aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0 1000000000u128 --network testnet --broadcast --priority-fees 10000
// 4. check balance: curl "https://api.explorer.provable.com/v1/testnet/program/mock_usdc_v2.aleo/mapping/balances/aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0"
// 5. approve: leo execute approve arc4626_vault_ok.aleo 500000000u128 --network testnet --broadcast


// DEVNET alternative 1
// 1. leo build
// 2. leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage
// 3. leo deploy --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11
// 4. leo execute mint_public aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px 1000000000u128 --network testnet --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11

// Check: curl "http://localhost:3030/testnet/program/mock_usdc.aleo/mapping/balances/aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"

program mock_usdc.aleo {

    // ──────────────────────────────────────────────
    //  Constants
    // ──────────────────────────────────────────────

    // const ADMIN: address = aleo1d9es6d8kuzg65dlfdpx9zxchcsarh8k0hwxfx5eg6k4w7ew6gs8sv5aza0;
    const ADMIN: address = aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px;
    const DECIMALS: u8 = 6u8;

    // ──────────────────────────────────────────────
    //  State (Mappings)
    // ──────────────────────────────────────────────

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
    //  Mint Functions
    // ──────────────────────────────────────────────

    async transition mint_public(
        public recipient: address,
        public amount: u128,
    ) -> Future {
        assert_eq(self.caller, ADMIN);
        return finalize_mint_public(recipient, amount);
    }

    async function finalize_mint_public(
        recipient: address,
        amount: u128,
    ) {
        let current: u128 = Mapping::get_or_use(balances, recipient, 0u128);
        Mapping::set(balances, recipient, current + amount);

        let supply: u128 = Mapping::get_or_use(total_supply, 0u8, 0u128);
        Mapping::set(total_supply, 0u8, supply + amount);
    }

    transition mint_private(
        recipient: address,
        amount: u128,
    ) -> Token {
        assert_eq(self.caller, ADMIN);
        return Token { owner: recipient, amount: amount };
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
    // The constructor is configured to prevent upgrades.
    @noupgrade
    async constructor() {}
}
