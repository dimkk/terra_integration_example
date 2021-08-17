import * as path from "path";
import chalk from "chalk";
import { LocalTerra, Wallet } from "@terra-money/terra.js";
import { storeCode, instantiateContract } from "./helpers";

export async function deployTerraswapToken(
  terra: LocalTerra,
  deployer: Wallet,
  name: string,
  symbol: string
) {
  process.stdout.write("CW20 code ID not given! Uploading CW20 code... ");

  const cw20CodeId = await storeCode(
    terra,
    deployer,
    path.resolve(__dirname, "../artifacts/terraswap_token.wasm")
  );

  console.log(chalk.green("Done!"), `${chalk.blue("codeId")}=${cw20CodeId}`);

  process.stdout.write(`Instantiating ${symbol} token contract... `);

  const result = await instantiateContract(terra, deployer, deployer, cw20CodeId, {
    name: name,
    symbol: symbol,
    decimals: 6,
    initial_balances: [],
    mint: {
      minter: deployer.key.accAddress,
    },
  });

  const contractAddress = result.logs[0].events[0].attributes[3].value;

  console.log(
    chalk.green("Done!"),
    `${chalk.blue("contractAddress")}=${contractAddress}`
  );

  return {
    cw20CodeId,
    cw20Token: contractAddress,
  };
}

export async function deployTerraswapPair(
  terra: LocalTerra,
  deployer: Wallet,
  initMsg: object
) {
  process.stdout.write("Uploading TerraSwap pair code... ");

  const codeId = await storeCode(
    terra,
    deployer,
    path.resolve(__dirname, "../artifacts/terraswap_pair.wasm")
  );

  console.log(chalk.green("Done!"), `${chalk.blue("codeId")}=${codeId}`);

  process.stdout.write("Instantiating TerraSwap pair contract... ");

  const result = await instantiateContract(terra, deployer, deployer, codeId, initMsg);

  const event = result.logs[0].events.find((event) => {
    return event.type == "instantiate_contract";
  });

  const terraswapPair = event?.attributes[3].value;
  const terraswapLpToken = event?.attributes[7].value;

  if (!terraswapPair || !terraswapLpToken) {
    throw "failed to parse instantiation event log";
  }

  console.log(
    chalk.green("Done!"),
    `${chalk.blue("terraswapPair")}=${terraswapPair}`,
    `${chalk.blue("terraswapLpToken")}=${terraswapLpToken}`
  );

  return { terraswapPair, terraswapLpToken };
}
