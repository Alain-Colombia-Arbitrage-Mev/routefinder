import asyncio
import aiohttp
import logging
from decimal import Decimal, getcontext
import itertools
import time
import json
from collections import defaultdict
import networkx as nx

# Configurar logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Establecer una precisión alta para los cálculos con decimales
getcontext().prec = 30

# Constantes
MIN_VOLUME = 100000  # Volumen mínimo en USD
MAX_ROUTE_LENGTH = 5
INITIAL_AMOUNTS = [100, 1000, 10000]  # Montos iniciales para probar
FEE = Decimal('0.001')  # 0.1% de comisión
BASE_CURRENCIES = ['USDT', 'USDC', 'BTC', 'ETH']
PRICE_CHANGE_THRESHOLD = 0.005  # 0.5% de cambio de precio

class ArbitrageAnalyzer:
    def __init__(self):
        self.session = None
        self.all_tickers = {}
        self.graph = nx.DiGraph()
        self.opportunities = []

    async def initialize(self):
        self.session = aiohttp.ClientSession()
        await self.update_tickers()
        self.build_graph()

    async def close(self):
        if self.session:
            await self.session.close()

    async def get_ticker(self, symbol):
        base_url = "https://api.kucoin.com"
        url = f"{base_url}/api/v1/market/orderbook/level1?symbol={symbol}"
        async with self.session.get(url) as response:
            if response.status == 200:
                data = await response.json()
                if data and 'data' in data:
                    return data['data']
            logger.error(f"Error al obtener el ticker para {symbol}")
            return None

    async def update_tickers(self):
        base_url = "https://api.kucoin.com"
        url = f"{base_url}/api/v1/market/allTickers"
        async with self.session.get(url) as response:
            if response.status == 200:
                data = await response.json()
                if data and 'data' in data and 'ticker' in data['data']:
                    self.all_tickers = {
                        ticker['symbol']: ticker for ticker in data['data']['ticker']
                        if float(ticker.get('volValue', 0)) > MIN_VOLUME
                    }
                    logger.info(f"Actualizados {len(self.all_tickers)} tickers con volumen suficiente")
                    return
            logger.error("Error al obtener todos los tickers")

    def build_graph(self):
        self.graph.clear()
        for symbol, ticker in self.all_tickers.items():
            base, quote = symbol.split('-')
            price = Decimal(ticker['last'])
            self.graph.add_edge(quote, base, symbol=symbol, price=price)
            self.graph.add_edge(base, quote, symbol=symbol, price=1/price)

    def find_arbitrage_opportunities(self):
        opportunities = []
        for base in BASE_CURRENCIES:
            for length in range(3, MAX_ROUTE_LENGTH + 1):
                for path in nx.all_simple_paths(self.graph, base, base, cutoff=length):
                    if len(path) > 2:
                        route = [self.graph[path[i]][path[i+1]]['symbol'] for i in range(len(path)-1)]
                        opportunities.append(route)
        return opportunities

    async def calculate_arbitrage(self, route, initial_amount):
        amount = Decimal(str(initial_amount))
        steps = []

        for pair in route:
            ticker = await self.get_ticker(pair)
            if not ticker:
                return None

            price = Decimal(ticker['price'])
            base, quote = pair.split('-')

            if quote == route[0].split('-')[1]:  # Comprar
                new_amount = (amount / price) * (1 - FEE)
                steps.append(f"Comprar {new_amount} {base} a {price} {quote}")
            else:  # Vender
                new_amount = (amount * price) * (1 - FEE)
                steps.append(f"Vender {amount} {base} por {new_amount} {quote}")
            
            amount = new_amount

        profit = (amount - Decimal(str(initial_amount))) / Decimal(str(initial_amount))
        return {
            'route': route,
            'initial_amount': initial_amount,
            'final_amount': float(amount),
            'profit_percentage': float(profit * 100),
            'steps': steps
        }

    async def monitor_prices(self, interval=60):
        while True:
            previous_tickers = self.all_tickers.copy()
            await self.update_tickers()
            
            significant_changes = []
            for symbol, ticker in self.all_tickers.items():
                if symbol in previous_tickers:
                    prev_price = Decimal(previous_tickers[symbol]['last'])
                    curr_price = Decimal(ticker['last'])
                    change = abs(curr_price - prev_price) / prev_price
                    if change > PRICE_CHANGE_THRESHOLD:
                        significant_changes.append((symbol, float(change) * 100))
            
            if significant_changes:
                logger.info("Cambios significativos de precio detectados:")
                for symbol, change in significant_changes:
                    logger.info(f"{symbol}: {change:.2f}%")
                
                self.build_graph()
                await self.analyze_opportunities()
            
            await asyncio.sleep(interval)

    async def analyze_opportunities(self):
        opportunities = self.find_arbitrage_opportunities()
        results = []
        for route in opportunities:
            for amount in INITIAL_AMOUNTS:
                result = await self.calculate_arbitrage(route, amount)
                if result and result['profit_percentage'] > 0:
                    results.append(result)
        
        results.sort(key=lambda x: x['profit_percentage'], reverse=True)
        self.opportunities = results[:10]  # Guardar las 10 mejores oportunidades

        logger.info("Top 10 oportunidades de arbitraje:")
        for i, result in enumerate(self.opportunities, 1):
            logger.info(f"{i}. Ruta: {' -> '.join(result['route'])}")
            logger.info(f"   Beneficio: {result['profit_percentage']:.4f}%")
            logger.info(f"   Monto inicial: {result['initial_amount']}, Monto final: {result['final_amount']:.4f}")
            for step in result['steps']:
                logger.info(f"   - {step}")
            logger.info("-----------------------------")

    def save_opportunities(self, filename='arbitrage_opportunities.json'):
        with open(filename, 'w') as f:
            json.dump(self.opportunities, f, indent=2)
        logger.info(f"Oportunidades guardadas en {filename}")

async def main():
    analyzer = ArbitrageAnalyzer()
    await analyzer.initialize()

    try:
        await asyncio.gather(
            analyzer.monitor_prices(),
            analyzer.analyze_opportunities()
        )
    finally:
        await analyzer.close()
        analyzer.save_opportunities()

if __name__ == "__main__":
    asyncio.run(main())