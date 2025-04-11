const http = require('http');
require('dotenv').config();
const { schedulePricingIndexing } = require('./src/pricing');
const { scheduleDebtData } = require('./src/debt');

const port = process.env.PORT || 3000;

schedulePricingIndexing();
scheduleDebtData();

const server = http.createServer(async (req, res) => {
  res.statusCode = 200;
  res.end();
});

server.listen(port);
console.log(`Smart Vault Job Runner running on port ${port}`)