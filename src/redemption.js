const https = require('https');
const { ethers, BigNumber } = require("ethers");
const { createClient } = require('redis');
const schedule = require('node-schedule');
const { getContract } = require("./contractFactory");
const { getNetwork } = require("./networks");

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || '6379';
const redis = createClient({
  url: `redis://${redisHost}:${redisPort}`
});
redis.on('error', err => console.log('Redis Client Error', err));


const USDsHypervisor = '0x547a116a2622876ce1c8d19d41c683c8f7bec5c0';
const PAXG = '0xfeb4dfc8c4cf7ed305bb08065d08ec6ee6728429'
const hypervisors = {
  '0x0000000000000000000000000000000000000000': '0x52ee1ffba696c5e9b0bc177a9f8a3098420ea691',
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': '0x52ee1ffba696c5e9b0bc177a9f8a3098420ea691',
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': '0x52ee1ffba696c5e9b0bc177a9f8a3098420ea691',
  '0x912ce59144191c1204e64559fe8253a0e49e6548': '0x6b7635b7d2e85188db41c3c05b1efa87b143fce8',
  '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': '0xfa392dbefd2d5ec891ef5aeb87397a89843a8260',
  '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a': '0xf08bdbc590c59cb7b27a8d224e419ef058952b5f',
  '0x3082cc23568ea640225c2467653db90e9250aaa0': '0x2bcbdd577616357464cfe307bc67f9e820a66e80'
}

const getVaultManager = async _ => {
  const network = getNetwork('arbitrum');
  const manager = await getContract(network.name, 'SmartVaultManager', '0x496aB4A155C8fE359Cd28d43650fAFA0A35322Fb');
  const provider = new ethers.getDefaultProvider(network.rpc);
  const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
  return { manager, wallet, provider };
};

const getVaultSupply = async (wallet, manager) => {
  try {
    return await manager.connect(wallet).totalSupply();
  } catch (_) {
    return await getVaultSupply(wallet, manager);
  }
};

const isHypervisorAddress = key => {
  return key.substring(0,2) === '0x' && key !== USDsHypervisor;
}

const getLockedCollateral = async (vaultAddress) => {
  return new Promise(resolve => {
    https.get(`https://wire2.gamma.xyz/arbitrum/user/${vaultAddress}`, res => {
      let json = '';

      res.on('data', data => {
        json += data;
      });

      res.on('end', _ => {
        const results = JSON.parse(json)[vaultAddress.toLowerCase()];
        if (results) {
          return resolve(
            Object.keys(results).filter(isHypervisorAddress).map(h => {
              return {
                address: h,
                value: ethers.utils.parseEther(results[h.toLowerCase()]['balanceUSD'].toString())
              }
            })
          )
        }
        resolve([]);
      });
    });
  });
};

const byValue = (a,b) => {
  return a.value.lt(b.value) ? 0 : -1;
}

const hypervisorOrAddress0For = (collateral, lockedCollateral) => {
  const filtered = lockedCollateral.filter(c => c.address === hypervisors[collateral]);
  return (filtered[0] && filtered[0].address) || ethers.constants.AddressZero;
}

const optimalCollateralFor = (hypervisor, collateral) => {
  const filtered = collateral.filter(c => hypervisors[c.address] === hypervisor);
  return filtered.sort(byValue)[0].address;
}

const saveRedemptionData = async data => {
  data = (({ tokenID, collateral, hypervisor }) => ({ tokenID, collateral, hypervisor }))(data);
  await redis.connect();
  await redis.HSET('redemption', data);
  await redis.disconnect();
}

const scheduleRedemptionData = async _ => {
  schedule.scheduleJob('22,52 * * * *', async _ => {
    console.log('indexing redemption data')
    const { manager, wallet } = await getVaultManager();
    const supply = Number((await getVaultSupply(wallet, manager)).toString());
    let candidate = {
      minted: BigNumber.from(0)
    }
    for (let tokenID = 1; tokenID <= supply; tokenID++) {
      const { minted, vaultAddress, collateral, totalCollateralValue } = (await manager.connect(wallet).vaultData(tokenID)).status;
      if (minted.gt(candidate.minted)) {
        const simpleCollateralSorted = collateral.filter(c => c.token.addr.toLowerCase() !== PAXG).map(c => {
          return {
            address: c.token.addr.toLowerCase(),
            value: c.collateralValue
          }
        }).sort(byValue)
        
        const lockedCollateralSorted = tokenID > 107 ? (await getLockedCollateral(vaultAddress)).sort(byValue) : [];
        const potentialCandidate = {
          tokenID,
          minted
        };
        if (lockedCollateralSorted.length > 0 && simpleCollateralSorted[0].value.lt(lockedCollateralSorted[0].value)) {
          potentialCandidate.mainValue = lockedCollateralSorted[0].value;
          potentialCandidate.hypervisor = lockedCollateralSorted[0].address;
          potentialCandidate.collateral = optimalCollateralFor(potentialCandidate.hypervisor, simpleCollateralSorted);
        } else {
          potentialCandidate.mainValue = simpleCollateralSorted[0].value;
          potentialCandidate.collateral = simpleCollateralSorted[0].address;
          potentialCandidate.hypervisor = hypervisorOrAddress0For(potentialCandidate.collateral, lockedCollateralSorted);
        }
        // check that main part of redeemable value is at least 10% of whole vault value
        // we don't want a case of a vault with $1 eth and $100000 paxg being used to redeem 1 USDs of its debt
        if (potentialCandidate.mainValue.mul(10).div(totalCollateralValue).gt(0)) {
          candidate = potentialCandidate;
        }
      }
    }
    if (candidate.tokenID) await saveRedemptionData(candidate);
    console.log('indexed redemption data')
  });
};


module.exports = {
  scheduleRedemptionData
};