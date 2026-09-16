const http = require("node:http");

const host = "127.0.0.1";
const port = 5179;

function send(response, status, body) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  if (request.method === "OPTIONS") {
    send(response, 204, {});
    return;
  }

  if (request.method === "GET" && request.url === "/api/health") {
    send(response, 200, { status: "ready", service: "dubroom-scorer-stub", version: "1.0" });
    return;
  }

  if (request.method === "POST" && request.url === "/api/score") {
    let receivedBytes = 0;
    request.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > 100 * 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      send(response, 200, {
        score: 100,
        metrics: { timing: 100, clarity: 100, emotion: 100 },
        received_bytes: receivedBytes,
        engine: "stub",
      });
    });
    return;
  }

  send(response, 404, { error: "not_found" });
});

server.listen(port, host, () => {
  console.log(`DUBROOM scorer stub is ready at http://${host}:${port}`);
  console.log("Every submitted take receives 100/100. Press Ctrl+C to stop.");
});
