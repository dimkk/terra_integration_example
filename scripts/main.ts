import BN from "bn.js";
import chalk from "chalk";
import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import { LocalTerra, MsgExecuteContract } from "@terra-money/terra.js";
import { deployTerraswapPair, deployTerraswapToken } from "./fixture";
import {
  queryNativeTokenBalance,
  queryTokenBalance,
  sendTransaction,
  toEncodedBinary,
} from "./helpers";

chai.use(chaiAsPromised);
const { expect } = chai;

//----------------------------------------------------------------------------------------
// Variables
//----------------------------------------------------------------------------------------

const terra = new LocalTerra();
const deployer = terra.wallets.test1;
const user1 = terra.wallets.test2;
const user2 = terra.wallets.test3;

let mirrorToken: string;
let terraswapPair: string;
let terraswapLpToken: string;

//----------------------------------------------------------------------------------------
// Setup
//----------------------------------------------------------------------------------------

async function setupTest() {
  let { cw20CodeId, cw20Token } = await deployTerraswapToken(
    terra,
    deployer,
    "Mock Mirror Token",
    "MIR"
  );
  mirrorToken = cw20Token;

  ({ terraswapPair, terraswapLpToken } = await deployTerraswapPair(terra, deployer, {
    asset_infos: [
      {
        token: {
          contract_addr: cw20Token,
        },
      },
      {
        native_token: {
          denom: "uusd",
        },
      },
    ],
    token_code_id: cw20CodeId,
  }));

  process.stdout.write("Fund user 1 with MIR... ");

  await sendTransaction(terra, deployer, [
    new MsgExecuteContract(deployer.key.accAddress, cw20Token, {
      mint: {
        recipient: user1.key.accAddress,
        amount: "10000000000",
      },
    }),
  ]);

  console.log(chalk.green("Done!"));

  process.stdout.write("Fund user 2 with MIR... ");

  await sendTransaction(terra, deployer, [
    new MsgExecuteContract(deployer.key.accAddress, cw20Token, {
      mint: {
        recipient: user2.key.accAddress,
        amount: "10000000000",
      },
    }),
  ]);

  console.log(chalk.green("Done!"));
}

//----------------------------------------------------------------------------------------
// Test 1. Provide Initial Liquidity
//
// User 1 provides 69 MIR + 420 UST
// User 1 should receive sqrt(69000000 * 420000000) = 170235131 uLP
//
// Result
// ---
// pool uMIR  69000000
// pool uusd  420000000
// user uLP   170235131
//----------------------------------------------------------------------------------------

async function testProvideLiquidity() {
  process.stdout.write("Should provide liquidity... ");

  await sendTransaction(terra, user1, [
    new MsgExecuteContract(user1.key.accAddress, mirrorToken, {
      increase_allowance: {
        amount: "100000000",
        spender: terraswapPair,
      },
    }),
    new MsgExecuteContract(
      user1.key.accAddress,
      terraswapPair,
      {
        provide_liquidity: {
          assets: [
            {
              info: {
                token: {
                  contract_addr: mirrorToken,
                },
              },
              amount: "69000000",
            },
            {
              info: {
                native_token: {
                  denom: "uusd",
                },
              },
              amount: "420000000",
            },
          ],
        },
      },
      {
        uusd: "420000000",
      }
    ),
  ]);

  const poolUMir = await queryTokenBalance(terra, terraswapPair, mirrorToken);
  expect(poolUMir).to.equal("69000000");

  const poolUUsd = await queryNativeTokenBalance(terra, terraswapPair, "uusd");
  expect(poolUUsd).to.equal("420000000");

  const userULp = await queryTokenBalance(terra, user1.key.accAddress, terraswapLpToken);
  expect(userULp).to.equal("170235131");

  console.log(chalk.green("Passed!"));
}

//----------------------------------------------------------------------------------------
// Test 2. Swap
//
// User 2 sells 1 MIR for UST
//
// k = poolUMir * poolUUsd
// = 69000000 * 420000000 = 28980000000000000
// returnAmount = poolUusd - k / (poolUMir + offerUMir)
// = 420000000 - 28980000000000000 / (69000000 + 1000000)
// = 6000000
// fee = returnAmount * feeRate
// = 6000000 * 0.003
// = 18000
// returnAmountAfterFee = returnUstAmount - fee
// = 6000000 - 18000
// = 5982000
// returnAmountAfterFeeAndTax = deductTax(5982000) = 5976023
// transaction cost for pool = addTax(5976023) = 5981999
//
// Result
// ---
// pool uMIR  69000000 + 1000000 = 70000000
// pool uusd  420000000 - 5981999 = 414018001
// user uLP   170235131
// user uMIR  10000000000 - 1000000 = 9999000000
// user uusd  balanceBeforeSwap + 5976023 - 4500000 (gas)
//----------------------------------------------------------------------------------------

async function testSwap() {
  process.stdout.write("Should swap... ");

  const userUusdBefore = await queryNativeTokenBalance(
    terra,
    user2.key.accAddress,
    "uusd"
  );

  await sendTransaction(terra, user2, [
    new MsgExecuteContract(user2.key.accAddress, mirrorToken, {
      send: {
        amount: "1000000",
        contract: terraswapPair,
        msg: toEncodedBinary({
          swap: {},
        }),
      },
    }),
  ]);

  const poolUMir = await queryTokenBalance(terra, terraswapPair, mirrorToken);
  expect(poolUMir).to.equal("70000000");

  const poolUUsd = await queryNativeTokenBalance(terra, terraswapPair, "uusd");
  expect(poolUUsd).to.equal("414018001");

  const userULp = await queryTokenBalance(terra, user1.key.accAddress, terraswapLpToken);
  expect(userULp).to.equal("170235131");

  const userUMir = await queryTokenBalance(terra, user2.key.accAddress, mirrorToken);
  expect(userUMir).to.equal("9999000000");

  const userUusdExpected = new BN(userUusdBefore)
    .add(new BN("5976023"))
    .sub(new BN("4500000"))
    .toString();

  const userUUsd = await queryNativeTokenBalance(terra, user2.key.accAddress, "uusd");
  expect(userUUsd).to.equal(userUusdExpected);

  console.log(chalk.green("Passed!"));
}

//----------------------------------------------------------------------------------------
// Test 3. Slippage tolerance
//
// User 2 tries to swap a large amount of MIR (say 50 MIR, while the pool only has 70) to
// UST with a low max spread. The transaction should fail
//----------------------------------------------------------------------------------------

async function testSlippage() {
  process.stdout.write("Should check max spread... ");

  await expect(
    sendTransaction(terra, user2, [
      new MsgExecuteContract(user2.key.accAddress, mirrorToken, {
        send: {
          amount: "50000000",
          contract: terraswapPair,
          msg: toEncodedBinary({
            swap: {
              max_spread: "0.01",
            },
          }),
        },
      }),
    ])
  ).to.be.rejectedWith("Max spread assertion");

  console.log(chalk.green("Passed!"));
}

//----------------------------------------------------------------------------------------
// Main
//----------------------------------------------------------------------------------------

(async () => {
  console.log(chalk.yellow("\nStep 1. Info"));

  console.log(`Use ${chalk.cyan(deployer.key.accAddress)} as deployer`);
  console.log(`Use ${chalk.cyan(user1.key.accAddress)} as user 1`);
  console.log(`Use ${chalk.cyan(user2.key.accAddress)} as user 1`);

  console.log(chalk.yellow("\nStep 2. Setup"));

  await setupTest();

  console.log(chalk.yellow("\nStep 3. Tests"));

  await testProvideLiquidity();
  await testSwap();
  await testSlippage();

  console.log("");
})();
