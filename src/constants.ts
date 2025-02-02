enum DEX {
    UniswapV3,
    Sushiswap,
    QuickSwap,
    uniswapV2
}
const MIN_TVL = 30000;
const DEFAULT_TIMEOUT = 5000; //ms
const DEFAULT_TOKEN_NUMBER = 5;
const SLIPPAGE = 0.005; // 0.1% slippage
const LENDING_FEE = 0.005; // 0.5% lending fee
const MINPROFIT = 0.001;

const INFURA_URL_VETTING_KEY ="";
const TIME_FRAME_FOR_SUBGRAPH_ONE_HOUR = 1;
const TIME_FRAME_FOR_SUBGRAPH_FOUR_HOURS = 4;
const TIME_FRAME_FOR_SUBGRAPH_SIX_HOURS = 6;

const FEE_TEIR_PERCENTAGE_OBJECT = {
  500: 0.0005,
  3000: 0.003,
  10000: 0.01,
  100: 0.0001,
};

 const QUOTER_CONTRACT_ADDRESS = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6';

//abi for uniswapV2
const UNISWAP_V2_SUSHSISWAP_ABI = [
  'function getAmountOut(uint amountIn, uint reserveIn, uint reserveOut) external pure returns (uint amountOut)',
  'function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts)',
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)',
];
const ROUTER_ADDRESS_OBJECT = {
  uniswapV2: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  uniswapV3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  sushiswap: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"
};


const MIN_USD_VALUE_FOR_OPTIMAL_INPUT_RANGE = 1000;
const MAX_USD_VALUE_FOR_OPTIMAL_INPUT_RANGE = 50000;
const STEP_BETWEEN_RANGE = 1000;


const PRICE_PERCENTAGE_DIFFERENCE_THRESHOLD = 1
const MIN_PROFIT_TO_CONSIDER_FOR_ON_CHAIN_CALL = 1


export  {
    DEX,
    MIN_TVL,
    DEFAULT_TIMEOUT,
    DEFAULT_TOKEN_NUMBER,
    SLIPPAGE,
    LENDING_FEE,
    MINPROFIT,
    FEE_TEIR_PERCENTAGE_OBJECT,
    QUOTER_CONTRACT_ADDRESS,
    INFURA_URL_VETTING_KEY,
    UNISWAP_V2_SUSHSISWAP_ABI,
    ROUTER_ADDRESS_OBJECT,
    MIN_USD_VALUE_FOR_OPTIMAL_INPUT_RANGE,
    MAX_USD_VALUE_FOR_OPTIMAL_INPUT_RANGE,
    STEP_BETWEEN_RANGE,
    PRICE_PERCENTAGE_DIFFERENCE_THRESHOLD,
    MIN_PROFIT_TO_CONSIDER_FOR_ON_CHAIN_CALL,
}