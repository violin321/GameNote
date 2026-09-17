import { createServer } from "node:http";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { equalSecret, MoonError, safeError } from "./security.mjs";

async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || ""))
    throw new MoonError("moon_content_type_invalid", 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new MoonError("moon_body_too_large", 413);
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("object");
    return result;
  } catch {
    throw new MoonError("moon_body_invalid", 400);
  }
}

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

export function createMoonServer(runtime, apiKey) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (!equalSecret(request.headers.authorization || "", `Bearer ${apiKey}`))
        throw new MoonError("unauthorized", 401);
      // The Unix-only API is not a browser endpoint. Reject Origin even with a leaked key.
      if (request.headers.origin) throw new MoonError("moon_origin_forbidden", 403);
      const route = `${request.method} ${request.url}`;
      if (route === "GET /v1/status") json(response, 200, runtime.status());
      else if (route === "POST /v1/auth/authorize") json(response, 200, await runtime.authorize());
      else if (route === "POST /v1/auth/callback") {
        const input = await body(request);
        if (Object.keys(input).length !== 1 || typeof input.callbackUrl !== "string")
          throw new MoonError("moon_callback_invalid", 400);
        await runtime.callback(input.callbackUrl);
        json(response, 204);
      } else if (route === "POST /v1/sync") json(response, 200, await runtime.sync());
      else if (route === "GET /v1/snapshot") json(response, 200, runtime.snapshot());
      else if (route === "DELETE /v1/link") {
        await runtime.disconnect();
        json(response, 204);
      } else throw new MoonError("not_found", 404);
    } catch (error) {
      const safe = safeError(error);
      json(response, safe.status, { error: safe.code });
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 32;
  return server;
}

export async function listenUnix(server, socketPath) {
  if (Buffer.byteLength(socketPath) > 100) throw new MoonError("moon_socket_path_too_long", 500);
  let stat;
  try {
    stat = await lstat(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (stat) {
    if (!stat.isSocket() || stat.uid !== process.getuid?.())
      throw new MoonError("moon_socket_unsafe", 500);
    const active = await new Promise((resolve, reject) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", (error) => {
        probe.destroy();
        if (error.code === "ECONNREFUSED") resolve(false);
        else reject(error);
      });
      probe.setTimeout(1000, () => {
        probe.destroy();
        reject(new MoonError("moon_socket_busy", 500));
      });
    });
    if (active) throw new MoonError("moon_socket_busy", 500);
    await unlink(socketPath);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
}
