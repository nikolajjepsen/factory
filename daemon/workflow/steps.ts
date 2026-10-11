import type { Step } from '@ai-factory/protocol';
import type { RunState } from './runState.js';
import { type Gate, type Phase, phasesFor, type Workflow } from './schema.js';

const GATE_LABEL: Record<Gate['kind'], string> = {
  ci: 'CI',
  review: 'Review',
  human: 'Godkendelse',
};

interface Slot {
  stage: number;
  phase: Phase;
  /** null for the agent turn, else the gate's index among the phase's gates. */
  gate: number | null;
  label: string;
}

/**
 * The "working on" progress bar: every agent turn and gate of the workflow in order, marked done,
 * active or pending from where the run is. The current stage uses the run's strategy override.
 */
export function stepsFor(
  workflow: Workflow,
  run: Pick<RunState, 'status' | 'stageIndex' | 'phase' | 'turnDone' | 'gateIndex' | 'overrides'>,
): Step[] {
  const slots: Slot[] = [];
  workflow.stages.forEach((stage, i) => {
    const strategy =
      i === run.stageIndex ? (run.overrides.strategy ?? stage.strategy) : stage.strategy;
    for (const phase of phasesFor(strategy)) {
      slots.push({
        stage: i,
        phase,
        gate: null,
        label: phase === 'plan' ? `${stage.id}: plan` : stage.id,
      });
      stage.gates
        .filter((gate) => gate.on === phase)
        .forEach((gate, g) =>
          slots.push({ stage: i, phase, gate: g, label: GATE_LABEL[gate.kind] }),
        );
    }
  });
  if (run.status === 'done') return slots.map((s) => ({ label: s.label, state: 'done' }));
  let active = slots.findIndex(
    (s) =>
      s.stage === run.stageIndex &&
      s.phase === run.phase &&
      s.gate === (run.turnDone ? run.gateIndex : null),
  );
  // All gates of the phase passed, but the run has not moved on yet: the next slot is up.
  if (active < 0) {
    const last = slots.findLastIndex((s) => s.stage === run.stageIndex && s.phase === run.phase);
    active = last + 1;
  }
  return slots.map((s, i) => ({
    label: s.label,
    state: i < active ? 'done' : i === active ? 'active' : 'pending',
  }));
}
