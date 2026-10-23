import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SecureErasePanel } from "../../src/renderer/SecureErasePanel";

describe("production secure erase refusal UI", () => {
  it("keeps production commands disabled while offering read-only status and readiness checks", () => {
    const html = renderToStaticMarkup(createElement(SecureErasePanel, { devices: [], dataSource: null }));
    expect(html).toContain("Refused: erasure engine unavailable");
    expect(html).toContain("Not executed");
    expect(html).toContain("Not performed — no completion or coverage evidence");
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
    expect(html).not.toContain("<progress");
    expect(html).toContain("Target for read-only preflight");
    expect(html).toContain("Refresh secure erase status");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("SIMULATED");
    expect(html).not.toContain("DEMO");
  });

  it("never promotes demo devices into production targets or solicits destructive confirmation", () => {
    const html = renderToStaticMarkup(createElement(SecureErasePanel, { devices: [{ id: `disk:${"a".repeat(64)}`, fingerprint: "test", model: "Synthetic device must be excluded",
      serialNumber: "SYNTHETIC", capacityBytes: 1024, deviceType: "HDD", isSystemDisk: false, accessMode: "ReadOnly" }], dataSource: "demo" }));
    expect(html).not.toContain("Synthetic device must be excluded");
    expect(html).toContain("Demo fixtures are excluded from production sanitization");
    expect(html).not.toContain("<input");
    expect(html).toContain("Start secure erase");
  });
});
