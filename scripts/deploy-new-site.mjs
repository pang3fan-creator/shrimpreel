#!/usr/bin/env node
// 一条命令：把模板派生成一个新站，建好 Cloudflare 资源，填好变量和密钥，跑完测试再部署。
//
//   node scripts/deploy-new-site.mjs --keyword "Moon Hop" --domain moonhop.ai
//   node scripts/deploy-new-site.mjs --keyword "Moon Hop" --domain moonhop.ai --dry-run
//
// 只做机械的部分。文案、素材、支付商品、Google OAuth 回调这些必须人工，脚本跑完会把清单再打印一遍。
//
// 环境变量（不设就跳过对应步骤）：
//   CLOUDFLARE_API_TOKEN  必填，wrangler 用它
//   ADMIN_EMAIL           必填，前台管理员邮箱
//   GOOGLE_CLIENT_ID      必填，登录用
//   PAYMENT_PROVIDER      默认 dodo
//   VIDEO_PROVIDER        默认 kie
//   MODERATION_PROVIDER   默认 openai
//   其余 secret（设了才 push）：SESSION_SECRET、GOOGLE_CLIENT_SECRET、KIE_API_KEY、FAL_KEY、YIR_API_KEY、
//   OPENAI_API_KEY、TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY、DODO_API_KEY、DODO_WEBHOOK_SECRET、
//   DODO_PRODUCTS、WAFFO_MERCHANT_ID、WAFFO_PRIVATE_KEY、WAFFO_PRODUCTS、WAFFO_STORE_ID
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = resolve(HERE, '..')

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const dryRun = args.includes('--dry-run')
const skipTests = args.includes('--skip-tests')
const noDeploy = args.includes('--no-deploy')
const keyword = arg('keyword')
const domain = arg('domain')?.trim().replace(/^https?:\/\//, '').replace(/\/.*/g, '').toLowerCase()
const slug = arg('slug', (keyword ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
const target = resolve(arg('out', join(SOURCE, '..', slug)))
const name = slug
const adminEmail = process.env.ADMIN_EMAIL
const googleId = process.env.GOOGLE_CLIENT_ID
const payment = process.env.PAYMENT_PROVIDER ?? 'dodo'
const video = process.env.VIDEO_PROVIDER ?? 'kie'
const moderation = process.env.MODERATION_PROVIDER ?? 'openai'

const log = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`)
const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1) }
const sh = (cmd, cwd = target, quiet = false) => {
  if (dryRun) { console.log(`  · ${cmd}`); return '' }
  if (!quiet) console.log(`  $ ${cmd}`)
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' })
}
const shOut = (cmd, cwd = target) => execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' })
const pick = (text, pattern, label) => {
  const found = text.match(pattern)?.[1]
  if (!found) die(`${label} 解析失败，wrangler 输出变了？\n${text.slice(-400)}`)
  return found
}

// ---------- 前置检查 ----------
if (!keyword || !domain) die('用法：node scripts/deploy-new-site.mjs --keyword "Moon Hop" --domain moonhop.ai')
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) die(`域名不像正式域名：${domain}`)
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) die(`slug 只能用字母数字和短横线（中文词请加 --slug）：${slug}`)
if (!process.env.CLOUDFLARE_API_TOKEN) die('没有 CLOUDFLARE_API_TOKEN')
if (!dryRun && existsSync(target)) die(`目标目录已存在：${target}`)

log(`新站 ${keyword} → https://${domain}`)
console.log(`  项目名   ${name}`)
console.log(`  目标目录 ${target}`)
console.log(`  资源     D1 ${name} · KV ${name}-kv · R2 ${name}-media · Queue ${name}-jobs / ${name}-jobs-dlq`)
console.log(`  支付 ${payment} · 视频 ${video} · 审核 ${moderation}`)
if (!adminEmail) console.log('  ! ADMIN_EMAIL 没设，脚本不会改 ADMIN_EMAILS')
if (!googleId) console.log('  ! GOOGLE_CLIENT_ID 没设，上线后没人能登录')
if (dryRun) console.log('\n（--dry-run：只打印，不执行）')

// ---------- 1. 复制模板 ----------
log('1/8 复制模板')
if (!dryRun) {
  sh(`mkdir -p "${target}"`, SOURCE, true)
  // 只取 git 跟踪的文件，不带 .git / node_modules / .dev.vars
  sh(`git -C "${SOURCE}" archive HEAD | tar -x -C "${target}"`, target, true)
  sh('npm ci --no-audit --no-fund', target, false)
}

// ---------- 2. 派生站点配置 ----------
log('2/8 改 site.ts / wrangler.jsonc / package.json')
const newSiteArgs = `node scripts/new-site.mjs --keyword "${keyword}" --domain ${domain} --slug ${slug} --write`
sh(newSiteArgs)

// ---------- 3. 建 Cloudflare 资源 ----------
log('3/8 建 Cloudflare 资源')
let dbId = '00000000-0000-0000-0000-000000000000'
let kvId = '00000000000000000000000000000000'
if (!dryRun) {
  const d1out = shOut(`npx wrangler d1 create ${name}`)
  dbId = pick(d1out, /"database_id":\s*"([0-9a-f-]{36})"/, 'D1 database_id')
  const kvout = shOut(`npx wrangler kv namespace create ${name}-kv`)
  kvId = pick(kvout, /"id":\s*"([0-9a-f]{32})"/, 'KV namespace id')
  sh(`npx wrangler r2 bucket create ${name}-media`)
  sh(`npx wrangler queues create ${name}-jobs-dlq`)
  sh(`npx wrangler queues create ${name}-jobs`)
  sh(`npx wrangler r2 bucket lifecycle add ${name}-media expire-uploads uploads/ --expire-days 8`)
  sh(`npx wrangler r2 bucket lifecycle add ${name}-media expire-outputs outputs/ --expire-days 31`)
  console.log(`  D1 ${dbId}\n  KV ${kvId}`)
}

// ---------- 4. 写回配置 ----------
log('4/8 填配置')
if (!dryRun) {
  const file = join(target, 'wrangler.jsonc')
  let src = readFileSync(file, 'utf8')
  const setVar = (key, value) => {
    const pattern = new RegExp(`("${key}":\\s*)"(?:[^"\\\\]|\\\\.)*"`)
    if (!pattern.test(src)) return console.log(`  ! wrangler.jsonc 里没有 ${key}，跳过`)
    src = src.replace(pattern, `$1${JSON.stringify(value)}`)
  }
  src = src.replace(/("database_id":\s*)"[^"]*"/, `$1"${dbId}"`)
  src = src.replace(/("binding": "KV", "id":\s*)"[^"]*"/, `$1"${kvId}"`)
  writeFileSync(file, src)

  setVar('APP_ENV', 'production')
  setVar('SITE_URL', `https://${domain}`)
  setVar('PAYMENT_PROVIDER', payment)
  setVar('VIDEO_PROVIDER', video)
  setVar('MODERATION_PROVIDER', moderation)
  if (adminEmail) setVar('ADMIN_EMAILS', adminEmail)
  if (googleId) setVar('GOOGLE_CLIENT_ID', googleId)
  if (process.env.TURNSTILE_SITE_KEY) setVar('TURNSTILE_SITE_KEY', process.env.TURNSTILE_SITE_KEY)
  if (process.env.DODO_PRODUCTS) setVar('DODO_PRODUCTS', process.env.DODO_PRODUCTS)
  if (process.env.WAFFO_PRODUCTS) setVar('WAFFO_PRODUCTS', process.env.WAFFO_PRODUCTS)
  if (process.env.WAFFO_STORE_ID) setVar('WAFFO_STORE_ID', process.env.WAFFO_STORE_ID)
  if (process.env.WAFFO_ENVIRONMENT) setVar('WAFFO_ENVIRONMENT', process.env.WAFFO_ENVIRONMENT)
  if (process.env.DODO_ENVIRONMENT) setVar('DODO_ENVIRONMENT', process.env.DODO_ENVIRONMENT)
  writeFileSync(file, src)
}

// ---------- 5. 数据库迁移 ----------
log('5/8 建表')
sh('npx wrangler d1 migrations apply DB --remote')

// ---------- 6. 上传模板源视频 ----------
log('6/8 上传源视频到 R2')
const seedDir = join(target, 'seed/templates')
if (!dryRun) {
  const files = shOut(`ls ${JSON.stringify(seedDir)}`).split('\n').filter((f) => f.endsWith('.mp4'))
  for (const f of files) {
    sh(`npx wrangler r2 object put ${name}-media/templates/${f} --file=${JSON.stringify(join(seedDir, f))} --content-type=video/mp4 --remote`)
  }
} else {
  console.log('  · 逐个上传 seed/templates/*.mp4 → templates/<文件名>')
}

// ---------- 7. 推密钥 ----------
log('7/8 推密钥')
const SECRETS = ['SESSION_SECRET', 'GOOGLE_CLIENT_SECRET', 'KIE_API_KEY', 'FAL_KEY', 'YIR_API_KEY', 'OPENAI_API_KEY',
  'TURNSTILE_SECRET_KEY', 'DODO_API_KEY', 'DODO_WEBHOOK_SECRET', 'WAFFO_MERCHANT_ID', 'WAFFO_PRIVATE_KEY']
const pushed = SECRETS.filter((k) => process.env[k])
for (const key of pushed) {
  if (dryRun) { console.log(`  · secret put ${key}`); continue }
  // 用 stdin 传值，避免出现在进程列表里
  execSync(`npx wrangler secret put ${key}`, { cwd: target, input: process.env[key], stdio: ['pipe', 'inherit', 'inherit'] })
}
if (!pushed.length) console.log('  ! 一个密钥都没设，线上会起不来（至少 SESSION_SECRET 和视频服务商的 key）')
if (!process.env.SESSION_SECRET) console.log('  ! SESSION_SECRET 没设，可以直接用：openssl rand -hex 32')

// ---------- 8. 体检、测试、部署 ----------
log('8/8 体检 → 测试 → 部署')
if (noDeploy) { console.log('  （--no-deploy：只准备，不部署）'); process.exit(0) }
sh('npm run doctor')
if (!skipTests) {
  sh('npm run typecheck')
  sh('npm test')
  sh('npm run seo:check')
}
sh('npm run deploy')

if (!dryRun) {
  log('线上巡检')
  try {
    const health = shOut(`curl -fsS --max-time 20 https://${domain}/api/health`)
    console.log(`  /api/health → ${health.trim().slice(0, 120)}`)
    const title = shOut(`curl -fsS --max-time 20 https://${domain}/ | grep -o '<title>[^<]*' | head -1`)
    console.log(`  ${title.trim()}`)
  } catch {
    console.log('  ! 域名还没解析到 Cloudflare，或 DNS 还在生效。稍后重试：')
    console.log(`    curl -fsS https://${domain}/api/health`)
  }
}

log('脚本跑完了。剩下这些必须人工：')
console.log(`  1. 文案：src/content/en.ts / zh.ts 的 hero、whatIs、ideas、faq、guides、articles.*（只换关键词会被判定为模板站）
  2. 素材：public/demo/*、public/og.png(1200×630)、public/favicon.svg；源视频记得放进 R2 的 templates/
  3. Google OAuth：回调地址加上 https://${domain}/api/auth/google/callback（本地开发也要 http://localhost:3000/api/auth/google/callback）
  4. 支付商品：node scripts/${payment === 'waffo' ? 'waffo' : 'dodo'}-setup.mjs，把商品 ID 写进 ${payment.toUpperCase()}_PRODUCTS 再跑一次本脚本的 --skip-tests 部分或手动 deploy
  5. webhook：https://${domain}/api/webhooks/${payment}
  6. 域名：DNS 托管到 Cloudflare，加一条指向 Worker 的路由（或自定义域）
  7. 邮件：Dashboard → Compute > Email Service → Onboard Domain 添加 ${domain}
  8. 上线后：npm run seo:check -- --base https://${domain} --production，然后提交 sitemap 给 Search Console / Bing
  9. 真钱跑一遍：付款 → 加积分 → 上传 → 生成 → 取片`)
