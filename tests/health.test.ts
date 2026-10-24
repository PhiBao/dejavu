import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { importanceScore, relianceBoost } from "@/lib/health";
import { captureMemory, recall } from "@/lib/memory";
import { createUser, loadStore, memoryUsageMap } from "@/lib/store";

process.env.DEJAVU_DATA_PATH = join(tmpdir(), `recall-health-${process.pid}.json`);

beforeEach(() => {
  try {
    rmSync(process.env.DEJAVU_DATA_PATH as string, { force: true });
  } catch {
    /* ignore */
  }
});

describe("importance scoring is explainable", () => {
  it("ranks a relied-on, person-linked, owed memory above a cold note", () => {
    const strong = importanceScore({
      hits: 5,
      lastHitAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      hasPerson: true,
      hasCommitment: true,
    });
    const cold = importanceScore({
      hits: 0,
      lastHitAt: null,
      createdAt: new Date(Date.now() - 200 * 86400_000).toISOString(),
      hasPerson: false,
      hasCommitment: false,
    });
    expect(strong.score).toBeGreaterThan(cold.score);
    expect(strong.score).toBeLessThanOrEqual(1);
    expect(cold.score).toBe(0);
  });

  it("explains every component it counts", () => {
    const { reasons } = importanceScore({
      hits: 3,
      lastHitAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      hasPerson: true,
      hasCommitment: true,
    });
    expect(reasons).toContain("recalled 3 times");
    expect(reasons).toContain("used recently");
    expect(reasons).toContain("tied to a person");
    expect(reasons).toContain("something you owe");
  });

  it("decays with recency", () => {
    const recent = importanceScore({
      hits: 0,
      lastHitAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      hasPerson: false,
      hasCommitment: false,
    });
    const stale = importanceScore({
      hits: 0,
      lastHitAt: new Date(Date.now() - 200 * 86400_000).toISOString(),
      createdAt: new Date(Date.now() - 200 * 86400_000).toISOString(),
      hasPerson: false,
      hasCommitment: false,
    });
    expect(recent.score).toBeGreaterThan(stale.score);
  });
});

describe("reliance boost is a tie-break, not a lever", () => {
  it("is small and capped", () => {
    expect(relianceBoost(0)).toBe(0);
    expect(relianceBoost(1)).toBeGreaterThan(0);
    expect(relianceBoost(1000)).toBeLessThanOrEqual(0.1);
  });

  it("never exceeds the cap", () => {
    for (const hits of [0, 1, 5, 50, 10_000]) {
      expect(relianceBoost(hits)).toBeLessThanOrEqual(0.1);
      expect(relianceBoost(hits)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the loop closes: recalls become usage", () => {
  it("records a hit for memories the user actually saw", async () => {
    const u = createUser("loop@test.dev");
    await captureMemory(u.id, "Met Sarah Chen — founder at Nimbus, hiring React engineers.");

    const before = memoryUsageMap(u.id).size;
    expect(before).toBe(0);

    const res = await recall(u.id, "who is hiring react engineers");
    expect(res.citations.length).toBeGreaterThan(0);

    const usage = memoryUsageMap(u.id);
    expect(usage.size).toBeGreaterThan(0);
    for (const row of usage.values()) {
      expect(row.hits).toBeGreaterThanOrEqual(1);
      expect(row.last_hit_at).toBeTruthy();
    }
  });

  it("accumulates hits across repeated recalls", async () => {
    const u = createUser("loop2@test.dev");
    await captureMemory(u.id, "Coffee with Marcus Webb, partner at Foundry Ventures. He invests in dev tools.");
    await recall(u.id, "who invests in dev tools");
    const first = [...memoryUsageMap(u.id).values()][0]?.hits ?? 0;
    await recall(u.id, "who invests in dev tools");
    const second = [...memoryUsageMap(u.id).values()][0]?.hits ?? 0;
    expect(second).toBeGreaterThan(first);
  });
});
