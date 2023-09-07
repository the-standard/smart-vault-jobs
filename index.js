const http = require('http');
require('dotenv').config();
const { schedulePricingIndexing } = require('./src/pricing');
const { scheduleStatIndexing } = require('./src/stats');

const port = process.env.PORT || 3000;

schedulePricingIndexing();
scheduleStatIndexing();

const server = http.createServer(async (req, res) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.url}`);
  res.statusCode = 200;
  res.end();
});

server.listen(port);
console.log(`Smart Vault Job Runner running on port ${port}`)