import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONFIG_JSONC,
  defaultConfigPath,
  loadConfig,
  writeDefaultConfig,
} from "../src/config/index.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tare-config-"));
  path = join(dir, "config.jsonc");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("defaultConfigPath", () => {
  it("punta a ~/.tare/config.jsonc", () => {
    expect(defaultConfigPath().replace(/\\/g, "/")).toMatch(/\/\.tare\/config\.jsonc$/);
  });
});

describe("loadConfig", () => {
  it("file assente → err con suggerimento tare init", async () => {
    const r = await loadConfig(path);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/tare init/);
  });

  it("config valida su disco → ok", async () => {
    await writeFile(path, DEFAULT_CONFIG_JSONC, "utf8");
    const r = await loadConfig(path);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.models.length).toBe(3);
  });

  it("config malformata su disco → err (dal parser)", async () => {
    await writeFile(path, `{ "models": {} }`, "utf8");
    expect((await loadConfig(path)).ok).toBe(false);
  });
});

describe("writeDefaultConfig", () => {
  it("scrive il template e lo crea ricaricabile", async () => {
    const w = await writeDefaultConfig(path);
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.value).toBe(path);
    expect(await readFile(path, "utf8")).toBe(DEFAULT_CONFIG_JSONC);
    expect((await loadConfig(path)).ok).toBe(true);
  });

  it("crea le cartelle mancanti", async () => {
    const nested = join(dir, "a", "b", "config.jsonc");
    expect((await writeDefaultConfig(nested)).ok).toBe(true);
  });

  it("non sovrascrive una config esistente (default)", async () => {
    await writeFile(path, "PRECEDENTE", "utf8");
    const r = await writeDefaultConfig(path);
    expect(r.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("PRECEDENTE");
  });

  it("overwrite=true rigenera la config", async () => {
    await writeFile(path, "PRECEDENTE", "utf8");
    const r = await writeDefaultConfig(path, true);
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe(DEFAULT_CONFIG_JSONC);
  });
});
