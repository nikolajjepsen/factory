import type { Octokit } from '@octokit/rest';
import { z } from 'zod';

// GitHub Projects v2 over GraphQL. Items come back in the board's manual order (verified against
// the real API, see test/fixtures/github/board-items.json), so that order is the priority.

export const BOARD_QUERY = `
query($owner: String!, $number: Int!, $after: String) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name optionId } }
          content {
            __typename
            ... on Issue {
              number title state url
              repository { nameWithOwner }
              labels(first: 20) { nodes { name } }
              subIssues(first: 50) { nodes { number state } }
              blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }
            }
          }
        }
      }
    }
  }
}`;

const IssueContent = z.object({
  __typename: z.literal('Issue'),
  number: z.number(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  url: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  subIssues: z.object({ nodes: z.array(z.object({ number: z.number(), state: z.string() })) }),
  blockedBy: z.object({
    nodes: z.array(
      z.object({
        number: z.number(),
        state: z.string(),
        repository: z.object({ nameWithOwner: z.string() }),
      }),
    ),
  }),
});

const BoardResponse = z.object({
  user: z.object({
    projectV2: z
      .object({
        id: z.string(),
        field: z
          .object({
            id: z.string(),
            options: z.array(z.object({ id: z.string(), name: z.string() })),
          })
          .nullable(),
        items: z.object({
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          nodes: z.array(
            z.object({
              id: z.string(),
              fieldValueByName: z
                .object({ name: z.string() })
                .nullable()
                .or(z.object({}).transform(() => null)),
              // Draft issues and pull requests have other content; only issues are work items.
              content: z
                .union([IssueContent, z.object({ __typename: z.string() }).loose()])
                .nullable(),
            }),
          ),
        }),
      })
      .nullable(),
  }),
});

export interface BoardItem {
  itemId: string;
  status: string | null;
  repo: string;
  number: number;
  title: string;
  url: string;
  open: boolean;
  labels: string[];
  openSubIssues: number[];
  /** Open issues this one is blocked by, as `owner/repo#N`. */
  openBlockers: string[];
}

export interface BoardSnapshot {
  projectId: string;
  statusFieldId: string;
  /** Status option name → option id. */
  statusOptions: Map<string, string>;
  /** In board order. */
  items: BoardItem[];
}

/** The board operations the daemon uses. Tests replace it with a fake. */
export interface Board {
  read(): Promise<BoardSnapshot>;
  setStatus(itemId: string, status: string): Promise<void>;
  /** Moves an item right after another, or to the top with null. */
  moveAfter(itemId: string, afterItemId: string | null): Promise<void>;
}

export function parseBoardPage(data: unknown): { snapshot: BoardSnapshot; next: string | null } {
  const project = BoardResponse.parse(data).user.projectV2;
  if (!project) throw new Error('Boardet findes ikke, eller tokenet mangler scopet "project".');
  if (!project.field) throw new Error('Boardet har intet single-select-felt ved navn "Status".');
  const items: BoardItem[] = [];
  for (const node of project.items.nodes) {
    const parsed = IssueContent.safeParse(node.content);
    if (!parsed.success) continue;
    const issue = parsed.data;
    items.push({
      itemId: node.id,
      status: node.fieldValueByName?.name ?? null,
      repo: issue.repository.nameWithOwner,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      open: issue.state === 'OPEN',
      labels: issue.labels.nodes.map((l) => l.name),
      openSubIssues: issue.subIssues.nodes.filter((s) => s.state === 'OPEN').map((s) => s.number),
      openBlockers: issue.blockedBy.nodes
        .filter((b) => b.state === 'OPEN')
        .map((b) => `${b.repository.nameWithOwner}#${String(b.number)}`),
    });
  }
  return {
    snapshot: {
      projectId: project.id,
      statusFieldId: project.field.id,
      statusOptions: new Map(project.field.options.map((o) => [o.name, o.id])),
      items,
    },
    next: project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null,
  };
}

export class GraphQLBoard implements Board {
  #snapshot: BoardSnapshot | undefined;

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly number: number,
  ) {}

  async read(): Promise<BoardSnapshot> {
    let after: string | null = null;
    let snapshot: BoardSnapshot | undefined;
    do {
      const data: unknown = await this.octokit.graphql(BOARD_QUERY, {
        owner: this.owner,
        number: this.number,
        after,
      });
      const page = parseBoardPage(data);
      snapshot = snapshot
        ? { ...snapshot, items: [...snapshot.items, ...page.snapshot.items] }
        : page.snapshot;
      after = page.next;
    } while (after);
    this.#snapshot = snapshot;
    return snapshot;
  }

  async moveAfter(itemId: string, afterItemId: string | null): Promise<void> {
    const snapshot = this.#snapshot ?? (await this.read());
    await this.octokit.graphql(
      `mutation($project: ID!, $item: ID!, $after: ID) {
        updateProjectV2ItemPosition(input: { projectId: $project, itemId: $item, afterId: $after }) {
          clientMutationId
        }
      }`,
      { project: snapshot.projectId, item: itemId, after: afterItemId },
    );
  }

  async setStatus(itemId: string, status: string): Promise<void> {
    const snapshot = this.#snapshot ?? (await this.read());
    const optionId = snapshot.statusOptions.get(status);
    if (!optionId) {
      throw new Error(
        `Boardet har ingen Status-kolonne "${status}". Kolonner: ${[...snapshot.statusOptions.keys()].join(', ')}`,
      );
    }
    await this.octokit.graphql(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) {
          clientMutationId
        }
      }`,
      {
        project: snapshot.projectId,
        item: itemId,
        field: snapshot.statusFieldId,
        option: optionId,
      },
    );
  }
}
