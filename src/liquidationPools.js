const https = require('https');
const schedule = require('node-schedule');
const { getDefaultProvider, Wallet, utils, BigNumber } = require('ethers');
const { parseBytes32String, formatUnits } = utils;
const Pool = require('pg-pool');
const { getNetwork } = require("./networks");
const { getContract } = require('./contractFactory');
const { formatEther, parseUnits } = require('ethers/lib/utils');
const { createClient } = require('redis');
const { WALLET_PRIVATE_KEY } = process.env;

const EUROS_ADDRESS = '0x643b34980e635719c15a2d4ce69571a258f940e9';
const TST_ADDRESS = '0xf5a27e55c748bcddbfea5477cb9ae924f0f7fd2e';

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || '6379';

const {
  POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USERNAME, POSTGRES_PASSWORD
} = process.env;

let pool = new Pool({
  database: POSTGRES_DB,
  user: POSTGRES_USERNAME,
  password: POSTGRES_PASSWORD,
  host: POSTGRES_HOST,
  port: POSTGRES_PORT
});

const redis = createClient({
  url: `redis://${redisHost}:${redisPort}`
});
redis.on('error', err => console.log('Redis Client Error', err));

const convert = (amount, price, dec) => {
  return Number(formatUnits(amount.mul(price)
    .div(BigNumber.from(10).pow(8)), dec)).toFixed(2);
};

const cachedPrice = async address => {
  await redis.connect();
  const cached = await redis.GET(`cached:${address}`);
  await redis.disconnect();
  return cached;
}

const cachePrice = async (address, price) => {
  await redis.connect();
  await redis.SET(`cached:${address}`, price);
  await redis.disconnect();
}

const fetchDexPrice = async address => {
  return new Promise(async resolve => {
    https.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, res => {
      let json = '';

      res.on('data', data => {
        json += data;
      });

      res.on('end', async _ => {
        try {
          const price = parseUnits(JSON.parse(json).pairs[0].priceUsd, 8).toString();
          await cachePrice(address, price);
          resolve(price);
        } catch (e) {
          console.log(e);
          resolve(await cachedPrice(address));
        }
      });
    });
  });
};

const fetchPrices = async (networkName, wallet) => {
  const prices = {};
  prices.EUROs = await fetchDexPrice(EUROS_ADDRESS);
  prices.TST = await fetchDexPrice(TST_ADDRESS);
  const tokens = await (await getContract(networkName, 'TokenManager')).connect(wallet).getAcceptedTokens();
  for (let i = 0; i < tokens.length; i++) {
    prices[tokens[i].symbol] = (await (await getContract(networkName, 'Chainlink', tokens[i].clAddr)).connect(wallet).latestRoundData()).answer.toString();
  }
  return prices;
};

const scheduleLiquidationPoolData = async _ => {
  schedule.scheduleJob('31 * * * *', async _ => {
    console.log('indexing liquidation pool snapshots')
    const network = getNetwork('arbitrum');
    const provider = new getDefaultProvider(network.rpc);
    const wallet = new Wallet(WALLET_PRIVATE_KEY, provider);
    const liquidationPool = await (await getContract(network.name, 'LiquidationPool')).connect(wallet);
    const prices = await fetchPrices(network.name, wallet);
    let i = 0;
    while (true) {
      try {
        const holderAddress = await liquidationPool.holders(i);
        const { _position, _rewards } = await liquidationPool.position(holderAddress);
        const rewardsArray = _rewards.map((reward) =>
          [parseBytes32String(reward.symbol), formatUnits(reward.amount, reward.dec), convert(reward.amount, prices[reward.symbol], reward.dec)]);
        const assets = [
          ['TST', formatEther(_position.TST), convert(_position.TST, prices.TST, 18)],
          ['EUROs', formatEther(_position.EUROs), convert(_position.EUROs, prices.EUROs, 18)],
          ...rewardsArray
        ];

        const now = new Date();
        const client = await pool.connect();
        try {
          console.log(POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USERNAME, POSTGRES_PASSWORD.length)
          const query = 'INSERT INTO user_pool_snapshots (user_address,assets,snapshot_at) VALUES ($1,$2,$3);';
          const data = [
            holderAddress.toLowerCase(),
            assets,
            now
          ];
          await client.query(query, data);
        } catch (e) {
          console.log(e);
        } finally {
          client.release();
          i++;
        }
      } catch {
        console.log('indexed liquidation pool snapshots');
        break;
      }
    }
  });
};

module.exports = {
  scheduleLiquidationPoolData
};