import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AleoWalletProvider } from '@provablehq/aleo-wallet-adaptor-react'
import { WalletModalProvider } from '@provablehq/aleo-wallet-adaptor-react-ui'
import { ShieldWalletAdapter } from '@provablehq/aleo-wallet-adaptor-shield'
import { Network } from '@provablehq/aleo-types'
import { DecryptPermission } from "@provablehq/aleo-wallet-adaptor-core"
import '@provablehq/aleo-wallet-adaptor-react-ui/dist/styles.css'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AleoWalletProvider
      wallets={[new ShieldWalletAdapter()]}
      autoConnect={false}
      network={Network.TESTNET}
      decryptPermission={DecryptPermission.UponRequest}
      programs={['zkperp_amm_v4.aleo', 'test_usdcx_stablecoin.aleo', 'credits.aleo']}
      onError={(e) => console.error(e.message)}
    >
      <WalletModalProvider>
        <App />
      </WalletModalProvider>
    </AleoWalletProvider>
  </StrictMode>
)
