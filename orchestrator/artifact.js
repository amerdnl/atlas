/**
 * The handoff artifact: one structured record of what is known about a task, carried from stage to
 * stage and grown by each role's result. Every function here is pure and returns a new artifact.
 *
 *   Research → Developer   relevant files, findings, decisions, risks (+ goal, criteria)
 *   Developer → QA         implementation summary, changed files, tests run, caveats
 *   QA → Developer (fail)  exact failures, evidence, recommended rework
 *   QA → Operations (pass) validation evidence and summary
 */
export function createArtifact({ taskId, goal, acceptanceCriteria = [], project = null }) {
  return {
    taskId,
    goal,
    acceptanceCriteria: [...acceptanceCriteria],
    project,
    currentStage: 'planning',
    fromRole: null,
    toRole: 'operations',
    relevantFiles: [],
    findings: [],
    decisions: [],
    risks: [],
    implementationSummary: '',
    changedFiles: [],
    testsRun: [],
    caveats: [],
    qaSummary: '',
    qaChecks: [],
    qaEvidence: [],
    qaFailures: [],
    recommendedRework: [],
    finalSummary: '',
    finalChecks: [],
    notes: [],
    history: [],
  };
}

const union = (a, b) => [...new Set([...a, ...b])];

/** Fold one role's normalized result (see contracts.js) into the artifact. */
export function applyResult(artifact, { role, stage, contract, sessionId, result, at }) {
  const a = structuredClone(artifact);
  switch (contract) {
    case 'plan':
      if (result.goal) a.goal = result.goal;
      a.acceptanceCriteria = union(a.acceptanceCriteria, result.acceptanceCriteria);
      a.notes = union(a.notes, result.notes);
      break;
    case 'research':
      Object.assign(a, { findings: result.findings, relevantFiles: result.relevantFiles, decisions: result.decisions, risks: result.risks });
      break;
    case 'develop':
      a.implementationSummary = result.summary;
      a.changedFiles = union(a.changedFiles, result.changedFiles);
      Object.assign(a, { testsRun: result.testsRun, caveats: result.caveats });
      break;
    case 'qa':
      Object.assign(a, { qaSummary: result.summary, qaChecks: result.checks, qaEvidence: result.evidence });
      if (result.status === 'fail') Object.assign(a, { qaFailures: result.failures, recommendedRework: result.recommendedRework });
      if (result.status === 'pass') Object.assign(a, { qaFailures: [], recommendedRework: [] });
      break;
    case 'finalize':
      Object.assign(a, { finalSummary: result.summary, finalChecks: result.finalChecks });
      break;
    default:
      throw new Error(`unknown contract ${contract}`);
  }
  a.history.push({ role, stage, sessionId, status: result.status, summary: result.summary, at });
  return a;
}

/** Record where the artifact is going next (after a workflow transition). */
export function routeArtifact(artifact, { stage, fromRole, toRole }) {
  return { ...artifact, currentStage: stage, fromRole, toRole };
}

/** The parts of the artifact a role needs to read, by stage — keeps prompts small. */
export function artifactView(artifact, stage) {
  const base = { taskId: artifact.taskId, goal: artifact.goal, acceptanceCriteria: artifact.acceptanceCriteria, currentStage: stage, fromRole: artifact.fromRole, notes: artifact.notes };
  const research = { relevantFiles: artifact.relevantFiles, findings: artifact.findings, decisions: artifact.decisions, risks: artifact.risks };
  const dev = { implementationSummary: artifact.implementationSummary, changedFiles: artifact.changedFiles, testsRun: artifact.testsRun, caveats: artifact.caveats };
  const qa = { qaSummary: artifact.qaSummary, qaChecks: artifact.qaChecks, qaEvidence: artifact.qaEvidence, qaFailures: artifact.qaFailures, recommendedRework: artifact.recommendedRework };
  switch (stage) {
    case 'planning': return base;
    case 'research': return base;
    case 'development': return { ...base, ...research };
    case 'rework': return { ...base, ...research, ...dev, ...qa };
    case 'testing': return { ...base, ...research, ...dev, previousQa: artifact.qaFailures.length ? qa : undefined };
    case 'finalizing': return { ...base, ...dev, ...qa, history: artifact.history };
    default: return base;
  }
}
