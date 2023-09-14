const { getContract } = require("./contractFactory");

const getVaultAddresses = async (wallet, network) => {
  const VaultManagerContract = await getContract(network.name, 'SmartVaultManager');

  const filter = VaultManagerContract.filters.VaultDeployed();
  const eventData = await (VaultManagerContract).connect(wallet)
    .queryFilter(filter);
  return eventData.filter(e => e.args).map(e => e.args[0]);
};

module.exports = {
  getVaultAddresses
};