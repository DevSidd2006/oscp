import React, { useEffect, useRef, useState } from "react";
import { DEMO_SCENARIOS, type DemoScenarioId } from "../shared/demo-workflows";

export function DemoLabPanel() {
  const [open, setOpen] = useState(false);
  const [scenarioId, setScenarioId] = useState<DemoScenarioId>("acquisition");
  const [step, setStep] = useState(0);
  const [state, setState] = useState<"idle" | "running" | "completed" | "cancelled">("idle");
  const running = useRef(false);
  const scenario = DEMO_SCENARIOS.find(value => value.id === scenarioId)!;
  useEffect(() => {
    if (state !== "running") return;
    const timer = setTimeout(() => {
      if (step + 1 >= scenario.steps.length) { running.current = false; setStep(scenario.steps.length); setState("completed"); }
      else setStep(value => value + 1);
    }, 300);
    return () => clearTimeout(timer);
  }, [state, step, scenario]);
  const start = () => { if (running.current) return; running.current = true; setStep(0); setState("running"); };
  return <section className="panel demo-lab-section" aria-labelledby="demo-lab-heading">
    <p className="eyebrow">DEMO · SYNTHETIC WORKFLOW LAB</p><h2 id="demo-lab-heading" tabIndex={-1}>Explore simulated workflows</h2>
    <p className="report-description">Walk through acquisition, NTFS/exFAT recovery, sanitization and delivery scenarios using fixed in-memory fixtures. Every result here is simulated, even when the rest of the dashboard shows connected drives.</p>
    <div className="demo-lab-notice"><strong>DEMO ONLY · No physical operations</strong><p>This lab makes no storage or helper calls, reads no source files, creates no output files, and changes no real capability or readiness state.</p></div>
    <button className="outline-button" aria-expanded={open} aria-controls="demo-lab-content" onClick={() => setOpen(value => !value)}>{open ? "Hide demo lab" : "Open demo lab"}</button>
    {open && <div id="demo-lab-content">
      <div className="sector-controls"><label>Demo scenario<select value={scenarioId} disabled={state === "running"} onChange={event => { setScenarioId(event.target.value as DemoScenarioId); setStep(0); setState("idle"); }}>{DEMO_SCENARIOS.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</select></label><button className="outline-button" disabled={state === "running"} onClick={start}>Run demo simulation</button>{state === "running" && <button className="outline-button" onClick={() => { running.current = false; setState("cancelled"); }}>Cancel simulation</button>}</div>
      <dl className="working-copy-details"><dt>Simulated source</dt><dd>{scenario.source}</dd><dt>Simulated output</dt><dd>{scenario.destination}</dd></dl>
      <ol className="demo-step-list">{scenario.steps.map((description, index) => <li key={description} data-step-state={index < step || state === "completed" ? "complete" : state === "running" && index === step ? "active" : "pending"}><span>{index < step || state === "completed" ? "Simulated" : state === "running" && index === step ? "Simulating" : "Pending"}</span>{description}</li>)}</ol>
      <p className="report-status demo-simulation-status" role="status" aria-live="polite">{state === "running" ? `DEMO: step ${step + 1} of ${scenario.steps.length}.` : state === "completed" ? "DEMO simulation finished. Results below are synthetic." : state === "cancelled" ? "DEMO simulation cancelled. No real operation was started." : "DEMO fixture ready. No real operation will be started."}</p>
      {state === "completed" && <div className="demo-result"><strong>{scenario.result}</strong><ul>{scenario.findings.map(value => <li key={value}>{value}</li>)}</ul><p>DEMO receipt only · not recovery evidence, acquisition verification, an erasure certificate or release approval.</p></div>}
    </div>}
  </section>;
}
