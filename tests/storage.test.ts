import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDay } from "../src/lib/storage";

test("a storage read failure is not treated as an empty saved day", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() { throw new Error("storage unavailable"); } },
  });
  try {
    await assert.rejects(loadDay(), /storage unavailable/);
  } finally {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});

test("a saved run's one-way caution becomes a note, so it no longer blocks export", async () => {
  const { upgradeSavedRun } = await import("../src/lib/storage");
  const run = {
    id: "r", area: "", sheetText: "", route: "", description: "", run: "", firstTime: "", miles: 1, gpx: "", coords: [], stops: [], vias: [],
    warnings: [
      { level: "warn" as const, message: "One-way direction data could not be confidently matched for Maple Road. Check road signs along this route." },
      { level: "warn" as const, message: "Couldn't follow the sheet onto ELM ST." },
    ],
  };
  assert.deepEqual(upgradeSavedRun(run).warnings.map((w) => w.level), ["info", "warn"]);
});
