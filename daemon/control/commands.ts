import { z } from 'zod';

// One control system: ChatOps comments and (from M5a) the daemon API both produce these commands,
// and Daemon.execute handles them. M5a moves the schema to packages/protocol.

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
] as const;
export type CommandName = (typeof COMMANDS)[number];

const NEEDS_ISSUE: readonly CommandName[] = [
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

export interface ChatOpsContext {
  /** The issue the comment was posted on, used when the command names no issue. */
  issue?: number;
  /** The project of the repo the comment was posted in. */
  project?: string;
}

const REF = /^(?:([\w.-]+\/[\w.-]+|[a-z0-9][a-z0-9-]*))?#(\d+)$/;

/** Parses every `/factory …` line in a comment. Unknown or malformed lines become errors. */
export function parseChatOps(
  body: string,
  context: ChatOpsContext = {},
): { commands: Command[]; errors: string[] } {
  const commands: Command[] = [];
  const errors: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('/factory')) continue;
    const words = line.slice('/factory'.length).trim();
    if (words === '' || !/^\S/.test(words)) {
      errors.push(`"${line}": mangler en kommando.`);
      continue;
    }
    const [verb = '', ...rest] = words.split(/\s+/);
    const result = parseLine(verb.toLowerCase(), rest, words, context);
    if (typeof result === 'string') errors.push(`"${line}": ${result}`);
    else commands.push(result);
  }
  return { commands, errors };
}

function parseLine(
  verb: string,
  args: string[],
  words: string,
  context: ChatOpsContext,
): Command | string {
  if (!(COMMANDS as readonly string[]).includes(verb)) {
    return `ukendt kommando "${verb}". Kendte: ${COMMANDS.join(', ')}.`;
  }
  const command = verb as CommandName;
  const draft: Record<string, unknown> = { command };

  // An optional issue reference comes first: #12, loge-app#12 or owner/repo#12.
  const ref = args[0] !== undefined ? REF.exec(args[0]) : null;
  if (ref) {
    args = args.slice(1);
    draft.issue = Number(ref[2]);
    if (ref[1]) draft.project = ref[1];
  } else if (NEEDS_ISSUE.includes(command) && context.issue !== undefined) {
    draft.issue = context.issue;
  }
  if (draft.issue !== undefined && draft.project === undefined && context.project)
    draft.project = context.project;

  switch (command) {
    case 'retry': {
      const flag = args.indexOf('--runner');
      if (flag >= 0) {
        const runner = args[flag + 1];
        if (!runner) return '--runner mangler et navn.';
        draft.runner = runner;
        args = args.filter((_, i) => i !== flag && i !== flag + 1);
      }
      break;
    }
    case 'focus': {
      const project = args.shift();
      if (!project) return 'skriv et projekt, eller "off" for at fjerne fokus.';
      if (project !== 'off') draft.project = project;
      break;
    }
    case 'workflow':
      draft.workflow = args.shift();
      break;
    case 'reject': {
      // Everything after the reference is feedback; surrounding quotes are optional.
      const afterRef = ref
        ? words.slice(words.indexOf(ref[0]) + ref[0].length)
        : words.slice(verb.length);
      draft.feedback = afterRef.trim().replace(/^["“](.*)["”]$/s, '$1');
      args = [];
      break;
    }
    default:
      break;
  }
  if (args.length > 0) return `uventede ord: ${args.join(' ')}.`;
  const parsed = Command.safeParse(draft);
  if (!parsed.success) return parsed.error.issues.map((i) => i.message).join('; ');
  return parsed.data;
}
