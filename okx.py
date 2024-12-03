import ccxt
import asyncio
import aiohttp
import time
from decimal import Decimal
import json

# Configuración de la API de OKX
exchange = ccxt.okx({
    'apiKey': 'a046929d-6c75-4c02-a20e-b1876aa911ca',
    'secret': 'ECD1328005C955659EB59EC2936A747E',
    'password': '@Angelyalaia.2024',
    'enableRateLimit': True,
})

MIN_PROFIT = 0.001  # 0.1% mínimo de beneficio
MIN_VOLUME = 10_000_000  # Volumen mínimo de 10,000,000 USD
MAX_REQUESTS = 20  # Máximo de solicitudes por lote
REQUEST_INTERVAL = 2  # Intervalo en segundos entre lotes de solicitudes

async def get_liquid_pairs(session, min_volume=MIN_VOLUME):
    async with session.get(f"{exchange.urls['api']}/api/v5/market/tickers") as response:
        tickers = await response.json()
        liquid_pairs = []
        for ticker in tickers['data']:
            volume = float(ticker['volCcy24h']) if ticker['volCcy24h'] else 0
            if volume > min_volume:
                liquid_pairs.append(ticker['instId'])
        return liquid_pairs

def get_triangular_paths(pairs):
    base_currencies = ['USDC', 'USDT', 'TRY']
    triangular_paths = []
    for base in base_currencies:
        for pair1, pair2, pair3 in itertools.permutations(pairs, 3):
            if (pair1.startswith(base) or pair1.endswith(base)) and \
               (pair2.startswith(base) or pair2.endswith(base) or \
                pair2.startswith(pair1.split('-')[0]) or pair2.endswith(pair1.split('-')[1])) and \
               (pair3.startswith(base) or pair3.endswith(base) or \
                pair3.startswith(pair2.split('-')[0]) or pair3.endswith(pair2.split('-')[1])):
                triangular_paths.append((pair1, pair2, pair3))
    return triangular_paths

def save_opportunities_to_json(opportunities, filename='arbitrage_opportunities.json'):
    with open(filename, 'w') as f:
        json.dump(opportunities, f, indent=2)
    print(f"Oportunidades guardadas en {filename}")

async def fetch_order_book(session, symbol):
    url = f"{exchange.urls['api']}/api/v5/market/books?instId={symbol}&sz=1"
    async with session.get(url) as response:
        return await response.json()

async def calculate_triangular_arbitrage(session, path, amount=100):
    pair1, pair2, pair3 = path
    try:
        orderbook1 = await fetch_order_book(session, pair1)
        orderbook2 = await fetch_order_book(session, pair2)
        orderbook3 = await fetch_order_book(session, pair3)
        
        fee = 0.001  # Asumimos una comisión del 0.1%, ajusta según las comisiones reales de OKX
        
        # Primera operación
        amount1 = amount
        price1 = Decimal(str(orderbook1['data'][0]['asks'][0][0]))
        amount2 = (Decimal(str(amount1)) / price1) * (Decimal('1') - Decimal(str(fee)))
        
        # Segunda operación
        if pair2.startswith(pair1.split('-')[1]):
            price2 = Decimal(str(orderbook2['data'][0]['bids'][0][0]))
            amount3 = amount2 * price2 * (Decimal('1') - Decimal(str(fee)))
        else:
            price2 = Decimal(str(orderbook2['data'][0]['asks'][0][0]))
            amount3 = (amount2 / price2) * (Decimal('1') - Decimal(str(fee)))
        
        # Tercera operación
        if pair3.startswith(pair2.split('-')[1]):
            price3 = Decimal(str(orderbook3['data'][0]['bids'][0][0]))
            final_amount = amount3 * price3 * (Decimal('1') - Decimal(str(fee)))
        else:
            price3 = Decimal(str(orderbook3['data'][0]['asks'][0][0]))
            final_amount = (amount3 / price3) * (Decimal('1') - Decimal(str(fee)))
        
        # Calcular el beneficio
        profit = (final_amount - Decimal(str(amount))) / Decimal(str(amount))
        
        # Determinar las acciones para cada par
        action1 = "buy"
        action2 = "sell" if pair2.startswith(pair1.split('-')[1]) else "buy"
        action3 = "sell" if pair3.startswith(pair2.split('-')[1]) else "buy"
        
        return float(profit), path, float(final_amount), action1, action2, action3
    except Exception as e:
        print(f"Error al calcular arbitraje para {path}: {str(e)}")
        return None

async def process_batch(session, paths):
    tasks = [calculate_triangular_arbitrage(session, path) for path in paths]
    return await asyncio.gather(*tasks)

async def main():
    async with aiohttp.ClientSession() as session:
        while True:
            try:
                print("Obteniendo pares líquidos...")
                liquid_pairs = await get_liquid_pairs(session)
                print(f"Pares líquidos encontrados: {len(liquid_pairs)}")
                
                print("Generando rutas de arbitraje triangular...")
                triangular_paths = get_triangular_paths(liquid_pairs)
                print(f"Rutas generadas: {len(triangular_paths)}")
                
                print("Calculando oportunidades de arbitraje...")
                opportunities = []
                for i in range(0, len(triangular_paths), MAX_REQUESTS):
                    batch = triangular_paths[i:i+MAX_REQUESTS]
                    results = await process_batch(session, batch)
                    for result in results:
                        if result and result[0] > MIN_PROFIT:
                            opportunities.append({
                                "profit": result[0],
                                "path": result[1],
                                "final_amount": result[2],
                                "steps": [
                                    {"pair": result[1][0], "action": result[3], "token": result[1][0].split('-')[0]},
                                    {"pair": result[1][1], "action": result[4], "token": result[1][1].split('-')[0]},
                                    {"pair": result[1][2], "action": result[5], "token": result[1][2].split('-')[0]}
                                ]
                            })
                    await asyncio.sleep(REQUEST_INTERVAL)  # Esperar 2 segundos entre lotes
                
                # Ordenar oportunidades por beneficio
                opportunities.sort(key=lambda x: x["profit"], reverse=True)
                
                # Guardar oportunidades en JSON
                save_opportunities_to_json(opportunities)
                
                # Mostrar las mejores oportunidades
                print(f"Oportunidades encontradas: {len(opportunities)}")
                for opp in opportunities[:5]:
                    print(f"Oportunidad: {opp['path']}")
                    print(f"  Beneficio: {opp['profit']:.2%}")
                    print(f"  Monto final: {opp['final_amount']:.2f}")
                    print(f"  Pasos:")
                    for step in opp['steps']:
                        print(f"    {step['action'].capitalize()} {step['token']} usando {step['pair']}")
                    print()
                
                # Esperar antes de la próxima iteración
                await asyncio.sleep(10)
            
            except Exception as e:
                print(f"Error en el ciclo principal: {str(e)}")
                await asyncio.sleep(10)

if __name__ == "__main__":
    asyncio.run(main())