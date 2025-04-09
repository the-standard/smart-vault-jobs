const http = require('http');
require('dotenv').config();
const { schedulePricingIndexing } = require('./src/pricing');
const { scheduleUSDsData, scheduleEUROsData } = require('./src/debt');

const port = process.env.PORT || 3000;

schedulePricingIndexing();
scheduleUSDsData();
scheduleEUROsData();

const server = http.createServer(async (req, res) => {
  res.statusCode = 200;
  res.end();
});

server.listen(port);
console.log(`Smart Vault Job Runner running on port ${port}`)