import asyncio
import ssl
import sys

async def forward(reader, writer):
    try:
        while block := await reader.read(65536):
            writer.write(block)
            await writer.drain()
    finally:
        writer.close()

async def handle(reader, writer):
    upstream, downstream = await asyncio.open_connection("127.0.0.1", 17446)
    await asyncio.gather(forward(reader, downstream), forward(upstream, writer), return_exceptions=True)

async def main():
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(sys.argv[1], sys.argv[2])
    server = await asyncio.start_server(handle, "127.0.0.1", 17445, ssl=context)
    async with server:
        await server.serve_forever()

asyncio.run(main())
