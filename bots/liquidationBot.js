// web3 package has an issue where if an rpc call fails badly (404 or other error codes)
// it stops completely, we will need to run the bot in a forever external daemon in order to restart the bot in those cases

// when a liquidation occurs we need to check which dex gives the best price
// we need to check the collateral token or its M equivilant on the dexs
// we will give ubeswap an advantage when it comes to pricing

const fs = require('fs')
const path = require('path')
const { newKit } = require('@celo/contractkit')
const LendingPoolAddressesProvider = require('../abi/LendingPoolAddressProvider.json')
const LendingPool = require('../abi/LendingPool.json')
const Uniswap = require('../abi/Uniswap.json')
const DataProvider = require('../abi/MoolaProtocolDataProvider.json')
const MToken = require('../abi/MToken.json')
const BigNumber = require('bignumber.js')
const Promise = require('bluebird')
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const argv = yargs(hideBin(process.argv)).argv

// doing some setup here
const localnode = argv.CELO_BOT_NODE || process.env.CELO_BOT_NODE || 'https://forno.celo.org'
const user = argv.CELO_BOT_ADDRESS || process.env.CELO_BOT_ADDRESS
const pk = argv.CELO_BOT_PK || process.env.CELO_BOT_PK
const loopDelay = argv.CELO_BOT_LOOP_DELAY || process.env.CELO_BOT_LOOP_DELAY || 60000
const swapThreshold = argv.CELO_BOT_UBE_THRESHOLD || process.env.CELO_BOT_UBE_THRESHOLD || 1
const maxBalance = argv.CELO_BOT_MAX_BALANCE || process.env.CELO_BOT_MAX_BALANCE
const dirName = argv.CELO_BOT_DATA_DIR || process.env.CELO_BOT_DATA_DIR || __dirname

// make sure we have what is needed
if (!pk || !user) {
  throw new Error('Miising parameters, make sure you have CELO_BOT_ADDRESS, CELO_BOT_PK set correctly either in environment or cli')
}

// some primitives
const ether = '1000000000000000000'
const maxUint256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

// some basic functions
function BN(num) {
  return new BigNumber(num)
}

function print(num) {
  return BN(num).dividedBy(ether).toFixed()
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

const retry = async (fun, tries = 5) => {
  try {
    return await fun()
  } catch(err) {
    if (tries == 0) throw err
    await Promise.delay(1000)
    return retry(fun, tries - 1)
  }
}

// bot
async function start() {
  // setting up the kit and tokens
  // this list will grow as more tokens are added to Moola
  // consider getting this list from an online source in the future
  kit = newKit(localnode)
  const addressProvider = new kit.web3.eth.Contract(LendingPoolAddressesProvider, '0xD1088091A174d33412a968Fa34Cb67131188B332')
  const cEUR = new kit.web3.eth.Contract(MToken, '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73')
  const cUSD = new kit.web3.eth.Contract(MToken, '0x765DE816845861e75A25fCA122bb6898B8B1282a')
  const mcEUR = new kit.web3.eth.Contract(MToken, '0xE273Ad7ee11dCfAA87383aD5977EE1504aC07568')
  const mcUSD = new kit.web3.eth.Contract(MToken, '0x918146359264C492BD6934071c6Bd31C854EDBc3')
  const CELO = new kit.web3.eth.Contract(MToken, '0x471EcE3750Da237f93B8E339c536989b8978a438')
  const dataProvider = new kit.web3.eth.Contract(DataProvider, '0x43d067ed784D9DD2ffEda73775e2CC4c560103A1')

  const web3 = kit.web3
  const eth = web3.eth

  // getting the lending pool as the address may change over time
  const lendingPool = new eth.Contract(LendingPool, await addressProvider.methods.getLendingPool().call())

  // building the tokens map
  const tokens = {
    celo: CELO,
    cusd: cUSD,
    ceur: cEUR,
    mceur: mcEUR,
    mcusd: mcUSD
  }

  // for ease of use later
  const tokenNames = Object.keys(tokens)
  
  // adding the user account and private key to the kit
  kit.addAccount(pk)

  // router addresses for swaps when needed
  const sushiSwapRouter = '0x1421bDe4B10e8dd459b3BCb598810B1337D56842'
  const ubeSwapRouter = '0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121'
  const wrappedEth = '0xE919F65739c26a42616b7b8eedC6b5524d1e3aC4'
  const ubeSwap = new eth.Contract(Uniswap, ubeSwapRouter)
  const sushiSwap = new eth.Contract(Uniswap, sushiSwapRouter)
  const swappers = {
    ubeSwap,
    sushiSwap
  }

  // approving spend of the tokens (both moola and swappers)
  await Promise.map(tokenNames, async (token) => {
    console.log(`Checking ${token} for approval`)
    if ((await tokens[token].methods.allowance(user, lendingPool.options.address).call()).length < 30) {
      console.log('Approve Moola', (await tokens[token].methods.approve(lendingPool.options.address, maxUint256).send({from: user, gas: 2000000})).transactionHash)
    }

    await Promise.map(Object.keys(swappers), async (swapper) => {
      if (await tokens[token].methods.allowance(user, swappers[swapper].options.address).call().length < 30) {
        console.log(`Approve ${swapper}`, (await tokens[token].methods.approve(swappers[swapper].options.address, maxUint256).send({from: user, gas: 2000000})).transactionHash)
      }
    })
  })

  // setting up the event collector
  const eventsCollector = require('events-collector')
  let fromBlock = 8955468 // start of moola
  let users = {}

  // if we have localstorage data we need to parse it here and find the last block that was proccessed
  const dataFilename = path.join(dirName, 'liquidationBotHistoryData.json')
  let filedata
  
  try {
    filedata = require(dataFilename)
    fromBlock = filedata.lastBlock
    users = filedata.users
  } catch (e) {
    console.log('No historical data')
  }

  // starting the bot loop
  while(true) {
    // get new blocks and search
    const [newEvents, parsedToBlock] = await eventsCollector({
      rpcUrl: localnode,
      log: console.log,
      abi: LendingPool.filter(el => el.name == 'Borrow'),
      address: lendingPool.options.address,
      blockStep: 5000,
      fromBlock,
      toBlock: 'latest',
      blocksExclude: 0,
      timestamps: false,
    })
    
    fromBlock = parsedToBlock
    for (let event of newEvents) {
      if (event.args.user) {
        users[event.args.user] = true
      }
      if (event.args.onBehalfOf) {
        users[event.args.onBehalfOf] = true
      }
    }

    // collecting users that have a non zero debt
    const usersData = await Promise.map(Object.keys(users), async (address) => [address, await lendingPool.methods.getUserAccountData(address).call()], {concurrency: 20})
      .filter(([address, data]) => !BN(data.totalDebtETH).isZero())
    
    console.log(`Users with debts: ${usersData.length}`)

    // sorting to get riskiest on top
    const riskiest = usersData.sort(([a1, data1], [a2, data2]) => BN(data1.healthFactor).comparedTo(BN(data2.healthFactor)))

    // showing top 3 riskiest users
    console.log(`Top 3 Riskiest users of ${riskiest.length}:`)
    for (let riskiestUser of riskiest.slice(0, 3)) {
      console.log(`${riskiestUser[0]} ${BN(print(riskiestUser[1].healthFactor)).toFixed(3)} ${BN(print(riskiestUser[1].totalCollateralETH)).toFixed(3)}`)
    }

    // getting all the users with health factor less than 1
    const risky = usersData.filter(([address, data]) => BN(data.healthFactor).dividedBy(ether).lt(BN(1))).map(el => el[0])
    console.log(`found ${risky.length} users to run`)

    // running liquidations
    for (let riskUser of risky) {
      console.log(`!!!!! liquidating user ${riskUser} !!!!!`)
      const riskData = await lendingPool.methods.getUserAccountData(riskUser).call()

      // doing this for every liquidation attempt as rates will change after every successful liquidation (by this bot or others)
      const rates = {}
      await Promise.map(tokenNames, async (token) => {
        if (token === 'celo') {
          rates["celo"] = BN(ether)
        } else {
          // getting rates from sushiswap as a reference to check borrow positions later on
          rates[token] = BN((await sushiSwap.methods.getAmountsOut(ether, [CELO.options.address, wrappedEth, tokens[token].options.address]).call())[2])
        }
      })

      // building user positions for all tokens (perhpas get the list of user balances instead of getting the reserve data for all of them)
      const positions = await Promise.map(tokenNames, async (token) => {
        let pos = await dataProvider.methods.getUserReserveData(tokens[token].options.address, riskUser).call()
        return [token, pos]
      })

      // for display only //////////////////////////////////
      const parsedData = {
        Address: riskUser,
        TotalCollateral: print(riskData.totalCollateralETH),
        TotalDebt: print(riskData.totalDebtETH),
        HealthFactor: print(riskData.healthFactor),
      }
      console.table(parsedData)
      ///////////////////////////////////////////////////////

      // building collateral vs borrow and finding the largest ones
      const biggestBorrow = positions.sort(([res1, data1], [res2, data2]) => BN(data2.currentStableDebt).plus(data2.currentVariableDebt).multipliedBy(rates[res2]).dividedBy(ether).comparedTo(BN(data1.currentStableDebt).plus(data1.currentVariableDebt).multipliedBy(rates[res1]).dividedBy(ether)))[0]
      const biggestCollateral = positions.filter(([_, data]) => data.usageAsCollateralEnabled).sort(([res1, data1], [res2, data2]) => BN(data2.currentATokenBalance).multipliedBy(rates[res2]).dividedBy(ether).comparedTo(BN(data1.currentATokenBalance).multipliedBy(rates[res1]).dividedBy(ether)))[0]

      const collateralToken = biggestCollateral[0].toLowerCase()
      const borrowToken = biggestBorrow[0].toLowerCase()

      try {
        let liquidationGasPrice
        try {
          // estimating gas cost for liquidation just as a precaution
          liquidationGasPrice = await lendingPool.methods.liquidationCall(tokens[collateralToken].options.address, tokens[borrowToken].options.address, riskUser, await tokens[borrowToken].methods.balanceOf(user).call(), false).estimateGas({from: user, gas: 2000000})
        } catch (err) {
          console.error(`[${riskUser}] Cannot estimate liquidate ${collateralToken}->${borrowToken}`, err.message)
          throw err
        }

        // balance before liquidation
        const collateralBefore = await tokens[collateralToken].methods.balanceOf(user).call()
        console.log(`Balance of ${collateralToken} Before Liquidation: ${print(collateralBefore)}`)

        // liquidating
        // we need to set a limit of how much to liquidate (in case of very large liquidation)
        let userBalance = await tokens[borrowToken].methods.balanceOf(user).call()
        if (maxBalance && userBalance > maxBalance) {
          userBalance = maxBalance
        }

        // liquidating
        try {
          let liquidationReceipt = await lendingPool.methods.liquidationCall(tokens[collateralToken].options.address, tokens[borrowToken].options.address, riskUser, userBalance, false).send({from: user, gas: liquidationGasPrice})
          console.log(liquidationReceipt)
        } catch (err) {
          console.error(`[${riskUser}] Cannot Liquidate ${collateralToken}->${borrowToken}`, err.message)
          throw err
        }

        // calculating profit
        const profit = BN((await tokens[collateralToken].methods.balanceOf(user).call())).minus(collateralBefore)

        // make sure we are profiting from this liquidation
        console.log(`Profit: ${print(profit)}`)
        if (!profit.isPositive()) {
          console.error(`NO Profit!`)
          // we need to decide if actually want to do the swap here, for now we are stopping the process
          throw new Error('No Profit')
        }

        // checking if we need to do a swap
        if (collateralToken !== borrowToken) {
          // here we need to decide which swapper to use
          // in order to do this we need to get the prices from all the swapper providers
          // for now we are supporting ubeSwap and sushiSwap

          // get ubeswap price
          // ubeSwap uses the mctoken instead of the ctoken in their pools so we need to take that into account here
          // also we will need to "deposit" the collateral token into moola before doing the final swap

          // checking if the m version exists
          let ubeSwapCollateral = tokens[collateralToken]
          let ubeSwapBorrow = tokens[borrowToken]
          let swapPath

          if (collateralToken !== 'celo' && tokens['m'+collateralToken]) {
            // switching to the mc token
            ubeSwapCollateral = tokens['m'+collateralToken]
          }

          if (borrowToken !== 'celo' && tokens['m'+borrowToken]) {
            // switching to the mc token
            ubeSwapBorrow = tokens['m'+borrowToken]
          }

          // preparing ubeswap path
          let ubeSwapPath = [ubeSwapCollateral.options.address, ubeSwapBorrow.options.address]
          // getting the price
          const ubeSwapPrice = BN((await ubeSwap.methods.getAmountsOut(profit, ubeSwapPath).call())[ubeSwapPath.length - 1])
          
          // preparing sushiswap path
          let sushiSwapPath = [tokens[collateralToken].options.address, tokens[borrowToken].options.address]
          // for swapping celo we need to go through wrapped ETH
          if (borrowToken === 'celo' || collateralToken === 'celo') {
            sushiSwapPath = [tokens[collateralToken].options.address, wrappedEth, tokens[borrowToken].options.address]
          }
          // getting the price
          const sushiSwapPrice = BN((await sushiSwap.methods.getAmountsOut(profit, sushiSwapPath).call())[sushiSwapPath.length - 1])

          // check which is better
          if (ubeSwapPrice.lt(sushiSwapPrice)) {
            // we are giving ubeSwap an advantage here up to a certain percentage
            const difference = sushiSwapPrice.minus(ubeSwapPrice)
            const percentage = sushiSwapPrice.multipliedBy(swapThreshold).dividedBy(100)

            if (difference.lt(percentage)) {
              swapPath = sushiSwapPath
              swapper = sushiSwap
            }
          } else {
            swapPath = ubeSwapPath
            swapper = ubeSwap
          }
          
          if (swapper === ubeSwap) {
            let depositGas
            let depositReceipt
            // we need to deposit the token into moola before swapping it
            try {
              depositGas = await lendingPool.methods.deposit(tokens[collateralToken].options.address, profit, user, 0).estimateGas({from: user, gas: 2000000})
            } catch (err) {
              console.error(`Failed to estimate Deposit!!!`)
              throw err
            }

            try {
              depositReceipt = await lendingPool.methods.deposit(tokens[collateralToken].options.address, profit, user, 0).send({from: user, gas: depositGas})
              console.log(depositReceipt)
            } catch (err) {
              console.error(`Failed to Deposit!!!`)
              throw err
            }
          }

          // swap the liquidated asset
          await retry(async () => {
            // estimate gas for the swap as a precaution
            let gasprice
            try {
              gasprice = await swapper.methods.swapExactTokensForTokens(profit, amountOut.multipliedBy(BN(999)).dividedBy(BN(1000)).toFixed(0), swapPath, user, nowSeconds() + 300).estimateGas({from: user, gas: 2000000})
            } catch (err) {
              console.error(`[${riskUser}] Cannot estimate swap ${collateralToken}->${borrowToken}`, err.message)
              throw err
            }

            // swap
            let swapReceipt
            try {
              swapReceipt = await swapper.methods.swapExactTokensForTokens(profit, amountOut.multipliedBy(BN(999)).dividedBy(BN(1000)).toFixed(0), swapPath, user, nowSeconds() + 300).send({from: user, gas: gasprice})
            } catch (err) {
              console.error(`[${riskUser}] Swap Failed!!! ${collateralToken}->${borrowToken}`, err.message)
              throw err
            }

            if (!swapReceipt.status) {
              throw Error('Swap failed')
            }
          })
        }

        // all done! showing balance after liquidation
        console.log(`${collateralToken}: ${print(await tokens[collateralToken].methods.balanceOf(user).call())}`)
      } catch (err) {
        // something went wrong
        console.error(`[${riskUser}] Cannot send liquidate ${collateralToken}->${borrowToken}`, err.message)
      }
    }
    
    // we should write the last block and its events to the localstorage here.
    fs.writeFileSync(dataFilename,JSON.stringify({
      lastBlock: parsedToBlock,
      users
    }))
    // waiting a minute to start getting more blocks
    await Promise.delay(loopDelay)
  }
}

start()
