import { gql } from 'graphql-request'

export const ENDPOINT = `https://gateway-arbitrum.network.thegraph.com/api/6842087090c3e66bac508150e15a17a9/deployments/id/QmQEYSGSD8t7jTw4gS2dwC4DLvyZceR9fYQ432Ff1hZpCp`;

export function POOLS(first: number = 100) {
  return gql`
    {
      pools(first: ${first}, orderBy: totalValueLockedUSD, orderDirection: desc) {
        id
        token0 {
          id
          symbol
          name
        }
        token1 {
          id
          name
          symbol
        }
        volumeUSD
        feeGrowthGlobal0X128
        feeGrowthGlobal1X128
        fee
        liquidity
        sqrtPrice
        totalValueLockedUSD
      }
    }
  `
}

export function TOKENS(first: number = 100) {
  return gql`
    {
      tokens(first: ${first}, orderBy: volumeUSD, orderDirection: asc) {
        id
        name
        symbol
        volumeUSD
      }
    }
  `
}

export function POOL(id: string) {
  return gql`
    {
      pool(id: "${id}") {
        token0 {
          id
          name
          symbol
        }
        token1 {
          id
          name
          symbol
        }
        liquidity
        sqrtPrice
        volumeUSD
        txCount
        totalValueLockedUSD
      }
    }
  `
}

export function TOKEN_WHITELIST_POOLS(id: string) {
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