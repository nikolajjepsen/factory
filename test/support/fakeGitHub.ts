import type {
  CheckRun,
  CommitStatus,
  CreatePullRequest,
  GitHub,
  Issue,
  IssueComment,
  PullRequest,
  Review,
} from '../../daemon/github/github.js';

/** In-memory GitHub. Tests set the fields they care about and read back what was done. */
export class FakeGitHub implements GitHub {
  issues = new Map<number, Issue>();
  existingPr: PullRequest | undefined;
  created: { repo: string; pr: CreatePullRequest }[] = [];
  labels = new Map<number, Set<string>>();
  comments: { issue: number; body: string }[] = [];
  /** Check runs returned per call to listCheckRuns, in order; the last one repeats. */
  checkRunSequence: CheckRun[][] = [[]];
  checkRunCalls = 0;
  statuses: CommitStatus[] = [];
  jobLogs = new Map<number, string>();
  reviews: Review[] = [];
  /** Comments per repo, returned by listCommentsSince when created at or after `since`. */
  repoComments = new Map<string, IssueComment[]>();
  reactions: { repo: string; commentId: number }[] = [];
  /** `owner/repo:label` pairs that have an open issue. */
  openLabels = new Set<string>();
  issueBodies = new Map<number, string>();
  createdIssues: { repo: string; title: string; body: string; number: number }[] = [];
  pinned: number[] = [];

  constructor(issue?: Partial<Issue>) {
    this.setIssue({
      number: 12,
      title: 'Tilføj add()',
      body: 'Se specs/add.md',
      html_url: 'https://github.com/o/demo/issues/12',
      state: 'open',
      labels: [],
      ...issue,
    });
  }

  setIssue(issue: Issue): void {
    this.issues.set(issue.number, issue);
  }

  get issue(): Issue {
    const first = [...this.issues.values()][0];
    if (!first) throw new Error('no issue');
    return first;
  }

  set issue(issue: Issue) {
    this.issues.set(issue.number, issue);
  }

  labelsOf(issue: number): string[] {
    return [...(this.labels.get(issue) ?? [])].sort();
  }

  getIssue(_repo: string, number: number) {
    const issue = this.issues.get(number);
    return issue
      ? Promise.resolve(issue)
      : Promise.reject(new Error(`no issue #${String(number)}`));
  }
  findOpenPullRequest() {
    return Promise.resolve(this.existingPr);
  }
  createPullRequest(repo: string, pr: CreatePullRequest) {
    this.created.push({ repo, pr });
    this.existingPr = { number: 5, html_url: 'https://github.com/o/demo/pull/5', state: 'open' };
    return Promise.resolve(this.existingPr);
  }
  getDefaultBranch() {
    return Promise.resolve('main');
  }
  addLabels(_repo: string, issue: number, labels: string[]) {
    const set = this.labels.get(issue) ?? new Set();
    for (const label of labels) set.add(label);
    this.labels.set(issue, set);
    return Promise.resolve();
  }
  removeLabel(_repo: string, issue: number, label: string) {
    this.labels.get(issue)?.delete(label);
    return Promise.resolve();
  }
  createComment(_repo: string, issue: number, body: string) {
    this.comments.push({ issue, body });
    return Promise.resolve();
  }
  listCheckRuns() {
    const index = Math.min(this.checkRunCalls, this.checkRunSequence.length - 1);
    this.checkRunCalls++;
    return Promise.resolve(this.checkRunSequence[index] ?? []);
  }
  listCommitStatuses() {
    return Promise.resolve(this.statuses);
  }
  getJobLog(_repo: string, jobId: number) {
    return Promise.resolve(this.jobLogs.get(jobId) ?? '');
  }
  listReviews() {
    return Promise.resolve(this.reviews);
  }
  listCommentsSince(repo: string, since: string) {
    return Promise.resolve((this.repoComments.get(repo) ?? []).filter((c) => c.createdAt >= since));
  }
  reactToComment(repo: string, commentId: number) {
    this.reactions.push({ repo, commentId });
    return Promise.resolve();
  }
  hasOpenIssueWithLabel(repo: string, label: string) {
    return Promise.resolve(this.openLabels.has(`${repo}:${label}`));
  }
  findOpenIssueByTitle(repo: string, title: string) {
    const found = this.createdIssues.find((i) => i.repo === repo && i.title === title);
    return Promise.resolve(
      found ? { number: found.number, body: this.issueBodies.get(found.number) ?? '' } : undefined,
    );
  }
  createIssue(repo: string, title: string, body: string) {
    const number = 100 + this.createdIssues.length;
    this.createdIssues.push({ repo, title, body, number });
    this.issueBodies.set(number, body);
    return Promise.resolve(number);
  }
  updateIssueBody(_repo: string, issue: number, body: string) {
    this.issueBodies.set(issue, body);
    return Promise.resolve();
  }
  pinIssue(_repo: string, issue: number) {
    this.pinned.push(issue);
    return Promise.resolve();
  }
}

export const checkRun = (overrides: Partial<CheckRun> = {}): CheckRun => ({
  id: 1,
  name: 'npm test',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/o/demo/runs/1',
  app: { slug: 'github-actions' },
  ...overrides,
});
