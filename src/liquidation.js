const https = require('https');
const schedule = require('node-schedule');
const { getContract } = require("./contractFactory");
const { ethers } = require('ethers');
const { getNetwork } = require('./networks');
const { createClient } = require('redis');

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || '6379';
const redis = createClient({
  url: `redis://${redisHost}:${redisPort}`
});
redis.on('error', err => console.log('Redis Client Error', err));

const getVaultSupply = async (wallet, manager) => {
  try {
    return await manager.connect(wallet).totalSupply();
  } catch (_) {
    return await getVaultSupply(wallet, manager);
  }
};

const postToDiscord = async (content, embeds) => {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      content,
      embeds
    });

    const options = {
      hostname: 'discord.com',
      port: 443,
      path: `/api/webhooks/1254770462186143816/${process.env.WEBHOOK_TOKEN}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      },
    };

    const req = https.request(options, (res) => {
      res.on('data', (d) => {
        process.stdout.write(d);
      });
    });

    req.on('error', (error) => {
      console.error(error);
      reject();
    });

    req.write(data);
    req.end();
    console.log('posted liquidation data to discord')
    resolve();
  });
};

const atRiskVaults = async (wallet, vaultManager) => {
  const supply = Number((await getVaultSupply(wallet, vaultManager)).toString());
  const embeds = []
  for (let tokenID = 1; tokenID <= supply; tokenID++) {
    console.log(tokenID)
    try {
      const { minted, totalCollateralValue, vaultAddress, vaultType } = (await vaultManager.connect(wallet).vaultData(tokenID)).status;
      if (minted.gt(0)) {
        const collateralPercentage = totalCollateralValue.mul(100).div(minted);
        const arbiscanURL = `https://arbiscan.io/address/${vaultAddress}`;
        if (collateralPercentage.lt(125)) {
          const formattedDebt = ethers.utils.formatEther(minted);
          const formattedVaultType = ethers.utils.parseBytes32String(vaultType);
          embeds.push({tokenID, formattedVaultType, arbiscanURL, vaultAddress, formattedDebt, collateralPercentage});
        }
      }
    } catch (e) {
      console.log(`vault data error ${tokenID}`);
    }
  }
  return embeds;
}

const postingFormat = data => {
  const { tokenID, formattedVaultType, arbiscanURL, vaultAddress, formattedDebt, collateralPercentage } = data;
  return {author: {name: `ID: ${tokenID} ${formattedVaultType}`, url: arbiscanURL}, title: vaultAddress, description: `debt: ${formattedDebt} ${formattedVaultType}, collateral: ${collateralPercentage}%`, url: arbiscanURL}
}

const saveTokenIDsToRedis = async data => {
  const key = 'atRiskVaults';
  await redis.connect();
  await redis.MULTI()
    .DEL(key)
    .SADD(key, data.map(vault => vault.tokenID.toString()))
    .EXEC();
  await redis.disconnect();
}

const scheduleLiquidation = async _ => {
  const network = getNetwork('arbitrum');

  // posts liquidation info to discord
  schedule.scheduleJob('51 */4 * * *', async _ => {
    console.log('logging liquidation info');
    const provider = new ethers.getDefaultProvider(network.rpc);
    const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
    const vaultManagerEUROs = await getContract(network.name, 'SmartVaultManager');
    const vaultManagerUSDs = await getContract(network.name, 'SmartVaultManager', '0x496aB4A155C8fE359Cd28d43650fAFA0A35322Fb');
    const EUROs = await getContract(network.name, 'EUROs');
    const USDs = await getContract(network.name, 'EUROs', '0x2Ea0bE86990E8Dac0D09e4316Bb92086F304622d');
    liquidatorETHBalance = ethers.utils.formatEther(await provider.getBalance(wallet.address));
    liquidatorEUROsBalance = ethers.utils.formatEther(await EUROs.connect(wallet).balanceOf(wallet.address));
    liquidatorUSDsBalance = ethers.utils.formatEther(await USDs.connect(wallet).balanceOf(wallet.address));
  
    let content = `Liquidator wallet balance:\n**${liquidatorETHBalance} ETH**\n**${liquidatorEUROsBalance} EUROs**\n**${liquidatorUSDsBalance} USDs**\n---\n`;

    const atRiskEUROs = await atRiskVaults(wallet, vaultManagerEUROs);
    const atRiskUSDs = await atRiskVaults(wallet, vaultManagerUSDs);

    await saveTokenIDsToRedis(atRiskUSDs);
    await postToDiscord(content, [ ...atRiskEUROs, ...atRiskUSDs ].map(postingFormat));
  });
};

module.exports = {
  scheduleLiquidation
};