import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG, WRITE_NAME_PATTERN, toolEffect } from "../src/catalog.js";
import { defaultConfig } from "../src/config.js";
import { decideIntercept } from "../src/policy.js";

const order = {
  storeCode: "SAMPLE-STORE",
  beCode: "SAMPLE-BE",
  beType: 1,
  items: [{ productCode: "SAMPLE-001", quantity: 1 }],
  takeWayCode: "1",
};

test("catalog matches the 35 tools observed on 2026-10-11", () => {
  assert.equal(CATALOG.length, 35);
  assert.equal(new Set(CATALOG.map((tool) => tool.name)).size, 35);
  assert.equal(CATALOG.some((tool) => tool.name === "query-partystore-date"), false);
  assert.equal(CATALOG.some((tool) => tool.name === "query-partystore-session"), false);
  for (const name of ["query-party-store-date", "query-party-store-session", "query-promotions", "query-survey-coupon"]) {
    assert.equal(CATALOG.find((tool) => tool.name === name)?.effect, "read");
  }
  for (const tool of CATALOG) {
    assert.equal(toolEffect(tool.name), tool.effect);
    if (tool.effect === "read") assert.equal(WRITE_NAME_PATTERN.test(tool.name), false);
  }
  assert.equal(toolEffect("mall-create-order-physical"), "write");
  assert.equal(toolEffect("query-party-store"), "read");
  assert.equal(toolEffect("cooldown-status"), "read");
});

test("writes are held and reads pass", () => {
  const config = defaultConfig();
  assert.equal(decideIntercept("calculate-price", { items: [] }, config, null).kind, "allow");
  assert.equal(decideIntercept("now-time-info", {}, config, null).kind, "allow");
  assert.equal(decideIntercept("create-order", order, config, null).kind, "hold");
  assert.equal(decideIntercept("draw-lottery", {}, config, null).kind, "hold");
  assert.equal(decideIntercept("cancel-order", { orderId: "1" }, config, null).kind, "hold");
});

test("oversized orders and leaked tokens are denied before any forward", () => {
  const config = defaultConfig();
  const tooMany = {
    ...order,
    items: [{ productCode: "SAMPLE-001", quantity: 13 }],
  };
  assert.equal(decideIntercept("create-order", tooMany, config, null).kind, "deny");
  const missingWay = decideIntercept("create-order", { ...order, takeWayCode: "" }, config, null);
  assert.equal(missingWay.kind, "deny");
  if (missingWay.kind === "deny") assert.match(missingWay.reason, /takeWayCode/);
  const pickup = { storeCode: "SAMPLE-STORE", beType: 1, items: [{ productCode: "SAMPLE-001", quantity: 1 }], takeWayCode: "eat-in" };
  assert.equal(decideIntercept("create-order", pickup, config, null).kind, "hold");
  const drive = decideIntercept("create-order", { ...pickup, beType: 5 }, config, null);
  assert.equal(drive.kind, "deny");
  if (drive.kind === "deny") assert.match(drive.reason, /beCode/);
  const token = "local-test-token";
  assert.equal(decideIntercept("now-time-info", { note: token }, config, token).kind, "deny");
});
