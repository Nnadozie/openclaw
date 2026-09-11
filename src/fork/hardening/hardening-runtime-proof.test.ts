// @fork-seam U4 — the hardening RUNTIME gate (executing, not a grep).
// Drives the real seam surface: scanForSecrets / requiredHeaders / assertAllowed / assertNoDelete.
// Non-vacuous: RED fixtures assert the guard DISCRIMINATES (a clean string passes; an allow-listed
// action passes) while the dangerous cases must be caught/refused.

import { describe, expect, it } from "vitest";
import { createHardeningSeam, HARDENING_HEADERS } from "./index.js";

describe("U4 RUNTIME PROOF — hardening seam", () => {
  it("(a) a planted secret is caught AND masked (never returned raw)", () => {
    const seam = createHardeningSeam();
    const raw = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";
    const r = seam.scanForSecrets(`config: apiKey=${raw}`);
    expect(r.clean).toBe(false);
    expect(r.findings.length).toBeGreaterThan(0);
    const joined = JSON.stringify(r);
    expect(joined).not.toContain(raw);
    expect(r.findings.every((f) => f.masked.includes("redacted"))).toBe(true);
  });

  it("(b) the hardening header set is present", () => {
    const seam = createHardeningSeam();
    const h = seam.requiredHeaders();
    for (const k of Object.keys(HARDENING_HEADERS)) expect(h[k]).toBeTruthy();
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=/);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("(c) an un-allow-listed action is REFUSED (fail-closed)", () => {
    const seam = createHardeningSeam({ allow: ["read"] });
    expect(() => seam.assertAllowed("write", ["read"])).toThrow(/not allow-listed/);
    expect(() => seam.assertAllowed("")).toThrow(/fail-closed/);
  });

  it("(d) a delete/destroy op is refused (NO-DELETE)", () => {
    const seam = createHardeningSeam();
    expect(() => seam.assertNoDelete("delete agent ag-1")).toThrow(/NO-DELETE/);
    expect(() => seam.assertNoDelete("purge-cache")).toThrow(/NO-DELETE/);
  });

  it("RED fixtures — the guard DISCRIMINATES broken from working", () => {
    const seam = createHardeningSeam({ allow: ["read"] });
    // a clean string is NOT flagged (no false positive)
    expect(seam.scanForSecrets("just a normal sentence about invoices").clean).toBe(true);
    // the allow-listed action passes (the guard is not a blanket deny)
    expect(() => seam.assertAllowed("read", ["read"])).not.toThrow();
    // a benign, non-destructive op passes the NO-DELETE guard
    expect(() => seam.assertNoDelete("create agent")).not.toThrow();
  });
});
