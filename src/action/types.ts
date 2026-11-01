/** Narrow interfaces over the GitHub Actions runtime and API, so the action logic is testable. */
export interface ActionIO {
  getInput(name: string): string;
  info(message: string): void;
  warning(message: string): void;
  setOutput(name: string, value: string): void;
  writeSummary(markdown: string): Promise<void>;
  uploadArtifact(name: string, files: string[], rootDir: string): Promise<void>;
  /** Download an artifact of another workflow run into `dest`. Returns false if it does not exist. */
  downloadArtifact(name: string, workflowRunId: number, dest: string): Promise<boolean>;
}

export interface PullRequestInfo {
  number: number;
  state: string;
  title: string;
  body: string | null;
  headSha: string;
}

export interface CommentInfo {
  id: number;
  body: string;
  authorLogin: string;
  authorType: string;
}

export interface PullsApi {
  getPull(number: number): Promise<PullRequestInfo>;
  getDiff(number: number): Promise<string>;
  listComments(number: number): Promise<CommentInfo[]>;
  createComment(number: number, body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
}

export const ARTIFACT_DEFAULT = 'doppeldiff-report';
