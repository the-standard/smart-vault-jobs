const http = require('http');
require('dotenv').config();
const { schedulePricingIndexing } = require('./src/pricing');
const { scheduleStatIndexing } = require('./src/stats');
const { scheduleLiquidation } = require('./src/liquidation');
const { scheduleIndexYieldData } = require('./src/yield');

const port = process.env.PORT || 3000;

schedulePricingIndexing();
scheduleStatIndexing();
scheduleLiquidation();
scheduleIndexYieldData();

const server = http.createServer(async (req, res) => {
  res.statusCode = 200;
  res.end();
});

server.listen(port);
console.log(`Smart Vault Job Runner running on port ${port}`)