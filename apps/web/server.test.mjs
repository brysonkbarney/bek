import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRuntimeConfigScript,
  createBekStaticServer,
  resolveRuntimeApiUrl,
} from "./server.mjs";

const cleanupPaths = [];

describe("Bek web static server", () => {
  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((dir) => rm(dir, { recursive: true })),
    );
  });

  it("builds runtime API config from BEK_WEB_API_URL", () => {
    expect(
      buildRuntimeConfigScript({
        BEK_WEB_API_URL: " https://api.example.test/// ",
        VITE_BEK_API_URL: "http://localhost:4317",
      }),
    ).toBe('window.__BEK_CONFIG__ = {"apiUrl":"https://api.example.test"};\n');
  });

  it("falls back through legacy Vite and public API URL env names", () => {
    expect(
      resolveRuntimeApiUrl({
        VITE_BEK_API_URL: "https://vite.example.test/",
        BEK_PUBLIC_URL: "https://public.example.test",
      }),
    ).toBe("https://vite.example.test");
    expect(
      resolveRuntimeApiUrl({
        BEK_PUBLIC_URL: "https://public.example.test/",
      }),
    ).toBe("https://public.example.test");
  });

  it("serves no-store runtime config over HTTP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bek-web-"));
    cleanupPaths.push(root);
    const server = createBekStaticServer({
      root,
      env: { BEK_WEB_API_URL: "https://api.example.test/" },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      expect(address).toEqual(
        expect.objectContaining({ port: expect.any(Number) }),
      );
      const response = await fetch(
        `http://127.0.0.1:${address.port}/bek-config.js`,
      );

      await expect(response.text()).resolves.toBe(
        'window.__BEK_CONFIG__ = {"apiUrl":"https://api.example.test"};\n',
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
