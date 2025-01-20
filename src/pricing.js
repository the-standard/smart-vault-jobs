const schedule = require('node-schedule');
const { createClient } = require('redis');
const { getContract } = require('./contractFactory');
const ethers = require('ethers');
const { getNetworks } = require('./networks');
require('./networks')

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || '6379';

const redis = createClient({
  url: `redis://${redisHost}:${redisPort}`
});
redis.on('error', err => console.log('Redis Client Error', err));

let wallet;

const getPricingData = async (networkName, chainlinkAddress) => {
  try {
    const chainlinkContract = await getContract(networkName, 'Chainlink', chainlinkAddress);
    return await chainlinkContract.connect(wallet).latestRoundData();
  } catch (e) {
    console.log(e);
    return await getPricingData(networkName, chainlinkAddress);
  }
}

const addNewPrice = async (networkName, token, ts) => {
  const symbol = ethers.utils.parseBytes32String(token.symbol);
  const data = await getPricingData(networkName, token.clAddr);
  await redis.connect();
  await redis.MULTI()
          .SADD(`tokens:${networkName}`, symbol)
          .ZADD(`prices:${networkName}:${symbol}`, [{score: ts, value: `${ts}:${data.answer.toString()}`}])
          .ZREMRANGEBYRANK(`prices:${networkName}:${symbol}`, 0, -49)
          .EXEC();
  await redis.disconnect();
}

const getTokensForNetwork = async networkName => {
  try {
    return await (await getContract(networkName, 'TokenManager')).connect(wallet).getAcceptedTokens();
  } catch (e) {
    console.log(e);
    return await getTokensForNetwork(networkName)
  }
}

const schedulePricingIndexing = async _ => {
  // schedule.scheduleJob('*/30 * * * *', async _ => {
    const networks = getNetworks();
    for (let i = 0; i < networks.length; i++) {
      const network = networks[i];
      console.log(`indexing prices ${network.name} ...`);
      const provider = new ethers.getDefaultProvider(network.rpc);
      wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
      const ts = Math.floor(new Date() / 1000);
      const tokens = await getTokensForNetwork(network.name);
      for (let i = 0; i < tokens.length; i++) {
        await addNewPrice(network.name, tokens[i], ts);
      }
      console.log(`indexed prices ${network.name}`);
    }
  // });
};

module.exports = {
  schedulePricingIndexing
}