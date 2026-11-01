import { createServer, type Server } from "node:http";

/**
 * The container's liveness probe, internal only: the worker has no public routes. It answers while
 * the process runs; a stalled chain or a paused breaker is reported by alerts, not by a restart.
 */
export function startHealthServer(port: number): Server {
  const server = createServer((request, response) => {
    const ok = request.url === "/live";
    response.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok }));
  });
  server.listen(port);
  return server;
}
