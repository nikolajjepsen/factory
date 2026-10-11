import type {
  CheckRun,
  CommitStatus,
  CreatePullRequest,
  GitHub,
  Issue,
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
