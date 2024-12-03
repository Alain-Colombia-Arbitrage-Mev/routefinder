import { gql } from 'graphql-request'

export const ENDPOINT = `https://gateway-arbitrum.network.thegraph.com/api/6842087090c3e66bac508150e15a17a9/subgraphs/id/8NiXkxLRT3R22vpwLB4DXttpEf3X1LrKhe4T1tQ3jjbP`;


export function PAIR(id: string) {
  return gql`
    {
      pair(id: "${id}") {
        token0 { id, symbol }
        token1 { id, symbol }
        token0Price
        token1Price
        reserveUSD
      }
    }
  `
}

export function HIGHEST_VOLUME_TOKENS(first: number, skip: number = 0, minVolumeUSD: number = 200000) {
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

export function POOLS(first: number, skip: number = 0, minLiquidityUSD: number = 200000) {
  return gql`
    {
      pairs(
        first: ${first}, 
        skip: ${skip}, 
        where: { reserveUSD_gt: "${minLiquidityUSD}" },
        orderBy: reserveUSD, 
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
        reserveUSD
      }
    }
  `
}