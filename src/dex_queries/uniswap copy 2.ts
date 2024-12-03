import { gql } from 'graphql-request'
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * VARIABLES
 */
export const ENDPOINT = `https://gateway-arbitrum.network.thegraph.com/api/6842087090c3e66bac508150e15a17a9/deployments/id/QmdAaDAUDCypVB85eFUkQMkS5DE1HV4s7WJb6iSiygNvAw`;

/**
 * QUERIES
 */
export function POOLS(first: number, skip: number = 0) {
  return gql`
    {
      pools(first: ${first}, skip: ${skip}) {
        id
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
    }
  `
}

export function HIGHEST_VOLUME_TOKENS(first: number, skip: number = 0, minVolumeUSD: number = 500000, orderby: string = "volumeUSD", orderDirection: string = "desc") {
  return gql`
    {
      tokens(
        first: ${first},
        skip: ${skip}, 
        where: { volumeUSD_gt: "${minVolumeUSD}" },
        orderBy: ${orderby}, 
        orderDirection: ${orderDirection}
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