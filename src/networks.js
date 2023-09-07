const networks = [
  {
    name: 'arbitrum',
    rpc: 'https://arb1.arbitrum.io/rpc'
  },
  {
    name: 'arbitrum_goerli',
    rpc: 'https://goerli-rollup.arbitrum.io/rpc'
  }
]

const getNetworks = _ => {
  return networks;
}

const getNetwork = name => {
  return networks.filter(network => network.name === name)[0];
}

module.exports = {
  getNetworks,
  getNetwork
}