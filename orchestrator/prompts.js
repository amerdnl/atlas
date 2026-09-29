import { ROLES } from '../workflow/roles.js';
import { artifactView } from './artifact.js';

/**
 * Role prompts and tool policies. The system prompt carries the role's identity and rules; the
 * user prompt carries this task, stage and the relevant slice of the handoff artifact. Both are
 * small and built from the same pieces for every role.
 *
 * Tool policies reinforce the role boundaries; they are not a security sandbox (Bash is Bash).
 * Operations and Research run with the backend's restricted, read-only toolset.
 */

// Tools no managed role needs: sub-agents, worktrees, notifications, scheduling, messaging, web.
const NEVER = ['Task', 'Agent', 'EnterWorktree', 'ExitWorktree', 'PushNotification', 'CronCreate', 'CronDelete', 'CronList',
  'ScheduleWakeup', 'SendMessage', 'RemoteTrigger', 'DesignSync', 'Skill', 'NotebookEdit', 'WebFetch', 'WebSearch'];
const EDITS = ['Edit', 'Write', 'MultiEdit'];
// ATLAS never rewrites the user's history or discards their work; agents may not either.
const GIT = ['push', 'reset', 'checkout', 'switch', 'restore', 'clean', 'rebase', 'commit', 'stash', 'branch', 'merge', 'tag'].map((c) => `Bash(git ${c} *)`);

export const ROLE_POLICY = Object.freeze({
  operations: { readOnly: true, restricted: true, permissionMode: 'default', allowedTools: ['Read', 'Grep', 'Glob'], disallowedTools: [...NEVER, ...EDITS] },
  research: { readOnly: true, restricted: true, permissionMode: 'default', allowedTools: ['Read', 'Grep', 'Glob'], disallowedTools: [...NEVER, ...EDITS] },
  developer: { readOnly: false, restricted: false, permissionMode: 'acceptEdits', allowedTools: ['Read', 'Grep', 'Glob', ...EDITS, 'Bash', 'TodoWrite'], disallowedTools: [...NEVER, ...GIT, 'Bash(rm -rf *)'] },
  qa: { readOnly: true, restricted: false, permissionMode: 'default', allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'TodoWrite'], disallowedTools: [...NEVER, ...EDITS, ...GIT, 'Bash(rm -rf *)'] },
});

const RESPONSIBILITY = {
  operations: 'You coordinate the work: you shape the request into a precise goal with testable acceptance criteria, and at the end you confirm and summarize what was delivered. You do not implement.',
  research: 'You investigate: the repository, its conventions, the files involved, how it is tested, and the decisions and risks the Developer needs. You do not implement.',
  developer: 'You implement the change, keeping it minimal and consistent with the codebase, and you run the relevant checks.',
  qa: 'You validate independently: you check every acceptance criterion against the actual code and by running tests. You report problems; you never fix them yourself.',
};

const MUST_NOT = {
  operations: ['edit, create or delete files', 'skip or reorder workflow stages'],
  research: ['edit, create or delete files', 'implement the change'],
  developer: ['commit, push, reset, stash or switch branches', 'change files unrelated to the goal', 'weaken or delete existing tests to make them pass'],
  qa: ['edit, create or delete any file (including to "fix" something)', 'pass a criterion you did not verify'],
};

const INSTRUCTIONS = {
  planning: 'Turn the request into a precise goal and a short list of testable acceptance criteria. Keep every criterion the user gave; add only what the request clearly implies. Look at the repository only as much as needed to make the criteria concrete.',
  research: 'Find out how to achieve the goal in this repository: the files to change or add, existing patterns to follow, how tests are written and run (exact commands), decisions the Developer should follow, and risks.',
  development: "Implement the goal, following Research's findings and decisions. Add or update tests for the acceptance criteria. Run the relevant tests and report exactly what you ran and the outcome.",
  rework: 'QA rejected the previous attempt. Fix exactly the failures listed in qaFailures, following recommendedRework, then re-run the relevant tests. Report what you changed.',
  testing: 'Verify every acceptance criterion: read the changed code and run the tests and checks yourself. Return "pass" only if every criterion is met, citing evidence (commands and their output). Otherwise return "fail" with each failure stated precisely and the rework you recommend.',
  finalizing: 'Confirm the delivered change matches the goal, the acceptance criteria and the QA evidence, using the change summary below. Summarize the result for the user. List any final checks you made.',
};

const RETURN = {
  planning: 'status ("complete", or "blocked" if the request cannot be made actionable), summary, goal, acceptanceCriteria, notes',
  research: 'status ("complete" or "blocked"), summary, findings, relevantFiles, decisions, risks',
  development: 'status ("complete" or "blocked"), summary, changedFiles, testsRun, caveats',
  rework: 'status ("complete" or "blocked"), summary, changedFiles, testsRun, caveats',
  testing: 'status ("pass", "fail", or "blocked" if you cannot test), summary, checks, evidence, failures, recommendedRework',
  finalizing: 'status ("complete" or "blocked"), summary, finalChecks',
};

/** System prompt: who this agent is and the rules it works under (identical across stages of a role). */
export function systemPrompt(role, cwd) {
  const name = ROLES[role].name;
  return [
    `You are the ATLAS ${name} agent. ATLAS runs a fixed software-delivery workflow: Operations → Research → Developer → QA → Operations, with QA sending failed work back to Developer.`,
    RESPONSIBILITY[role],
    `You must not: ${MUST_NOT[role].join('; ')}.`,
    `Work only inside ${cwd}. Be concise. Your final answer is the structured result required by the output schema — put everything the next role needs into it.`,
  ].join('\n');
}

/** User prompt for one stage: the task, the relevant artifact slice, what to do, what to return. */
export function stagePrompt({ role, stage, task, artifact, project, changes = null }) {
  const lines = [
    `Task ${task.id} — stage: ${stage} (you are ${ROLES[role].name}${task.attempt > 1 && (stage === 'rework' || stage === 'testing') ? `, attempt ${task.attempt}` : ''}).`,
    `Request: ${task.description || task.title}`,
    `Project: ${project.cwd}${project.branch ? ` (git branch ${project.branch})` : ''}`,
    '',
    INSTRUCTIONS[stage],
    '',
    'Handoff artifact (JSON):',
    JSON.stringify(artifactView(artifact, stage)),
  ];
  if (changes) {
    lines.push('', 'Change summary since the task started (from git):', changes.status.length ? changes.status.join('\n') : '(no changes)', changes.diffStat || '');
  }
  lines.push('', `Return: ${RETURN[stage]}.`);
  return lines.join('\n');
}

/** Sent (resuming the same session) when a result did not match its contract. */
export const repairPrompt = (error) => `Your result did not match the required output schema (${error}). Return the complete structured result now, following the schema exactly.`;
