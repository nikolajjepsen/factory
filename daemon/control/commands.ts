import { COMMANDS, Command, type CommandName, NEEDS_ISSUE } from '@ai-factory/protocol';

// ChatOps: `/factory …` lines in comments become the shared Command (packages/protocol).

export { COMMANDS, Command, type CommandName };

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
    case 'enable':
    case 'disable': {
      // In a project repo the project may be left out.
      const project = args.shift() ?? context.project;
      if (!project) return 'skriv projektet, fx loge-app.';
      draft.project = project;
      break;
    }
    case 'workflow':
      draft.workflow = args.shift();
      break;
    case 'boost': {
      const value = args.shift();
      if (value === undefined) break;
      if (value.toLowerCase() === 'off') {
        draft.minutes = 0;
        break;
      }
      const duration = /^(\d+(?:[.,]\d+)?)(h|t|m)$/i.exec(value);
      if (!duration?.[1] || !duration[2]) return 'skriv en varighed som 3h eller 90m, eller "off".';
      const amount = Number(duration[1].replace(',', '.'));
      draft.minutes = Math.round(duration[2].toLowerCase() === 'm' ? amount : amount * 60);
      if (draft.minutes === 0) return 'varigheden skal være over 0.';
      break;
    }
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
