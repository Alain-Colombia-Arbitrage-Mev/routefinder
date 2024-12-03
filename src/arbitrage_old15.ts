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

const UNISWAP_V3_POOL_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)"
];

interface SwapStep {
  fromToken: string;
  toToken: string;
  dex: DEX | string;
  router: string;
  feeTier: number; 
  poolAddress: string;
}

interface ArbitrageRoute {
  cycle: string[];
  cycleWeight: number;
  type: 'cyclic' | 'non-cyclic';
  [key: string]: SwapStep | string[] | number | 'cyclic' | 'non-cyclic';
}

async function fetchUniswapV3Pools(first: number = 100, skip: number = 0, minVolumeUSD: number = 50000): Promise<Set<string>> {
  const query = UNISWAP.POOLS(first, skip, minVolumeUSD);
  try {
    const response = await request(UNISWAP.ENDPOINT, query);
    const pools = new Set<string>(response.pools.map((pool: any) => pool.id));
    console.log(`Uniswap V3 pools fetched: ${pools.size}`);
    return pools;
  } catch (error) {
    console.error('Error fetching Uniswap V3 pools:', error);
    return new Set<string>();
  }
}

async function fetchQuickSwapPools(first: number = 100): Promise<Set<string>> {
  const query = QUICKSWAP.POOLS(first);
  try {
    console.log("Fetching QuickSwap pools with query:", query);
    const response = await request(QUICKSWAP.ENDPOINT, query);
    console.log("QuickSwap response:", JSON.stringify(response, null, 2));
    const pools = new Set<string>(response.pools.map((pool: any) => pool.id));
    console.log(`QuickSwap pools fetched: ${pools.size}`);
    return pools;
  } catch (error) {
    console.error('Error fetching QuickSwap pools:', error);
    return new Set<string>();
  }
}

async function getPoolData(poolAddress: string, dex: DEX): Promise<{ price: number, liquidity: string, token0: string, token1: string, feeTier: number }> {
  try {
    let poolData;
    if (dex === DEX.QuickSwap) {
      const query = QUICKSWAP.POOL(poolAddress);
      poolData = await request(QUICKSWAP.ENDPOINT, query);
      poolData = poolData.pool;
    } else {
      const poolContract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
      poolData = {
        token0: { id: await poolContract.token0() },
        token1: { id: await poolContract.token1() },
        liquidity: await poolContract.liquidity(),
        sqrtPrice: (await poolContract.slot0())[0],
        fee: await poolContract.fee(),
      };
    }

    const price = Math.pow(Number(poolData.sqrtPrice) / Math.pow(2, 96), 2);
    const feeTier = dex === DEX.QuickSwap ? Number(poolData.fee) : Number(poolData.fee);

    if (price === 0) {
      console.warn(`Price is zero for pool ${poolAddress}`);
      return { price: 0, liquidity: '0', token0: poolData.token0.id, token1: poolData.token1.id, feeTier };
    }

    return { 
      price, 
      liquidity: poolData.liquidity.toString(), 
      token0: poolData.token0.id, 
      token1: poolData.token1.id, 
      feeTier 
    };
  } catch (error) {
    console.error(`Error al obtener datos de la pool de ${dex} ${poolAddress}:`, error);
    return { price: 0, liquidity: '0', token0: '', token1: '', feeTier: 0 };
  }
}

async function fetchPoolPrices(g: Graph, pools: Set<string>, dex: DEX, debug: boolean = false): Promise<void> {
  if (debug) console.log(pools);
  for (var pool of Array.from(pools.values())) {
    try {
      if (debug) console.log(dex, pool);
      
      const { price, liquidity, token0, token1, feeTier } = await getPoolData(pool, dex);
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

async function calcArbitrage(g: Graph): Promise<ArbitrageRoute[]> {
  console.log("Starting arbitrage calculation...");
  let arbitrageData: ArbitrageRoute[] = [];
  let uniqueCycle: {[key: string]: boolean} = {};

  // Calcular rutas cíclicas
  for (const originToken of ORIGIN_TOKENS) {
    const startVertex = g.getVertexByKey(originToken);
    if (!startVertex) {
      console.log(`Origin token ${originToken} not found in graph. Skipping...`);
      continue;
    }

    console.log(`Calculating for vertex: ${startVertex.getKey()}`);
    let cycles = findCycles(g, startVertex, 3, 10);
    
    for (const cycle of cycles) {
      let cycleString = cycle.join('');
      if (!uniqueCycle[cycleString]) {
        uniqueCycle[cycleString] = true;
        let { weight: cycleWeight, steps } = calculateCycleWeight(g, cycle);
        
        // Verificar si la ruta incluye tanto Uniswap V3 como QuickSwap
        const hasUniswap = steps.some(step => step.dex === DEX.UniswapV3);
        const hasQuickSwap = steps.some(step => step.dex === DEX.QuickSwap);
        
        if (cycleWeight > 1.006 && cycleWeight < 1.5 && hasUniswap && hasQuickSwap) {
          let arbitrageRoute: ArbitrageRoute = {
            cycle: cycle,
            cycleWeight: cycleWeight,
            type: 'cyclic'
          };
          steps.forEach((step, index) => {
            (arbitrageRoute as any)[`step${index + 1}`] = {
              ...step,
              dex: getDexName(step.dex as DEX),
            };
          });
          arbitrageData.push(arbitrageRoute);
        }
      }
    }
  }

  // Calcular rutas no cíclicas
  for (const sourceToken of ORIGIN_TOKENS) {
    for (const targetToken of ORIGIN_TOKENS) {
      if (sourceToken !== targetToken) {
        const nonCyclicArbitrage = detectNonCyclicArbitrage(g, sourceToken, targetToken, 3);
        if (nonCyclicArbitrage && nonCyclicArbitrage.cycleWeight > 1.01 && nonCyclicArbitrage.cycleWeight < 1.5) {
          arbitrageData.push(nonCyclicArbitrage);
        }
      }
    }
  }

  console.log(`Arbitrage calculation complete. Found ${arbitrageData.length} opportunities.`);
  return arbitrageData;
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
        cycles.push([...path, startVertex.getKey()]);
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
        feeTier: edge.metadata.feeTier,
        poolAddress: edge.metadata.address
      });
    } else {
      console.warn(`No edge found between ${cycle[i]} and ${cycle[i + 1]}`);
      return { weight: 0, steps: [] };
    }
  }
  
  logWeight -= Math.log(1 - FLASH_LOAN_FEE / 2);
  
  return { weight: Math.exp(-logWeight), steps };
}

function detectNonCyclicArbitrage(graph: Graph, sourceToken: string, targetToken: string, minLength: number): ArbitrageRoute | null {
  console.log(`Detecting non-cyclic arbitrage from ${sourceToken} to ${targetToken}`);
  
  let bestArbitrage: ArbitrageRoute | null = null;
  let bestWeight = 0;

  function dfs(currentToken: string, path: string[], weight: number, steps: SwapStep[]) {
    if (path.length > minLength + 1) return; // +1 porque incluimos el token inicial

    if (currentToken === targetToken && path.length >= minLength) {
      const cycleWeight = Math.exp(weight);
      if (cycleWeight > 1.01 && cycleWeight < 1.5 && cycleWeight > bestWeight) {
        bestWeight = cycleWeight;
        bestArbitrage = {
          cycle: [...path, sourceToken], // Añadimos el token inicial al final para cerrar el ciclo
          cycleWeight: cycleWeight,
          type: 'non-cyclic'
        };
        steps.forEach((step, index) => {
          (bestArbitrage as any)[`step${index + 1}`] = step;
        });
        (bestArbitrage as any)[`step${steps.length + 1}`] = {
          fromToken: currentToken,
          toToken: sourceToken,
          dex: DEX.UniswapV3, // Asumimos UniswapV3 para el último paso
          router: ROUTER_ADDRESS_OBJECT.uniswapV3,
          feeTier: 3000, // Asumimos un feeTier por defecto
          poolAddress: '' // Esto debería ser llenado con la dirección real del pool si está disponible
        };
      }
      return;
    }

    const edges = graph.getAllEdges().filter(edge => edge.startVertex.getKey() === currentToken);
    for (const edge of edges) {
      const nextToken = edge.endVertex.getKey();
      if (!path.includes(nextToken)) {
        const newStep: SwapStep = {
          fromToken: currentToken,
          toToken: nextToken,
          dex: edge.metadata.dex,
          router: edge.metadata.dex === DEX.UniswapV3 ? ROUTER_ADDRESS_OBJECT.uniswapV3 : ROUTER_ADDRESS_OBJECT.quickswap,
          feeTier: edge.metadata.feeTier,
          poolAddress: edge.metadata.address
        };
        dfs(nextToken, [...path, nextToken], weight + edge.weight - Math.log(1 - edge.metadata.fee - SLIPPAGE), [...steps, newStep]);
      }
    }
  }

  dfs(sourceToken, [sourceToken], 0, []);

  if (bestArbitrage) {
    console.log(`Found non-cyclic arbitrage opportunity: ${bestArbitrage.cycle.join(' -> ')} with weight ${bestArbitrage.cycleWeight}`);
  } else {
    console.log(`No non-cyclic arbitrage opportunity found from ${sourceToken} to ${targetToken}`);
  }

  return bestArbitrage;
}

async function main(debug: boolean = false, minVolumeUSD: number = 50000) {
  try {
    console.log("Iniciando el proceso de arbitraje...");

    let g: Graph = new Graph(true);

    console.log("Obteniendo pools y precios...");
    
    console.log("Fetching Uniswap V3 pools...");
    let uniPools = await fetchUniswapV3Pools(100, 0, minVolumeUSD);
    console.log(`Uniswap V3 pools fetched: ${uniPools.size}`);
    if (debug) {
      console.log("Uniswap V3 pools:", Array.from(uniPools));
    }

    console.log("Fetching QuickSwap pools...");
    let quickPools = await fetchQuickSwapPools(100);
    console.log(`QuickSwap pools fetched: ${quickPools.size}`);
    if (debug) {
      console.log("QuickSwap pools:", Array.from(quickPools));
    }

    console.log("Fetching Uniswap V3 pool prices...");
    await fetchPoolPrices(g, uniPools, DEX.UniswapV3, debug);

    console.log("Fetching QuickSwap pool prices...");
    await fetchPoolPrices(g, quickPools, DEX.QuickSwap, debug);

    console.log(`Total pools: ${uniPools.size + quickPools.size}`);

    console.log("Calculando rutas de arbitraje...");
    const arbitrageRoutes = await calcArbitrage(g);
    console.log(`Se encontraron ${arbitrageRoutes.length} rutas de arbitraje potenciales.`);

    if (debug) {
      console.log("Rutas de arbitraje encontradas:");
      arbitrageRoutes.forEach((route, index) => {
        console.log(`Ruta ${index + 1}:`);
        console.log(`  Ciclo: ${route.cycle.join(' -> ')}`);
        console.log(`  Peso del ciclo: ${route.cycleWeight}`);
        console.log(`  Pasos:`);
        for (let i = 1; route[`step${i}`]; i++) {
          const step = route[`step${i}`] as SwapStep;
          console.log(`    Paso ${i}: ${step.fromToken} -> ${step.toToken} (${step.dex})`);
        }
        console.log('');
      });
    }

    const filePath = path.join(__dirname, 'arbitrageRoutes.json');
    fs.writeFileSync(filePath, JSON.stringify(arbitrageRoutes, null, 2));
    console.log(`Resultados guardados en ${filePath}`);

    console.log(`Proceso completado. Se encontraron ${arbitrageRoutes.length} rutas de arbitraje.`);

    // Imprimir estadísticas
    console.log("\nEstadísticas:");
    console.log(`Total de vértices en el grafo: ${g.getAllVertices().length}`);
    console.log(`Total de aristas en el grafo: ${g.getAllEdges().length}`);
    const uniswapEdges = g.getAllEdges().filter(edge => edge.metadata.dex === DEX.UniswapV3);
    const quickswapEdges = g.getAllEdges().filter(edge => edge.metadata.dex === DEX.QuickSwap);
    console.log(`Aristas de Uniswap V3: ${uniswapEdges.length}`);
    console.log(`Aristas de QuickSwap: ${quickswapEdges.length}`);

  } catch (error) {
    console.error("Error en la ejecución principal:", error);
  }
}

// Si quieres ejecutar el script directamente
if (require.main === module) {
  main(true, 50000)
    .then(() => console.log("Script completed successfully"))
    .catch(error => console.error("An error occurred during execution:", error));
}

export { main };