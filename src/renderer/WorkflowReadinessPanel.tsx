import React from "react";
import { PENDING_WORKFLOWS, readinessLabel } from "../shared/workflow-readiness";

export function WorkflowReadinessPanel() {
  return <section className="panel workflow-readiness-section" aria-labelledby="workflow-readiness-heading">
    <p className="eyebrow">REMAINING WORKFLOWS</p><h2 id="workflow-readiness-heading" tabIndex={-1}>Implementation and release readiness</h2>
    <p className="report-description">These are engineering acceptance requirements, not steps you can complete in this app. The actions below remain unavailable. Opening a checklist does not authorize or enable an operation.</p>
    <div className="readiness-grid">{PENDING_WORKFLOWS.map(workflow => <article className="readiness-card" key={workflow.id} data-workflow={workflow.id}>
      <h3>{workflow.title}</h3><p className="readiness-state">{readinessLabel(workflow.state)}</p><p className="panel-note">{workflow.reason}</p>
      {workflow.id === "recovery" && <p className="panel-note">Planning metadata is available for selected image files. <a className="readiness-link" href="#image-inspector-heading" onClick={event => { event.preventDefault(); const heading = document.getElementById("image-inspector-heading"); heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ behavior: "smooth" }); }}>Inspect an image to save a recovery plan</a>. Actual file recovery remains disabled.</p>}
      <details><summary>View acceptance checklist</summary><ul>{workflow.requirements.map(requirement => <li key={requirement.id}><strong>{requirement.label}</strong><p>{requirement.acceptance}</p><span>Evidence required</span></li>)}</ul></details>
      <button className="outline-button" disabled aria-describedby={`${workflow.id}-unavailable`}>{workflow.actionLabel}</button><p className="sr-only" id={`${workflow.id}-unavailable`}>This workflow is unavailable; acceptance evidence has not been recorded.</p>
    </article>)}</div>
  </section>;
}
