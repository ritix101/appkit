/* eslint-disable max-depth */
import {
  AccountController,
  ChainController,
  ConnectionController,
  CoreHelperUtil,
  NetworkController,
  type ConnectionControllerClient,
  type Connector,
  type NetworkControllerClient
} from '@reown/appkit-core'
import { ConstantsUtil, PresetsUtil } from '@reown/appkit-utils'
import UniversalProvider from '@walletconnect/universal-provider'
import type { UniversalProviderOpts } from '@walletconnect/universal-provider'
import { WcHelpersUtil } from '../utils/HelpersUtil.js'
import type { AppKit } from '../client.js'
import type { SessionTypes } from '@walletconnect/types'
import type {
  CaipNetwork,
  CaipNetworkId,
  CaipAddress,
  ChainNamespace,
  AdapterType
} from '@reown/appkit-common'
import { SafeLocalStorage, SafeLocalStorageKeys } from '@reown/appkit-common'
import { ProviderUtil } from '../store/index.js'
import type { AppKitOptions } from '../utils/TypesUtil.js'
import { allChains } from '../networks/index.js'

type Metadata = {
  name: string
  description: string
  url: string
  icons: string[]
}

const OPTIONAL_METHODS = [
  'eth_accounts',
  'eth_requestAccounts',
  'eth_sendRawTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'personal_sign',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_getPermissions',
  'wallet_requestPermissions',
  'wallet_registerOnboarding',
  'wallet_watchAsset',
  'wallet_scanQRCode'
]

// -- Client --------------------------------------------------------------------
export class UniversalAdapterClient {
  private walletConnectProviderInitPromise?: Promise<void>

  private appKit: AppKit | undefined = undefined

  public caipNetworks: CaipNetwork[]

  public walletConnectProvider?: UniversalProvider

  public metadata?: Metadata

  public isUniversalAdapterClient = true

  public chainNamespace: ChainNamespace

  public defaultNetwork: CaipNetwork | undefined = undefined

  public networkControllerClient: NetworkControllerClient

  public connectionControllerClient: ConnectionControllerClient

  public options: AppKitOptions | undefined = undefined

  public adapterType: AdapterType = 'universal'

  public constructor(options: AppKitOptions) {
    const { siweConfig, metadata } = options

    this.caipNetworks = options.networks

    this.chainNamespace = 'eip155'

    this.metadata = metadata

    this.defaultNetwork = options.defaultNetwork || options.networks[0]

    this.networkControllerClient = {
      // @ts-expect-error switchCaipNetwork is async for some adapter but not for this adapter
      switchCaipNetwork: caipNetwork => {
        if (caipNetwork) {
          SafeLocalStorage.setItem(
            SafeLocalStorageKeys.ACTIVE_CAIP_NETWORK,
            JSON.stringify(caipNetwork)
          )
          try {
            this.switchNetwork(caipNetwork)
          } catch (error) {
            throw new Error('networkControllerClient:switchCaipNetwork - unable to switch chain')
          }
        }
      },

      getApprovedCaipNetworksData: async () => {
        await this.getWalletConnectProvider()

        return new Promise(resolve => {
          const ns = this.walletConnectProvider?.session?.namespaces
          const nsChains: CaipNetworkId[] | undefined = []

          if (ns) {
            Object.keys(ns).forEach(key => {
              const chains = ns?.[key]?.chains
              if (chains) {
                nsChains.push(...(chains as CaipNetworkId[]))
              }
            })
          }

          const result = {
            supportsAllNetworks: true,
            approvedCaipNetworkIds: nsChains as CaipNetworkId[] | undefined
          }

          resolve(result)
        })
      }
    }

    this.connectionControllerClient = {
      connectWalletConnect: async onUri => {
        const WalletConnectProvider = await this.getWalletConnectProvider()

        if (!WalletConnectProvider) {
          throw new Error('connectionControllerClient:getWalletConnectUri - provider is undefined')
        }

        WalletConnectProvider.on('display_uri', (uri: string) => {
          onUri(uri)
        })

        if (
          ChainController.state.activeChain &&
          ChainController.state?.chains?.get(ChainController.state.activeChain)?.adapterType ===
            'wagmi'
        ) {
          const adapter = ChainController.state.chains.get(ChainController.state.activeChain)
          await adapter?.connectionControllerClient?.connectWalletConnect?.(onUri)
          this.appKit?.setIsConnected(true, this.chainNamespace)
          this.setWalletConnectProvider()
        } else {
          const siweParams = await siweConfig?.getMessageParams?.()
          const isSiweEnabled = siweConfig?.options?.enabled
          const isProviderSupported = typeof WalletConnectProvider?.authenticate === 'function'
          const isSiweParamsValid = siweParams && Object.keys(siweParams || {}).length > 0

          if (
            siweConfig &&
            isSiweEnabled &&
            siweParams &&
            isProviderSupported &&
            isSiweParamsValid
          ) {
            const { SIWEController, getDidChainId, getDidAddress } = await import(
              '@reown/appkit-siwe'
            )

            const chains = this.caipNetworks
              ?.filter(network => network.chainNamespace === 'eip155')
              .map(chain => chain.id) as string[]

            const result = await WalletConnectProvider.authenticate({
              nonce: await siweConfig?.getNonce?.(),
              methods: [...OPTIONAL_METHODS],
              ...siweParams,
              chains
            })
            // Auths is an array of signed CACAO objects https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-74.md
            const signedCacao = result?.auths?.[0]

            if (signedCacao) {
              const { p, s } = signedCacao
              const cacaoChainId = getDidChainId(p.iss)
              const address = getDidAddress(p.iss)
              if (address && cacaoChainId) {
                SIWEController.setSession({
                  address,
                  chainId: parseInt(cacaoChainId, 10)
                })
              }

              try {
                // Kicks off verifyMessage and populates external states
                const message = WalletConnectProvider.client.formatAuthMessage({
                  request: p,
                  iss: p.iss
                })

                await SIWEController.verifyMessage({
                  message,
                  signature: s.s,
                  cacao: signedCacao
                })
              } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Error verifying message', error)
                // eslint-disable-next-line no-console
                await WalletConnectProvider.disconnect().catch(console.error)
                // eslint-disable-next-line no-console
                await SIWEController.signOut().catch(console.error)
                throw error
              }
            }
          } else {
            const optionalNamespaces = WcHelpersUtil.createNamespaces(this.caipNetworks)
            await WalletConnectProvider.connect({ optionalNamespaces })
          }
          this.appKit?.setIsConnected(true, this.chainNamespace)
          this.setWalletConnectProvider()
        }
      },

      disconnect: async () => {
        SafeLocalStorage.removeItem(SafeLocalStorageKeys.WALLET_ID)
        SafeLocalStorage.removeItem(SafeLocalStorageKeys.ACTIVE_CAIP_NETWORK)

        if (siweConfig?.options?.signOutOnDisconnect) {
          const { SIWEController } = await import('@reown/appkit-siwe')
          await SIWEController.signOut()
        }

        await this.walletConnectProvider?.disconnect()

        this.appKit?.setIsConnected(false)
        this.appKit?.resetAccount('eip155')
        this.appKit?.resetAccount('solana')
      },

      signMessage: async (message: string) => {
        const provider = await this.getWalletConnectProvider()
        const caipAddress = ChainController.state.activeCaipAddress
        const address = CoreHelperUtil.getPlainAddress(caipAddress)

        if (!provider) {
          throw new Error('connectionControllerClient:signMessage - provider is undefined')
        }

        const signature = await provider.request({
          method: 'personal_sign',
          params: [message, address]
        })

        return signature as string
      },

      estimateGas: async () => await Promise.resolve(BigInt(0)),
      // -- Transaction methods ---------------------------------------------------
      /**
       *
       * These methods are supported only on `wagmi` and `ethers` since the Solana SDK does not support them in the same way.
       * These function definition is to have a type parity between the clients. Currently not in use.
       */
      getEnsAvatar: async (value: string) => await Promise.resolve(value),

      getEnsAddress: async (value: string) => await Promise.resolve(value),

      writeContract: async () => await Promise.resolve('0x'),

      sendTransaction: async () => await Promise.resolve('0x'),

      parseUnits: () => BigInt(0),

      formatUnits: () => ''
    }
  }

  // -- Public ------------------------------------------------------------------
  public construct(appkit: AppKit, options: AppKitOptions) {
    if (!options.projectId) {
      throw new Error('Solana:construct - projectId is undefined')
    }
    this.appKit = appkit
    this.options = options

    this.createProvider()
    this.syncRequestedNetworks(this.caipNetworks)
    this.syncConnectors()
  }

  public switchNetwork(caipNetwork: CaipNetwork) {
    if (caipNetwork) {
      if (this.walletConnectProvider) {
        this.walletConnectProvider.setDefaultChain(caipNetwork.id)
      }
    }
  }

  public async disconnect() {
    if (this.walletConnectProvider) {
      await (this.walletConnectProvider as unknown as UniversalProvider).disconnect()
      this.appKit?.resetAccount('eip155')
      this.appKit?.resetAccount('solana')
    }
  }

  public async getWalletConnectProvider() {
    if (!this.walletConnectProvider) {
      try {
        await this.createProvider()
      } catch (error) {
        throw new Error('EthereumAdapter:getWalletConnectProvider - Cannot create provider')
      }
    }

    return this.walletConnectProvider
  }

  // -- Private -----------------------------------------------------------------
  private createProvider() {
    if (
      !this.walletConnectProviderInitPromise &&
      typeof window !== 'undefined' &&
      this.options?.projectId
    ) {
      this.walletConnectProviderInitPromise = this.initWalletConnectProvider(
        this.options?.projectId
      )
    }

    return this.walletConnectProviderInitPromise
  }

  private async initWalletConnectProvider(projectId: string) {
    const walletConnectProviderOptions: UniversalProviderOpts = {
      projectId,
      metadata: {
        name: this.metadata ? this.metadata.name : '',
        description: this.metadata ? this.metadata.description : '',
        url: this.metadata ? this.metadata.url : '',
        icons: this.metadata ? this.metadata.icons : ['']
      }
    }

    this.walletConnectProvider = await UniversalProvider.init(walletConnectProviderOptions)

    await this.checkActiveWalletConnectProvider()
  }

  private syncRequestedNetworks(caipNetworks: AppKitOptions['networks']) {
    const uniqueChainNamespaces = [
      ...new Set(caipNetworks.map(caipNetwork => caipNetwork.chainNamespace))
    ]
    uniqueChainNamespaces
      .filter(c => Boolean(c))
      .forEach(chainNamespace => {
        this.appKit?.setRequestedCaipNetworks(
          caipNetworks.filter(caipNetwork => caipNetwork.chainNamespace === chainNamespace),
          chainNamespace
        )
      })
  }

  private async checkActiveWalletConnectProvider() {
    const WalletConnectProvider = await this.getWalletConnectProvider()
    const walletId = SafeLocalStorage.getItem(SafeLocalStorageKeys.WALLET_ID)

    if (WalletConnectProvider) {
      if (walletId === ConstantsUtil.WALLET_CONNECT_CONNECTOR_ID) {
        this.setWalletConnectProvider()
      }
    }
  }

  private setWalletConnectProvider() {
    SafeLocalStorage.setItem(
      SafeLocalStorageKeys.WALLET_ID,
      ConstantsUtil.WALLET_CONNECT_CONNECTOR_ID
    )

    const nameSpaces = this.walletConnectProvider?.session?.namespaces

    if (nameSpaces) {
      Object.keys(nameSpaces)
        .reverse()
        .forEach(key => {
          const caipAddress = nameSpaces?.[key]?.accounts[0] as CaipAddress

          ProviderUtil.setProvider(key as ChainNamespace, this.walletConnectProvider)
          ProviderUtil.setProviderId(key as ChainNamespace, 'walletConnect')

          if (caipAddress) {
            this.appKit?.setCaipAddress(caipAddress, key as ChainNamespace)
          }
        })

      const storedCaipNetwork = SafeLocalStorage.getItem(SafeLocalStorageKeys.ACTIVE_CAIP_NETWORK)

      if (storedCaipNetwork) {
        try {
          const parsedCaipNetwork = JSON.parse(storedCaipNetwork) as CaipNetwork
          if (parsedCaipNetwork) {
            NetworkController.setActiveCaipNetwork(parsedCaipNetwork)
          }
        } catch (error) {
          console.warn('>>> Error setting active caip network', error)
        }
      } else if (!ChainController.state.activeCaipNetwork) {
        this.setDefaultNetwork(nameSpaces)
      } else if (
        !NetworkController.state.approvedCaipNetworkIds?.includes(
          ChainController.state.activeCaipNetwork.id
        )
      ) {
        this.setDefaultNetwork(nameSpaces)
      }
    }

    SafeLocalStorage.setItem(
      SafeLocalStorageKeys.ACTIVE_CAIP_NETWORK,
      JSON.stringify(this.appKit?.getCaipNetwork())
    )

    this.syncAccount()
    this.watchWalletConnect()
  }

  private setDefaultNetwork(nameSpaces: SessionTypes.Namespaces) {
    const chainNamespace = this.caipNetworks[0]?.chainNamespace

    if (chainNamespace) {
      const namespace = nameSpaces?.[chainNamespace]

      if (namespace?.chains) {
        const chainId = namespace.chains[0]

        if (chainId) {
          const requestedCaipNetworks = NetworkController.state?.requestedCaipNetworks

          if (requestedCaipNetworks) {
            const network = requestedCaipNetworks.find(c => c.id === chainId)

            if (network) {
              NetworkController.setActiveCaipNetwork(network as unknown as CaipNetwork)
            }
          }
        }
      }
    }
  }

  private async watchWalletConnect() {
    const provider = await this.getWalletConnectProvider()
    const namespaces = provider?.session?.namespaces || {}

    function disconnectHandler() {
      Object.keys(namespaces).forEach(key => {
        AccountController.resetAccount(key as ChainNamespace)
      })
      ConnectionController.resetWcConnection()

      SafeLocalStorage.removeItem(SafeLocalStorageKeys.WALLET_ID)
      SafeLocalStorage.removeItem(SafeLocalStorageKeys.ACTIVE_CAIP_NETWORK)

      provider?.removeListener('disconnect', disconnectHandler)
      provider?.removeListener('accountsChanged', accountsChangedHandler)
    }

    const accountsChangedHandler = (accounts: string[]) => {
      if (accounts.length > 0) {
        this.syncAccount()
      }
    }

    const chainChanged = (chainId: number | string) => {
      // eslint-disable-next-line eqeqeq
      const caipNetwork = this.caipNetworks.find(c => c.chainId == chainId)
      const isSameNetwork =
        caipNetwork?.chainId === ChainController.state.activeCaipNetwork?.chainId

      if (!isSameNetwork) {
        if (caipNetwork) {
          NetworkController.setActiveCaipNetwork(caipNetwork)
        } else {
          const chain = allChains.find(c => c.chainId.toString() === chainId.toString())
          if (chain) {
            NetworkController.setActiveCaipNetwork(chain)
          } else {
            NetworkController.setActiveCaipNetwork({
              chainId: Number(chainId),
              id: `eip155:${chainId}`,
              name: 'Unknown Network',
              currency: '',
              explorerUrl: '',
              rpcUrl: '',
              chainNamespace: this.appKit?.getActiveChainNamespace() || 'eip155'
            })
          }
        }
      }
    }

    if (provider) {
      provider.on('disconnect', () => {
        this.appKit?.setIsConnected(false)
        disconnectHandler()
      })
      provider.on('accountsChanged', accountsChangedHandler)
      provider.on('chainChanged', chainChanged)
    }
  }

  private getProviderData() {
    const namespaces = this.walletConnectProvider?.session?.namespaces || {}

    const isConnected = this.appKit?.getIsConnectedState() || false
    const preferredAccountType = this.appKit?.getPreferredAccountType() || ''

    return {
      provider: this.walletConnectProvider,
      namespaces,
      namespaceKeys: namespaces ? Object.keys(namespaces) : [],
      isConnected,
      preferredAccountType
    }
  }

  private syncAccount() {
    const { namespaceKeys, namespaces } = this.getProviderData()

    const preferredAccountType = this.appKit?.getPreferredAccountType()

    const isConnected = this.appKit?.getIsConnectedState() || false

    if (isConnected) {
      namespaceKeys.forEach(async key => {
        const chainNamespace = key as ChainNamespace
        const address = namespaces?.[key]?.accounts[0] as CaipAddress
        const isNamespaceConnected = this.appKit?.getCaipAddress(chainNamespace)

        if (!isNamespaceConnected) {
          this.appKit?.setPreferredAccountType(preferredAccountType, chainNamespace)
          this.appKit?.setCaipAddress(address, chainNamespace)
          this.syncConnectedWalletInfo()
          this.syncAccounts()
          await Promise.all([this.appKit?.setApprovedCaipNetworksData(chainNamespace)])
        }
      })
    } else {
      this.appKit?.resetWcConnection()
      this.appKit?.resetNetwork()
      this.syncAccounts(true)
    }
  }

  private syncAccounts(reset = false) {
    const { namespaces } = this.getProviderData()
    const chainNamespaces = Object.keys(namespaces) as ChainNamespace[]

    chainNamespaces.forEach(chainNamespace => {
      const addresses = namespaces?.[chainNamespace]?.accounts
        ?.map(account => {
          const [, , address] = account.split(':')

          return address
        })
        .filter((address, index, self) => self.indexOf(address) === index) as string[]

      if (reset) {
        this.appKit?.setAllAccounts([], chainNamespace)
      }

      if (addresses) {
        this.appKit?.setAllAccounts(
          addresses.map(address => ({ address, type: 'eoa' })),
          chainNamespace
        )
      }
    })
  }

  private syncConnectedWalletInfo() {
    const currentActiveWallet = SafeLocalStorage.getItem(SafeLocalStorageKeys.WALLET_ID)
    const namespaces = this.walletConnectProvider?.session?.namespaces || {}
    const chainNamespaces = Object.keys(namespaces) as ChainNamespace[]

    chainNamespaces.forEach(chainNamespace => {
      if (this.walletConnectProvider?.session) {
        this.appKit?.setConnectedWalletInfo(
          {
            ...this.walletConnectProvider.session.peer.metadata,
            name: this.walletConnectProvider.session.peer.metadata.name,
            icon: this.walletConnectProvider.session.peer.metadata.icons?.[0]
          },
          chainNamespace
        )
      } else if (currentActiveWallet) {
        this.appKit?.setConnectedWalletInfo({ name: currentActiveWallet }, 'eip155')
        this.appKit?.setConnectedWalletInfo({ name: currentActiveWallet }, 'solana')
      }
    })
  }

  private syncConnectors() {
    const w3mConnectors: Connector[] = []

    w3mConnectors.push({
      id: ConstantsUtil.WALLET_CONNECT_CONNECTOR_ID,
      explorerId: PresetsUtil.ConnectorExplorerIds[ConstantsUtil.WALLET_CONNECT_CONNECTOR_ID],
      imageId: PresetsUtil.ConnectorImageIds[ConstantsUtil.WALLET_CONNECT_CONNECTOR_ID],
      name: PresetsUtil.ConnectorNamesMap[ConstantsUtil.WALLET_CONNECT_CONNECTOR_ID],
      type: 'WALLET_CONNECT',
      chain: this.chainNamespace
    })

    this.appKit?.setConnectors(w3mConnectors)
  }
}
