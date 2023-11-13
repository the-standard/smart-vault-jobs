const schedule = require('node-schedule');
const { getContract } = require("./contractFactory");
const { ethers } = require('ethers');
const { getNetwork } = require('./networks');

const getVaultSupply = async (wallet, manager) => {
  try {
    return await manager.connect(wallet).totalSupply();
  } catch (_) {
    return await getVaultSupply(wallet, manager);
  }
}

const scheduleLiquidation = async _ => {
  const network = getNetwork('arbitrum');
  const manager = await getContract(network.name, 'SmartVaultManager');
  const provider = new ethers.getDefaultProvider(network.rpc)
  const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
  let tokenId = Math.floor(Math.random() * await getVaultSupply(wallet, manager)) + 1;
  let running = false;
  schedule.scheduleJob('*/15 * * * * *', async _ => {
    if (!running) {
      running = true;
      console.log(`attempting liquidation vault #${tokenId}`);
      try {
        await manager.connect(wallet).liquidateVault(tokenId);
        console.log(`liquidated: ${tokenId}`);
      } catch (e) {
        console.log(`liquidation attempt failed`);
      }
      tokenId++;
      if (tokenId > await getVaultSupply(wallet, manager)) tokenId = 1;
      running = false;
    }
  });
}

module.exports = {
  scheduleLiquidation
}