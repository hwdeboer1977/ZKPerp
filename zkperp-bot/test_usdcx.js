// test_usdcx_transfer.js
import { Account, ProgramManager, AleoNetworkClient, NetworkRecordProvider } from "@provablehq/sdk";

const ENDPOINT = "https://api.explorer.provable.com/v2";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const account = new Account({ privateKey: PRIVATE_KEY });
const networkClient = new AleoNetworkClient(ENDPOINT);
const recordProvider = new NetworkRecordProvider(account, networkClient);

const programManager = new ProgramManager(ENDPOINT, undefined, recordProvider);
programManager.setAccount(account);

// Step 1: transfer_public_to_private
async function convertToPrivate() {
const tx = await programManager.execute({
    programName: "test_usdcx_stablecoin.aleo",
    functionName: "transfer_public_to_private",
    fee: 0.01,
    privateFee: false,  // use public credits
    inputs: [
        account.address().to_string(),
        "1000000u128"
    ],
});
  console.log("tx id:", tx);
  return tx;
}

convertToPrivate().catch(console.error);