const schedule = require('node-schedule');
const { getContract } = require("./contractFactory");
const { ethers } = require('ethers');
const { getNetwork } = require('./networks');

const scheduleLiquidation = async _ => {
  const network = getNetwork('arbitrum');
  const manager = await getContract(network.name, 'SmartVaultManager');
  let tokenId = 1;
  schedule.scheduleJob('* * * * *', async _ => {
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
    if (tokenId > await manager.connect(wallet).totalSupply()) tokenId = 1;
  });
}

module.exports = {
  scheduleLiquidation
}