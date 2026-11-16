// GraphQL v4: a small parser (operations, variables, arguments, aliases,
// inline fragments) and an executor over the same store REST uses. Unknown
// fields answer HTTP 200 with an `errors` entry naming the field and partial
// data; an unknown repository answers `null` with no errors.

import {
  createIssueObject,
  createPullObject,
  mergePullObject,
  pullFiles,
} from './rest.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  threeWayMerge,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { base64urlDecode, base64urlEncode, isRecord, nowIso } from './util.ts';

// ---------------------------------------------------------------- global ids

/** An opaque, stable global id: base64url of `Type:key`. */
export function globalId(type: string, key: string): string {
  return base64urlEncode(`${type}:${key}`);
}

function parseGlobalId(id: string): { type: string; key: string } | null {
  const decoded = base64urlDecode(id);
  if (decoded === null) return null;
  const colon = decoded.indexOf(':');
  if (colon <= 0) return null;
  return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.fullName);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.fullName}#${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${repo.fullName}#${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return globalId('IssueComment', `${repo.fullName}#${issue.number}/${commentId}`);
}

function repoFromGlobalId(store: Store, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  const [owner, name] = parsed.key.split('/');
  if (owner === undefined || name === undefined) return null;
  return store.getRepo(owner, name) ?? null;
}

function issueFromGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return null;
  const hash = parsed.key.lastIndexOf('#');
  if (hash < 0) return null;
  const [owner, name] = parsed.key.slice(0, hash).split('/');
  const number = Number(parsed.key.slice(hash + 1));
  if (owner === undefined || name === undefined || !Number.isSafeInteger(number)) return null;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  const issue = repo.issues.get(number);
  if (issue === undefined) return null;
  return { repo, issue };
}

function pullFromGlobalId(store: Store, id: string): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  const hash = parsed.key.lastIndexOf('#');
  if (hash < 0) return null;
  const [owner, name] = parsed.key.slice(0, hash).split('/');
  const number = Number(parsed.key.slice(hash + 1));
  if (owner === undefined || name === undefined || !Number.isSafeInteger(number)) return null;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(number);
  if (pull === undefined) return null;
  return { repo, pull };
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selections: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeName: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

class GraphQLSyntaxError extends Error {}

class Parser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.skipIgnored(), this.pos < this.text.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new GraphQLSyntaxError('empty document');
    return operations;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos]!)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  private peek(): string {
    this.skipIgnored();
    return this.text[this.pos] ?? '';
  }

  private expect(char: string): void {
    this.skipIgnored();
    if (this.text[this.pos] !== char) {
      throw new GraphQLSyntaxError(`expected '${char}' at ${this.pos}`);
    }
    this.pos += 1;
  }

  private readName(): string {
    this.skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match === null) throw new GraphQLSyntaxError(`expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const saved = this.pos;
    const word = this.peekWord();
    if (word === 'query' || word === 'mutation') {
      operation = word;
      this.readName();
      if (/^[A-Za-z_]/.test(this.peek())) name = this.readName();
    } else {
      this.pos = saved;
    }
    const variableDefs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek() === '(') {
      this.expect('(');
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.readName();
        this.expect(':');
        this.readType();
        let defaultValue: ValueNode | null = null;
        if (this.peek() === '=') {
          this.expect('=');
          defaultValue = this.parseValue();
        }
        variableDefs.push({ name: varName, defaultValue });
      }
      this.expect(')');
    }
    // Directives (@include/@skip) are not used by the suite; skip them if present.
    while (this.peek() === '@') {
      this.pos += 1;
      this.readName();
      if (this.peek() === '(') this.parseArguments();
    }
    const selections = this.parseSelectionSet();
    return { operation, name, variableDefs, selections };
  }

  private peekWord(): string {
    this.skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    return match?.[0] ?? '';
  }

  private readType(): void {
    this.skipIgnored();
    if (this.peek() === '[') {
      this.expect('[');
      this.readType();
      this.expect(']');
    } else {
      this.readName();
    }
    if (this.peek() === '!') this.pos += 1;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '') throw new GraphQLSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      let typeName: string | null = null;
      if (this.peekWord() === 'on') {
        this.readName();
        typeName = this.readName();
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeName, selections };
    }
    const first = this.readName();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.expect(':');
      alias = first;
      name = this.readName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek() === '(') args = this.parseArguments();
    while (this.peek() === '@') {
      this.pos += 1;
      this.readName();
      if (this.peek() === '(') this.parseArguments();
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    this.skipIgnored();
    const char = this.text[this.pos] ?? '';
    if (char === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (char === '"') return { kind: 'string', value: this.parseString() };
    if (char === '[') {
      this.expect('[');
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (char === '{') {
      this.expect('{');
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (char === '-' || /[0-9]/.test(char)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
      if (match === null) throw new GraphQLSyntaxError(`bad number at ${this.pos}`);
      this.pos += match[0].length;
      const text = match[0];
      return /[.eE]/.test(text)
        ? { kind: 'float', value: Number(text) }
        : { kind: 'int', value: Number(text) };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.text.length) {
      const char = this.text[this.pos]!;
      this.pos += 1;
      if (char === '"') return out;
      if (char === '\\') {
        const escape = this.text[this.pos] ?? '';
        this.pos += 1;
        if (escape === 'n') out += '\n';
        else if (escape === 't') out += '\t';
        else if (escape === 'r') out += '\r';
        else if (escape === 'u') {
          out += String.fromCharCode(parseInt(this.text.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += escape;
      } else {
        out += char;
      }
    }
    throw new GraphQLSyntaxError('unterminated string');
  }
}

// ---------------------------------------------------------------- values

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function resolveValue(
  node: ValueNode,
  variables: Record<string, unknown>,
): JsonValue {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : (value as JsonValue);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: { [key: string]: JsonValue } = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function resolveArgs(
  args: Record<string, ValueNode>,
  variables: Record<string, unknown>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------- schema (for introspection + unknown-field errors)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
    'description',
    'isPrivate',
    'createdAt',
    'updatedAt',
  ],
  Issue: [
    'id',
    'databaseId',
    'number',
    'title',
    'body',
    'state',
    'author',
    'createdAt',
    'updatedAt',
    'closedAt',
    'comments',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id',
    'databaseId',
    'number',
    'title',
    'body',
    'state',
    'merged',
    'mergedAt',
    'headRefName',
    'baseRefName',
    'mergeable',
    'files',
    'author',
    'createdAt',
    'updatedAt',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  Ref: ['name'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  IssueConnection: 'OBJECT',
  PageInfo: 'OBJECT',
  PullRequest: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  Ref: 'OBJECT',
  IssueComment: 'OBJECT',
  IssueCommentEdge: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __EnumValue: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  Node: 'INTERFACE',
};

// ---------------------------------------------------------------- executor

interface TypedValue {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function repoTyped(repo: Repo): TypedValue {
  return { __typename: 'Repository', repo };
}

function issueTyped(repo: Repo, issue: Issue): TypedValue {
  return { __typename: 'Issue', repo, issue };
}

function pullTyped(repo: Repo, pull: PullRequest): TypedValue {
  return { __typename: 'PullRequest', repo, pull };
}

function executeSelections(
  ctx: ExecContext,
  parentType: string,
  parent: TypedValue | null,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeName !== null && selection.typeName !== parentType) continue;
      Object.assign(out, executeSelections(ctx, parentType, parent, selection.selections));
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(ctx, parentType, parent, selection);
  }
  return out;
}

function unknownField(ctx: ExecContext, parentType: string, name: string): null {
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
  return null;
}

function resolveField(
  ctx: ExecContext,
  parentType: string,
  parent: TypedValue | null,
  field: FieldNode,
): unknown {
  const known = TYPE_FIELDS[parentType];
  if (known !== undefined && !known.includes(field.name)) {
    return unknownField(ctx, parentType, field.name);
  }
  const args = resolveArgs(field.args, ctx.variables);
  const sub = (value: TypedValue | null, type: string): unknown => {
    if (value === null) return null;
    if (field.selections === null) return value;
    return executeSelections(ctx, type, value, field.selections);
  };

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      return sub({ __typename: 'User' }, 'User');
    }
    if (field.name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined) return null;
      return sub(repoTyped(repo), 'Repository');
    }
    if (field.name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = repoFromGlobalId(ctx.store, id);
        if (repo === null) return null;
        return sub(repoTyped(repo), 'Repository');
      }
      if (parsed.type === 'Issue') {
        const found = issueFromGlobalId(ctx.store, id);
        if (found === null) return null;
        return sub(issueTyped(found.repo, found.issue), 'Issue');
      }
      if (parsed.type === 'PullRequest') {
        const found = pullFromGlobalId(ctx.store, id);
        if (found === null) return null;
        return sub(pullTyped(found.repo, found.pull), 'PullRequest');
      }
      return null;
    }
    if (field.name === '__type') {
      const name = typeof args.name === 'string' ? args.name : '';
      if (TYPE_KIND[name] === undefined && TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) {
        return null;
      }
      return sub({ __typename: '__Type', typeName: name }, '__Type');
    }
    return unknownField(ctx, parentType, field.name);
  }

  if (parentType === 'Mutation') {
    return resolveMutation(ctx, field, args);
  }

  if (parent === null) return null;

  if (parentType === 'User') {
    if (field.name === 'login') return VIEWER_LOGIN;
    if (field.name === 'id') return globalId('User', VIEWER_LOGIN);
    if (field.name === 'name') return VIEWER_LOGIN;
    return unknownField(ctx, parentType, field.name);
  }

  if (parentType === 'Repository') {
    const repo = parent.repo as Repo;
    switch (field.name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return repo.fullName;
      case 'owner':
        return sub({ __typename: 'User' }, 'User');
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return sub({ __typename: 'Ref', refName: repo.defaultBranch }, 'Ref');
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.privateFlag;
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : NaN;
        const issue = repo.issues.get(number);
        if (issue === undefined) return null;
        return sub(issueTyped(repo, issue), 'Issue');
      }
      case 'issues':
        return sub(resolveIssueConnection(ctx, repo, args), 'IssueConnection');
      case 'pullRequests':
        return sub(resolvePullConnection(ctx, repo, args), 'PullRequestConnection');
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : NaN;
        const pull = repo.pulls.get(number);
        if (pull === undefined) return null;
        return sub(pullTyped(repo, pull), 'PullRequest');
      }
      default:
        return unknownField(ctx, parentType, field.name);
    }
  }

  if (parentType === 'Issue') {
    const { repo, issue } = parent as unknown as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'databaseId':
        return issue.id;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issueState(issue);
      case 'author':
        return sub({ __typename: 'User' }, 'User');
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'closedAt':
        return issue.closedAt;
      default:
        return unknownField(ctx, parentType, field.name);
    }
  }

  if (parentType === 'IssueConnection') {
    const connection = parent as unknown as { nodes: TypedValue[]; endCursor: string | null; hasNextPage: boolean };
    switch (field.name) {
      case 'nodes':
        return connection.nodes.map((node) =>
          field.selections === null ? node : executeSelections(ctx, node.__typename, node, field.selections),
        );
      case 'pageInfo':
        return sub(
          {
            __typename: 'PageInfo',
            hasNextPage: connection.hasNextPage,
            endCursor: connection.endCursor,
            hasPreviousPage: false,
            startCursor: null,
          },
          'PageInfo',
        );
      case 'totalCount':
        return connection.nodes.length;
      default:
        return unknownField(ctx, parentType, field.name);
    }
  }

  if (parentType === 'PullRequestConnection') {
    const connection = parent as unknown as { nodes: TypedValue[]; endCursor: string | null; hasNextPage: boolean };
    switch (field.name) {
      case 'nodes':
        return connection.nodes.map((node) =>
          field.selections === null ? node : executeSelections(ctx, node.__typename, node, field.selections),
        );
      case 'pageInfo':
        return sub(
          {
            __typename: 'PageInfo',
            hasNextPage: connection.hasNextPage,
            endCursor: connection.endCursor,
            hasPreviousPage: false,
            startCursor: null,
          },
          'PageInfo',
        );
      case 'totalCount':
        return connection.nodes.length;
      default:
        return unknownField(ctx, parentType, field.name);
    }
  }

  if (parentType === 'PageInfo') {
    switch (field.name) {
      case 'hasNextPage':
        return parent.hasNextPage as boolean;
      case 'hasPreviousPage':
        return parent.hasPreviousPage as boolean;
      case 'startCursor':
        return parent.startCursor as string | null;
      case 'endCursor':
        return parent.endCursor as string | null;
      default:
        return unknownField(ctx, parentType, field.name);
    }
  }

  if (parentType === 'PullRequest') {
    const { repo, pull } = parent as unknown as { repo: Repo; pull: PullRequest };
    switch (field.name) {
      case 'id':
        return pullGlobalId(repo, pull);
      case 'databaseId':
        return pull.id;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.mergedAt;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable': {
        if (pull.state !== 'open') return 'UNKNOWN';
        const baseTip = repo.resolveRef(pull.baseRef);
        const headTip = repo.resolveRef(pull.headRef);
        if (baseTip === null || headTip === null) return 'UNKNOWN';
        const mergeBase = repo.mergeBase(baseTip, headTip);
        const outcome = threeWayMerge(
          repo,
          mergeBase === null ? null : repo.treeOf(mergeBase),
          repo.treeOf(baseTip),
          repo.treeOf(headTip),
        );
        return outcome.ok ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'files': {
        // `files` is a connection (gh queries files(first:) { nodes { path } }).
        const files = pullFiles(repo, pull);
        const first =
          typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : files.length;
        const page = files.slice(0, first);
        return sub(
          {
            __typename: 'PullRequestChangedFileConnection',
            nodes: page.map(
              (file) =>
                ({ __typename: 'PullRequestChangedFile', path: file.filename }) as TypedValue,
            ),
            endCursor: null,
            hasNextPage: files.length > first,
          },
          'PullRequestChangedFileConnection',
        );
      }
      case 'author':
        return sub({ __typename: 'User' }, 'User');
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      default:
        return unknownField(ctx, parentType, field.name);
    }
  }

  if (parentType === 'PullRequestChangedFileConnection') {
    const connection = parent as unknown as { nodes: TypedValue[]; endCursor: string | null; hasNextPage: boolean };
    switch (field.name) {
      case 'nodes':
        return connection.nodes.map((node) =>
          field.selections === null ? node : executeSelections(ctx, node.__typename, node, field.selections),
        );
      case 'pageInfo':
        return sub(
          {
            __typename: 'PageInfo',
            hasNextPage: connection.hasNextPage,
            endCursor: connection.endCursor,
            hasPreviousPage: false,
            startCursor: null,
          },
          'PageInfo',
        );
      case 'totalCount':
        return connection.nodes.length;
      default:
        return unknownField(ctx, parentType, field.name);
    }
  }

  if (parentType === 'PullRequestChangedFile') {
    if (field.name === 'path') return parent.path as string;
    return unknownField(ctx, parentType, field.name);
  }

  if (parentType === 'Ref') {
    if (field.name === 'name') return parent.refName as string;
    return unknownField(ctx, parentType, field.name);
  }

  if (parentType === 'IssueComment') {
    if (field.name === 'id') return parent.commentId as string;
    if (field.name === 'body') return parent.commentBody as string;
    if (field.name === 'author') return sub({ __typename: 'User' }, 'User');
    return unknownField(ctx, parentType, field.name);
  }

  if (parentType === 'IssueCommentEdge') {
    if (field.name === 'node') {
      const node = parent.node as TypedValue;
      return sub(node, 'IssueComment');
    }
    if (field.name === 'cursor') return parent.cursor as string | null;
    return unknownField(ctx, parentType, field.name);
  }

  if (
    parentType === 'CreateIssuePayload' ||
    parentType === 'CloseIssuePayload' ||
    parentType === 'CreatePullRequestPayload' ||
    parentType === 'MergePullRequestPayload' ||
    parentType === 'AddCommentPayload'
  ) {
    if (field.name === 'issue') {
      const value = parent.issue as TypedValue | null;
      return value === null ? null : sub(value, 'Issue');
    }
    if (field.name === 'pullRequest') {
      const value = parent.pullRequest as TypedValue | null;
      return value === null ? null : sub(value, 'PullRequest');
    }
    if (field.name === 'commentEdge') {
      const value = parent.commentEdge as TypedValue | null;
      return value === null ? null : sub(value, 'IssueCommentEdge');
    }
    if (field.name === 'clientMutationId') return null;
    return unknownField(ctx, parentType, field.name);
  }

  if (parentType === '__Type') {
    const typeName = parent.typeName as string;
    switch (field.name) {
      case 'name':
        return typeName;
      case 'kind':
        return TYPE_KIND[typeName] ?? 'OBJECT';
      case 'description':
        return null;
      case 'fields': {
        const names = TYPE_FIELDS[typeName] ?? [];
        return names.map((name) => {
          const node: TypedValue = { __typename: '__Field', fieldName: name };
          return field.selections === null
            ? node
            : executeSelections(ctx, '__Field', node, field.selections);
        });
      }
      case 'enumValues': {
        const values = ENUM_VALUES[typeName] ?? [];
        return values.map((name) => {
          const node: TypedValue = { __typename: '__EnumValue', enumName: name };
          return field.selections === null
            ? node
            : executeSelections(ctx, '__EnumValue', node, field.selections);
        });
      }
      default:
        return unknownField(ctx, parentType, field.name);
    }
  }

  if (parentType === '__Field') {
    if (field.name === 'name') return parent.fieldName as string;
    if (field.name === 'description') return null;
    return unknownField(ctx, parentType, field.name);
  }

  if (parentType === '__EnumValue') {
    if (field.name === 'name') return parent.enumName as string;
    if (field.name === 'description') return null;
    return unknownField(ctx, parentType, field.name);
  }

  return unknownField(ctx, parentType, field.name);
}

function cursorFor(number: number): string {
  return base64urlEncode(`Cursor:${number}`);
}

function numberFromCursor(cursor: string): number | null {
  const decoded = base64urlDecode(cursor);
  if (decoded === null || !decoded.startsWith('Cursor:')) return null;
  const n = Number(decoded.slice('Cursor:'.length));
  return Number.isSafeInteger(n) ? n : null;
}

function resolveIssueConnection(
  _ctx: ExecContext,
  repo: Repo,
  args: Record<string, JsonValue>,
): TypedValue {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    issues = issues.filter((issue) => states.includes(issueState(issue)));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 'asc' : 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    if (index >= 0) issues = issues.slice(index + 1);
  }
  const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueTyped(repo, issue)),
    endCursor,
    hasNextPage,
  };
}

function resolvePullConnection(
  _ctx: ExecContext,
  repo: Repo,
  args: Record<string, JsonValue>,
): TypedValue {
  let pulls = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    pulls = pulls.filter((pull) => states.includes(pullState(pull)));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 'asc' : 'desc';
  pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  if (after !== null) {
    const index = pulls.findIndex((pull) => pull.number === after);
    if (index >= 0) pulls = pulls.slice(index + 1);
  }
  const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : pulls.length;
  const page = pulls.slice(0, first);
  const hasNextPage = pulls.length > first;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullTyped(repo, pull)),
    endCursor,
    hasNextPage,
  };
}

function inputOf(args: Record<string, JsonValue>): Record<string, JsonValue> {
  return isRecord(args.input) ? args.input : {};
}

function resolveMutation(
  ctx: ExecContext,
  field: FieldNode,
  args: Record<string, JsonValue>,
): unknown {
  const sub = (value: TypedValue | null, type: string): unknown => {
    if (value === null) return null;
    if (field.selections === null) return value;
    return executeSelections(ctx, type, value, field.selections);
  };
  const fail = (message: string): unknown => {
    ctx.errors.push({ message });
    return null;
  };
  const input = inputOf(args);

  if (field.name === 'createIssue') {
    const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const repo = repoFromGlobalId(ctx.store, repositoryId);
    if (repo === null) return fail('repository not found');
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') return fail('title is required');
    const bodyText = typeof input.body === 'string' ? input.body : '';
    const result = createIssueObject(repo, title, bodyText, []);
    if ('error' in result) return fail(result.error);
    return sub(
      { __typename: 'CreateIssuePayload', issue: issueTyped(repo, result.issue) },
      'CreateIssuePayload',
    );
  }

  if (field.name === 'closeIssue') {
    const issueId = typeof input.issueId === 'string' ? input.issueId : '';
    const found = issueFromGlobalId(ctx.store, issueId);
    if (found === null) return fail('issue not found');
    found.issue.state = 'closed';
    found.issue.closedAt = nowIso();
    found.issue.updatedAt = nowIso();
    return sub(
      { __typename: 'CloseIssuePayload', issue: issueTyped(found.repo, found.issue) },
      'CloseIssuePayload',
    );
  }

  if (field.name === 'createPullRequest') {
    const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const repo = repoFromGlobalId(ctx.store, repositoryId);
    if (repo === null) return fail('repository not found');
    const title = typeof input.title === 'string' ? input.title : '';
    const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
    if (title === '' || baseRefName === '' || headRefName === '') {
      return fail('title, baseRefName and headRefName are required');
    }
    const result = createPullObject(repo, title, '', headRefName, baseRefName);
    if ('error' in result) return fail(result.error);
    return sub(
      { __typename: 'CreatePullRequestPayload', pullRequest: pullTyped(repo, result.pull) },
      'CreatePullRequestPayload',
    );
  }

  if (field.name === 'mergePullRequest') {
    const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
    const found = pullFromGlobalId(ctx.store, pullRequestId);
    if (found === null) return fail('pull request not found');
    const result = mergePullObject(found.repo, found.pull);
    if ('error' in result) return fail(result.error);
    return sub(
      { __typename: 'MergePullRequestPayload', pullRequest: pullTyped(found.repo, found.pull) },
      'MergePullRequestPayload',
    );
  }

  if (field.name === 'addComment') {
    const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
    const found = issueFromGlobalId(ctx.store, subjectId);
    if (found === null) return fail('subject not found');
    const bodyText = typeof input.body === 'string' ? input.body : '';
    if (bodyText === '') return fail('body is required');
    const commentId = found.issue.comments.reduce((max, comment) => Math.max(max, comment.id), 0) + 1;
    const now = nowIso();
    found.issue.comments.push({ id: commentId, body: bodyText, createdAt: now, updatedAt: now });
    const node: TypedValue = {
      __typename: 'IssueComment',
      commentId: commentGlobalId(found.repo, found.issue, commentId),
      commentBody: bodyText,
    };
    return sub(
      {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(commentId) },
      },
      'AddCommentPayload',
    );
  }

  return unknownField(ctx, 'Mutation', field.name);
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

function executeOne(
  store: Store,
  operation: { query?: unknown; variables?: unknown; operationName?: unknown },
): Record<string, unknown> {
  const queryText = typeof operation.query === 'string' ? operation.query : '';
  let operations: OperationNode[];
  try {
    operations = new Parser(queryText).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'syntax error' }] };
  }
  const operationName = typeof operation.operationName === 'string' ? operation.operationName : null;
  const chosen =
    operations.find((item) => item.name === operationName) ??
    (operations.length === 1 ? operations[0]! : null);
  if (chosen === null) {
    return { data: null, errors: [{ message: 'operation not found' }] };
  }
  const variables: Record<string, unknown> = isRecord(operation.variables)
    ? { ...operation.variables }
    : {};
  for (const def of chosen.variableDefs) {
    if (variables[def.name] === undefined && def.defaultValue !== null) {
      variables[def.name] = resolveValue(def.defaultValue, variables);
    }
  }
  const ctx: ExecContext = { store, variables, errors: [] };
  const rootType = chosen.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, null, chosen.selections);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

export function handleGraphQL(store: Store, body: Buffer): GraphQLResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((item) => executeOne(store, isRecord(item) ? item : {})) };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: { errors: [{ message: 'query is required' }] } };
  }
  const result = executeOne(store, parsed);
  return { status: 200, body: result };
}

// Re-exported for the MCP module's shared shapes.
export { VIEWER_ID, VIEWER_LOGIN };
