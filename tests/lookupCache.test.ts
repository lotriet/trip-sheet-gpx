import assert from "node:assert/strict";
import { test } from "node:test";
import { clearLookupMemory, lookup, recall, remember } from "../src/lib/lookupCache";

test("a saved answer is used without asking again", async () => {
  clearLookupMemory();
  let asked = 0;
  const ask = async () => {
    asked++;
    return [{ name: "Oak St" }];
  };
  assert.deepEqual(await lookup("q:oak", ask), [{ name: "Oak St" }]);
  assert.deepEqual(await lookup("q:oak", ask), [{ name: "Oak St" }]);
  assert.equal(asked, 1);
});

test("with no signal, an old answer beats none, and nothing saved still fails", async () => {
  clearLookupMemory();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() - 400 * 24 * 3600 * 1000; // saved over a year ago
    await remember("q:elm", ["old"]);
    Date.now = realNow;
    assert.equal(await recall("q:elm"), undefined, "too old to count as fresh");
    const offline = async (): Promise<string[]> => {
      throw new Error("offline");
    };
    assert.deepEqual(await lookup("q:elm", offline), ["old"]);
    await assert.rejects(lookup("q:never-seen", offline), /offline/);
  } finally {
    Date.now = realNow;
  }
});

test("an empty answer is asked again sooner than a real one", async () => {
  clearLookupMemory();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() - 5 * 24 * 3600 * 1000;
    await remember("q:none", []);
    await remember("q:some", ["x"]);
    Date.now = realNow;
    assert.equal(await recall("q:none"), undefined);
    assert.deepEqual(await recall("q:some"), ["x"]);
  } finally {
    Date.now = realNow;
  }
});
