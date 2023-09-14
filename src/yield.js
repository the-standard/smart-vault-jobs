const https = require('https');
const schedule = require('node-schedule');
const { createClient } = require('redis');

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || '6379';
const CAMELOT_LIQUIDITY_API_URL = 'https://api.camelot.exchange/v2/liquidity-v3-data';
const POOL_ADDRESS = '0xc9AA2fEB84F0134a38d5D1c56b1E787191327Cb0';
const GRAIL_ADDRESS = '0x3d9907f9a368ad0a51be60f7da3b97cf940982d8';
const TST_ADDRESS = '0xf5A27E55C748bCDdBfeA5477CB9Ae924f0f7fd2e';

const redis = createClient({
  url: `redis://${redisHost}:${redisPort}`
});
redis.on('error', err => console.log('Redis Client Error', err));

const saveToRedis = async data => {
  const ts = Math.floor(new Date() / 1000);
  await redis.connect();
  await redis.set(`yield:${GRAIL_ADDRESS}`, `${ts}:${data.tvl}:${data.apy}`);
  await redis.set(`yield:${TST_ADDRESS}`, `${ts}:${data.tvl}:5`);
  await redis.disconnect();
}

const getCamelotData = async _ => {
  return new Promise(resolve => {
    https.get(CAMELOT_LIQUIDITY_API_URL, res => {
      let json = '';
  
      res.on('data', data => {
        json += data;
      });
  
      res.on('end', _ => {
        const poolData = JSON.parse(json).data.pools[POOL_ADDRESS];
        resolve({
          tvl: poolData.activeTvlUSD,
          apy: poolData.activeTvlAverageAPR
        })
      });
    });
  })
}

const scheduleIndexYieldData = _ => {
  schedule.scheduleJob(`*/15 * * * *`, async _ => {
    await saveToRedis(await getCamelotData());
  });
}

module.exports = {
  scheduleIndexYieldData
}