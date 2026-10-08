/**
 * `teamai push --docs --dir/--file <path>`: publishes a local directory or file
 * into the team repo's `docs/<ns>/<basename>`, through the ordinary push
 * branch/PR path. Drives the real push() against a bare "remote" and a working
 * clone, mocking only config detection and the provider's PR creation — the
 * docs handler, git and the copy are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { simpleGit } from 'simple-git';

const mockCreatePullRequest = vi.fn().mockResolvedValue('https://example.test/pr/1');
const mockAutoDetectInit = vi.fn();
let storedState: Record<string, unknown>;

vi.mock('../providers/index.js', () => ({
  getProvider: () => ({
    name: 'github',
    parseRepoInput: (input: string) => ({ owner: 'acme', repo: 'team', httpsUrl: input }),
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  }),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn(() => Promise.resolve(structuredClone(storedState))),
  saveStateForScope: vi.fn((state: unknown) => {
    storedState = structuredClone(state) as Record<string, unknown>;
    return Promise.resolve();
  }),
}));

vi.mock('../read-only.js', () => ({ assertNotReadOnly: vi.fn() }));
vi.mock('../utils/pre-push-sync.js', () => ({ syncTeamUpdatesToLocal: vi.fn() }));
// push() takes a real ~/.teamai/.sync-lock; parallel workers would race on it.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/prompt.js', () => ({
  isInteractive: vi.fn(() => false),
  askQuestion: vi.fn(() => Promise.resolve('')),
  askConfirmation: vi.fn(() => Promise.resolve(true)),
  askSelection: vi.fn(() => Promise.resolve(null)),
  parseSelection: vi.fn(),
  closePrompt: vi.fn(),
}));

const ROLES_YAML = `version: 1
roles:
  - id: dev
    resources:
      knowledge: []
      skills: []
      docs: [guides]
`;

/** A bare remote with one commit on main, plus a clone of it as the team repo. */
async function initTeamRepos(
  root: string,
  seedFiles: Record<string, string> = {},
): Promise<{ teamRepo: string; remote: string }> {
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const teamRepo = path.join(root, 'team-repo');
  await simpleGit().init(['--bare', '--initial-branch=main', remote]);

  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'version: 1\n');
  fs.writeFileSync(path.join(seed, 'README.md'), '# team\n');
  for (const [relative, content] of Object.entries(seedFiles)) {
    const target = path.join(seed, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const seedGit = simpleGit(seed);
  await seedGit.init();
  await seedGit.addConfig('user.email', 't@t.com');
  await seedGit.addConfig('user.name', 't');
  await seedGit.add('.');
  await seedGit.commit('init');
  await seedGit.branch(['-M', 'main']);
  await seedGit.addRemote('origin', remote);
  await seedGit.push(['-u', 'origin', 'main']);

  await simpleGit().clone(remote, teamRepo);
  const trGit = simpleGit(teamRepo);
  await trGit.addConfig('user.email', 't@t.com');
  await trGit.addConfig('user.name', 't');
  return { teamRepo, remote };
}

/** A local directory or file to publish, outside the team repo. */
function makeSource(root: string, relative: string, files: Record<string, string>): string {
  const target = path.join(root, relative);
  fs.mkdirSync(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(target, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return target;
}

/** What log.error printed, where push reports a refusal. */
function errorOutput(): string {
  return vi.mocked(console.error).mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

async function pushBranches(remote: string): Promise<string[]> {
  const out = await simpleGit(remote).raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/']);
  return out.split('\n').filter(Boolean);
}

/** The one branch a successful push left on the remote, with the failure printed. */
async function onlyBranch(remote: string): Promise<string> {
  const branches = await pushBranches(remote);
  expect(branches, `expected exactly one pushed branch; errors:\n${errorOutput()}`).toHaveLength(1);
  return branches[0]!;
}

describe('teamai push --docs', () => {
  let tmpDir: string;
  let teamRepo: string;
  let remote: string;
  let sourceRoot: string;
  let previousExitCode: typeof process.exitCode;

  async function setup(seedFiles: Record<string, string> = {}, localConfigExtra: Record<string, unknown> = {}) {
    ({ teamRepo, remote } = await initTeamRepos(tmpDir, seedFiles));
    const localConfig = {
      repo: { localPath: teamRepo, remote },
      username: 'alice',
      scope: 'user',
      ...localConfigExtra,
    };
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig: { repo: 'acme/team', toolPaths: {} } });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-push-docs-'));
    sourceRoot = path.join(tmpDir, 'work');
    fs.mkdirSync(sourceRoot, { recursive: true });
    vi.clearAllMocks();
    storedState = { lastPush: null, pushedSkills: [], pushedRules: [], pendingPushes: [] };
    mockCreatePullRequest.mockResolvedValue('https://example.test/pr/1');
    previousExitCode = process.exitCode;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    // Only the console spies: `vi.restoreAllMocks()` also resets the module
    // factory mocks above, whose `acquireLock` would then return undefined from
    // the second test on.
    vi.mocked(console.log).mockRestore();
    vi.mocked(console.error).mockRestore();
    vi.mocked(process.stderr.write).mockRestore();
    process.exitCode = previousExitCode;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('publishes a directory\'s contents into a directory named by the source itself', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', {
      'api.md': 'api\n',
      'nested/flow.md': 'flow\n',
    });

    await push({ docs: source });

    expect(process.exitCode).toBe(previousExitCode);
    const branch = await onlyBranch(remote);
    // tutk's files land in docs/tutk/, never docs/tutk/tutk/.
    expect(await simpleGit(remote).show([`${branch}:docs/tutk/api.md`])).toBe('api\n');
    expect(await simpleGit(remote).show([`${branch}:docs/tutk/nested/flow.md`])).toBe('flow\n');
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
  });

  it('names the directory with --namespace instead of the source name', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    await push({ docs: source, namespace: 'guides' });

    const branch = await onlyBranch(remote);
    expect(await simpleGit(remote).show([`${branch}:docs/guides/api.md`])).toBe('api\n');
  });

  it('publishes a single file as docs/<name>', async () => {
    await setup();
    const { push } = await import('../push.js');
    const file = path.join(sourceRoot, 'handbook.md');
    fs.writeFileSync(file, 'handbook\n');

    await push({ docs: file });

    const branch = await onlyBranch(remote);
    expect(await simpleGit(remote).show([`${branch}:docs/handbook.md`])).toBe('handbook\n');
  });

  it('puts a file under --namespace when one is given', async () => {
    await setup();
    const { push } = await import('../push.js');
    const file = path.join(sourceRoot, 'handbook.md');
    fs.writeFileSync(file, 'handbook\n');

    await push({ docs: file, namespace: 'guides' });

    const branch = await onlyBranch(remote);
    expect(await simpleGit(remote).show([`${branch}:docs/guides/handbook.md`])).toBe('handbook\n');
  });

  it('replaces the destination subtree, dropping files the source no longer has', async () => {
    await setup({ 'docs/tutk/api.md': 'old\n', 'docs/tutk/gone.md': 'gone\n' });
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'new\n' });

    await push({ docs: source });

    const branch = await onlyBranch(remote);
    expect(await simpleGit(remote).show([`${branch}:docs/tutk/api.md`])).toBe('new\n');
    const files = await simpleGit(remote).raw(['ls-tree', '-r', '--name-only', branch]);
    expect(files).not.toContain('docs/tutk/gone.md');
  });

  it('ignores a manifest docs namespace: the path decides, not the roles', async () => {
    // The team declares a `guides` docs namespace, but a path push names its own
    // directory, so nothing is read from the manifest and nothing is withheld.
    await setup({ 'manifest/roles.yaml': ROLES_YAML }, { primaryRole: 'dev' });
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    await push({ docs: source });

    const branch = await onlyBranch(remote);
    expect(await simpleGit(remote).show([`${branch}:docs/tutk/api.md`])).toBe('api\n');
  });

  it('rejects --docs with --all, a missing path, and a blank path', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    await push({ docs: source, all: true });
    expect(process.exitCode).toBe(2);
    expect(errorOutput()).toContain('--skill or --all');

    process.exitCode = previousExitCode;
    await push({ docs: path.join(sourceRoot, 'nope') });
    expect(process.exitCode).toBe(2);
    expect(errorOutput()).toContain('No such file or directory');

    process.exitCode = previousExitCode;
    await push({ docs: '   ' });
    expect(process.exitCode).toBe(2);
    expect(errorOutput()).toContain('--docs <dir-or-file>');
  });

  it('rejects the reserved team-codebase namespace, but not a directory of that name', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    await push({ docs: source, namespace: 'team-codebase' });
    expect(process.exitCode).toBe(2);
    expect(errorOutput()).toContain('reserved');
    expect(await pushBranches(remote)).toEqual([]);

    // The reservation is on the named namespace, not on the source's own name.
    process.exitCode = previousExitCode;
    const reservedName = makeSource(sourceRoot, 'team-codebase', { 'a.md': 'a\n' });
    await push({ docs: reservedName });
    expect(process.exitCode).toBe(previousExitCode);
    const branch = await onlyBranch(remote);
    expect(await simpleGit(remote).show([`${branch}:docs/team-codebase/a.md`])).toBe('a\n');
  });

  it('rejects a source whose last segment is not a safe path component', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'ok', { 'a.md': 'a\n' });
    const unsafe = path.join(sourceRoot, 'weird name');

    fs.renameSync(source, unsafe);
    await push({ docs: unsafe });

    expect(process.exitCode).toBe(2);
    expect(errorOutput()).toContain('Cannot publish');
    expect(await pushBranches(remote)).toEqual([]);
  });

  it('reports the destination on a dry run and pushes nothing', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    await push({ docs: source, dryRun: true });

    expect(process.exitCode).toBe(previousExitCode);
    const printed = vi.mocked(console.log).mock.calls.map((args) => args.join(' ')).join('\n');
    expect(printed).toContain('docs/tutk');
    expect(printed).not.toContain('docs/tutk/tutk');
    expect(await pushBranches(remote)).toEqual([]);
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it('refuses --docs in single-repo mode', async () => {
    await setup({}, { repo: { kind: 'self', localPath: teamRepo, businessRepoRoot: tmpDir } });
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    await push({ docs: source });

    expect(process.exitCode).toBe(2);
    expect(errorOutput()).toContain('.teamai/docs/');
  });

  it('updates the open PR instead of opening a duplicate', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    // Explicit branch: the generated name carries a second-resolution
    // timestamp, so two pushes in one test can collide on it.
    await push({ docs: source, branch: 'teamai/push/test/reuse' });
    const first = await onlyBranch(remote);

    fs.writeFileSync(path.join(source, 'api.md'), 'api v2\n');
    await push({ docs: source, branch: 'teamai/push/test/reuse' });

    expect(await pushBranches(remote)).toEqual([first]);
    expect(await simpleGit(remote).show([`${first}:docs/tutk/api.md`])).toBe('api v2\n');
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
  });

  it('opens a separate PR when the same name is pushed to another namespace', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    // Explicit branches: the generated name carries a second-resolution
    // timestamp, so two pushes in one test can collide on it.
    await push({ docs: source, namespace: 'guides', branch: 'teamai/push/test/a' });
    await push({ docs: source, namespace: 'handbook', branch: 'teamai/push/test/b' });

    expect((await pushBranches(remote)).sort()).toEqual(['teamai/push/test/a', 'teamai/push/test/b']);
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(2);
  });

  it('rejects a namespace that is not a single safe path segment', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    await push({ docs: source, namespace: '../escape' });

    expect(process.exitCode).toBe(2);
    expect(errorOutput()).toContain('Invalid --namespace value');
    expect(await pushBranches(remote)).toEqual([]);
  });

  it('leaves other resources\u2019 open-PR records alone', async () => {
    await setup();
    storedState.pendingPushes = [{
      branch: 'teamai/push/alice/20260101-000000',
      prUrl: 'https://example.test/pr/skill',
      createdAt: '2026-01-01T00:00:00.000Z',
      items: [{ type: 'skills', name: 'my-skill', relativePath: 'skills/guides/my-skill' }],
    }];
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    await push({ docs: source });

    const pending = (storedState.pendingPushes as Array<{ branch: string }>).map((e) => e.branch);
    expect(pending).toContain('teamai/push/alice/20260101-000000');
  });

  it('drops a docs record whose branch is gone, so the next push opens a fresh PR', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    // Explicit branch names: the generated one carries a second-resolution
    // timestamp, so two pushes in one test can collide on it.
    await push({ docs: source, branch: 'teamai/push/test/first' });
    const first = await onlyBranch(remote);
    // The PR merged and its branch was deleted; the docs record must not block a
    // fresh push. Deleting the ref directly keeps the bare remote's own config
    // out of it.
    await simpleGit(remote).raw(['update-ref', '-d', `refs/heads/${first}`]);

    fs.writeFileSync(path.join(source, 'api.md'), 'api v2\n');
    await push({ docs: source, branch: 'teamai/push/test/second' });

    const branches = await pushBranches(remote);
    expect(branches).toEqual(['teamai/push/test/second']);
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(2);
  });

  it('survives a later plain push without losing its open-PR record', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    await push({ docs: source });
    const branch = await onlyBranch(remote);
    const before = (storedState.pendingPushes as Array<{ branch: string }>).length;
    expect(before).toBe(1);

    // A plain push scans no docs at all. Its prune must not read that as "the
    // docs resource is gone" and drop the record, or the next `--docs` push
    // would open a duplicate PR for the same branch.
    await push({ all: true });

    const pending = (storedState.pendingPushes as Array<{ branch: string }>).map((e) => e.branch);
    expect(pending).toContain(branch);
  });

  it('drops a docs record whose branch is gone, so the next push opens a fresh PR', async () => {
    await setup();
    const { push } = await import('../push.js');
    const source = makeSource(sourceRoot, 'tutk', { 'api.md': 'api\n' });

    // Explicit branch names: the generated one carries a second-resolution
    // timestamp, so two pushes in one test can collide on it.
    await push({ docs: source, branch: 'teamai/push/test/first' });
    const first = await onlyBranch(remote);
    // The PR merged and its branch was deleted; the docs record must not block a
    // fresh push. Deleting the ref directly keeps the bare remote's own config
    // out of it.
    await simpleGit(remote).raw(['update-ref', '-d', `refs/heads/${first}`]);

    fs.writeFileSync(path.join(source, 'api.md'), 'api v2\n');
    await push({ docs: source, branch: 'teamai/push/test/second' });

    const branches = await pushBranches(remote);
    expect(branches).toEqual(['teamai/push/test/second']);
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(2);
  });
});
