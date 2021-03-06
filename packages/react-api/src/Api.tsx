// Copyright 2017-2022 @polkadot/react-api authors & contributors
// SPDX-License-Identifier: Apache-2.0

import type BN from 'bn.js';
import type { InjectedExtension } from '@polkadot/extension-inject/types';
import type { ChainProperties, ChainType } from '@polkadot/types/interfaces';
import type { KeyringStore } from '@polkadot/ui-keyring/types';
import type { ApiProps, ApiState } from './types';

import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import store from 'store';

import { ApiPromise, WsProvider } from '@polkadot/api';
import { deriveMapCache, setDeriveCache } from '@polkadot/api-derive/util';
import { ethereumChains, typesBundle, typesChain } from '@polkadot/apps-config';
import { web3Accounts, web3Enable } from '@polkadot/extension-dapp';
import { useSettings } from '@polkadot/react-api/useSettings';
import { TokenUnit } from '@polkadot/react-components/InputNumber';
import { StatusContext } from '@polkadot/react-components/Status';
import ApiSigner from '@polkadot/react-signer/signers/ApiSigner';
import { TypeRegistry } from '@polkadot/types/create';
import { keyring } from '@polkadot/ui-keyring';
import { settings } from '@polkadot/ui-settings';
import { formatBalance, isTestChain, objectSpread, stringify } from '@polkadot/util';
import { defaults as addressDefaults } from '@polkadot/util-crypto/address/defaults';

import ApiContext from './ApiContext';
import { decodeUrlTypes } from './urlTypes';

const registry = new TypeRegistry();
const kusamaRegistry = new TypeRegistry();

interface Props {
  children: React.ReactNode;
  url?: string;
  store?: KeyringStore;
}

interface InjectedAccountExt {
  address: string;
  meta: {
    name: string;
    source: string;
    whenCreated: number;
  };
}

interface ChainData {
  injectedAccounts: InjectedAccountExt[];
  properties: ChainProperties;
  systemChain: string;
  systemChainType: ChainType;
  systemName: string;
  systemVersion: string;
}

export const DEFAULT_DECIMALS = registry.createType('u32', 12);
export const DEFAULT_SS58 = registry.createType('u32', addressDefaults.prefix);
export const DEFAULT_AUX = ['Aux1', 'Aux2', 'Aux3', 'Aux4', 'Aux5', 'Aux6', 'Aux7', 'Aux8', 'Aux9'];

let api: ApiPromise;
let kusamaApi: ApiPromise;

export { api, kusamaApi };

function isKeyringLoaded () {
  try {
    return !!keyring.keyring;
  } catch {
    return false;
  }
}

function getDevTypes (): Record<string, Record<string, string>> {
  const types = decodeUrlTypes() || store.get('types', {}) as Record<string, Record<string, string>>;
  const names = Object.keys(types);

  names.length && console.log('Injected types:', names.join(', '));

  return types;
}

const collectionParam = { name: 'collection', type: 'UpDataStructsCollectionId' };

type RpcParam = {
  name: string;
  type: string;
  isOptional?: true;
};

const atParam = { isOptional: true, name: 'at', type: 'Hash' };

const fun = (description: string, params: RpcParam[], type: string) => ({
  description,
  params: [...params, atParam],
  type
});

const CROSS_ACCOUNT_ID_TYPE = 'PalletCommonAccountBasicCrossAccountIdRepr';
const TOKEN_ID_TYPE = 'UpDataStructsTokenId';

const crossAccountParam = (name = 'account') => ({ name, type: CROSS_ACCOUNT_ID_TYPE });
const tokenParam = { name: 'tokenId', type: TOKEN_ID_TYPE };

const rpc = {
  accountBalance: fun('Get amount of different user tokens', [collectionParam, crossAccountParam()], 'u32'),
  accountTokens: fun('Get tokens owned by account', [collectionParam, crossAccountParam()], 'Vec<UpDataStructsTokenId>'),
  adminlist: fun('Get admin list', [collectionParam], 'Vec<PalletCommonAccountBasicCrossAccountIdRepr>'),
  allowance: fun('Get allowed amount', [collectionParam, crossAccountParam('sender'), crossAccountParam('spender'), tokenParam], 'u128'),
  allowed: fun('Check if user is allowed to use collection', [collectionParam, crossAccountParam()], 'bool'),
  allowlist: fun('Get allowlist', [collectionParam], 'Vec<PalletCommonAccountBasicCrossAccountIdRepr>'),
  balance: fun('Get amount of specific account token', [collectionParam, crossAccountParam(), tokenParam], 'u128'),
  collectionById: fun('Get collection by specified id', [collectionParam], 'Option<UpDataStructsCollection>'),
  collectionStats: fun('Get collection stats', [], 'UpDataStructsCollectionStats'),
  collectionTokens: fun('Get tokens contained in collection', [collectionParam], 'Vec<UpDataStructsTokenId>'),
  constMetadata: fun('Get token constant metadata', [collectionParam, tokenParam], 'Vec<u8>'),
  lastTokenId: fun('Get last token id', [collectionParam], TOKEN_ID_TYPE),
  tokenExists: fun('Check if token exists', [collectionParam, tokenParam], 'bool'),
  tokenOwner: fun('Get token owner', [collectionParam, tokenParam], CROSS_ACCOUNT_ID_TYPE),
  variableMetadata: fun('Get token variable metadata', [collectionParam, tokenParam], 'Vec<u8>')
};

async function getInjectedAccounts (injectedPromise: Promise<InjectedExtension[]>): Promise<InjectedAccountExt[]> {
  try {
    await injectedPromise;

    const accounts = await web3Accounts();

    return accounts.map(({ address, meta }, whenCreated): InjectedAccountExt => ({
      address,
      meta: {
        ...meta,
        name: `${meta.name || 'unknown'} (${meta.source === 'polkadot-js' ? 'extension' : meta.source})`,
        whenCreated
      }
    }));
  } catch (error) {
    console.error('web3Accounts', error);

    return [];
  }
}

async function retrieve (api: ApiPromise, injectedPromise: Promise<InjectedExtension[]>): Promise<ChainData> {
  const [chainProperties, systemChain, systemChainType, systemName, systemVersion, injectedAccounts] = await Promise.all([
    api.rpc.system.properties(),
    api.rpc.system.chain(),
    api.rpc.system.chainType
      ? api.rpc.system.chainType()
      : Promise.resolve(registry.createType('ChainType', 'Live')),
    api.rpc.system.name(),
    api.rpc.system.version(),
    getInjectedAccounts(injectedPromise)
  ]);

  return {
    injectedAccounts,
    properties: registry.createType('ChainProperties', {
      ss58Format: api.consts.system?.ss58Prefix || chainProperties.ss58Format,
      tokenDecimals: chainProperties.tokenDecimals,
      tokenSymbol: chainProperties.tokenSymbol
    }),
    systemChain: (systemChain || '<unknown>').toString(),
    systemChainType,
    systemName: systemName.toString(),
    systemVersion: systemVersion.toString()
  };
}

async function loadOnReady (api: ApiPromise, injectedPromise: Promise<InjectedExtension[]>, store: KeyringStore | undefined, types: Record<string, Record<string, string>>): Promise<ApiState> {
  registry.register(types);

  const { injectedAccounts, properties, systemChain, systemChainType, systemName, systemVersion } = await retrieve(api, injectedPromise);
  const ss58Format = settings.prefix === -1
    ? properties.ss58Format.unwrapOr(DEFAULT_SS58).toNumber()
    : settings.prefix;
  const tokenSymbol = properties.tokenSymbol.unwrapOr([formatBalance.getDefaults().unit, ...DEFAULT_AUX]);
  const tokenDecimals = properties.tokenDecimals.unwrapOr([DEFAULT_DECIMALS]);
  const isEthereum = ethereumChains.includes(api.runtimeVersion.specName.toString());
  const isDevelopment = (systemChainType.isDevelopment || systemChainType.isLocal || isTestChain(systemChain));

  console.log(`chain: ${systemChain} (${systemChainType.toString()}), ${stringify(properties)}`);

  // explicitly override the ss58Format as specified
  registry.setChainProperties(registry.createType('ChainProperties', { ss58Format, tokenDecimals, tokenSymbol }));

  // first setup the UI helpers
  formatBalance.setDefaults({
    decimals: (tokenDecimals as BN[]).map((b) => b.toNumber()),
    unit: tokenSymbol[0].toString()
  });
  TokenUnit.setAbbr(tokenSymbol[0].toString());

  // finally load the keyring
  isKeyringLoaded() || keyring.loadAll({
    genesisHash: api.genesisHash,
    isDevelopment,
    ss58Format,
    store,
    type: isEthereum ? 'ethereum' : 'ed25519'
  }, injectedAccounts);

  const defaultSection = Object.keys(api.tx)[0];
  const defaultMethod = Object.keys(api.tx[defaultSection])[0];
  const apiDefaultTx = api.tx[defaultSection][defaultMethod];
  const apiDefaultTxSudo = (api.tx.system && api.tx.system.setCode) || apiDefaultTx;

  setDeriveCache(api.genesisHash.toHex(), deriveMapCache);

  return {
    apiDefaultTx,
    apiDefaultTxSudo,
    hasInjectedAccounts: injectedAccounts.length !== 0,
    isApiReady: true,
    isDevelopment: isEthereum ? false : isDevelopment,
    isEthereum,
    isKusamaApiReady: false,
    specName: api.runtimeVersion.specName.toString(),
    specVersion: api.runtimeVersion.specVersion.toString(),
    systemChain,
    systemName,
    systemVersion
  };
}

function Api ({ children, store }: Props): React.ReactElement<Props> | null {
  const { queuePayload, queueSetTxStatus } = useContext(StatusContext);
  const { apiSettings } = useSettings();
  const [state, setState] = useState<ApiState>({ hasInjectedAccounts: false, isApiReady: false } as unknown as ApiState);

  const [isApiConnected, setIsApiConnected] = useState(false);
  const [isApiInitialized, setIsApiInitialized] = useState(false);
  const [apiError, setApiError] = useState<null | string>(null);

  const [isKusamaApiConnected, setIsKusamaApiConnected] = useState(false);
  const [isKusamaApiInitialized, setIsKusamaApiInitialized] = useState(false);
  const [kusamaApiError, setIsKusamaApiError] = useState<null | string>(null);

  const [extensions, setExtensions] = useState<InjectedExtension[] | undefined>();

  const value = useMemo<ApiProps>(
    () => objectSpread({}, state, { api, apiError, extensions, isApiConnected, isApiInitialized, isKusamaApiConnected, isKusamaApiInitialized, isWaitingInjected: !extensions, kusamaApi, kusamaApiError }),
    [apiError, extensions, isApiConnected, isApiInitialized, isKusamaApiConnected, isKusamaApiInitialized, kusamaApiError, state]
  );

  const initKusamaApi = useCallback(() => {
    if (!apiSettings?.blockchain?.kusama.wsEndpoint) {
      return;
    }

    const provider = new WsProvider(apiSettings.blockchain.kusama.wsEndpoint);
    const signer = new ApiSigner(registry, queuePayload, queueSetTxStatus);
    const types = getDevTypes();

    kusamaApi = new ApiPromise({ provider, registry: kusamaRegistry, signer, types, typesBundle, typesChain });

    kusamaApi.on('connected', () => setIsKusamaApiConnected(true));
    kusamaApi.on('disconnected', () => setIsKusamaApiConnected(false));
    kusamaApi.on('error', (error: Error) => setIsKusamaApiError(error.message));
    kusamaApi.on('ready', (): void => {
      setState((prevState) => ({
        ...prevState,
        isKusamaApiReady: true
      }));
    });

    setIsKusamaApiInitialized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiSettings]);

  const initChainApi = useCallback(() => {
    if (!apiSettings?.blockchain?.unique.wsEndpoint) {
      return;
    }

    const provider = new WsProvider(apiSettings.blockchain.unique.wsEndpoint);
    const signer = new ApiSigner(registry, queuePayload, queueSetTxStatus);
    const types = getDevTypes();

    api = new ApiPromise({ provider,
      registry,
      rpc: {
        unique: rpc
      },
      signer,
      types,
      typesBundle,
      typesChain });

    api.on('connected', () => setIsApiConnected(true));
    api.on('disconnected', () => setIsApiConnected(false));
    api.on('error', (error: Error) => setApiError(error.message));
    api.on('ready', (): void => {
      const injectedPromise = web3Enable('polkadot-js/apps');

      injectedPromise
        .then(setExtensions)
        .catch(console.error);

      loadOnReady(api, injectedPromise, store, types)
        .then((st) => {
          setState(st);

          initKusamaApi();
        })
        .catch((error): void => {
          console.error(error);

          setApiError((error as Error).message);
        });
    });

    setIsApiInitialized(true);
  }, [apiSettings, initKusamaApi, queuePayload, queueSetTxStatus, store]);

  // initial initialization
  useEffect((): void => {
    if (apiSettings) {
      initChainApi();
    }
  }, [apiSettings, initChainApi, initKusamaApi, queuePayload, queueSetTxStatus, store]);

  if (!value.isApiInitialized) {
    return null;
  }

  return (
    <ApiContext.Provider value={value}>
      {children}
    </ApiContext.Provider>
  );
}

export default React.memo(Api);
