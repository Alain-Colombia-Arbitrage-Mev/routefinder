import { gql } from 'graphql-request'
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const ENDPOINT = `https://gateway-arbitrum.network.thegraph.com/api/6842087090c3e66bac508150e15a17a9/deployments/id/QmQEYSGSD8t7jTw4gS2dwC4DLvyZceR9fYQ432Ff1hZpCp`;

export function POOLS(first: number, skip: number = 0, minLiquidityUSD: number = 50000, minVolumeUSD: number = 50000) {
  return gql`
    {
      pools(
        first: ${first}, 
        skip: ${skip}, 
        where: { 
          totalValueLockedUSD_gt: "${minLiquidityUSD}",
          volumeUSD_gt: "${minVolumeUSD}"
        },
        orderBy: volumeUSD, 
        orderDirection: desc
      ) {
        id
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
        totalValueLockedUSD
        volumeUSD
      }
    }
  `
}

export function HIGHEST_VOLUME_TOKENS(first: number, skip: number = 0, minVolumeUSD: number = 40000) {
  return gql`
    {
      tokens(
        first: ${first},
        skip: ${skip}, 
        where: { volumeUSD_gt: "${minVolumeUSD}" },
        orderBy: volumeUSD, 
        orderDirection: desc
      ) {
        id
        symbol
        name
        volumeUSD
      }
    }
  `
}

export function fetch_pool(id: string) {
  return gql`
    {
      pool(id: "${id}") {
        token0 { id, symbol }
        token1 { id, symbol }
        token0Price
        token1Price
        totalValueLockedUSD
        feeTier 
        feesUSD
      }
    }
  `
}

export function token_whitelist_pools(id: string) {
  return gql`
    {
      token(id: "${id}") {
        whitelistPools {
          id
          token0 {
            id
          }
          token1 {
            id
          }
        }
      }
    }
  `
}