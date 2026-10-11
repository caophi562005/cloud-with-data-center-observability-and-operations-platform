import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Vitest discovers .test.mjs as part of the app suite; keep the same behavioral tests
// runnable with Node alone, before CodeBuild installs the app's dependencies.
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test')
const publisherUrl = new URL('../codebuild-web.mjs', import.meta.url)
const buildspecPath = fileURLToPath(new URL('../../buildspec.yml', import.meta.url))
const noCache = 'no-cache,no-store,must-revalidate'
const immutable = 'public,max-age=31536000,immutable'

async function publisher() {
  assert.ok(existsSync(publisherUrl), 'CodeBuild publisher must be implemented')
  return import(publisherUrl.href)
}

const fixtureRoot = fileURLToPath(new URL('../../../../.superpowers/private/production-domain/publisher-fixtures/', import.meta.url))
const sourceSha = '1111111111111111111111111111111111111111'

function fixtureTest(name, body, { omitPaths = [], emptyAssets = false, symlinkPath } = {}) {
  test(name, async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    const root = mkdtempSync(path.join(fixtureRoot, 'case-'))
    const dist = path.join(root, 'apps', 'web', 'dist')
    mkdirSync(path.dirname(dist), { recursive: true })
    const put = (relative, content = 'public content') => {
      const target = path.join(dist, relative)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content)
      return target
    }
    const omitted = [...omitPaths, ...(symlinkPath === undefined ? [] : [symlinkPath])]
    for (const [relative, content] of [
      ['index.html', '<!doctype html><div id="root"></div>'],
      ['assets/index-0123ABcd.js', 'console.log("public app")'],
      ['assets/index-5678EFgh.css', 'body { color: black }'],
      ['favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ]) {
      if (omitted.some((skip) => skip === '' || relative === skip || relative.startsWith(`${skip}/`))) continue
      if (emptyAssets && relative.startsWith('assets/')) continue
      put(relative, content)
    }
    if (emptyAssets) mkdirSync(path.join(dist, 'assets'), { recursive: true })
    if (symlinkPath !== undefined) {
      const directory = ['linked', 'assets', ''].includes(symlinkPath)
      const linkTarget = path.join(root, directory ? 'link-target' : 'link-target.js')
      if (directory) mkdirSync(linkTarget)
      else writeFileSync(linkTarget, 'public target content')
      const link = path.join(dist, symlinkPath)
      mkdirSync(path.dirname(link), { recursive: true })
      symlinkSync(linkTarget, link, directory ? 'junction' : 'file')
    }
    const env = {
      CODEBUILD_SRC_DIR: root,
      CODEBUILD_WEBHOOK_TRIGGER: 'branch/main',
      CODEBUILD_WEBHOOK_EVENT: 'PUSH',
      CODEBUILD_WEBHOOK_HEAD_REF: 'refs/heads/main',
      CODEBUILD_SOURCE_REPO_URL: 'https://github.com/caophi562005/cloud-with-data-center-observability-and-operations-platform.git',
      CODEBUILD_BUILD_ARN: 'arn:aws:codebuild:ap-southeast-1:491333778094:build/opsgrid-dev-web-main:12345678-1234-4123-8123-123456789abc',
      CODEBUILD_RESOLVED_SOURCE_VERSION: sourceSha,
      VITE_API_URL: 'https://api.opsgrid.hacmieu.com',
      CODEBUILD_BUILD_SUCCEEDING: '1',
      WEB_BUCKET: 'opsgrid-dev-web-491333778094',
      CLOUDFRONT_DISTRIBUTION_ID: 'E2VCLELC875H4L',
      AWS_DEFAULT_REGION: 'ap-southeast-1',
    }
    const calls = []
    const lookups = []
    const distribution = {
      Distribution: {
        Id: 'E2VCLELC875H4L',
        ARN: 'arn:aws:cloudfront::491333778094:distribution/E2VCLELC875H4L',
        Status: 'Deployed',
        DistributionConfig: {
          Enabled: true,
          DefaultCacheBehavior: { TargetOriginId: 'private-singapore-s3' },
          Origins: { Quantity: 1, Items: [{
            Id: 'private-singapore-s3',
            DomainName: 'opsgrid-dev-web-491333778094.s3.ap-southeast-1.amazonaws.com',
            OriginPath: '',
            S3OriginConfig: { OriginAccessIdentity: '' },
            OriginAccessControlId: 'EOAC1234567890',
          }] },
        },
      },
    }
    const getDistribution = (id) => { lookups.push(id); return distribution }
    const runAws = (args) => { calls.push(args) }
    const getMainHead = () => sourceSha
    // Retain checkout-local fixtures; no local files are deleted by these tests.
    await body({ root, dist, put, env, calls, lookups, distribution, runAws, getDistribution, getMainHead })
  })
}

fixtureTest('guard accepts the exact native main PUSH before a build status exists', async ({ env }) => {
  const { validateBuildEnvironment } = await publisher()
  delete env.CODEBUILD_BUILD_SUCCEEDING
  assert.equal(validateBuildEnvironment(env).bucket, 'opsgrid-dev-web-491333778094')
})

const rejectedTriggers = [undefined, '', 'branch/develop', 'push', 'pr/42', 'pr/0', 'pr/-1', 'pr/01', 'pr/1x', 'branch/main\n']
for (const trigger of rejectedTriggers) {
  fixtureTest(`publishing rejects malformed/manual/PR trigger ${JSON.stringify(trigger)}`, async ({ env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    env.CODEBUILD_WEBHOOK_TRIGGER = trigger
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), /main PUSH/)
    assert.deepEqual(calls, [])
  })
}

for (const headRef of [undefined, '', 'main', 'refs/heads/develop', 'refs/heads/main\n']) {
  fixtureTest(`publishing rejects head ref ${JSON.stringify(headRef)}`, async ({ env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    env.CODEBUILD_WEBHOOK_HEAD_REF = headRef
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), /main/)
    assert.deepEqual(calls, [])
  })
}

for (const [key, invalid] of [
  ['CODEBUILD_WEBHOOK_EVENT', undefined], ['CODEBUILD_WEBHOOK_EVENT', 'PULL_REQUEST_UPDATED'],
  ['CODEBUILD_SOURCE_REPO_URL', 'https://github.com/untrusted/repository.git'],
  ['CODEBUILD_BUILD_ARN', 'arn:aws:codebuild:ap-southeast-1:491333778094:build/other:12345678-1234-4123-8123-123456789abc'],
  ['CODEBUILD_RESOLVED_SOURCE_VERSION', undefined], ['CODEBUILD_RESOLVED_SOURCE_VERSION', 'refs/heads/main'],
  ['VITE_API_URL', undefined], ['VITE_API_URL', 'https://api.opsgrid.hacmieu.com/api/v1'],
]) {
  fixtureTest(`publishing rejects untrusted ${key}`, async ({ env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    env[key] = invalid
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), new RegExp(key))
    assert.deepEqual(calls, [])
  })
}

fixtureTest('stale source SHA skips all AWS operations', async ({ env, calls, runAws, getDistribution }) => {
  const { publishWeb } = await publisher()
  assert.deepEqual(publishWeb({ env, runAws, getDistribution, getMainHead: () => '2222222222222222222222222222222222222222' }),
    'skipped-stale')
  assert.deepEqual(calls, [])
})

fixtureTest('failed remote main lookup never uploads or invalidates', async ({ env, calls, runAws, getDistribution }) => {
  const { publishWeb } = await publisher()
  assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead() { throw new Error('Main lookup unavailable') } }), /Main lookup/)
  assert.deepEqual(calls, [])
})

for (const mainHead of [undefined, '', `${sourceSha}\n`, 'refs/heads/main']) {
  fixtureTest(`invalid remote main result ${JSON.stringify(mainHead)} fails closed`, async ({ env, calls, runAws, getDistribution }) => {
    const { publishWeb } = await publisher()
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead: () => mainHead }), /Main source lookup/)
    assert.deepEqual(calls, [])
  })
}

for (const status of [undefined, '', '0', 'true', '1\n']) {
  fixtureTest(`publishing rejects unsuccessful or missing build status ${JSON.stringify(status)}`, async ({ env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    env.CODEBUILD_BUILD_SUCCEEDING = status
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), /successful build/)
    assert.deepEqual(calls, [])
  })
}

for (const [key, invalid] of [
  ['WEB_BUCKET', 'opsgrid-prod-web-491333778094'],
  ['WEB_BUCKET', 's3://opsgrid-dev-web-491333778094'],
  ['CLOUDFRONT_DISTRIBUTION_ID', 'EOTHER'],
  ['AWS_DEFAULT_REGION', 'us-east-1'],
  ['CODEBUILD_SRC_DIR', 'relative/source'],
]) {
  fixtureTest(`publishing rejects unexpected ${key}`, async ({ env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    env[key] = invalid
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), new RegExp(key))
    assert.deepEqual(calls, [])
  })
}

for (const key of ['WEB_BUCKET', 'CLOUDFRONT_DISTRIBUTION_ID', 'AWS_DEFAULT_REGION', 'CODEBUILD_SRC_DIR']) {
  fixtureTest(`publishing requires ${key}`, async ({ env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    delete env[key]
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), new RegExp(key))
    assert.deepEqual(calls, [])
  })
}

fixtureTest('publishing uploads assets first, other public files next, index last, then invalidates', async ({ dist, put, env, calls, runAws, getDistribution, getMainHead }) => {
  const { publishWeb } = await publisher()
  put('help/index.html', '<!doctype html><p>help</p>')
  put('robots.txt', 'User-agent: *')
  publishWeb({ env, runAws, getDistribution, getMainHead })
  assert.deepEqual(calls, [
    ['s3', 'sync', path.join(dist, 'assets'), 's3://opsgrid-dev-web-491333778094/assets/',
      '--cache-control', immutable, '--no-follow-symlinks', '--only-show-errors', '--region', 'ap-southeast-1'],
    ['s3', 'cp', path.join(dist, 'favicon.svg'), 's3://opsgrid-dev-web-491333778094/favicon.svg',
      '--cache-control', noCache, '--only-show-errors', '--region', 'ap-southeast-1'],
    ['s3', 'cp', path.join(dist, 'help', 'index.html'), 's3://opsgrid-dev-web-491333778094/help/index.html',
      '--cache-control', noCache, '--only-show-errors', '--region', 'ap-southeast-1', '--content-type', 'text/html; charset=utf-8'],
    ['s3', 'cp', path.join(dist, 'robots.txt'), 's3://opsgrid-dev-web-491333778094/robots.txt',
      '--cache-control', noCache, '--only-show-errors', '--region', 'ap-southeast-1'],
    ['s3', 'cp', path.join(dist, 'index.html'), 's3://opsgrid-dev-web-491333778094/index.html',
      '--cache-control', noCache, '--only-show-errors', '--region', 'ap-southeast-1', '--content-type', 'text/html; charset=utf-8'],
    ['cloudfront', 'create-invalidation', '--distribution-id', 'E2VCLELC875H4L', '--paths', '/*', '--region', 'ap-southeast-1'],
  ])
  assert.ok(calls.every((args) => !args.includes('--delete') && !args.includes('--acl')))
})

for (const invalidPath of [
  '.env', '.env.production', '.git/config', 'assets/.private/file.js',
  'assets/index-0123ABcd.js.map', 'assets/source.ts', 'assets/unhashed.js',
  'credentials.json', 'private-key.pem', 'source/app.tsx', 'node_modules/package.json',
  'backup.zip', 'folder with spaces/file.txt',
]) {
  fixtureTest(`publishing rejects unsafe output ${invalidPath} before any upload`, async ({ put, env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    put(invalidPath)
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), /Unsafe|Unsupported|hashed/)
    assert.deepEqual(calls, [])
  })
}

for (const credential of [
  '-----BEGIN PRIVATE KEY-----\nsensitive\n-----END PRIVATE KEY-----',
  'const key = "AKIA0123456789ABCDEF";',
  '{"AWS_SECRET_ACCESS_KEY":"do-not-publish-this"}',
]) {
  fixtureTest('publishing rejects recognizable credentials inside otherwise public files', async ({ put, env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    put('assets/private-0123ABcd.js', credential)
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), /credential/)
    assert.deepEqual(calls, [])
  })
}

for (const badIndex of ['', ' \n\t']) {
  fixtureTest('publishing rejects an empty index before any upload', async ({ put, env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    put('index.html', badIndex)
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), /index.html/)
    assert.deepEqual(calls, [])
  })
}

for (const missing of ['', 'index.html', 'assets']) {
  fixtureTest(`publishing rejects missing ${missing || 'dist'}`, async ({ env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), /dist|index.html|assets/)
    assert.deepEqual(calls, [])
  }, { omitPaths: [missing] })
}

fixtureTest('publishing rejects an empty assets directory', async ({ env, calls, runAws, getDistribution, getMainHead }) => {
  const { publishWeb } = await publisher()
  assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), /assets/)
  assert.deepEqual(calls, [])
}, { emptyAssets: true })

for (const location of ['assets/linked-0123ABcd.js', 'linked', 'index.html', 'assets', '']) {
  fixtureTest(`publishing rejects symbolic links at ${location || 'dist'}`, async ({ env, calls, runAws, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), /symlink/)
    assert.deepEqual(calls, [])
  }, { symlinkPath: location })
}

for (const failureAt of [0, 1, 2, 3]) {
  fixtureTest(`AWS failure at operation ${failureAt + 1} stops all subsequent operations`, async ({ env, calls, getDistribution, getMainHead }) => {
    const { publishWeb } = await publisher()
    const runAws = (args) => {
      calls.push(args)
      if (calls.length === failureAt + 1) throw new Error('AWS boundary failure')
    }
    assert.throws(() => publishWeb({ env, runAws, getDistribution, getMainHead }), /AWS boundary failure/)
    assert.equal(calls.length, failureAt + 1)
    if (failureAt < 2) assert.ok(calls.every((args) => !args.includes('s3://opsgrid-dev-web-491333778094/index.html')))
    if (failureAt < 3) assert.ok(calls.every((args) => args[0] !== 'cloudfront'))
  })
}

fixtureTest('CLI rejects invalid input without echoing supplied credential values', async ({ env }) => {
  await publisher()
  const result = spawnSync(process.execPath, [fileURLToPath(publisherUrl), 'publish'], {
    env: { ...process.env, ...env, WEB_BUCKET: 'private-credential-value', AWS_SECRET_ACCESS_KEY: 'secret-not-for-logs' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /WEB_BUCKET/)
  assert.ok(!`${result.stdout}${result.stderr}`.includes('private-credential-value'))
  assert.ok(!`${result.stdout}${result.stderr}`.includes('secret-not-for-logs'))
})

// Parse only this buildspec's plain scalar command lists. Execute the resulting
// commands in bash rather than asserting that particular source lines exist.
function phaseCommands(source, phase) {
  const lines = source.split(/\r?\n/)
  const start = lines.indexOf(`  ${phase}:`)
  assert.notEqual(start, -1, `missing ${phase} phase`)
  const commands = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [a-z_]+:/.test(lines[i])) break
    const command = /^      - (.+)$/.exec(lines[i])
    if (command) commands.push(command[1])
  }
  assert.ok(commands.length > 0, `${phase} must run commands`)
  return commands
}

function bashPath() {
  if (process.platform !== 'win32') return 'bash'
  const gitBash = 'C:/Program Files/Git/bin/bash.exe'
  assert.ok(existsSync(gitBash), 'Git bash is required for buildspec behavior tests on Windows')
  return gitBash
}

for (const mode of ['success', 'invalid-trigger', 'build-failure']) {
  fixtureTest(`buildspec ${mode} enforces guards and command order`, async ({ root, env, dist, distribution }) => {
    await publisher()
    assert.ok(existsSync(buildspecPath), 'CodeBuild buildspec must be implemented')
    const buildspec = readFileSync(buildspecPath, 'utf8')
    const bin = path.join(root, 'bin')
    const log = path.join(root, 'operations.log')
    mkdirSync(bin)
    // Real publisher validation/filesystem logic, with only the AWS boundary replaced.
    const wrapper = path.join(root, 'node-wrapper.mjs')
    writeFileSync(wrapper, `
import { appendFileSync } from 'node:fs';
import { publishWeb, validateBuildEnvironment } from ${JSON.stringify(publisherUrl.href)};
const args = process.argv.slice(2);
if (args[0] === '--test') { appendFileSync(process.env.OPERATIONS_LOG, 'node-tests\\n'); }
else if (args[1] === 'guard') { validateBuildEnvironment(process.env); }
else if (args[0] === '--version') { console.log(process.version); }
else if (args[1] === 'publish') { publishWeb({ getMainHead() { return ${JSON.stringify(sourceSha)}; }, getDistribution() { appendFileSync(process.env.OPERATIONS_LOG, 'aws cloudfront get-distribution\\n'); return ${JSON.stringify(distribution)}; }, runAws(args) { appendFileSync(process.env.OPERATIONS_LOG, 'aws ' + args.join(' ') + '\\n'); } }); }
else { throw new Error('Unexpected node invocation'); }
`)
    writeFileSync(path.join(bin, 'node'), '#!/usr/bin/env bash\nexec "$REAL_NODE" "$NODE_WRAPPER" "$@"\n', { mode: 0o755 })
    for (const tool of ['npm', 'pnpm']) {
      writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\nprintf '${tool} %s\\n' "$*" >> "$OPERATIONS_LOG"\nif [[ '${tool}' == pnpm && "$*" == *lint && "$FAIL_BUILD" == 1 ]]; then exit 9; fi\n`, { mode: 0o755 })
    }
    const install = phaseCommands(buildspec, 'install').join('\n')
    const build = phaseCommands(buildspec, 'build').join('\n')
    const post = phaseCommands(buildspec, 'post_build').join('\n')
    const run = spawnSync(bashPath(), ['--noprofile', '--norc', '-c', `
export PATH="$FAKE_BIN:$PATH"
set -e
${install}
set +e
( set -e; ${build} )
status=$?
if [ "$status" -eq 0 ]; then export CODEBUILD_BUILD_SUCCEEDING=1; else export CODEBUILD_BUILD_SUCCEEDING=0; fi
( set -e; ${post} )
post_status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi
exit "$post_status"
`], {
      env: {
        ...process.env, ...env,
        CODEBUILD_SRC_DIR: root.replaceAll('\\', '/'),
        CODEBUILD_WEBHOOK_TRIGGER: mode === 'invalid-trigger' ? 'pr/42' : 'branch/main',
        FAIL_BUILD: mode === 'build-failure' ? '1' : '0',
        REAL_NODE: process.execPath.replaceAll('\\', '/'), NODE_WRAPPER: wrapper.replaceAll('\\', '/'),
        FAKE_BIN: bin.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`),
        OPERATIONS_LOG: log.replaceAll('\\', '/'),
      },
      encoding: 'utf8',
    })
    const operations = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    if (mode === 'invalid-trigger') {
      assert.notEqual(run.status, 0, run.stderr)
      assert.deepEqual(operations, [])
      assert.match(run.stderr, /main PUSH/)
    } else if (mode === 'build-failure') {
      assert.equal(run.status, 9, run.stderr)
      assert.deepEqual(operations, [
        'npm install --global pnpm@11.24.0', 'node-tests',
        'pnpm --dir apps/web install --frozen-lockfile', 'pnpm --dir apps/web lint',
      ])
      assert.match(run.stderr, /successful build/)
    } else {
      assert.equal(run.status, 0, run.stderr)
      assert.deepEqual(operations.slice(0, 6), [
        'npm install --global pnpm@11.24.0', 'node-tests',
        'pnpm --dir apps/web install --frozen-lockfile', 'pnpm --dir apps/web lint',
        'pnpm --dir apps/web test', 'pnpm --dir apps/web build',
      ])
      assert.equal(operations.length, 11)
      assert.equal(operations[6], 'aws cloudfront get-distribution')
      assert.match(operations[7], /^aws s3 sync /)
      assert.ok(operations[7].includes(dist.replaceAll('\\', path.sep)))
      assert.match(operations[9], /s3:\/\/opsgrid-dev-web-491333778094\/index.html/)
      assert.match(operations[10], /^aws cloudfront create-invalidation /)
    }
  })
}
