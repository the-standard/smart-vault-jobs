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

const getVaultManager = async _ => {
  const network = getNetwork('arbitrum');
  const manager = await getContract(network.name, 'SmartVaultManager');
  const provider = new ethers.getDefaultProvider(network.rpc);
  const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
  return { manager, wallet, provider };
};

const scheduleLiquidation = async _ => {
  const network = getNetwork('arbitrum');

  // checks for undercollateralised vaults and liquidates
    schedule.scheduleJob('6,36 * * * *', async _ => {
    console.log('running liquidations')
    const start = Math.floor(new Date / 1000);
    const index = await getContract(network.name, 'SmartVaultIndex');
    const { manager, wallet } = await getVaultManager();
    const supply = Number((await getVaultSupply(wallet, manager)).toString());
    for (let tokenID = 1; tokenID <= supply; tokenID++) {
      const vaultAddress = await index.connect(wallet).getVaultAddress(tokenID);
      const vault = await getContract(network.name, 'SmartVault', vaultAddress);
      try {
        if (await vault.connect(wallet).undercollateralised()) {
          console.log(`liquidating ${tokenID}`)
          const RewardGateway = await getContract(network.name, 'RewardGateway');
          await RewardGateway.connect(wallet).liquidateVault(tokenID);
        }
      } catch (e) {
        console.log('vault liquidation error', tokenID);
      }
    }
    const end = Math.floor(new Date / 1000);

    console.log(`liquidations complete ${end - start}s`)
  });

  // posts liquidation info to discord
  schedule.scheduleJob('55 7 * * *', async _ => {
    console.log('logging liquidation info');
    const { manager, wallet, provider } = await getVaultManager();
    const EUROs = await getContract(network.name, 'EUROs');
    liquidatorETHBalance = ethers.utils.formatEther(await provider.getBalance(wallet.address));
    liquidatorEUROsBalance = ethers.utils.formatEther(await EUROs.connect(wallet).balanceOf(wallet.address));
  
    const supply = Number((await getVaultSupply(wallet, manager)).toString());
    let content = `Liquidator wallet balance:\n**${liquidatorETHBalance} ETH**\n**${liquidatorEUROsBalance} EUROs**\n---\n`;
    let embeds = [];
    for (let tokenID = 1; tokenID <= supply; tokenID++) {
      try {
        const { minted, totalCollateralValue, vaultAddress } = (await manager.connect(wallet).vaultData(tokenID)).status;
        if (minted.gt(0)) {
          const collateralPercentage = totalCollateralValue.mul(100).div(minted);
          const formattedDebt = ethers.utils.formatEther(minted);
          const arbiscanURL = `https://arbiscan.io/address/${vaultAddress}`;
          if (collateralPercentage.lt(125)) embeds.push({author: {name: `ID: ${tokenID}`, url: arbiscanURL}, title: vaultAddress, description: `debt: ${formattedDebt}, collateral: ${collateralPercentage}%`, url: arbiscanURL});
        }
      } catch (e) {
        console.log(`vault data error ${tokenID}`);
      }
    }
  
    await postToDiscord(content, embeds);
  });
};

module.exports = {
  scheduleLiquidation
};