import { z } from 'zod';

// One control system: ChatOps comments and the daemon API (`POST /commands`) both produce these
// commands, and the daemon's single handler executes them.

export const COMMANDS = [
  'pause',
  'resume',
  'status',
  'halt',
  'stop',
  'retry',
  'hold',
  'focus',
  'workflow',
  'reject',
  'approve',
  'boost',
] as const;
export type CommandName = (typeof COMMANDS)[number];

export const NEEDS_ISSUE: readonly CommandName[] = [
  'stop',
  'retry',
  'hold',
  'workflow',
  'reject',
  'approve',
];

export const Command = z
  .object({
    command: z.enum(COMMANDS),
    issue: z.number().int().positive().optional(),
    /** A project name from projects.yml or an `owner/repo`. For `focus`, omit it to clear focus. */
    project: z.string().min(1).optional(),
    runner: z.string().min(1).optional(),
    workflow: z.string().min(1).optional(),
    feedback: z.string().optional(),
    /** For `boost`: how long the quota rules are set aside. Unset: until midnight. 0: end it now. */
    minutes: z.number().int().min(0).optional(),
  })
  .superRefine((c, ctx) => {
    if (NEEDS_ISSUE.includes(c.command) && c.issue === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['issue'],
        message: `/factory ${c.command} needs an issue, e.g. #12`,
      });
    }
    if (c.command === 'workflow' && !c.workflow) {
      ctx.addIssue({
        code: 'custom',
        path: ['workflow'],
        message: '/factory workflow needs a workflow name',
      });
    }
  });
export type Command = z.infer<typeof Command>;

/** The answer to a command, in Danish. */
export const CommandResult = z.object({
  text: z.string(),
  /** Whether the text is worth a reply comment (status, errors, notes); otherwise a +1 is enough. */
  reply: z.boolean(),
});
export type CommandResult = z.infer<typeof CommandResult>;
