// Click-through tests of the route screen on the built page (out/), from the
// UI audit of 15 Nov 2026. The made-up example is built with no signal: the
// roads come from the site's own files, and the street search is answered
// with a spot by the example's streets.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { openSite } from "./site.mjs";

let site, page;

before(async () => {
  site = await openSite();
});

after(async () => {
  await site?.close();
});

/** The made-up example, built from the editor scrolled part way down. */
beforeEach(async () => {
  await page?.context().close();
  page = await (await site.browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
    if (route.request().url().startsWith("https://photon.komoot.io/")) {
      return route.fulfill({
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-78.6192, 35.6705] }, properties: { name: "Example", osm_value: "residential", countrycode: "US" } }],
        }),
      });
    }
    return route.abort();
  });
  await page.goto(site.url);
  await page.getByRole("button", { name: "Add a run" }).click();
  await page.getByRole("button", { name: "Try a made-up example" }).click();
  await page.getByRole("button", { name: "Build the route" }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.getByRole("button", { name: "Build the route" }).click();
  await page.getByRole("button", { name: "Add to today’s list" }).waitFor({ timeout: 60000 });
  await page.locator(".turn-pin").first().waitFor();
});

test("a new route opens at its top, with the map", async () => {
  // It kept the editor's scroll and opened part way down the list.
  await page.waitForTimeout(300);
  assert.ok((await page.evaluate(() => window.scrollY)) < 5);
});

test("zoomed out, the map leaves the confirmed turns off the stop numbers", async () => {
  const pins = () => page.locator(".turn-pin").count();
  const near = await pins();
  assert.ok(near > 0, "the turns show at street level");
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom out" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".turn-pin").length === 0);
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForFunction((n) => document.querySelectorAll(".turn-pin").length === n, near);
});

test("on a phone on its side, the buttons sit in one slim row", async () => {
  const bar = page.locator("[data-action-bar]");
  const tops = async () => Promise.all(["Add to today’s list", "Edit directions"].map(async (name) => (await page.getByRole("button", { name }).boundingBox()).y));
  const [addTall, editTall] = await tops();
  assert.ok(editTall > addTall + 20, "upright, the buttons stack");
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(300);
  const [add, edit] = await tops();
  assert.ok(Math.abs(add - edit) < 2, "on its side, one row");
  assert.ok((await bar.boundingBox()).height < 70, `bar ${(await bar.boundingBox()).height} px tall`);
});

test("notes about the map are folded under one line", async () => {
  const notes = page.locator("[data-route-notes]");
  assert.match(await notes.locator("summary").textContent(), /^\d+ notes? about the map$/);
  const first = notes.locator("summary + div > div").first();
  assert.equal(await first.isVisible(), false);
  await notes.locator("summary").click();
  assert.equal(await first.isVisible(), true);
});

test("on a phone, each direction keeps its street on the same line", async () => {
  await page.getByRole("button", { name: "Edit directions" }).click();
  const rows = page.locator("[data-direction-row]");
  await rows.first().waitFor();
  const n = await rows.count();
  assert.ok(n > 3);
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const kind = await row.getByRole("combobox", { name: "Direction" }).boundingBox();
    const street = await row.getByRole("textbox", { name: "Street" }).boundingBox();
    assert.ok(Math.abs(kind.y - street.y) < 8, `row ${i}: direction at ${kind.y}, street at ${street.y}`);
  }
  // The stop's number, time and delete on one line too.
  const time = await page.getByRole("textbox", { name: "Stop time" }).first().boundingBox();
  const remove = await page.getByRole("button", { name: "Delete stop 1" }).boundingBox();
  assert.ok(Math.abs(time.y + time.height / 2 - (remove.y + remove.height / 2)) < 4);
});

test("the photo and file buttons say what they do", async () => {
  await page.goto(site.url);
  await page.getByRole("button", { name: "Add a run" }).click();
  assert.equal(await page.getByLabel("Take photos of the trip sheet").count(), 1);
  assert.equal(await page.getByLabel("Choose photos, a PDF or a text file of the trip sheet").count(), 1);
});
