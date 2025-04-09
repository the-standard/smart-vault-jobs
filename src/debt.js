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
const PAXG = '0xfeb4dfc8c4cf7ed305bb08065d08ec6ee6728429';
const hypervisors = {
  '0x0000000000000000000000000000000000000000': '0x52ee1ffba696c5e9b0bc177a9f8a3098420ea691',
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': '0x52ee1ffba696c5e9b0bc177a9f8a3098420ea691',
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': '0x52ee1ffba696c5e9b0bc177a9f8a3098420ea691',
  '0x912ce59144191c1204e64559fe8253a0e49e6548': '0x6b7635b7d2e85188db41c3c05b1efa87b143fce8',
  '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': '0xfa392dbefd2d5ec891ef5aeb87397a89843a8260',
  '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a': '0xf08bdbc590c59cb7b27a8d224e419ef058952b5f',
  '0x3082cc23568ea640225c2467653db90e9250aaa0': '0x2bcbdd577616357464cfe307bc67f9e820a66e80'
};

const byValue = (a,b) => {
  return a.value.lt(b.value) ? 0 : -1;
}

const getVaultManager = async address => {
  const network = getNetwork('arbitrum');
  const provider = new ethers.getDefaultProvider(network.rpc);
  const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
  const manager = (await getContract(network.name, 'SmartVaultManager', address)).connect(wallet);
  return { manager, provider, wallet };
};

const getVaultSupply = async (manager) => {
  try {
    return await manager.totalSupply();
  } catch (_) {
    return await getVaultSupply(manager);
  }
};

const hypervisorOrAddress0For = (collateral, lockedCollateral) => {
  const filtered = lockedCollateral.filter(c => c.address === hypervisors[collateral]);
  return (filtered[0] && filtered[0].address) || ethers.constants.AddressZero;
}

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

const optimalCollateralFor = (hypervisor, collateral) => {
  const filtered = collateral.filter(c => hypervisors[c.address] === hypervisor);
  return filtered.sort(byValue)[0].address;
}

const generateRedemptionCandidateData = async ({ collateral, vaultAddress, tokenID }) => {
  const simpleCollateralSorted = collateral.filter(c => c.token.addr.toLowerCase() !== PAXG).map(c => {
    return {
      address: c.token.addr.toLowerCase(),
      value: c.collateralValue
    }
  }).sort(byValue)
  
  const lockedCollateralSorted = tokenID > 122 ? (await getLockedCollateral(vaultAddress)).sort(byValue) : [];

  const data = {};

  if (lockedCollateralSorted.length > 0 && simpleCollateralSorted[0].value.lt(lockedCollateralSorted[0].value)) {
    data.mainValue = lockedCollateralSorted[0].value;
    data.hypervisor = lockedCollateralSorted[0].address;
    data.collateral = optimalCollateralFor(data.hypervisor, simpleCollateralSorted);
  } else {
    data.mainValue = simpleCollateralSorted[0].value;
    data.collateral = simpleCollateralSorted[0].address;
    data.hypervisor = hypervisorOrAddress0For(data.collateral, lockedCollateralSorted);
  }
  return data;
}

const postingFormat = data => {
  const { tokenID, formattedVaultType, vaultAddress, formattedDebt, collateralPercentage } = data;
  const arbiscanURL = `https://arbiscan.io/address/${vaultAddress}`;
  return {author: {name: `ID: ${tokenID} ${formattedVaultType}`, url: arbiscanURL}, title: vaultAddress, description: `debt: ${formattedDebt} ${formattedVaultType}, collateral: ${collateralPercentage}%`, url: arbiscanURL}
}

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

const getAllVaultData = async manager => {
  const supply = Number((await getVaultSupply(manager)).toString());
  const data = [];
  for (let tokenID = 1; tokenID <= supply; tokenID++) {
    console.log(tokenID)
    try {
      const { status } = await manager.vaultData(tokenID);
      data.push({ ... status, tokenID });
    } catch (e) {
      console.log('vault data error', tokenID);
    }
  }
  return data;
}

const determineRedemptionCandidate = async data => {
  for (let i = 0; i < data.length; i++) {
    const redemptionCandidateData = await generateRedemptionCandidateData(data[i]);
    if (data[i].totalCollateralValue.div(redemptionCandidateData.mainValue).lt(10)) {
      return { 
        ... redemptionCandidateData,
        tokenID: data[i].tokenID
      };
    }
  }
}

const saveRedemptionData = async data => {
  data = (({ tokenID, collateral, hypervisor }) => ({ tokenID, collateral, hypervisor }))(data);
  await redis.connect();
  await redis.HSET('redemption', data);
  await redis.disconnect();
}

const scheduleUSDsData = async _ => {
  schedule.scheduleJob('22,52 * * * *', async _ => {
    const { provider, manager, wallet } = await getVaultManager('0x496aB4A155C8fE359Cd28d43650fAFA0A35322Fb');
    const vaultData = await getAllVaultData(manager);
    const sortedByRisk = vaultData
      .filter(vault => vault.minted.gt(0))
      .sort((a,b) => a.totalCollateralValue.mul(100).div(a.minted) - b.totalCollateralValue.mul(100).div(b.minted));
    const liquidationRisks = sortedByRisk
      .filter(vault => vault.totalCollateralValue.mul(100).div(vault.minted).lt(125))
      .map(vault => {
        return {
          ... vault,
          formattedDebt: ethers.utils.formatEther(vault.minted),
          formattedVaultType: ethers.utils.parseBytes32String(vault.vaultType),
          collateralPercentage: vault.totalCollateralValue.mul(100).div(vault.minted)
        }
      });
    const redemptionCandidate = await determineRedemptionCandidate(sortedByRisk);

    const EUROs = await getContract('arbitrum', 'EUROs');
    const USDs = await getContract('arbitrum', 'EUROs', '0x2Ea0bE86990E8Dac0D09e4316Bb92086F304622d');
    const liquidatorETHBalance = ethers.utils.formatEther(await provider.getBalance(wallet.address));
    const liquidatorEUROsBalance = ethers.utils.formatEther(await EUROs.connect(wallet).balanceOf(wallet.address));
    const liquidatorUSDsBalance = ethers.utils.formatEther(await USDs.connect(wallet).balanceOf(wallet.address));
    const content = `Liquidator wallet balance:\n**${liquidatorETHBalance} ETH**\n**${liquidatorEUROsBalance} EUROs**\n**${liquidatorUSDsBalance} USDs**\n---\n`;
    await postToDiscord(content, liquidationRisks.map(postingFormat));
    if (redemptionCandidate.tokenID) await saveRedemptionData(redemptionCandidate);
  });
}

const scheduleEUROsData = async _ => {
  schedule.scheduleJob('32 * * * *', async _ => {
    const { provider, manager, wallet } = await getVaultManager('0xba169cceCCF7aC51dA223e04654Cf16ef41A68CC');
    const vaultData = await getAllVaultData(manager);
    const sortedByRisk = vaultData
      .filter(vault => vault.minted.gt(0))
      .sort((a,b) => a.totalCollateralValue.mul(100).div(a.minted) - b.totalCollateralValue.mul(100).div(b.minted));
    const liquidationRisks = sortedByRisk
      .filter(vault => vault.totalCollateralValue.mul(100).div(vault.minted).lt(125))
      .map(vault => {
        return {
          ... vault,
          formattedDebt: ethers.utils.formatEther(vault.minted),
          formattedVaultType: ethers.utils.parseBytes32String(vault.vaultType),
          collateralPercentage: vault.totalCollateralValue.mul(100).div(vault.minted)
        }
      });

    const EUROs = await getContract('arbitrum', 'EUROs');
    const USDs = await getContract('arbitrum', 'EUROs', '0x2Ea0bE86990E8Dac0D09e4316Bb92086F304622d');
    const liquidatorETHBalance = ethers.utils.formatEther(await provider.getBalance(wallet.address));
    const liquidatorEUROsBalance = ethers.utils.formatEther(await EUROs.connect(wallet).balanceOf(wallet.address));
    const liquidatorUSDsBalance = ethers.utils.formatEther(await USDs.connect(wallet).balanceOf(wallet.address));
    const content = `Liquidator wallet balance:\n**${liquidatorETHBalance} ETH**\n**${liquidatorEUROsBalance} EUROs**\n**${liquidatorUSDsBalance} USDs**\n---\n`;
    await postToDiscord(content, liquidationRisks.map(postingFormat));
  });
}

module.exports = {
  scheduleUSDsData,
  scheduleEUROsData
};