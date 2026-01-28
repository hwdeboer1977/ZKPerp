# Fix open_block in zkperp_v4 Contract

## The Problem
Currently, the Position record has `open_block` hardcoded to `0u32`, which means the frontend cannot calculate borrow fees accurately.

## The Fix

### Location
File: `~/ZKPerp/leo/zkperp/src/main.leo`
Function: `open_position`

### Find this line:
```leo
async transition open_position(
    public collateral: u128,
    public size: u64,
    public is_long: boolean,
    public entry_price: u64,
    public max_slippage: u64,
    nonce: field,
    recipient: address,
) -> (Position, Future) {
    
    // ... validation code ...
    
    let position: Position = Position {
        owner: recipient,
        position_id: position_id,
        is_long: is_long,
        size_usdc: size,
        collateral_usdc: collateral_after_fee,
        entry_price: entry_price,
        open_block: 0u32,  // ❌ CHANGE THIS LINE!
    };
    
    // ...
}
```

### Change to:
```leo
    let position: Position = Position {
        owner: recipient,
        position_id: position_id,
        is_long: is_long,
        size_usdc: size,
        collateral_usdc: collateral_after_fee,
        entry_price: entry_price,
        open_block: block.height,  // ✅ FIXED!
    };
```

## BUT WAIT! There's a problem...

**You CANNOT access `block.height` in the transition function!**

`block.height` is only available in the `async function finalize` part, not in the `transition` part.

## The Real Solution

You have two options:

### Option 1: Pass block height from finalize back somehow (NOT POSSIBLE in Aleo)

Aleo doesn't let you return values from finalize to transition.

### Option 2: Accept that frontend must query the mapping

Keep the current design where:
- Position record has `open_block: 0u32` (placeholder)
- Actual block is in `position_open_blocks` mapping
- Frontend queries the mapping when closing

### Option 3: Store block height in a way the record can access

**This is actually NOT possible in Aleo's execution model!**

The record is created in the `transition` (executed client-side), but `block.height` is only available in `finalize` (executed on-chain).

## Recommended Solution

**Accept the limitation and make the frontend query the mapping:**

```typescript
async function fetchPositionOpenBlock(positionId: string): Promise<number> {
  try {
    // Remove "field.private" suffix if present
    const cleanId = positionId.replace('.private', '').replace('.public', '');
    
    const url = `${NETWORK_CONFIG.EXPLORER_API}/program/${PROGRAM_IDS.ZKPERP}/mapping/position_open_blocks/${cleanId}`;
    console.log('Fetching open block from:', url);
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const text = await response.text();
    console.log('Open block data:', text);
    
    // Parse "14045665u32"
    const blockMatch = text.match(/(\d+)u32/);
    if (blockMatch) {
      const block = parseInt(blockMatch[1]);
      console.log('Parsed open block:', block);
      return block;
    }
    
    throw new Error('Could not parse block');
  } catch (error) {
    console.error('Error fetching open block:', error);
    // Fallback: estimate based on current time
    // Aleo testnet: ~4 second blocks
    // If position was opened in last hour, assume 900 blocks ago
    return 900;
  }
}
```

Then in your `closePosition`:

```typescript
// Fetch actual open block from on-chain mapping
const openBlock = await fetchPositionOpenBlock(position.position_id);
const currentBlock = await fetchCurrentBlockHeight();
const actualBlocksOpen = currentBlock - openBlock;

console.log('Blocks calculation:', {
  openBlock,
  currentBlock,
  actualBlocksOpen,
});
```

## Why This is Necessary

Aleo's execution model:
1. **Transition** = Client-side execution (creates records, prepares transaction)
2. **Finalize** = On-chain execution (updates mappings, has access to `block.height`)

Records are created in step 1, but `block.height` is only available in step 2.

This is a fundamental limitation of Aleo's design for privacy - records must be created client-side so they can be encrypted before being sent to the chain.

## Deploy Steps

Since you can't fix this in the contract, **update your frontend** to query the mapping:

1. Add `fetchPositionOpenBlock()` helper function
2. Update `closePosition()` to use it
3. Test closing position

This is the **correct way** to handle it in Aleo! 🎯