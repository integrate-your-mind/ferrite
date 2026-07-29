import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlan,
  DEFAULT_SITE_ORIGIN,
  siteOrigin,
} from "./build-sites-source.mjs";

test("Sites source build uses the production Ferrite subdomain by default", () => {
  assert.equal(siteOrigin(), DEFAULT_SITE_ORIGIN);
  assert.equal(
    siteOrigin("https://preview.example.test"),
    "https://preview.example.test",
  );
});

test("Sites source build rejects ambiguous or unsafe origins", () => {
  for (const value of [
    "http://ferrite.mondello.dev",
    "https://user@example.test",
    "https://example.test/path",
    "https://example.test/?query=1",
    "https://example.test/#fragment",
  ]) {
    assert.throws(() => siteOrigin(value), /must be an HTTPS origin/);
  }
});

test("Sites source build avoids recursive package-manager scripts", () => {
  const plan = buildPlan();
  assert.equal(plan.length, 4);
  assert.deepEqual(
    plan.map(({ command }) => command),
    [process.execPath, process.execPath, "cargo", process.execPath],
  );
  assert.match(
    plan[0].args.join(" "),
    /packages[/\\]protocol[/\\]tsconfig\.json/,
  );
  assert.match(
    plan[1].args.join(" "),
    /packages[/\\]runtime[/\\]tsconfig\.json/,
  );
  assert.deepEqual(plan[2].args.slice(0, 2), ["run", "--locked"]);
  assert.match(plan[3].args[0], /website[/\\]deploy-adapter\.mjs$/);
  for (const step of plan) {
    assert.notEqual(step.command, "pnpm");
    assert.notEqual(step.command, "npm");
  }
});
