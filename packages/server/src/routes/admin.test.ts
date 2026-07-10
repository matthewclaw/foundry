/**
 * E5.7 — admin routes: POST /api/backup writes a real backup and returns metadata.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import { createFakeAdapter, loadScenario } from "@foundry/adapter-fake";

describe("admin routes", () => {
  let dataDir: string;
  const backupDirs: string[] = [];

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    for (const d of backupDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("POST /api/backup creates a backup with foundry.db", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "foundry-admin-"));
    const backupDir = mkdtempSync(join(tmpdir(), "foundry-backup-"));
    backupDirs.push(backupDir);

    const server = createServer({
      dataDir,
      adapters: {
        fake: createFakeAdapter(loadScenario("happy-path")),
      },
    });

    await server.start();

    try {
      const result = await server.app.inject({
        method: "POST",
        url: "/api/backup",
        payload: { dest: backupDir },
      });

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.payload);
      expect(body.path).toBe(backupDir);
      expect(body.sizeBytes).toBeGreaterThan(0);

      // Verify backup actually created the DB
      expect(existsSync(join(backupDir, "foundry.db"))).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
