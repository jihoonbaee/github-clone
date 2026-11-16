// MCP: JSON-RPC 2.0 over Streamable HTTP at POST /mcp, answering plain JSON.
// Speaks the modern era (2026-07-28 `server/discover`, no handshake) and the
// legacy handshake (`initialize` + `notifications/initialized`) as a fallback.
// Six tools over the same store REST uses; `tools/list` is a frozen constant
// so two calls answer byte-identical tool arrays.

import {
  createIssueObject,
  createPullObject,
  issueJson,
  mergePullObject,
  pullJson,
  repoJson,
} from './rest.ts';
import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';
import { isRecord } from './util.ts';

export const MCP_SERVER_NAME = 'github-core-clone-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_REVISION = '2026-07-28';

const TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
        owner: Object.freeze({ type: 'string', description: 'The repository owner (the authenticated user).' }),
      }),
      required: Object.freeze(['name']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed, or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch (the changes).' }),
        base: Object.freeze({ type: 'string', description: 'The base branch (the target).' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
      additionalProperties: false,
    }),
  }),
]);

interface RpcResponse {
  status: number;
  /** JSON value, or null for a bodyless 202 (notifications). */
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, httpStatus = 200): RpcResponse {
  return { status: httpStatus, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function serverInfo(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function capabilities(): Record<string, unknown> {
  return { tools: {} };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function missingArg(name: string): RpcResponse {
  return rpcError(null, -32602, `Missing required argument: ${name}`);
}

function requireString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

type ToolCallResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: RpcResponse };

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolCallResult {
  const fail = (response: RpcResponse): ToolCallResult => ({ ok: false, error: response });
  const done = (value: Record<string, unknown>): ToolCallResult => ({ ok: true, value });
  const repoOf = (): { repo: Repo } | ToolCallResult => {
    const owner = requireString(args, 'owner');
    const repoName = requireString(args, 'repo');
    if (owner === null) return fail(missingArg('owner'));
    if (repoName === null) return fail(missingArg('repo'));
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      return fail(rpcError(null, -32602, `repository ${owner}/${repoName} not found`));
    }
    return { repo };
  };

  switch (name) {
    case 'create_repo': {
      const repoName = requireString(args, 'name');
      if (repoName === null) return fail(missingArg('name'));
      const existing = store.getRepo(VIEWER_LOGIN, repoName);
      if (existing !== undefined) return done(toolResult(repoJson(existing)));
      const description = typeof args.description === 'string' ? args.description : '';
      const privateFlag = args.private === true;
      const repo = store.createRepo(VIEWER_LOGIN, repoName, description, privateFlag);
      return done(toolResult(repoJson(repo)));
    }
    case 'get_repo': {
      const found = repoOf();
      if ('ok' in found) return found;
      return done(toolResult(repoJson(found.repo)));
    }
    case 'create_issue': {
      const found = repoOf();
      if ('ok' in found) return found;
      const title = requireString(args, 'title');
      if (title === null) return fail(missingArg('title'));
      const bodyText = typeof args.body === 'string' ? args.body : '';
      const result = createIssueObject(found.repo, title, bodyText, []);
      if ('error' in result) return done(toolError(result.error));
      return done(toolResult(issueJson(found.repo, result.issue)));
    }
    case 'list_issues': {
      const found = repoOf();
      if ('ok' in found) return found;
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...found.repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return done(toolResult(issues.map((issue) => issueJson(found.repo, issue))));
    }
    case 'create_pull_request': {
      const found = repoOf();
      if ('ok' in found) return found;
      const title = requireString(args, 'title');
      if (title === null) return fail(missingArg('title'));
      const head = requireString(args, 'head');
      if (head === null) return fail(missingArg('head'));
      const base = requireString(args, 'base');
      if (base === null) return fail(missingArg('base'));
      const bodyText = typeof args.body === 'string' ? args.body : '';
      const result = createPullObject(found.repo, title, bodyText, head, base);
      if ('error' in result) return done(toolError(result.error));
      return done(toolResult(pullJson(found.repo, result.pull)));
    }
    case 'merge_pull_request': {
      const found = repoOf();
      if ('ok' in found) return found;
      const raw = args.pull_number;
      const pullNumber = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
        return fail(missingArg('pull_number'));
      }
      const pull = found.repo.pulls.get(pullNumber);
      if (pull === undefined) return done(toolError(`pull request #${pullNumber} not found`));
      const result = mergePullObject(found.repo, pull);
      if ('error' in result) return done(toolError(result.error));
      return done(toolResult(pullJson(found.repo, pull)));
    }
    default:
      return fail(rpcError(null, -32601, `Method not found: ${name}`));
  }
}

export function handleMcp(store: Store, body: Buffer): RpcResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const id = parsed.id;
  const isNotification = id === undefined;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};
  const errorWithId = (response: RpcResponse): RpcResponse => {
    if (isRecord(response.body)) {
      return { status: response.status, body: { ...response.body, id: id ?? null } };
    }
    return response;
  };

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [MCP_REVISION],
      capabilities: capabilities(),
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion =
      offered !== '' && /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: capabilities(),
      serverInfo: serverInfo(),
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification gets no JSON-RPC answer: HTTP 202, empty body.
    return { status: 202, body: null };
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (toolName === '') return rpcError(id, -32602, 'Missing required argument: name');
    const result = callTool(store, toolName, args);
    if (!result.ok) return errorWithId(result.error);
    return rpcResult(id, result.value);
  }

  if (method === '') return rpcError(id ?? null, -32600, 'Invalid Request');
  if (isNotification) return { status: 202, body: null };
  return rpcError(id, -32601, `Method not found: ${method}`);
}
