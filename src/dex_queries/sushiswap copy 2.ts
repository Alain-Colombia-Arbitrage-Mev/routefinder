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

export function PAIRS(ids: string[]) { 
  let idString = '[\"' + ids.join("\",\"") + "\"]";
  return gql`
    query {
      pairs (where: {
        token0_in: ${idString},
        token1_in: ${idString}
      }) {
        id
        name
        token0 {id}
        token1 {id}
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

// Función adicional para obtener pools de Sushiswap (similar a la de Uniswap)
export function POOLS(first: number, skip: number = 0) {
  return gql`
    {
      pairs(first: ${first}, skip: ${skip}) {
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