// REST API v3: repositories, refs, commits, contents, labels, issues,
// pull requests and comments. Every answer is JSON with an
// X-GitHub-Request-Id; errors are JSON `{message}` bodies.

import { parseCommit } from './gitobj.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  diffTrees,
  threeWayMerge,
  type Comment,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { isRecord, nowIso } from './util.ts';

export interface ApiRequest {
  method: string;
  /** Decoded path segments after `/api/v3` (root = []). */
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  host: string;
}

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  /** JSON value, or null for a bodyless 204. */
  body: unknown;
}

function json(status: number, body: unknown, headers?: Record<string, string>): ApiResponse {
  return { status, body, headers };
}

function error(status: number, message: string): ApiResponse {
  return { status, body: { message } };
}

// ---------------------------------------------------------------- shapes

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    html_url: `https://github.example/${VIEWER_LOGIN}`,
    url: `/api/v3/users/${VIEWER_LOGIN}`,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.example/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://github.example/${repo.fullName}.git`,
    has_issues: true,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://github.example/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.example/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.example/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
  };
}

function parseIdentityLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: nowIso() };
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(Number(match[3]) * 1_000).toISOString(),
  };
}

function commitJson(oid: string, data: Buffer): Record<string, unknown> {
  const info = parseCommit(data);
  const author = parseIdentityLine(info.author);
  const committer = parseIdentityLine(info.committer);
  return {
    sha: oid,
    commit: {
      // The stored object keeps git's trailing newline; the API presents the
      // message without it, as GitHub does.
      message: info.message.replace(/\n+$/, ''),
      author,
      committer,
      tree: { sha: info.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------- helpers

function parseBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

function pageLink(host: string, path: string, perPage: number, page: number): string {
  return `http://${host}${path}?per_page=${perPage}&page=${page}`;
}

// ---------------------------------------------------------------- the router

export function handleRest(store: Store, request: ApiRequest): ApiResponse {
  const { method, segments, query } = request;
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let parsed: unknown = {};
  if (hasBody) {
    const result = parseBody(request.body);
    if (!result.ok) return error(400, 'Problems parsing JSON');
    parsed = result.value;
  }
  const body = isRecord(parsed) ? parsed : {};

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return error(404, 'Not Found');
    return json(
      200,
      { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return error(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return error(404, 'Not Found');
    return json(200, userJson());
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') return listUserRepos(store, request);
    if (method === 'POST') return createUserRepo(store, body);
    return error(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const name = segments[2]!;
    const rest = segments.slice(3);
    if (owner !== VIEWER_LOGIN) return error(404, 'Not Found');
    const repo = store.getRepo(owner, name);
    if (repo === undefined) return error(404, 'Not Found');
    return handleRepoRoute(store, repo, rest, request, body);
  }

  return error(404, 'Not Found');
}

function listUserRepos(store: Store, request: ApiRequest): ApiResponse {
  const { perPage, page } = pageParams(request.query);
  const repos = store.listReposByOwner(VIEWER_LOGIN);
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${pageLink(request.host, '/api/v3/user/repos', perPage, page + 1)}>; rel="next"`);
  }
  if (totalPages > 1) {
    links.push(`<${pageLink(request.host, '/api/v3/user/repos', perPage, totalPages)}>; rel="last"`);
  }
  if (links.length > 0) headers.Link = links.join(', ');
  return json(200, slice.map(repoJson), headers);
}

function createUserRepo(store: Store, body: Record<string, unknown>): ApiResponse {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return error(422, 'name is invalid');
  }
  if (store.hasRepo(VIEWER_LOGIN, name)) {
    return error(422, 'name already exists on this account');
  }
  const description = typeof body.description === 'string' ? body.description : '';
  const privateFlag = body.private === true;
  const repo = store.createRepo(VIEWER_LOGIN, name, description, privateFlag);
  return json(201, repoJson(repo));
}

// ---------------------------------------------------------------- repo routes

function handleRepoRoute(
  store: Store,
  repo: Repo,
  rest: string[],
  request: ApiRequest,
  body: Record<string, unknown>,
): ApiResponse {
  const { method, query } = request;

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.privateFlag = body.private;
      repo.updatedAt = nowIso();
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null };
    }
    return error(404, 'Not Found');
  }

  const head = rest[0]!;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches: Array<Record<string, unknown>> = [];
      for (const name of [...repo.refs.keys()].sort()) {
        if (!name.startsWith('refs/heads/')) continue;
        branches.push({
          name: name.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(name) },
          protected: false,
        });
      }
      return json(200, branches);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return error(404, 'Not Found');
      return json(200, { name: branch, commit: { sha: oid }, protected: false });
    }
    return error(404, 'Not Found');
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') return createRef(repo, body);
    if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
      const branch = rest.slice(3).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return error(404, 'Not Found');
      return json(200, { ref: `refs/heads/${branch}`, object: { sha: oid } });
    }
    if (rest.length >= 4 && rest[2] === 'tags' && method === 'GET') {
      const tag = rest.slice(3).join('/');
      const oid = repo.refs.get(`refs/tags/${tag}`);
      if (oid === undefined) return error(404, 'Not Found');
      return json(200, { ref: `refs/tags/${tag}`, object: { sha: oid } });
    }
    return error(404, 'Not Found');
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const oid = repo.resolveRef(ref);
    if (oid === null) return error(404, 'Not Found');
    const commits = repo.listCommits(oid);
    return json(
      200,
      commits.map(({ oid: sha, info }) => commitJson(sha, repo.getObject(sha)!.data)),
    );
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(repo, path, query);
    if (method === 'PUT') return putContents(repo, path, body);
    if (method === 'DELETE') return deleteContents(repo, path, body);
    return error(404, 'Not Found');
  }

  if (head === 'labels' && rest.length === 1) {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') return error(422, 'name is required');
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      const existing = repo.labels.get(name);
      if (existing !== undefined) return json(201, { name: existing.name, color: existing.color });
      const label = { name, color };
      repo.labels.set(name, label);
      return json(201, { name, color });
    }
    if (method === 'GET') {
      return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    return error(404, 'Not Found');
  }

  if (head === 'issues') {
    return handleIssueRoute(repo, rest.slice(1), request, body);
  }

  if (head === 'pulls') {
    return handlePullRoute(repo, rest.slice(1), request, body);
  }

  return error(404, 'Not Found');
}

function createRef(repo: Repo, body: Record<string, unknown>): ApiResponse {
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || sha === '') return error(422, 'ref and sha are required');
  if (!repo.hasObject(sha)) return error(422, 'sha does not exist');
  if (repo.refs.has(ref)) return error(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  return json(201, { ref, object: { sha } });
}

// ---------------------------------------------------------------- contents

function resolveBranchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function getContents(repo: Repo, path: string, query: URLSearchParams): ApiResponse {
  const ref = query.get('ref') ?? repo.defaultBranch;
  const oid = repo.resolveRef(ref);
  if (oid === null) return error(404, 'Not Found');
  const treeOid = repo.treeOf(oid);
  if (treeOid === null) return error(404, 'Not Found');
  const target = repo.readPath(treeOid, path);
  if (target === null) return error(404, 'Not Found');
  if (target.isDir) {
    const entries = repo.listDir(treeOid, path) ?? [];
    const base = path === '' ? '' : `${path}/`;
    return json(
      200,
      entries.map((entry) => {
        const isDir = entry.mode === '40000';
        const object = repo.getObject(entry.oid);
        return {
          type: isDir ? 'dir' : 'file',
          name: entry.name,
          path: `${base}${entry.name}`,
          sha: entry.oid,
          size: isDir ? 0 : (object?.data.length ?? 0),
        };
      }),
    );
  }
  const object = repo.getObject(target.oid);
  if (object === undefined) return error(404, 'Not Found');
  const name = path.split('/').pop() ?? path;
  return json(200, {
    type: 'file',
    encoding: 'base64',
    content: object.data.toString('base64'),
    sha: target.oid,
    size: object.data.length,
    name,
    path,
  });
}

function putContents(repo: Repo, path: string, body: Record<string, unknown>): ApiResponse {
  if (path === '') return error(422, 'path is required');
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  const contentRaw = typeof body.content === 'string' ? body.content : null;
  if (contentRaw === null) return error(422, 'content is required');
  const content = Buffer.from(contentRaw.replace(/\s+/g, ''), 'base64');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  let tip = resolveBranchTip(repo, branch);
  if (tip === null) {
    // A branch that does not exist yet starts from the default branch's tip
    // (or from nothing when the repository is still unborn).
    const defaultTip = resolveBranchTip(repo, repo.defaultBranch);
    if (defaultTip !== null) tip = defaultTip;
  }
  const files = tip === null ? new Map<string, { mode: string; oid: string }>() : repo.flattenTree(repo.treeOf(tip)!);
  const existing = files.get(path);
  const isUpdate = existing !== undefined;
  if (isUpdate) {
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (sha !== existing.oid) return error(409, 'sha does not match the current file');
  }
  const blobOid = repo.putObject('blob', content);
  files.set(path, { mode: '100644', oid: blobOid });
  const treeOid = repo.buildTreeFromFiles(files);
  const parents = tip === null ? [] : [tip];
  const commitOid = repo.createCommit(treeOid, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = nowIso();
  return json(isUpdate ? 200 : 201, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: content.length,
      encoding: 'base64',
      content: content.toString('base64'),
    },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(repo: Repo, path: string, body: Record<string, unknown>): ApiResponse {
  if (path === '') return error(422, 'path is required');
  const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = resolveBranchTip(repo, branch);
  if (tip === null) return error(404, 'Not Found');
  const treeOid = repo.treeOf(tip);
  if (treeOid === null) return error(404, 'Not Found');
  const files = repo.flattenTree(treeOid);
  const existing = files.get(path);
  if (existing === undefined) return error(404, 'Not Found');
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (sha !== '' && sha !== existing.oid) return error(409, 'sha does not match the current file');
  files.delete(path);
  const newTreeOid = repo.buildTreeFromFiles(files);
  const commitOid = repo.createCommit(newTreeOid, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = nowIso();
  return json(200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------- issues

function handleIssueRoute(
  repo: Repo,
  rest: string[],
  request: ApiRequest,
  body: Record<string, unknown>,
): ApiResponse {
  const { method, query } = request;
  if (rest.length === 0) {
    if (method === 'GET') return listIssues(repo, query);
    if (method === 'POST') return createIssue(repo, body);
    return error(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number <= 0) return error(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return error(404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') return json(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' || body.state === 'open') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? nowIso() : null;
      }
      issue.updatedAt = nowIso();
      return json(200, issueJson(repo, issue));
    }
    return error(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      return json(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
    }
    if (method === 'POST') {
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return error(422, 'body is required');
      const comment: Comment = {
        id: nextCommentId(),
        body: text,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      return json(201, commentJson(repo, issue, comment));
    }
    return error(404, 'Not Found');
  }
  return error(404, 'Not Found');
}

let commentCounter = 0;
function nextCommentId(): number {
  commentCounter += 1;
  return commentCounter;
}

function listIssues(repo: Repo, query: URLSearchParams): ApiResponse {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  const { perPage, page } = pageParams(query);
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  // Created order is the issue number (numbers rise with creation).
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const start = (page - 1) * perPage;
  return json(200, issues.slice(start, start + perPage).map((issue) => issueJson(repo, issue)));
}

export function createIssueObject(
  repo: Repo,
  title: string,
  bodyText: string,
  labelNames: readonly string[],
): { issue: Issue } | { error: string } {
  const labels: Array<{ name: string; color: string }> = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (label === undefined) return { error: `Label '${name}' does not exist` };
    labels.push({ name: label.name, color: label.color });
  }
  const now = nowIso();
  const issue: Issue = {
    id: nextIssueId(),
    number: repo.nextNumber,
    title,
    body: bodyText,
    state: 'open',
    labels,
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return { issue };
}

let issueIdCounter = 0;
function nextIssueId(): number {
  issueIdCounter += 1;
  return issueIdCounter;
}

function createIssue(repo: Repo, body: Record<string, unknown>): ApiResponse {
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return error(422, 'title is required');
  const bodyText = typeof body.body === 'string' ? body.body : '';
  const labelNames = Array.isArray(body.labels)
    ? body.labels.filter((label): label is string => typeof label === 'string')
    : [];
  const result = createIssueObject(repo, title, bodyText, labelNames);
  if ('error' in result) return error(422, result.error);
  return json(201, issueJson(repo, result.issue));
}

// ---------------------------------------------------------------- pull requests

function handlePullRoute(
  repo: Repo,
  rest: string[],
  request: ApiRequest,
  body: Record<string, unknown>,
): ApiResponse {
  const { method, query } = request;
  if (rest.length === 0) {
    if (method === 'GET') return listPulls(repo, query);
    if (method === 'POST') return createPull(repo, body);
    return error(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number <= 0) return error(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return error(404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') return json(200, pullJson(repo, pull));
    return error(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    return json(200, pullFiles(repo, pull));
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    return mergePull(repo, pull);
  }
  return error(404, 'Not Found');
}

function listPulls(repo: Repo, query: URLSearchParams): ApiResponse {
  const state = query.get('state') ?? 'open';
  const { perPage, page } = pageParams(query);
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.number - a.number);
  const start = (page - 1) * perPage;
  return json(200, pulls.slice(start, start + perPage).map((pull) => pullJson(repo, pull)));
}

export function createPullObject(
  repo: Repo,
  title: string,
  bodyText: string,
  headRef: string,
  baseRef: string,
): { pull: PullRequest } | { error: string; status: number } {
  const headSha = repo.resolveRef(headRef);
  const baseSha = repo.resolveRef(baseRef);
  if (headSha === null || baseSha === null) {
    return { error: 'head or base branch does not exist', status: 422 };
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
      return { error: 'A pull request already exists for this head and base', status: 422 };
    }
  }
  const now = nowIso();
  const pull: PullRequest = {
    id: nextIssueId(),
    number: repo.nextNumber,
    title,
    body: bodyText,
    state: 'open',
    merged: false,
    headRef,
    baseRef,
    headSha,
    baseSha,
    mergeCommitSha: null,
    mergedAt: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return { pull };
}

function createPull(repo: Repo, body: Record<string, unknown>): ApiResponse {
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (title === '' || head === '' || base === '') {
    return error(422, 'title, head and base are required');
  }
  const bodyText = typeof body.body === 'string' ? body.body : '';
  const result = createPullObject(repo, title, bodyText, head, base);
  if ('error' in result) return error(result.status, result.error);
  return json(201, pullJson(repo, result.pull));
}

export function pullFiles(repo: Repo, pull: PullRequest): Array<Record<string, unknown>> {
  const baseTip = repo.resolveRef(pull.baseRef);
  const headTip = repo.resolveRef(pull.headRef);
  if (baseTip === null || headTip === null) return [];
  const mergeBase = repo.mergeBase(baseTip, headTip);
  const baseTree = mergeBase === null ? null : repo.treeOf(mergeBase);
  const headTree = repo.treeOf(headTip);
  const diffs = diffTrees(repo, baseTree, headTree);
  return diffs.map((diff) => ({
    filename: diff.filename,
    status: diff.status,
    additions: diff.additions,
    deletions: diff.deletions,
    changes: diff.changes,
  }));
}

export function mergePullObject(
  repo: Repo,
  pull: PullRequest,
): { sha: string } | { error: string; status: number } {
  if (pull.state !== 'open') {
    return { error: 'Pull request is already closed', status: 405 };
  }
  const baseTip = repo.resolveRef(pull.baseRef);
  const headTip = repo.resolveRef(pull.headRef);
  if (baseTip === null || headTip === null) {
    return { error: 'head or base branch does not exist', status: 422 };
  }
  const mergeBase = repo.mergeBase(baseTip, headTip);
  const outcome = threeWayMerge(
    repo,
    mergeBase === null ? null : repo.treeOf(mergeBase),
    repo.treeOf(baseTip),
    repo.treeOf(headTip),
  );
  if (!outcome.ok || outcome.files === undefined) {
    return { error: 'Merge conflict', status: 405 };
  }
  const treeOid = repo.buildTreeFromFiles(outcome.files);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
  const commitOid = repo.createCommit(treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  const now = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commitOid;
  pull.mergedAt = now;
  pull.closedAt = now;
  pull.updatedAt = now;
  pull.baseSha = commitOid;
  repo.updatedAt = now;
  return { sha: commitOid };
}

function mergePull(repo: Repo, pull: PullRequest): ApiResponse {
  const result = mergePullObject(repo, pull);
  if ('error' in result) return error(result.status, result.error);
  return json(200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
}
