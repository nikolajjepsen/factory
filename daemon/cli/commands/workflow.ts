import type { Command } from 'commander';

export interface WorkflowValidation {
  /** One line per checked source, for example "baseline: bugfix, chore, feature". */
  checked: string[];
  problems: string[];
  /** Projects that could not be checked, for example because they are not cloned here. */
  skipped: string[];
}

export interface WorkflowCommandDeps {
  validateWorkflows: () => Promise<WorkflowValidation>;
  stdout: (text: string) => void;
}

export function registerWorkflowCommand(program: Command, deps: WorkflowCommandDeps): void {
  const workflow = program.command('workflow').description('workflow-filer');
  workflow
    .command('validate')
    .description(
      'valider baseline-workflows og projekternes .factory/ (workflows, agenter, project.yml)',
    )
    .action(async (_options: unknown, command: Command) => {
      const result = await deps.validateWorkflows();
      for (const line of result.checked) deps.stdout(`✓ ${line}\n`);
      for (const line of result.skipped) deps.stdout(`- sprunget over: ${line}\n`);
      if (result.problems.length > 0) {
        command.error(result.problems.map((p) => `✖ ${p}`).join('\n'), { exitCode: 1 });
      }
    });
}
