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
  // Agrega aquí más tokens que quieras usar como origen
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
  poolAddress: string;
}

interface ArbitrageRoute {
  cycle: string[];
  cycleWeight: number;
  steps: SwapStep[];
  type: 'cyclic' | 'non-cyclic';
}

async function fetchTokens(first: number, skip: number = 0, dex: DEX): Promise<string[]> {
  let dexEndpoint = (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT : QUICKSWAP.ENDPOINT;
  let tokensQuery = (dex === DEX.UniswapV3) ? UNISWAP.HIGHEST_VOLUME_TOKENS(first) : QUICKSWAP.HIGHEST_VOLUME_TOKENS(first, skip);
  
  try {
    let mostActiveTokens = await request(dexEndpoint, tokensQuery);
    console.log(`Tokens from ${dex}:`, mostActiveTokens.tokens)

    return mostActiveTokens.tokens.map((t: any) => t.id);
  } catch (error) {
    console.error(`Error fetching tokens from ${dex}:`, error);
    return [];
  }
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

function modifiedMooreBellmanFord(graph: Graph, sourceVertex: GraphVertex): { distances: {[key: string]: number}, paths: {[key: string]: string[]} } {
  const distances: {[key: string]: number} = {};
  const paths: {[key: string]: string[]} = {};
  
  for (const vertex of graph.getAllVertices()) {
    distances[vertex.getKey()] = Infinity;
    paths[vertex.getKey()] = [];
  }
  
  if (!sourceVertex) {
    console.warn("Source vertex is undefined");
    return { distances, paths };
  }
  
  distances[sourceVertex.getKey()] = 0;
  
  for (let i = 0; i < graph.getAllVertices().length - 1; i++) {
    for (const edge of graph.getAllEdges()) {
      if (!edge.startVertex || !edge.endVertex) continue;
      
      const startDistance = distances[edge.startVertex.getKey()];
      const endDistance = distances[edge.endVertex.getKey()];
      
      if (startDistance + edge.weight < endDistance) {
        distances[edge.endVertex.getKey()] = startDistance + edge.weight;
        paths[edge.endVertex.getKey()] = [...paths[edge.startVertex.getKey()], edge.endVertex.getKey()];
        
        if (!paths[edge.startVertex.getKey()].includes(edge.endVertex.getKey()) || edge.endVertex.getKey() === sourceVertex.getKey()) {
          distances[edge.endVertex.getKey()] = startDistance + edge.weight;
          paths[edge.endVertex.getKey()] = [...paths[edge.startVertex.getKey()], edge.endVertex.getKey()];
        }
      }
    }
  }
  
  return { distances, paths };
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

    if ((currentToken === targetToken || currentToken === sourceToken) && path.length >= minLength) {
      const cycleWeight = Math.exp(weight);
      if (cycleWeight > 1.015 && cycleWeight < 1.5 && cycleWeight > bestWeight) {
        bestWeight = cycleWeight;
        const isCyclic = currentToken === sourceToken;
        bestArbitrage = {
          cycle: isCyclic ? path : [...path, sourceToken],
          cycleWeight: cycleWeight,
          steps: steps,
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
          feeTier: edge.metadata.dex === DEX.UniswapV3 ? edge.metadata.feeTier : 3000,
          poolAddress: edge.metadata.address // Añadimos la dirección del pool
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

function findCycles(g: Graph, startVertex: GraphVertex, minLength: number, maxLength: number): string[][] {
  let cycles: string[][] = [];
  let path: string[] = [startVertex.getKey()];
  let visited: {[key: string]: boolean} = {};

  function dfs(currentVertex: GraphVertex, depth: number) {
    if (depth > maxLength) return;

    visited[currentVertex.getKey()] = true;

    const edges = g.getAllEdges().filter(edge => edge.startVertex.getKey() === currentVertex.getKey());

    for (const edge of edges) {
      const nextVertex = edge.endVertex;
      
      if (nextVertex.getKey() === startVertex.getKey() && depth >= minLength) {
        cycles.push([...path, startVertex.getKey()]); // Añadimos el token inicial al final para cerrar el ciclo
      } else if (!visited[nextVertex.getKey()] && depth < maxLength - 1) {
        path.push(nextVertex.getKey());
        dfs(nextVertex, depth + 1);
        path.pop();
      }
    }

    visited[currentVertex.getKey()] = false;
  }

  dfs(startVertex, 0);
  return cycles;
}

function calculateCycleWeight(g: Graph, cycle: string[]): { weight: number, steps: SwapStep[] } {
  let logWeight = 0;
  let steps: SwapStep[] = [];
  for (let i = 0; i < cycle.length - 1; i++) {
    const edge = g.findEdge(g.getVertexByKey(cycle[i]), g.getVertexByKey(cycle[i + 1]));
    if (edge) {
      logWeight += edge.weight - Math.log(1 - edge.metadata.fee - SLIPPAGE);
      steps.push({
        fromToken: cycle[i],
        toToken: cycle[i + 1],
        dex: edge.metadata.dex,
        router: edge.metadata.dex === DEX.UniswapV3 
          ? ROUTER_ADDRESS_OBJECT.uniswapV3 
          : ROUTER_ADDRESS_OBJECT.quickswap,
        feeTier: edge.metadata.dex === DEX.UniswapV3 
          ? edge.metadata.feeTier  // Use feeTier for Uniswap V3
          : 3000,  // Use 3000 (0.3%) for QuickSwap
        poolAddress: edge.metadata.address // Añadimos la dirección del pool
      });
    } else {
      console.warn(`No edge found between ${cycle[i]} and ${cycle[i + 1]}`);
      return { weight: 0, steps: [] };
    }
  }
  
  logWeight -= Math.log(1 - FLASH_LOAN_FEE);
  
  return { weight: Math.exp(-logWeight), steps };
}

async function calcArbitrage(g: Graph): Promise<ArbitrageRoute[]> {
  console.log("Starting arbitrage calculation...");
  let arbitrageData: ArbitrageRoute[] = [];

  for (const sourceToken of ORIGIN_TOKENS) {
    const startVertex = g.getVertexByKey(sourceToken);
    if (!startVertex) {
      console.log(`Origin token ${sourceToken} not found in graph. Skipping...`);
      continue;
    }

    console.log(`Calculating for vertex: ${startVertex.getKey()}`);
    
    for (const targetToken of ORIGIN_TOKENS) {
      if (sourceToken !== targetToken) {
        const arbitrage = detectArbitrage(g, sourceToken, targetToken, 3);
        if (arbitrage && arbitrage.cycleWeight > 1.015 && arbitrage.cycleWeight < 1.5) {
          // Verificar si la ruta incluye tanto Uniswap V3 como QuickSwap
          const hasUniswap = arbitrage.steps.some(step => step.dex === DEX.UniswapV3);
          const hasQuickSwap = arbitrage.steps.some(step => step.dex === DEX.QuickSwap);
          
          if (hasUniswap && hasQuickSwap) {
            arbitrageData.push(arbitrage);
          }
        }
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
      feeTier: step.feeTier || (step.dex === DEX.QuickSwap ? 3000 : undefined),
      poolAddress: step.poolAddress // Mantenemos la dirección del pool
    }))
  }));

  console.log(`Arbitrage calculation complete. Found ${processedArbitrageData.length} opportunities.`);
  return processedArbitrageData;
}

async function main(numberTokens: number = 50, DEXs: Set<DEX>, debug: boolean = false) {
  try {
    console.log("Iniciando el proceso de arbitraje...");

    let uniTokens = DEXs.has(DEX.UniswapV3) ? await fetchTokens(numberTokens, 0, DEX.UniswapV3) : [];
    let quickTokens = DEXs.has(DEX.QuickSwap) ? await fetchTokens(numberTokens, 0, DEX.QuickSwap) : [];
    
    let tokenIds = [...new Set([...uniTokens, ...quickTokens, ...ORIGIN_TOKENS])];

    console.log(`Total tokens: ${tokenIds.length}`);

    let g: Graph = new Graph(true);
    tokenIds.forEach(element => {
      g.addVertex(new GraphVertex(element))
    });

    console.log("Obteniendo pools y precios...");
    let uniPools: Set<string> | undefined;
    let quickPools: Set<string> | undefined;

    if (DEXs.has(DEX.UniswapV3)) {
      uniPools = await fetchUniswapV3Pools(uniTokens, 100);
      console.log(`Uniswap V3 pools found: ${uniPools.size}`);
      await fetchPoolPrices(g, uniPools, DEX.UniswapV3, debug);
    }
    if (DEXs.has(DEX.QuickSwap)) {
      quickPools = await fetchQuickSwapPools(quickTokens, 100);
      console.log(`QuickSwap pools found: ${quickPools.size}`);
      await fetchPoolPrices(g, quickPools, DEX.QuickSwap, debug);
    }

    console.log(`Total pools: ${(uniPools?.size || 0) + (quickPools?.size || 0)}`);

    console.log("Calculando rutas de arbitraje...");
    const arbitrageRoutes = await calcArbitrage(g);
    console.log(`Se encontraron ${arbitrageRoutes.length} rutas de arbitraje potenciales.`);

    const filePath = path.join(__dirname, 'arbitrageRoutes.json');
    fs.writeFileSync(filePath, JSON.stringify(arbitrageRoutes, null, 2));
    console.log(`Resultados guardados en ${filePath}`);

    console.log(`Proceso completado. Se encontraron ${arbitrageRoutes.length} rutas de arbitraje.`);
  } catch (error) {
    console.error("Error en la ejecución principal:", error);
  }
}

// Si quieres ejecutar el script directamente
if (require.main === module) {
  main(10, new Set([DEX.UniswapV3, DEX.QuickSwap]), true)
    .then(() => console.log("Script completed successfully"))
    .catch(error => console.error("An error occurred during execution:", error));
  }
  
  export { main };