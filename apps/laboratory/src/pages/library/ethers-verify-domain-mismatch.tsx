import { createWeb3Modal, defaultConfig } from '@web3modal/ethers/react'
import { EthersTests } from '../../components/Ethers/EthersTests'
import { AppKitButtons } from '../../components/AppKitButtons'
import { ThemeStore } from '../../utils/StoreUtil'
import { EthersConstants } from '../../utils/EthersConstants'
import { ConstantsUtil } from '../../utils/ConstantsUtil'
import { EthersModalInfo } from '../../components/Ethers/EthersModalInfo'

// Special project ID with verify enabled on localhost
const projectId = 'e4eae1aad4503db9966a04fd045a7e4d'

const modal = createWeb3Modal({
  ethersConfig: defaultConfig({
    metadata: ConstantsUtil.Metadata,
    defaultChainId: 1,
    chains: EthersConstants.chains,
    coinbasePreference: 'smartWalletOnly'
  }),
  chains: EthersConstants.chains,
  defaultChain: EthersConstants.chains[1],
  projectId,
  enableAnalytics: true,
  metadata: ConstantsUtil.Metadata,
  termsConditionsUrl: 'https://walletconnect.com/terms',
  privacyPolicyUrl: 'https://walletconnect.com/privacy',
  customWallets: ConstantsUtil.CustomWallets
})

ThemeStore.setModal(modal)

export default function Ethers() {
  return (
    <>
      <AppKitButtons />
      <EthersModalInfo />
      <EthersTests />
    </>
  )
}