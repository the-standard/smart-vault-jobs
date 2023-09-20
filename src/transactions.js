const fs = require('fs');
const https = require('https');
const schedule = require('node-schedule');
const { ethers } = require("ethers");
const { createClient } = require('redis');
const { getArchiveNode, getNetwork } = require("./networks");
const { getWallet } = require('./wallet');
const { getContract } = require('./contractFactory');

const contracts = JSON.parse(fs.readFileSync('contracts.json', { encoding: 'utf8' }));
const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || '6379';

const redis = createClient({
  url: `redis://${redisHost}:${redisPort}`
});
redis.on('error', err => console.log('Redis Client Error', err));

const LATEST_INDEXED_BLOCK_KEY = 'tx:latestBlock';
const SMART_VAULT_LAUNCH_BLOCK = 117059962;
const VAULT_ADDRESSES_KEY = 'vaultAddresses';
let startBlock;
let endBlock;
let tokenDecs = {};

const withBlockLimits = filter => {
  return {
    ...filter,
    fromBlock: startBlock,
    toBlock: endBlock
  };
};

const getStatusAt = async (tx, wallet) => {
  try {
    const vault = new ethers.Contract(tx.vaultAddress, contracts.SmartVault, wallet);
    return await vault.status({ blockTag: tx.blockNumber });
  } catch (e) {
    console.log(e);
    console.log(`getting status for ${tx.vaultAddress} at ${tx.blockNumber}`);
  }
}

const addVaultStatus = async (transactions) => {
  const transactionsWithStatus = [];
  const { wallet } = getWallet(getArchiveNode('arbitrum'));
  const statuses = await Promise.all(transactions.map(tx => getStatusAt(tx, wallet)))
  for (let i = 0; i < transactions.length; i++) {
    transactionsWithStatus.push({
      ... transactions[i],
      minted: statuses[i].minted.toString(),
      totalCollateralValue: statuses[i].totalCollateralValue.toString()
    })
  }
  return transactionsWithStatus;
};

const getDepositsForERC20 = async (vaults, token, wallet) => {
  try {
    const tokenContract = new ethers.Contract(token.addr, contracts.ERC20, wallet);
    const filter = withBlockLimits(tokenContract.filters.Transfer(null, vaults));
    const events = await tokenContract.queryFilter(filter, startBlock, endBlock);
    return events.map(event => {
      return {
        ... event,
        tokenSymbol: ethers.utils.parseBytes32String(token.symbol),
        tokenDec: token.dec
      }
    });
  } catch (e) {
    console.log(e);
    console.log(`retrying deposits ${ethers.utils.parseBytes32String(token.symbol)}`);
    return await getDepositsForERC20(vaults, token, wallet);
  }
};

const getERC20DepositsForVaults = async (vaults, tokens, wallet, provider) => {
  if (vaults.length === 0) return [];
  const depositEvents = (await Promise.all(tokens.map(token => getDepositsForERC20(vaults, token, wallet)))).flat();
  const timestamps = (await Promise.all(depositEvents.map(e => provider.getBlock(e.blockNumber)))).map(block => block.timestamp);
  return depositEvents.map((event, i) => {
    return {
      type: 'deposit',
      txHash: event.transactionHash.toLowerCase(),
      blockNumber: event.blockNumber,
      asset: event.tokenSymbol,
      vaultAddress: event.args.to.toLowerCase(),
      amount: event.args.value.toString(),
      assetDec: event.tokenDec,
      timestamp: timestamps[i]
    }
  });
};

const allTransactionsFor = async vault => {
  try {
    const url = `https://api.arbiscan.io/api?module=account&action=txlist&address=${vault}&startblock=${startBlock}&endBlock=${endBlock}&sort=asc&apikey=${process.env.ARBISCAN_KEY}`;
    return new Promise(resolve => {
      https.get(url, res => {
        let json = '';

        res.on('data', data => {
          json += data;
        });

        res.on('end', _ => {
          resolve(JSON.parse(json));
        });
      });
    });
  } catch (e) {
    console.log(e);
    console.log(`retrying eth deposits ${vault}`);
    return await allTransactionsFor(vault);
  }
};

const vaultEthDeposits = async (vault) => {
  const allTransactions = await allTransactionsFor(vault);
  const ethDeposits = allTransactions.result.filter(tx => tx.value !== '0');
  return ethDeposits.map(tx => {
    const deposit = tx.to.toLowerCase() === vault.toLowerCase();
    return {
      type: deposit ? 'deposit' : 'withdrawal',
      txHash: tx.hash.toLowerCase(),
      blockNumber: parseInt(tx.blockNumber),
      asset: 'ETH',
      vaultAddress: vault.toLowerCase(),
      amount: tx.value,
      assetDec: 18,
      timestamp: tx.timeStamp
    };
  });
};

const requestRateLimit = async ms => {
  return new Promise(resolve => {
    setTimeout(() => resolve(), ms);
  });
};

const getAllEthDeposits = async (vaults) => {
  let deposits = [];

  for (let i = 0; i < vaults.length; i++) {
    await requestRateLimit(500);
    deposits = [...deposits, ... await vaultEthDeposits(vaults[i])];
  }

  return deposits;
};

const getVaultWithdrawals = async (vault, wallet) => {
  try {
    const vaultContract = new ethers.Contract(vault, contracts.SmartVault, wallet);
    const filter = withBlockLimits(vaultContract.filters.CollateralRemoved());
    return (await vaultContract.queryFilter(filter, startBlock, endBlock)).map(event => {
      return {
        ... event,
        vaultAddress: vault
      }
    });
  } catch (e) {
    console.log(e);
    console.log(`retrying withdrawals ${vault}`);
    return await getVaultWithdrawals(vault, wallet);
  }
};

const getWithdrawals = async (vaults, wallet, provider) => {
  const withdrawalEvents = (await Promise.all(vaults.map(vault => getVaultWithdrawals(vault, wallet)))).flat();
  const timestamps = (await Promise.all(withdrawalEvents.map(e => provider.getBlock(e.blockNumber)))).map(block => block.timestamp);
  return withdrawalEvents.map((event, i) => {
    return {
      type: 'withdrawal',
      txHash: event.transactionHash.toLowerCase(),
      blockNumber: event.blockNumber,
      asset: ethers.utils.parseBytes32String(event.args.symbol),
      vaultAddress: event.vaultAddress.toLowerCase(),
      amount: event.args.amount.toString(),
      assetDec: tokenDecs[event.args.symbol],
      timestamp: timestamps[i]
    }
  });
};

const getVaultBorrows = async (vault, wallet) => {
  try {
    const vaultContract = new ethers.Contract(vault, contracts.SmartVault, wallet);
    const filter = withBlockLimits(vaultContract.filters.EUROsMinted());
    return (await vaultContract.queryFilter(filter, startBlock, endBlock)).map(event => {
      return {
        ... event,
        vaultAddress: vault
      }
    });
  } catch (e) {
    console.log(e);
    console.log(`retrying borrows ${vault}`);
    return await getVaultBorrows(vault, wallet);
  }
};

const getBorrows = async (vaults, wallet, provider) => {
  const borrowEvents = (await Promise.all(vaults.map(vault => getVaultBorrows(vault, wallet)))).flat();
  const timestamps = (await Promise.all(borrowEvents.map(e => provider.getBlock(e.blockNumber)))).map(block => block.timestamp);
  return borrowEvents.map((event, i) => {
    return {
      type: 'borrow',
      txHash: event.transactionHash.toLowerCase(),
      blockNumber: event.blockNumber,
      asset: 'EUROs',
      vaultAddress: event.vaultAddress.toLowerCase(),
      amount: event.args.amount.toString(),
      assetDec: 18,
      timestamp: timestamps[i]
    }
  });
};

const getVaultRepays = async (vault, wallet) => {
  try {
    const vaultContract = new ethers.Contract(vault, contracts.SmartVault, wallet);
    const filter = withBlockLimits(vaultContract.filters.EUROsBurned());
    return (await vaultContract.queryFilter(filter, startBlock, endBlock)).map(event => {
      return {
        ... event,
        vaultAddress: vault.toLowerCase()
      }
    });
  } catch (e) {
    console.log(e);
    console.log(`retrying repays ${vault}`);
    return await getVaultRepays(vault, wallet);
  }
};

const getRepays = async (vaults, wallet, provider) => {
  const repayEvents = (await Promise.all(vaults.map(vault => getVaultRepays(vault, wallet)))).flat();
  const timestamps = (await Promise.all(repayEvents.map(e => provider.getBlock(e.blockNumber)))).map(block => block.timestamp);
  return repayEvents.map((event, i) => {
    return {
      type: 'repay',
      txHash: event.transactionHash.toLowerCase(),
      blockNumber: event.blockNumber,
      asset: 'EUROs',
      vaultAddress: event.vaultAddress.toLowerCase(),
      amount: event.args.amount.toString(),
      assetDec: 18,
      timestamp: timestamps[i]
    }
  });
};

const getLiquidations = async (smartVaultManagerContract, provider) => {
  try {
    const liquidations = [];
    const filter = withBlockLimits(smartVaultManagerContract.filters.VaultLiquidated());
    const liquidationEvents = await smartVaultManagerContract.queryFilter(filter, startBlock, endBlock);
    for (let i = 0; i < liquidationEvents.length; i++) {
      const event = liquidationEvents[i];
      liquidations.push({
        type: 'liquidation',
        txHash: event.transactionHash.toLowerCase(),
        blockNumber: event.blockNumber,
        asset: 'n/a',
        vaultAddress: event.args.vaultAddress.toLowerCase(),
        amount: '0',
        assetDec: 0,
        timestamp: (await provider.getBlock(event.blockNumber)).timestamp
      });

      const previousBlock = event.blockNumber - 1;
      liquidations.push({
        type: 'pre-liquidation',
        txHash: '0x',
        blockNumber: event.blockNumber - 1,
        asset: 'n/a',
        vaultAddress: event.args.vaultAddress.toLowerCase(),
        amount: '0',
        assetDec: 0,
        timestamp: (await provider.getBlock(previousBlock)).timestamp
      });
    }
    return liquidations;
  } catch (e) {
    console.log(e);
    console.log('retrying liquidations');
    return await getLiquidations(smartVaultManagerContract, provider);
  }
};

const getCreations = async (smartVaultManagerContract, provider) => {
  try {
    const filter = withBlockLimits(smartVaultManagerContract.filters.VaultDeployed());
    const creationEvents = await smartVaultManagerContract.queryFilter(filter, startBlock, endBlock);
    const timestamps = (await Promise.all(creationEvents.map(e => provider.getBlock(e.blockNumber)))).map(block => block.timestamp);
    return creationEvents.map((event, i) => {
      return {
        type: 'creation',
        txHash: event.transactionHash.toLowerCase(),
        blockNumber: event.blockNumber,
        asset: 'n/a',
        vaultAddress: event.args.vaultAddress.toLowerCase(),
        amount: '0',
        assetDec: 0,
        timestamp: timestamps[i]
      }
    });
  } catch (e) {
    console.log(e);
    console.log('retrying creations');
    return await getCreations(smartVaultManagerContract, provider);
  }
};

const getVaultAddressForTokenId = async (tokenId, wallet, network) => {
  const smartVaultIndex = (await getContract(network.name, 'SmartVaultIndex')).connect(wallet);
  return (await smartVaultIndex.getVaultAddress(tokenId)).toLowerCase();
};

const getTransfers = async (smartVaultManagerContract, provider, wallet, network) => {
  try {
    const filter = withBlockLimits(smartVaultManagerContract.filters.Transfer());
    const transferEvents = (await smartVaultManagerContract.queryFilter(filter, startBlock, endBlock))
      .filter(event => event.args.from !== ethers.constants.AddressZero);
    const vaultAddresses = await Promise.all(transferEvents.map(e => getVaultAddressForTokenId(e.args.tokenId.toString(), wallet, network)))
    const timestamps = (await Promise.all(transferEvents.map(e => provider.getBlock(e.blockNumber)))).map(block => block.timestamp);
    return transferEvents.map((event, i) => {
      return {
        type: 'transfer',
        txHash: event.transactionHash.toLowerCase(),
        blockNumber: event.blockNumber,
        asset: 'n/a',
        vaultAddress: vaultAddresses[i],
        amount: '0',
        assetDec: 0,
        timestamp: timestamps[i]
      }
    });
  } catch (e) {
    console.log(e);
    console.log('retrying transfers');
    return await getTransfers(smartVaultManagerContract, provider, wallet, network);
  }
};

const getTs = _ => {
  return Math.floor(new Date() / 1000);
};

const setStartBlock = async _ => {
  await redis.connect();
  const lastIndexed = await redis.get(LATEST_INDEXED_BLOCK_KEY);
  await redis.disconnect();
  startBlock = lastIndexed ? parseInt(lastIndexed) + 1 : SMART_VAULT_LAUNCH_BLOCK;
};

const setEndBlock = async provider => {
  const blockDiffLimit = 10_000;
  const latest = await provider.getBlockNumber();
  if (latest - startBlock > blockDiffLimit) {
    endBlock = startBlock + blockDiffLimit;
  } else {
    endBlock = latest;
  }
};

const getAcceptedERC20s = async (network, wallet) => {
  return (await (await getContract(network.name, 'TokenManager')).connect(wallet).getAcceptedTokens())
    .filter(token => token.addr !== ethers.constants.AddressZero);
};

const setTokenDecs = tokens => {
  tokenDecs[ethers.utils.formatBytes32String('ETH')] = 18;
  tokens.forEach(token => {
    tokenDecs[token.symbol] = token.dec;
  });
};

const getIndexedVaults = async _ => {
  await redis.connect();
  const vaults = await redis.SMEMBERS(VAULT_ADDRESSES_KEY);
  await redis.disconnect();
  return vaults;
};

const saveToRedis = async (transactions, vaults) => {
  // SCHEMA:
  // key: 'vaultTxs:0x...'
  // score: timestamp
  // value: 'type:hash:blockNo:asset:amount:assetDec:minted:collateralValue'
  // e.g. 'deposit:0x8ae26a528861d3e6c08d4331885eaba2d1b5b55fc540234fc9b8c9c198a0d429:124132949:PAXG:8000000000000000:18:136175000000000000000:181087962079756018667'
  const schema = ['type', 'txHash', 'blockNumber', 'asset', 'amount', 'assetDec', 'minted', 'totalCollateralValue']

  let redisTx = await redis.MULTI();
  for (let i = 0; i < transactions.length; i++) {
    const transaction = transactions[i];
    const key = `vaultTxs:${transaction.vaultAddress}`;
    const score = transaction.timestamp;
    const value = schema.map(key => transaction[key]).join(':');
    redisTx = redisTx.ZADD(key, [{ score, value }]);
  }

  if (vaults.length > 0) {
    redisTx = redisTx
      .SADD(VAULT_ADDRESSES_KEY, vaults.map(addr => addr.toLowerCase()));
  }

  await redis.connect();
  await redisTx
    .SET(LATEST_INDEXED_BLOCK_KEY, endBlock)
    .EXEC();
  await redis.disconnect();
};

const indexVaultTransactions = async _ => {
  const startTs = getTs();
  const network = getNetwork('arbitrum');
  const { wallet, provider } = getWallet(network);
  await setStartBlock();
  await setEndBlock(provider);
  console.log(`indexing transactions from block ${startBlock} to ${endBlock} ...`);
  const smartVaultManagerContract = (await getContract(network.name, 'SmartVaultManager')).connect(wallet);
  const erc20Tokens = await getAcceptedERC20s(network, wallet);
  setTokenDecs(erc20Tokens);
  const vaultCreations = await getCreations(smartVaultManagerContract, provider);
  const unindexedVaults = vaultCreations.map(event => event.vaultAddress);
  const vaults = [... await getIndexedVaults(), ...unindexedVaults];
  const transactions = await addVaultStatus(([... await Promise.all([
    getERC20DepositsForVaults(vaults, erc20Tokens, wallet, provider),
    getAllEthDeposits(vaults),
    getWithdrawals(vaults, wallet, provider),
    getBorrows(vaults, wallet, provider),
    getRepays(vaults, wallet, provider),
    getLiquidations(smartVaultManagerContract, provider),
    getTransfers(smartVaultManagerContract, provider, wallet, network)
  ]), ...vaultCreations]).flat());
  await saveToRedis(transactions, unindexedVaults);
  const endTs = getTs();
  console.log(`indexed transactions (${endTs - startTs}s)`);
};

const scheduleVaultTransactionIndexing = async _ => {
  let running = false;
  schedule.scheduleJob('* * * * *', async _ => {
    if (!running) {
      running = true;
      await indexVaultTransactions();
      running = false;
    }
  });
};

module.exports = {
  scheduleVaultTransactionIndexing
};