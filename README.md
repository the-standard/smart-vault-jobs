# Smart Vault Jobs

This application runs background jobs to support The Standard Smart Vaults.

### Endpoints

- [liquidation](./src/liquidation.js) performs any necessary liquidations of Smart Vaults every 5 mins
- [pricing](./src/pricing.js) indexes simple pricing data about Smart Vault assets, to be consumed via the [Smart Vault API](https://github.com/the-standard/smart-vault-api)
- [stats](./src/stats.js) indexes data about the Smart Vaults project, to be consumed via the [Smart Vault API](https://github.com/the-standard/smart-vault-api)

## Setup

Install the project dependencies:

```npm install```

Edit the [example env file](.env.example), and rename it to `.env` in the root of the project.

Start the application:

```npm start```