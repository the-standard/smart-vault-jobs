const fs = require('fs');
const https = require('https');
const schedule = require('node-schedule');
const { ethers } = require("ethers");
const { createClient } = require('redis');
const { getArchiveNode, getNetwork } = require("./networks");
const { getWallet } = require('./wallet');
const { getContract } = require('./contractFactory');
const { getVaultAddresses } = require('./vaults');

const contracts = JSON.parse(fs.readFileSync('contracts.json', { encoding: 'utf8' }));
const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || '6379';

const redis = createClient({
  url: `redis://${redisHost}:${redisPort}`
});
redis.on('error', err => console.log('Redis Client Error', err));

const LATEST_INDEXED_BLOCK_KEY = 'tx:latestBlock';
const SMART_VAULT_LAUNCH_BLOCK = 117059962;
let startBlock;
let endBlock;
let tokenDecs = {};

const withBlockLimits = filter => {
  return {
    ... filter,
    fromBlock: startBlock,
    toBlock: endBlock
  }
}

const addVaultStatus = async (transactions) => {
  const transactionsWithStatus = [];
  for (let i = 0; i < transactions.length; i++) {
    const transaction = transactions[i]
    const { wallet } = getWallet(getArchiveNode('arbitrum'));
    const vault = new ethers.Contract(transaction.vaultAddress, contracts.SmartVault, wallet);
    const { minted, totalCollateralValue } = await vault.status({blockTag: transaction.blockNumber});
    transactionsWithStatus.push({ ... transaction, minted: minted.toString(), totalCollateralValue: totalCollateralValue.toString() });
  }
  return transactionsWithStatus;
}

const getERC20DepositsForVaults = async (vaults, tokens, wallet, provider) => {
  let deposits = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const tokenContract = new ethers.Contract(token.addr, contracts.ERC20, wallet);
    const filter = withBlockLimits(tokenContract.filters.Transfer(null, vaults));
    const tokenDepositEvents = await tokenContract.queryFilter(filter);
    for (let j = 0; j < tokenDepositEvents.length; j++) {
      const tokenDepositEvent = tokenDepositEvents[j];
      deposits.push({
        type: 'deposit',
        txHash: tokenDepositEvent.transactionHash.toLowerCase(),
        blockNumber: tokenDepositEvent.blockNumber,
        asset: ethers.utils.parseBytes32String(token.symbol),
        vaultAddress: tokenDepositEvent.args.to.toLowerCase(),
        amount: tokenDepositEvent.args.value.toString(),
        amountDec: token.dec,
        timestamp: (await provider.getBlock(tokenDepositEvent.blockNumber)).timestamp
      })
    }
  }

  return deposits;
}

const allTransactionsFor = async vault => {
  const url = `https://api.arbiscan.io/api?module=account&action=txlist&address=${vault}&startblock=${startBlock}&endBlock=${endBlock}&sort=asc&apikey=${process.env.ARBISCAN_KEY}`
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
}

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
      amountDec: 18,
      timestamp: tx.timeStamp
    }
  })
}

const requestRateLimit = async ms => {
  return new Promise(resolve => {
    setTimeout(() => resolve(), ms);
  });
}

const getAllEthDeposits = async (vaults) => {
  let deposits = [];

  for (let i = 0; i < vaults.length; i++) {
    await requestRateLimit(500)
    deposits = [ ... deposits, ... await vaultEthDeposits(vaults[i])];
  }

  return deposits;
}

const getWithdrawals = async (vaults, wallet, provider) => {
  let withdrawals = [];
  for (let i = 0; i < vaults.length; i++) {
    const vault = vaults[i]
    const vaultContract = new ethers.Contract(vault, contracts.SmartVault, wallet);
    const filter = withBlockLimits(vaultContract.filters.CollateralRemoved());
    const vaultWithdrawals = await vaultContract.queryFilter(filter);
    for (let j = 0; j < vaultWithdrawals.length; j++) {
      const vaultWithdrawal = vaultWithdrawals[j];
      withdrawals.push({
        type: 'withdrawal',
        txHash: vaultWithdrawal.transactionHash.toLowerCase(),
        blockNumber: vaultWithdrawal.blockNumber,
        asset: ethers.utils.parseBytes32String(vaultWithdrawal.args.symbol),
        vaultAddress: vault.toLowerCase(),
        amount: vaultWithdrawal.args.amount.toString(),
        amountDec: tokenDecs[vaultWithdrawal.args.symbol],
        timestamp: (await provider.getBlock(vaultWithdrawal.blockNumber)).timestamp
      })
    }
  }
  return withdrawals;
}

const getBorrows = async (vaults, wallet, provider) => {
  let borrows = [];
  for (let i = 0; i < vaults.length; i++) {
    const vault = vaults[i]
    const vaultContract = new ethers.Contract(vault, contracts.SmartVault, wallet);
    const filter = withBlockLimits(vaultContract.filters.EUROsMinted());
  
    const vaultBorrows = await vaultContract.queryFilter(filter);
    for (let j = 0; j < vaultBorrows.length; j++) {
      const vaultBorrow = vaultBorrows[j];
      borrows.push({
        type: 'borrow',
        txHash: vaultBorrow.transactionHash.toLowerCase(),
        blockNumber: vaultBorrow.blockNumber,
        asset: 'EUROs',
        vaultAddress: vault.toLowerCase(),
        amount: vaultBorrow.args.amount.toString(),
        amountDec: 18,
        timestamp: (await provider.getBlock(vaultBorrow.blockNumber)).timestamp
      })
    }
  }
  return borrows;
}

const getRepays = async (vaults, wallet, provider) => {
  let repays = [];
  for (let i = 0; i < vaults.length; i++) {
    const vault = vaults[i]
    const vaultContract = new ethers.Contract(vault, contracts.SmartVault, wallet);
    const filter = withBlockLimits(vaultContract.filters.EUROsBurned());
  
    const vaultRepays = await vaultContract.queryFilter(filter);
    for (let j = 0; j < vaultRepays.length; j++) {
      const vaultRepay = vaultRepays[j];
      repays.push({
        type: 'repay',
        txHash: vaultRepay.transactionHash.toLowerCase(),
        blockNumber: vaultRepay.blockNumber,
        asset: 'EUROs',
        vaultAddress: vault.toLowerCase(),
        amount: vaultRepay.args.amount.toString(),
        amountDec: 18,
        timestamp: (await provider.getBlock(vaultRepay.blockNumber)).timestamp
      })
    }
  }
  return repays;
}

const getLiquidations = async (smartVaultManagerContract, provider) => {
  const liquidations = [];
  const filter = withBlockLimits(smartVaultManagerContract.filters.VaultLiquidated());

  const liquidationEvents = await smartVaultManagerContract.queryFilter(filter);
  for (let i = 0; i < liquidationEvents.length; i++) {
    const event = liquidationEvents[i];
    liquidations.push({
      type: 'liquidation',
      txHash: event.transactionHash.toLowerCase(),
      blockNumber: event.blockNumber,
      asset: 'n/a',
      vaultAddress: event.args.vaultAddress.toLowerCase(),
      amount: '0',
      amountDec: 0,
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
      amountDec: 0,
      timestamp: (await provider.getBlock(previousBlock)).timestamp
    });
  }
  return liquidations;
}

const getTs = _ => {
  return Math.floor(new Date() / 1000);
}

const setStartBlock = async _ => {
  await redis.connect();
  const lastIndexed = await redis.get(LATEST_INDEXED_BLOCK_KEY);
  startBlock = lastIndexed ? parseInt(lastIndexed) : SMART_VAULT_LAUNCH_BLOCK;
  await redis.disconnect();
}

const setEndBlock = async provider => {
  endBlock = await provider.getBlockNumber();
}

const getAcceptedERC20s = async (network, wallet) => {
  return (await (await getContract(network.name, 'TokenManager')).connect(wallet).getAcceptedTokens())
    .filter(token => token.addr !== ethers.constants.AddressZero);
}

const saveToRedis = async transactions => {
  // SCHEMA:
  // key: 'vaultTxs:0x...'
  // score: timestamp
  // value: 'type:hash:blockNo:asset:amount:amountDec:minted:collateralValue'
  // e.g. 'deposit:0x8ae26a528861d3e6c08d4331885eaba2d1b5b55fc540234fc9b8c9c198a0d429:124132949:PAXG:8000000000000000:18:136175000000000000000:181087962079756018667'

  let redisTx = await redis.MULTI();
  for (let i = 0; i < transactions.length; i++) {
    const transaction = transactions[i];
    const key = `vaultTxs:${transaction.vaultAddress}`;
    const score = transaction.timestamp;
    const value = `${transaction.type}:${transaction.txHash}:${transaction.blockNumber}:${transaction.asset}:${transaction.amount}:${transaction.amountDec}:${transaction.minted}:${transaction.totalCollateralValue}`
    redisTx = redisTx.ZADD(key, [{score, value}]);
  }

  await redis.connect();
  await redisTx
    .SET(LATEST_INDEXED_BLOCK_KEY, endBlock)
    .EXEC();
  await redis.disconnect();
}

const setTokenDecs = tokens => {
  tokenDecs[ethers.utils.formatBytes32String('ETH')] = 18;
  tokens.forEach(token => {
    tokenDecs[token.symbol] = token.dec;
  });
}

const indexVaultTransactions = async _ => {
  try {
    const startTs = getTs();
    const network = getNetwork('arbitrum');
    const { wallet, provider } = getWallet(network);
    await setStartBlock();
    await setEndBlock(provider);
    console.log(`indexing transactions from block ${startBlock} to ${endBlock} ...`);
    const smartVaultManagerContract = (await getContract(network.name, 'SmartVaultManager')).connect(wallet);
    const erc20Tokens = await getAcceptedERC20s(network, wallet);
    setTokenDecs(erc20Tokens);
    const vaults = await getVaultAddresses(wallet, network);
    const transactions = await addVaultStatus((await Promise.all([
      getERC20DepositsForVaults(vaults, erc20Tokens, wallet, provider),
      getAllEthDeposits(vaults),
      getWithdrawals(vaults, wallet, provider),
      getBorrows(vaults, wallet, provider),
      getRepays(vaults, wallet, provider),
      getLiquidations(smartVaultManagerContract, provider)
    ])).flat());
    await saveToRedis(transactions);
    const endTs = getTs();
    console.log(`indexed transactions (${endTs - startTs}s)`)
  } catch (e) {
    console.error(e);
    // try again - rpc issues can be erratic
    await indexVaultTransactions();
  }
}

const scheduleVaultTransactionIndexing = async _ => {
  const job = schedule.scheduleJob('2,32 * * * *', async _ => {
    await indexVaultTransactions();
  });
  job.on('error', err => {
    console.log(err);
  });
}

module.exports = {
  scheduleVaultTransactionIndexing
}