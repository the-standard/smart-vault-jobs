const https = require('https');
const schedule = require('node-schedule');
const { getContract } = require("./contractFactory");
const { ethers, BigNumber } = require('ethers');
const { getNetwork } = require('./networks');

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

const liquidatableVaults = async (wallet, vaultManager) => {
  const supply = Number((await getVaultSupply(wallet, vaultManager)).toString());
  const embeds = []
  for (let tokenID = 1; tokenID <= supply; tokenID++) {
    try {
      const { minted, totalCollateralValue, vaultAddress, vaultType } = (await vaultManager.connect(wallet).vaultData(tokenID)).status;
      if (minted.gt(0)) {
        const collateralPercentage = totalCollateralValue.mul(100).div(minted);
        const arbiscanURL = `https://arbiscan.io/address/${vaultAddress}`;
        if (collateralPercentage.lt(125)) {
          const formattedDebt = ethers.utils.formatEther(minted);
          const formattedVaultType = ethers.utils.parseBytes32String(vaultType);
          embeds.push({author: {name: `ID: ${tokenID}`, url: arbiscanURL}, title: vaultAddress, description: `debt: ${formattedDebt} ${formattedVaultType}, collateral: ${collateralPercentage}%`, url: arbiscanURL});
        }
      }
    } catch (e) {
      console.log(`vault data error ${tokenID}`);
    }
  }
  return embeds;
}

const scheduleLiquidation = async _ => {
  const network = getNetwork('arbitrum');

  // posts liquidation info to discord
  schedule.scheduleJob('55 7 * * *', async _ => {
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
    const embeds = [ 
      ... await liquidatableVaults(wallet, vaultManagerEUROs),
      ... await liquidatableVaults(wallet, vaultManagerUSDs)
    ]
  
    await postToDiscord(content, embeds);
  });
};

module.exports = {
  scheduleLiquidation
};