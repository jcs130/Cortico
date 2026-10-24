import { expect, it, vi, afterEach } from "vitest";
import { MotionProvider } from "../src/core/motion.ts";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it("uses explicit remote motion gateway paths and keeps credentials server-side", async () => {
  vi.stubEnv("AVATAR_TEST_MOTION", "fixture-motion-key");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ generatorConfigured: true })),
    );
  const provider = new MotionProvider(() => ({
    id: "remote",
    label: "Remote",
    file: "local.vrm",
    sha256: "a".repeat(64),
    format: "vrm",
    attribution: "Fixture",
    licenseUrl: "https://example.invalid",
    motion: {
      url: "https://motion.example.invalid/provider/v1",
      tokenEnv: "AVATAR_TEST_MOTION",
    },
  }));
  expect(await provider.call({ action: "status" }, "one")).toEqual({
    generatorConfigured: true,
  });
  expect(String(fetch.mock.calls[0][0])).toBe(
    "https://motion.example.invalid/provider/v1/health",
  );
  expect((fetch.mock.calls[0][1]?.headers as any).Authorization).toBe(
    "Bearer fixture-motion-key",
  );
  provider.stop();
  await expect(provider.call({ action: "status" }, "two")).rejects.toThrow(
    "stopped",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
