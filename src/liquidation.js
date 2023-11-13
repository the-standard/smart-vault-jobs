const schedule = require('node-schedule');
const { getContract } = require("./contractFactory");
const { ethers } = require('ethers');
const { getNetwork } = require('./networks');

const getVaultSupply = async wallet => {
  try {
    return await manager.connect(wallet).totalSupply()
  } catch (_) {
    return await getVaultSupply();
  }
}

const scheduleLiquidation = async _ => {
  const network = getNetwork('arbitrum');
  const manager = await getContract(network.name, 'SmartVaultManager');
  let tokenId = 1;
  let running = false;
  schedule.scheduleJob('* * * * *', async _ => {
    if (!running) {
      running = true;
      const provider = new ethers.getDefaultProvider(network.rpc)
      const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
      console.log(`attempting liquidation vault #${tokenId}`);
      try {
        await manager.connect(wallet).liquidateVault(tokenId);
        console.log(`liquidated: ${tokenId}`);
      } catch (e) {
        console.log(`liquidation attempt failed`);
      }
      tokenId++;
      if (tokenId > await getVaultSupply(wallet)) tokenId = 1;
      running = false;
    }
  });
}

module.exports = {
  scheduleLiquidation
}