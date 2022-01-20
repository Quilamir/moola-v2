## LiquidationBot.js

This bot is intendded to be a functional liquidation bot, it is in no way a competitive implementation, use at own risk.

### Installation
Run `npm install` from the root directory, this bot does not have its own package file.

### Running
The bot uses RPC servers in odrder to scan the Celo chain, in cases where the RPC server is not available or is limiting the amount of calls you can send to it the bot may fail and exit.

It is recomended to run the bot using [Forever](https://www.npmjs.com/package/forever "Forever") in order to make sure that when an RPC issue arises the bot will restart automatically.

In order to start the bot: `node liquidationBot.js`

When using forever: `forever start liquidationBot.js`

By default the bot will run using "forno" as its RPC server, you may run your own Celo node with a local RPC server and use it instead for more stability.

#### Important!
Please note that the bot will use the balances of the provided address in order to complete liquidations, therefore in order for the bot to successfuly liquidate positions the address must be funded before hand.

### Environment
The bot expects several Environment variables (these can be sent via command line arguments as well)

- CELO_BOT_NODE - (optional) The URL for the RPC server.
- CELO_BOT_ADDRESS - (required) The address of the user account.
- CELO_BOT_PK - (required) The private key controling the user address.
- CELO_BOT_LOOP_DELAY - (optional) Amount of milliseconds to wait between bot itterations.
- CELO_BOT_UBE_THRESHOLD - (optional) The percentage of advantage recieved by ubeSwap when deciding which swapper service to use.
- CELO_BOT_MAX_BALANCE - (optional) The maximum amount to attempt liquidation with (still in development).
- CELO_BOT_DATA_DIR - (optional) The directory where to save the local storage data.
