const { ethers } = require('ethers');
const fs = require('fs');
const https = require('https');
const contracts = JSON.parse(fs.readFileSync('contracts.json', { encoding: 'utf8' }));
const addressesJSONURL = 'https://raw.githubusercontent.com/the-standard/smart-vault/main/docs/addresses.json';

const getAddressOf = async (networkName, contractName) => {
  return new Promise(resolve => {
    https.get(addressesJSONURL, res => {
      let json = '';

      res.on('data', data => {
        json += data;
      });

      res.on('end', _ => {
        resolve(JSON.parse(json)[networkName][contractName]);
      });
    });
  });
};

const getContract = async (networkName, contractName, address) => {
  if (!address) {
    address = await getAddressOf(networkName, contractName);
  }
  return new ethers.Contract(address, contracts[contractName]);
};

const getERC20 = async (address) => {
  return new ethers.Contract(address, contracts.ERC20);
}

module.exports = {
  getContract,
  getERC20
};