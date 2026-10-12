import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const target = Object.freeze({
  WEB_BUCKET: 'opsgrid-dev-web-491333778094',
  CLOUDFRONT_DISTRIBUTION_ID: 'E2VCLELC875H4L',
  AWS_DEFAULT_REGION: 'ap-southeast-1',
  VITE_API_URL: 'https://api.opsgrid.hacmieu.com',
  CODEBUILD_SOURCE_REPO_URL: 'https://github.com/caophi562005/cloud-with-data-center-observability-and-operations-platform.git',
})
const noCache = 'no-cache,no-store,must-revalidate'
const immutable = 'public,max-age=31536000,immutable'
const publicExtensions = new Set([
  '.html', '.js', '.css', '.json', '.webmanifest', '.txt', '.xml', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2',
  '.ttf', '.otf', '.wasm',
])

// Defense in depth, not an authorization boundary: reviewed main code can alter
// this script. Native webhook filters, repository governance and scoped IAM apply.
export function validateBuildEnvironment(env, { requireSuccess = false } = {}) {
  if (env.CODEBUILD_WEBHOOK_TRIGGER !== 'branch/main') {
    throw new Error('Only the exact native main PUSH trigger may build or publish')
  }
  if (env.CODEBUILD_WEBHOOK_EVENT !== 'PUSH') {
    throw new Error('CODEBUILD_WEBHOOK_EVENT must be the exact main PUSH event')
  }
  if (env.CODEBUILD_WEBHOOK_HEAD_REF !== 'refs/heads/main') {
    throw new Error('CODEBUILD_WEBHOOK_HEAD_REF must be refs/heads/main')
  }
  if (typeof env.CODEBUILD_BUILD_ARN !== 'string' ||
      !/^arn:aws:codebuild:ap-southeast-1:491333778094:build\/opsgrid-dev-web-main:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(env.CODEBUILD_BUILD_ARN)) {
    throw new Error('CODEBUILD_BUILD_ARN must identify the approved main build project')
  }
  if (typeof env.CODEBUILD_RESOLVED_SOURCE_VERSION !== 'string' || !/^[0-9a-f]{40}$/.test(env.CODEBUILD_RESOLVED_SOURCE_VERSION)) {
    throw new Error('CODEBUILD_RESOLVED_SOURCE_VERSION must be the resolved commit SHA')
  }
  for (const [key, expected] of Object.entries(target)) {
    if (env[key] !== expected) throw new Error(`${key} must match the approved dev web target`)
  }
  if (typeof env.CLOUDFRONT_DISTRIBUTION_ID !== 'string' ||
      !/^E[A-Z0-9]{7,31}$/.test(env.CLOUDFRONT_DISTRIBUTION_ID) ||
      env.CLOUDFRONT_DISTRIBUTION_ID !== env.CLOUDFRONT_DISTRIBUTION_ID.trim()) {
    throw new Error('CLOUDFRONT_DISTRIBUTION_ID must be a valid distribution ID')
  }
  if (typeof env.CODEBUILD_SRC_DIR !== 'string' || !path.isAbsolute(env.CODEBUILD_SRC_DIR) || env.CODEBUILD_SRC_DIR.includes('\0')) {
    throw new Error('CODEBUILD_SRC_DIR must be an absolute source directory')
  }
  if (requireSuccess && env.CODEBUILD_BUILD_SUCCEEDING !== '1') {
    throw new Error('Publication requires a successful build (CODEBUILD_BUILD_SUCCEEDING=1)')
  }
  const sourceDir = path.resolve(env.CODEBUILD_SRC_DIR)
  return {
    sourceDir,
    distDir: path.join(sourceDir, 'apps', 'web', 'dist'),
    bucket: env.WEB_BUCKET,
    distributionId: env.CLOUDFRONT_DISTRIBUTION_ID,
    region: env.AWS_DEFAULT_REGION,
    resolvedSourceVersion: env.CODEBUILD_RESOLVED_SOURCE_VERSION,
  }
}

function requireDirectory(directory, label) {
  let stat
  try { stat = lstatSync(directory) } catch { throw new Error(`Missing ${label} directory`) }
  if (stat.isSymbolicLink()) throw new Error(`Unsafe symlink at ${label}`)
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`)
}

export function inspectDist(distDir) {
  requireDirectory(distDir, 'dist')
  const files = []
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || /^(src|source|node_modules)$/i.test(name) ||
          /credentials?|secrets?|private[-_]?key|id_(rsa|dsa|ecdsa|ed25519)/i.test(name)) {
        throw new Error('Unsafe output path in dist')
      }
      const relative = prefix ? `${prefix}/${name}` : name
      const fullPath = path.join(directory, name)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) throw new Error('Unsafe symlink in dist')
      if (stat.isDirectory()) {
        visit(fullPath, relative)
        continue
      }
      if (!stat.isFile() || !publicExtensions.has(path.extname(name).toLowerCase())) {
        throw new Error('Unsupported static output file in dist')
      }
      if (relative.startsWith('assets/') && !/-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name)) {
        throw new Error('Immutable assets must have hashed filenames')
      }
      const content = readFileSync(fullPath, 'utf8')
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAWS_(?:SECRET_ACCESS_KEY|SESSION_TOKEN)\b["'\s]*[:=]/.test(content)) {
        throw new Error('Recognizable credential material is not public static output')
      }
      files.push(relative)
    }
  }
  // Validate every entry before the first AWS operation; never upload the source
  // directory, hidden files, source maps, unsupported files, or symlink targets.
  visit(distDir)
  const indexPath = path.join(distDir, 'index.html')
  if (!files.includes('index.html') || !readFileSync(indexPath, 'utf8').trim()) {
    throw new Error('dist/index.html must exist and be nonempty')
  }
  const assetsDir = path.join(distDir, 'assets')
  requireDirectory(assetsDir, 'dist/assets')
  if (!files.some((file) => file.startsWith('assets/'))) throw new Error('dist/assets must contain static assets')
  return {
    assetsDir,
    indexPath,
    publicFiles: files.filter((file) => file !== 'index.html' && !file.startsWith('assets/')).sort(),
  }
}

export function runAwsCommand(args) {
  // AWS resolves credentials from the service role. Never capture or print them,
  // concatenate a shell command, or dump the process environment.
  const result = spawnSync('aws', args, { stdio: 'inherit', shell: false })
  if (result.error || result.status !== 0) {
    throw new Error(`AWS ${args[0]} ${args[1]} failed`)
  }
}

export function getDistributionCommand(distributionId) {
  // Capture only nonsecret target metadata. Do not echo AWS responses or stderr.
  const query = '{Distribution: Distribution.{Id: Id, ARN: ARN, DistributionConfig: {DefaultCacheBehavior: {TargetOriginId: DistributionConfig.DefaultCacheBehavior.TargetOriginId}, Origins: {Items: DistributionConfig.Origins.Items[].{Id: Id, DomainName: DomainName, OriginPath: OriginPath, S3OriginConfig: S3OriginConfig, CustomOriginConfig: CustomOriginConfig}}}}}'
  const result = spawnSync('aws', ['cloudfront', 'get-distribution', '--id', distributionId,
    '--region', target.AWS_DEFAULT_REGION, '--query', query, '--output', 'json', '--no-cli-pager'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error('Distribution verification lookup failed')
  try { return JSON.parse(result.stdout) } catch { throw new Error('Distribution verification returned invalid JSON') }
}

export function validateDistributionTarget(distribution, config) {
  const expectedArn = `arn:aws:cloudfront::491333778094:distribution/${config.distributionId}`
  if (distribution?.Id !== config.distributionId || distribution?.ARN !== expectedArn) {
    throw new Error('Distribution ID and account ARN must match the approved target')
  }
  const origins = distribution.DistributionConfig?.Origins?.Items
  const targetOriginId = distribution.DistributionConfig?.DefaultCacheBehavior?.TargetOriginId
  if (!Array.isArray(origins) || !targetOriginId) throw new Error('Distribution must have a default origin')
  const matches = origins.filter((origin) => origin.Id === targetOriginId)
  const origin = matches[0]
  if (matches.length !== 1 || origin.DomainName !== `${config.bucket}.s3.${config.region}.amazonaws.com` ||
      !origin.S3OriginConfig || origin.CustomOriginConfig || (origin.OriginPath ?? '') !== '') {
    throw new Error('Distribution default origin must be the approved regional S3 bucket root')
  }
}

export function getMainHeadCommand() {
  const config = validateBuildEnvironment(process.env, { requireSuccess: true })
  const result = spawnSync('git', ['ls-remote', '--exit-code', '--refs', 'origin', 'refs/heads/main'],
    { cwd: config.sourceDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, maxBuffer: 64 * 1024, timeout: 30_000 })
  if (result.error || result.status !== 0) throw new Error('Main source lookup failed')
  const match = /^([0-9a-f]{40})\trefs\/heads\/main\r?\n?$/.exec(result.stdout)
  if (!match) throw new Error('Main source lookup returned an invalid commit')
  return match[1]
}

export function publishWeb({ env = process.env, runAws = runAwsCommand, getDistribution = getDistributionCommand, getMainHead = getMainHeadCommand } = {}) {
  const config = validateBuildEnvironment(env, { requireSuccess: true })
  // Reject symlinked fixed parent paths as well as entries within dist.
  requireDirectory(config.sourceDir, 'CODEBUILD_SRC_DIR')
  requireDirectory(path.join(config.sourceDir, 'apps'), 'apps')
  requireDirectory(path.join(config.sourceDir, 'apps', 'web'), 'apps/web')
  const { assetsDir, indexPath, publicFiles } = inspectDist(config.distDir)
  const mainSha = getMainHead()
  if (typeof mainSha !== 'string' || !/^[0-9a-f]{40}$/.test(mainSha)) throw new Error('Main source lookup returned an invalid commit')
  if (mainSha !== config.resolvedSourceVersion) {
    console.log(`Skipping stale main build ${config.resolvedSourceVersion}; no AWS publication operations issued`)
    return 'skipped-stale'
  }
  validateDistributionTarget(getDistribution(config.distributionId)?.Distribution, config)
  const destination = `s3://${config.bucket}/`
  const options = ['--only-show-errors', '--region', config.region]

  // No --delete: clients that already loaded old HTML still need old hashed
  // assets. Sync requires ListBucket, not GetObject or DeleteObject.
  runAws(['s3', 'sync', assetsDir, `${destination}assets/`, '--cache-control', immutable,
    '--no-follow-symlinks', ...options])
  function upload(relative, fullPath) {
    const args = ['s3', 'cp', fullPath, `${destination}${relative}`, '--cache-control', noCache, ...options]
    if (path.extname(relative).toLowerCase() === '.html') args.push('--content-type', 'text/html; charset=utf-8')
    runAws(args)
  }
  for (const relative of publicFiles) upload(relative, path.join(config.distDir, relative))
  // Publish the entry point only after all referenced files are available.
  upload('index.html', indexPath)
  runAws(['cloudfront', 'create-invalidation', '--distribution-id', config.distributionId,
    '--paths', '/*', '--region', config.region])
  console.log(`Published reviewed main source ${config.resolvedSourceVersion}`)
  return 'published'
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: codebuild-web.mjs guard|publish')
    if (process.argv[2] === 'guard') validateBuildEnvironment(process.env)
    else if (process.argv[2] === 'publish') publishWeb()
    else throw new Error('Usage: codebuild-web.mjs guard|publish')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
