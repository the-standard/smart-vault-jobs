const schedule = require('node-schedule');
const { createClient } = require('redis');
require('ethers');
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

const priceDataLength = 48;

let wallet;

const addNewPrice = async (networkName, token, ts) => {
  const symbol = ethers.decodeBytes32String(token.symbol);
  const chainlinkContract = await getContract(networkName, 'Chainlink', token.clAddr);
  const data = await chainlinkContract.connect(wallet).latestRoundData();
  await redis.connect();
  await redis.SADD(`tokens:${networkName}`, symbol);
  await redis.ZADD(`prices:${networkName}:${symbol}`, [{score: ts, value: `${ts}:${data.answer.toString()}`}]);
  await redis.ZREMRANGEBYRANK(`${networkName}:${symbol}`, 0, priceDataLength * -1 - 1);
  await redis.disconnect();
}

const schedulePricingIndexing = async _ => {
  delay = 0;
  getNetworks().forEach(network => {
    schedule.scheduleJob(`${delay} */30 * * * *`, async _ => {
      console.log(`indexing prices ${network.name} ...`);
      const provider = new ethers.getDefaultProvider(network.rpc);
      wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
      const ts = Math.floor(new Date() / 1000);
      const tokens = await (await getContract(network.name, 'TokenManager')).connect(wallet).getAcceptedTokens();
      for (let i = 0; i < tokens.length; i++) {
        await addNewPrice(network.name, tokens[i], ts);
      }
      console.log(`indexed prices ${network.name}`);
    });
    delay += 10;
  });
};

module.exports = {
  schedulePricingIndexing
}