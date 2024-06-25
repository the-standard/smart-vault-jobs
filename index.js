const http = require('http');
require('dotenv').config();
const { schedulePricingIndexing } = require('./src/pricing');
const { scheduleIndexYieldData } = require('./src/yield');
// const { scheduleVaultTransactionIndexing } = require('./src/transactions');
const { scheduleLiquidation } = require('./src/liquidation');

const port = process.env.PORT || 3000;

schedulePricingIndexing();
scheduleIndexYieldData();
// scheduleVaultTransactionIndexing();
scheduleLiquidation();

const server = http.createServer(async (req, res) => {
  res.statusCode = 200;
  res.end();
});

server.listen(port);
console.log(`Smart Vault Job Runner running on port ${port}`)