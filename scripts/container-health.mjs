import { request } from "node:http";

function healthy(options) {
  return new Promise((resolve) => {
    const req = request({ ...options, method: "GET" }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    req.setTimeout(2000, () => req.destroy());
    req.once("error", () => resolve(false));
    req.end();
  });
}

const [web, moon] = await Promise.all([
  healthy({ hostname: "127.0.0.1", port: Number(process.env.PORT || 3000), path: "/api/health" }),
  healthy({ socketPath: process.env.MOON_SIDECAR_SOCKET_PATH, path: "/healthz" }),
]);
if (!web || !moon) process.exitCode = 1;
