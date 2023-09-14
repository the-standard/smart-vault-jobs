const schedule = require('node-schedule');
const ethers = require('ethers');
const { createClient } = require('redis');
const { getContract, getERC20 } = require('./contractFactory');
const { getNetwork } = require('./networks');
const { getVaultAddresses } = require('./vaults');

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || '6379';

const redis = createClient({
  url: `redis://${redisHost}:${redisPort}`
});
redis.on('error', err => console.log('Redis Client Error', err));

const saveTvlDateToRedis = async data => {
  await redis.connect();
  let multi = redis.MULTI()
    .DEL('assets')
    .SADD('assets', data.map(asset => asset.address));
  data.forEach(asset => {
    multi = multi.SETEX(`tvl:${asset.address}`, 3600, asset.assetTvl);
  });
  await multi.EXEC();
  await redis.disconnect();
};

const indexStats = async _ => {
  const network = getNetwork('arbitrum');
  const provider = new ethers.getDefaultProvider(network.rpc);
  const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
  const tokens = await (await getContract(network.name, 'TokenManager')).connect(wallet).getAcceptedTokens();
  const vaultAddresses = await getVaultAddresses(wallet, network);

  const tvl = [];
  for (let i = 0; i < tokens.length; i++) {
    const { addr } = tokens[i];
    let assetTvl = 0n;
    for (let j = 0; j < vaultAddresses.length; j++) {
      const vaultAddress = vaultAddresses[j];
      if (addr === ethers.constants.AddressZero) {
        assetTvl += await provider.getBalance(vaultAddress);
      } else {
        assetTvl += await (await getERC20(addr)).connect(wallet).balanceOf(vaultAddress);
      }
    }
    tvl.push({ address: addr, assetTvl: assetTvl.toString() });
  }

  await saveTvlDateToRedis(tvl);
};

const scheduleStatIndexing = async _ => {
  schedule.scheduleJob('15 10 6 * * *', async _ => {
    console.log(`indexing stats...`);
    await indexStats();
    console.log(`indexed stats.`);
  });
};

module.exports = {
  scheduleStatIndexing
};