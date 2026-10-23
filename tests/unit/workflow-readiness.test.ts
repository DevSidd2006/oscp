import { describe, expect, it } from "vitest";
import { PENDING_WORKFLOWS, readinessLabel } from "../../src/shared/workflow-readiness";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowReadinessPanel } from "../../src/renderer/WorkflowReadinessPanel";

describe("pending workflow safety boundaries", () => {
  it("keeps recovery, erasure, boot media and release actions unavailable", () => {
    expect(PENDING_WORKFLOWS.map(workflow => workflow.id)).toEqual(["recovery", "secure-erase", "winpe", "windows-package"]);
    for (const workflow of PENDING_WORKFLOWS) expect(workflow.executionEnabled).toBe(false);
  });
  it("renders every unavailable action as a native disabled control without needing a preload API", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowReadinessPanel));
    const buttons = markup.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(4);
    expect(buttons.every(button => /\bdisabled=""/.test(button))).toBe(true);
    for (const workflow of PENDING_WORKFLOWS) expect(markup).toContain(`aria-describedby="${workflow.id}-unavailable"`);
    expect(markup).toContain("Opening a checklist does not authorize or enable an operation.");
    expect(markup.match(/Evidence required/g)).toHaveLength(16);
  });
  it("distinguishes implementation work from release validation", () => {
    expect(PENDING_WORKFLOWS.filter(workflow => workflow.state === "implementation-required").map(workflow => workflow.id)).toEqual(["recovery", "secure-erase", "winpe"]);
    expect(PENDING_WORKFLOWS.find(workflow => workflow.id === "windows-package")?.state).toBe("validation-required");
    expect(readinessLabel("implementation-required")).toBe("Implementation required");
    expect(readinessLabel("validation-required")).toBe("Validation pending");
  });
});
