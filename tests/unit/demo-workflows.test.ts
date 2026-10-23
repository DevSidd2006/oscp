import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEMO_SCENARIOS } from "../../src/shared/demo-workflows";
import { DemoLabPanel } from "../../src/renderer/DemoLabPanel";

describe("isolated demo workflow lab", () => {
  it("renders without a browser, preload, filesystem or physical helper", () => {
    const html = renderToStaticMarkup(createElement(DemoLabPanel));
    expect(html).toContain("DEMO ONLY · No physical operations");
    expect(html).toContain("creates no output files");
    expect(html).toContain('aria-expanded="false"');
  });
  it("includes all requested synthetic scenarios without success certifications", () => {
    expect(DEMO_SCENARIOS.map(value => value.id)).toEqual(["acquisition", "ntfs", "exfat", "sanitization", "delivery"]);
    for (const scenario of DEMO_SCENARIOS) {
      expect(scenario.source).toContain("DEMO");
      expect(scenario.result).toMatch(/^SIMULATED /);
      expect(scenario.steps).toHaveLength(3);
      expect(scenario.findings.join(" ")).toMatch(/No |no /);
    }
    expect(DEMO_SCENARIOS.find(value => value.id === "sanitization")!.result).toContain("NOT VERIFIED");
    expect(DEMO_SCENARIOS.find(value => value.id === "delivery")!.result).toContain("BLOCKED");
  });
});
