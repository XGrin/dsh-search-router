#!/usr/bin/env node
/**
 * Minimal mock SearXNG endpoint (dev artifact): `GET /search?q=…&format=json`
 * answering the documented SearXNG JSON shape. For local end-to-end boots
 * without any real search API.
 *
 *   node scripts/mock-searxng.mjs [port]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 18434);
let hits = 0;

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  hits += 1;
  if (url.pathname !== "/search" || url.searchParams.get("format") !== "json") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    query: url.searchParams.get("q"),
    results: [
      { url: "https://example.com/mock-1", title: "Mock SearXNG result one", content: `hit ${hits} for ${url.searchParams.get("q")}` },
      { url: "https://example.com/mock-2", title: "Mock SearXNG result two", content: "second mock result" },
    ],
  }));
  console.log(`[mock-searxng] served: ${url.searchParams.get("q")}`);
}).listen(port, "127.0.0.1", () => {
  console.log(`[mock-searxng] listening on http://127.0.0.1:${port}`);
});
