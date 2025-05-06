const { ethers, BigNumber } = require('ethers');
const https = require('https')
const Pool = require('pg-pool');
const { getContract } = require('./contractFactory');
const { getNetwork } = require('./networks');
const { formatUnits, formatEther } = require('ethers/lib/utils');

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

const entryPools = {
  '0x0000000000000000000000000000000000000000': '0xc6962004f452be9203591991d15f6b388e09e8d0',
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': '0xc6962004f452be9203591991d15f6b388e09e8d0',
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': '0x0e4831319a50228b9e450861297ab92dee15b44f',
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': '0xbe3ad6a5669dc0b8b12febc03608860c31e2eef6',
  '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': '0x468b88941e7cc0b88c1869d68ab6b570bcef62ff',
  '0x912ce59144191c1204e64559fe8253a0e49e6548': '0xc6f780497a95e246eb9449f5e4770916dcd6396a'
}

const clFeeds = {
  '0x0000000000000000000000000000000000000000': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': '0xd0C7101eACbB49F3deCcCc166d238410D6D46d57',
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7',
  '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': '0x86E53CF1B870786351Da77A57575e79CB55812CB',
  '0x912ce59144191c1204e64559fe8253a0e49e6548': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6'
}

const post = async query => {
  const dataString = JSON.stringify({ query });

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': dataString.length,
    },
    timeout: 2000
  }

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.studio.thegraph.com/query/109184/smart-vault-history/v1.2.1', options, (res) => {
      if (res.statusCode < 200 || res.statusCode > 299) {
        return reject(new Error(`HTTP status code ${res.statusCode}`))
      }

      const body = []
      res.on('data', (chunk) => body.push(chunk))
      res.on('end', () => {
        const resString = Buffer.concat(body).toString()
        resolve(JSON.parse(resString))
      })
    })

    req.on('error', (err) => {
      reject(err)
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request time out'))
    })

    req.write(dataString)
    req.end()
  })
}

const getDetailedActivity = async activityID => {
  return (await post(`query { autoRedemption(id: "${activityID}") { token USDsRedeemed } }`)).data.autoRedemption;
}

const calculateCollateralSwapped = async (activity, provider) => {
  const poolAddr = entryPools[activity.token.toLowerCase()];
  const swapHopOneLog = (await provider.getTransactionReceipt(activity.id)).logs
    .filter(log => log.address.toLowerCase() === poolAddr)[0];
  const contract = await getContract('arbitrum', 'UniswapV3Pool', poolAddr);
  const decodedEventArgs = contract.interface.parseLog(swapHopOneLog).args;
  return decodedEventArgs.amount0.gt(0) ?
    decodedEventArgs.amount0 : decodedEventArgs.amount1;
}

const convertToUSDHistorical = async (activity, provider) => {
  const clFeed = (await getContract('arbitrum', 'Chainlink', clFeeds[activity.token])).connect(provider);
  let { updatedAt, roundId, answer } = await clFeed.latestRoundData();
  while(updatedAt.gt(activity.blockTimestamp)) {
    console.log(updatedAt.sub(1746505440).toString());
    roundId = roundId.sub(1);
    ({updatedAt, answer} = await clFeed.getRoundData(roundId));
  }
  return formatUnits(activity.collateralSold.mul(answer), 8 + activity.decimals);
}

const scheduleRedemptionChecks = async _ => {
  const provider = new ethers.getDefaultProvider(getNetwork('arbitrum').rpc);
  const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
  const client = await pool.connect();
  try {
    const lastRedemptionQuery = 'SELECT redeemed_at FROM redemptions ORDER BY redeemed_at DESC LIMIT 1;';
    const lastRedemptionTS = new Date((await client.query(lastRedemptionQuery)).rows[0].redeemed_at)/1000;
    console.log(lastRedemptionTS)
    // const activities = (await post(
    //   `query { smartVaultActivities(where: {detailType: "autoRedemption", blockTimestamp_gt: ${lastRedemptionTS}} orderBy: blockTimestamp orderDirection: asc) { id vault{id} blockTimestamp } }`
    // )).data.smartVaultActivities;

    // for (let i = 0; i < 1; i++) {
    //   const activity = { ... activities[i], ... await getDetailedActivity(activities[i].id) }
    //   activity.symbol = activity.token === ethers.constants.AddressZero ?
    //     'ETH' : await (await getContract('arbitrum', 'ERC20', activity.token)).connect(wallet).symbol();
    //   activity.decimals = activity.token === ethers.constants.AddressZero ?
    //     18 : await (await getContract('arbitrum', 'ERC20', activity.token)).connect(wallet).decimals();
    //   activity.collateralSold = await calculateCollateralSwapped(activity, provider);
    //   activity.collateralSoldUSD = await convertToUSDHistorical(activity, provider);
    //   const insertRedemptionQuery = 'INSERT INTO redemptions (tx_hash,vault_address,collateral_token,redeemed_at,usds_redeemed,collateral_sold,collateral_sold_usd) values ($1,$2,$3,$4,$5,$6,$7)'
    //   await client.query(insertRedemptionQuery, [
    //     activity.id,
    //     activity.vault.id,
    //     activity.symbol,
    //     new Date(activity.blockTimestamp*1000),
    //     formatEther(BigNumber.from(activity.USDsRedeemed)),
    //     formatUnits(activity.collateralSold, activity.decimals),
    //     activity.collateralSoldUSD
    //   ])
    // }

  } catch (e) {
    console.log(e);
  } finally {
    client.release();
  }
}

module.exports = {
  scheduleRedemptionChecks
}