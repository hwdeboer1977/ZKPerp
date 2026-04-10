import { ethers } from "ethers";
import { canonicalString } from "./canonical.js";

/**
 * Sign a canonical payload with an Ethereum secp256k1 private key.
 * Uses eth_sign personal message hashing (EIP-191).
 */
export function signPayload(privateKey, payload) {
  const wallet = new ethers.Wallet(privateKey);
  const message = canonicalString(payload);
  const signature = wallet.signMessageSync(message);
  const digest = ethers.hashMessage(message);

  return {
    signer: wallet.address.toLowerCase(),
    digest,
    signature,
    payload
  };
}

/**
 * Recover the signer address from a payload + signature.
 * Returns lowercase address.
 */
export function recoverSigner(payload, signature) {
  const message = canonicalString(payload);
  return ethers.verifyMessage(message, signature).toLowerCase();
}
