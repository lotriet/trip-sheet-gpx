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
