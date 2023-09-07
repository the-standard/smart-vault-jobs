require('dotenv').config();
const { schedulePricingIndexing } = require('./src/pricing');

schedulePricingIndexing();