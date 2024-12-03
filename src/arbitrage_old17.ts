import { ethers } from 'ethers';
import { request } from 'graphql-request';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

import Graph from './graph_library/Graph';
import GraphVertex from './graph_library/GraphVertex';
import GraphEdge, { EdgeMetadata } from './graph_library/GraphEdge';
import * as UNISWAP from './dex_queries/uniswap';
import * as QUICKSWAP from './dex_queries/quickswap';
import { 
  DEX, 
  MIN_TVL, 
  MINPROFIT, 
  FEE_TEIR_PERCENTAGE_OBJECT,
  ROUTER_ADDRESS_OBJECT
} from './constants';

dotenv.config();

const provider = new ethers.JsonRpcProvider("https://api.speedynodes.net/http/pol-http?apikey=b441d8e15f065db7bbabb964560a4394");

const SLIPPAGE = 0.0005; // 0.05% de slippage por trade
const FLASH_LOAN_FEE = 0.0009; // 0.09% de fee para el préstamo flash (este valor puede variar según el proveedor)

const ORIGIN_TOKENS = [
  '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
  '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', // WBTC
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", //USDT
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", //WETH
];

const UNISWAP_V3_FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

const UNISWAP_V3_POOL_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)"
];

const QUICKSWAP_FACTORY_ADDRESS = '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32';
const QUICKSWAP_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];

const QUICKSWAP_PAIR_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

const uniswapV3Factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ABI, provider);
const quickswapFactory = new ethers.Contract(QUICKSWAP_FACTORY_ADDRESS, QUICKSWAP_FACTORY_ABI, provider);

interface SwapStep {
  fromToken: string;
  toToken: string;
  dex: DEX | string;
  router: string;
  feeTier?: number; 
}

interface ArbitrageRoute {
  cycle: string[];
  cycleWeight: number;
  steps: SwapStep[];
  type: 'cyclic' | 'non-cyclic';
}

async function fetchTokens(first: number, dex: DEX): Promise<string[]> {
  let dexEndpoint = (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT : QUICKSWAP.ENDPOINT;
  let allTokens: string[] = [];
  let skip = 0;
  
  while (allTokens.length < first) {
    let tokensQuery = (dex === DEX.UniswapV3) ? UNISWAP.HIGHEST_VOLUME_TOKENS(100, skip) : QUICKSWAP.HIGHEST_VOLUME_TOKENS(100, skip);
    
    try {
      let result = await request(dexEndpoint, tokensQuery);
      let newTokens = result.tokens.map((t: any) => t.id);
      allTokens.push(...newTokens);
      
      if (newTokens.length < 100) break; // No more tokens to fetch
      
      skip += 100;
    } catch (error) {
      console.error(`Error fetching tokens from ${dex}:`, error);
      break;
    }
  }

  console.log(`Tokens from ${dex}:`, allTokens.length);
  return allTokens.slice(0, first);
}

async function fetchUniswapV3Pools(tokenIds: string[], maxPools: number = 50): Promise<Set<string>> {
  const pools = new Set<string>();
  const fees = [500, 3000, 10000];

  for (let i = 0; i < tokenIds.length && pools.size < maxPools; i++) {
    for (let j = i + 1; j < tokenIds.length && pools.size < maxPools; j++) {
      for (const fee of fees) {
        if (pools.size >= maxPools) break;
        const pool = await uniswapV3Factory.getPool(tokenIds[i], tokenIds[j], fee);
        if (pool !== ethers.ZeroAddress) {
          pools.add(pool);
        }
      }
    }
  }

  console.log(`Uniswap V3 pools found: ${pools.size}`);
  return pools;
}

async function fetchQuickSwapPools(tokenIds: string[], maxPools: number = 50): Promise<Set<string>> {
  const pools = new Set<string>();

  for (let i = 0; i < tokenIds.length && pools.size < maxPools; i++) {
    for (let j = i + 1; j < tokenIds.length && pools.size < maxPools; j++) {
      const pair = await quickswapFactory.getPair(tokenIds[i], tokenIds[j]);
      if (pair !== ethers.ZeroAddress) {
        pools.add(pair);
      }
    }
  }

  console.log(`QuickSwap pools found: ${pools.size}`);
  return pools;
}

async function getUniswapV3PoolData(poolAddress: string): Promise<{ price: number, liquidity: string, token0: string, token1: string, feeTier: number }> {
  const poolContract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);

  try {
    const token0 = await poolContract.token0();
    const token1 = await poolContract.token1();
    const [sqrtPriceX96, , , , , ] = await poolContract.slot0();
    const liquidity = await poolContract.liquidity();
    const feeTier = await poolContract.fee();

    const price = Math.pow(Number(sqrtPriceX96) / Math.pow(2, 96), 2);

    if (price === 0) {
      console.warn(`Price is zero for pool ${poolAddress}`);
      return { price: 0, liquidity: '0', token0, token1, feeTier };
    }

    return { price, liquidity: liquidity.toString(), token0, token1, feeTier };
  } catch (error) {
    console.error(`Error al obtener datos de la pool de Uniswap V3 ${poolAddress}:`, error);
    return { price: 0, liquidity: '0', token0: '', token1: '', feeTier: 0 };
  }
}

async function getQuickSwapPoolData(poolAddress: string): Promise<{ price: number, liquidity: string, token0: string, token1: string }> {
  const poolContract = new ethers.Contract(poolAddress, QUICKSWAP_PAIR_ABI, provider);

  try {
    const token0 = await poolContract.token0();
    const token1 = await poolContract.token1();
    const [reserve0, reserve1] = await poolContract.getReserves();

    const price = Number(reserve1) / Number(reserve0);
    const liquidity = (BigInt(reserve0.toString()) + BigInt(reserve1.toString())).toString();

    if (price === 0) {
      console.warn(`Price is zero for pool ${poolAddress}`);
      return { price: 0, liquidity: '0', token0, token1 };
    }

    return { price, liquidity, token0, token1 };
  } catch (error) {
    console.error(`Error al obtener datos de la pool de QuickSwap ${poolAddress}:`, error);
    return { price: 0, liquidity: '0', token0: '', token1: '' };
  }
}

async function fetchPoolPrices(g: Graph, pools: Set<string>, dex: DEX, debug: boolean = false): Promise<void> {
  if (debug) console.log(pools);
  for (var pool of Array.from(pools.values())) {
    try {
      if (debug) console.log(dex, pool);
      
      if (dex === DEX.UniswapV3) {
        const { price, liquidity, token0, token1, feeTier } = await getUniswapV3PoolData(pool);
        if (price === 0) continue;

        if (!g.getVertexByKey(token0)) {
          g.addVertex(new GraphVertex(token0));
        }
        if (!g.getVertexByKey(token1)) {
          g.addVertex(new GraphVertex(token1));
        }

        let vertex0 = g.getVertexByKey(token0);
        let vertex1 = g.getVertexByKey(token1);

        let metadata = { 
          dex: dex, 
          address: pool, 
          liquidity, 
          fee: Number(feeTier) / 1000000,
          feeTier: Number(feeTier)
        };

        updateOrAddEdge(g, vertex0, vertex1, -Math.log(price), price, metadata);
        updateOrAddEdge(g, vertex1, vertex0, -Math.log(1/price), 1/price, metadata);
      } else {
        const { price, liquidity, token0, token1 } = await getQuickSwapPoolData(pool);
        if (price === 0) continue;

        if (!g.getVertexByKey(token0)) {
          g.addVertex(new GraphVertex(token0));
        }
        if (!g.getVertexByKey(token1)) {
          g.addVertex(new GraphVertex(token1));
        }

        let vertex0 = g.getVertexByKey(token0);
        let vertex1 = g.getVertexByKey(token1);

        let metadata = { dex: dex, address: pool, liquidity, fee: 0.003 };

        updateOrAddEdge(g, vertex0, vertex1, -Math.log(price), price, metadata);
        updateOrAddEdge(g, vertex1, vertex0, -Math.log(1/price), 1/price, metadata);
      }
    } catch (error) {
      console.error(`Error fetching pool ${pool} for ${dex}:`, error);
    }
  }
  console.log(`Finished processing ${pools.size} pools for ${dex}`);
}

function updateOrAddEdge(g: Graph, startVertex: GraphVertex, endVertex: GraphVertex, weight: number, rawWeight: number, metadata: EdgeMetadata): void {
  if (!startVertex || !endVertex) {
    console.warn(`Cannot add edge: one or both vertices do not exist`);
    return;
  }

  const existingEdge = g.findEdge(startVertex, endVertex);
  if (existingEdge) {
    if (weight < existingEdge.weight) {
      existingEdge.weight = weight;
      existingEdge.rawWeight = rawWeight;
      existingEdge.metadata = metadata;
    }
  } else {
    g.addEdge(new GraphEdge(startVertex, endVertex, weight, rawWeight, metadata));
  }
}

function getDexName(dex: DEX): string {
  switch (dex) {
    case DEX.UniswapV3:
      return "UniswapV3";
    case DEX.QuickSwap:
      return "QuickSwap";
    default:
      return "Unknown";
  }
}

function detectArbitrage(graph: Graph, sourceToken: string, targetToken: string, minLength: number): ArbitrageRoute | null {
  console.log(`Detecting arbitrage from ${sourceToken} to ${targetToken}`);
  
  let bestArbitrage: ArbitrageRoute | null = null;
  let bestWeight = 0;

  function dfs(currentToken: string, path: string[], weight: number, steps: SwapStep[]) {
    if (path.length > minLength + 1) return;

    if (currentToken === targetToken && path.length >= minLength) {
      const cycleWeight = Math.exp(weight);
      if (cycleWeight > 1.015 && cycleWeight < 1.5 && cycleWeight > bestWeight) {
        bestWeight = cycleWeight;
        const isCyclic = path[0] === sourceToken;
        bestArbitrage = {
          cycle: isCyclic ? path : [...path, sourceToken],
          cycleWeight: cycleWeight,
          steps: isCyclic ? steps : [...steps, {
            fromToken: currentToken,
            toToken: sourceToken,
            dex: DEX.UniswapV3,
            router: ROUTER_ADDRESS_OBJECT.uniswapV3
          }],
          type: isCyclic ? 'cyclic' : 'non-cyclic'
        };
      }
      return;
    }

    const edges = graph.getAllEdges().filter(edge => edge.startVertex.getKey() === currentToken);
    for (const edge of edges) {
      const nextToken = edge.endVertex.getKey();
      if (!path.includes(nextToken) || (nextToken === sourceToken && path.length >= minLength)) {
        const fee = edge.metadata.dex === DEX.UniswapV3 ? edge.metadata.fee : 0.003;
        const newStep: SwapStep = {
          fromToken: currentToken,
          toToken: nextToken,
          dex: edge.metadata.dex,
          router: edge.metadata.dex === DEX.UniswapV3 ? ROUTER_ADDRESS_OBJECT.uniswapV3 : ROUTER_ADDRESS_OBJECT.quickswap,
          feeTier: edge.metadata.dex === DEX.UniswapV3 ? edge.metadata.feeTier : 3000
        };
        dfs(nextToken, [...path, nextToken], weight + edge.weight - Math.log(1 - fee - SLIPPAGE), [...steps, newStep]);
      }
    }
  }

  dfs(sourceToken, [sourceToken], 0, []);

  if (bestArbitrage) {
    console.log(`Found arbitrage opportunity: ${bestArbitrage.cycle.join(' -> ')} with weight ${bestArbitrage.cycleWeight}`);
  } else {
    console.log(`No arbitrage opportunity found from ${sourceToken} to ${targetToken}`);
  }

  return bestArbitrage;
}

async function calcArbitrage(g: Graph): Promise<ArbitrageRoute[]> {
  console.log("Starting arbitrage calculation...");
  let arbitrageData: ArbitrageRoute[] = [];

  // Calcular todas las rutas de arbitraje
  for (const sourceToken of ORIGIN_TOKENS) {
    for (const targetToken of ORIGIN_TOKENS) {
      const arbitrage = detectArbitrage(g, sourceToken, targetToken, 3);
      if (arbitrage && arbitrage.cycleWeight > 1.015 && arbitrage.cycleWeight < 1.5) {
        arbitrageData.push(arbitrage);
      }
    }
  }

  // Procesar los datos de arbitraje para reemplazar los números de DEX por nombres
  const processedArbitrageData = arbitrageData.map(route => ({
    ...route,
    steps: route.steps.map(step => ({
      ...step,
      dex: getDexName(step.dex as DEX),
      router: step.router,
      feeTier: step.feeTier
    }))
  }));

  console.log(`Arbitrage calculation complete. Found ${processedArbitrageData.length} opportunities.`);
  return processedArbitrageData;
}

async function main(numberTokens: number = 50, DEXs: Set<DEX>, debug: boolean = false) {
  try {
    console.log("Iniciando el proceso de arbitraje...");

    let uniTokens = DEXs.has(DEX.UniswapV3) ? await fetchTokens(numberTokens, DEX.UniswapV3) : [];
    let quickTokens = DEXs.has(DEX.QuickSwap) ? await fetchTokens(numberTokens, DEX.QuickSwap) : [];
    
    let tokenIds = [...new Set([...uniTokens, ...quickTokens, ...ORIGIN_TOKENS])];

    console.log(`Total tokens: ${tokenIds.length}`);

    let g: Graph = new Graph(true);
    tokenIds.forEach(element => {
      g.addVertex(new GraphVertex(element))
    });

    console.log("Obteniendo pools y precios...");
    let uniPools: Set<string> | undefined;
    let quickPools: Set<string> | undefined;

    const maxPoolsPerDex = 200; // Aumentado de 50 a 200

    if (DEXs.has(DEX.UniswapV3)) {
      uniPools = await fetchUniswapV3Pools(tokenIds, maxPoolsPerDex);
      console.log(`Uniswap V3 pools found: ${uniPools.size}`);
      await fetchPoolPrices(g, uniPools, DEX.UniswapV3, debug);
    }
    if (DEXs.has(DEX.QuickSwap)) {
      quickPools = await fetchQuickSwapPools(tokenIds, maxPoolsPerDex);
      console.log(`QuickSwap pools found: ${quickPools.size}`);
      await fetchPoolPrices(g, quickPools, DEX.QuickSwap, debug);
    }

    console.log(`Total pools: ${(uniPools?.size || 0) + (quickPools?.size || 0)}`);

    console.log("Calculando rutas de arbitraje...");
    const arbitrageRoutes = await calcArbitrage(g);
    console.log(`Se encontraron ${arbitrageRoutes.length} rutas de arbitraje potenciales.`);

    // Filtrar rutas de arbitraje que incluyan tanto UniswapV3 como QuickSwap
    const filteredArbitrageRoutes = arbitrageRoutes.filter(route => {
      const dexes = new Set(route.steps.map(step => step.dex));
      return dexes.has('UniswapV3') && dexes.has('QuickSwap');
    });

    console.log(`Se encontraron ${filteredArbitrageRoutes.length} rutas de arbitraje que incluyen UniswapV3 y QuickSwap.`);

    // Ordenar las rutas por cycleWeight de mayor a menor
    filteredArbitrageRoutes.sort((a, b) => b.cycleWeight - a.cycleWeight);

    // Tomar las top 10 rutas
    const top10Routes = filteredArbitrageRoutes.slice(0, 10);

    const filePath = path.join(__dirname, 'arbitrageRoutes.json');
    fs.writeFileSync(filePath, JSON.stringify(top10Routes, null, 2));
    console.log(`Top 10 resultados guardados en ${filePath}`);

    console.log(`Proceso completado. Se encontraron ${filteredArbitrageRoutes.length} rutas de arbitraje válidas.`);

    // Imprimir un resumen de las top 10 rutas
    console.log("\nResumen de las top 10 rutas de arbitraje:");
    top10Routes.forEach((route, index) => {
      console.log(`${index + 1}. Peso: ${route.cycleWeight.toFixed(4)}, Ruta: ${route.cycle.join(' -> ')}`);
    });

  } catch (error) {
    console.error("Error en la ejecución principal:", error);
  }
}

// Si quieres ejecutar el script directamente
if (require.main === module) {
  main(50, new Set([DEX.UniswapV3, DEX.QuickSwap]), true)
    .then(() => console.log("Script completed successfully"))
    .catch(error => console.error("An error occurred during execution:", error));
}