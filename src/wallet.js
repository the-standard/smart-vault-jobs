const { ethers } = require("ethers");

const getWallet = network => {
  const provider = new ethers.getDefaultProvider(network.rpc)
  const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
  return { wallet, provider };
}

module.exports = {
  getWallet
}