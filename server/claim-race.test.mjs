// 回归测试：并发认领旧单人农场（farm 1）时，原子 UPDATE 未命中的一方
// 必须拿到「认领失败」（false），否则 /me 与 /coop/claim 会替失败者也广播
// 「认领成功」，导致其他客户端按错误归属刷新权限。
// 用临时目录复制 server 模块，db.js 会在该目录创建独立 farm.db。
import { mkdirSync, cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const tmp = path.join(root, '.tmp-claim-race-test')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
for (const f of ['db.js', 'auth.js']) cpSync(path.join(root, f), path.join(tmp, f))

const { db } = await import(pathToFileURL(path.join(tmp, 'db.js')).href)
const { claimIfNeeded } = await import(pathToFileURL(path.join(tmp, 'auth.js')).href)

let failures = 0
const assert = (cond, msg) => {
  if (!cond) { failures++; console.error('❌', msg) }
  else console.log('✅', msg)
}
const run = (sql, ...p) => db.prepare(sql).run(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)

const now = Date.now()
run('INSERT INTO users (id,name,created_at) VALUES (?,?,?)', 101, '认领者甲', now)
run('INSERT INTO users (id,name,created_at) VALUES (?,?,?)', 102, '认领者乙', now)

// ===== 1) 正常认领：首个认领者成功并写入 owner 成员 =====
assert(q1('SELECT owner_id FROM farms WHERE id=1').owner_id === null, '旧单人存档初始为待认领')
assert(claimIfNeeded(1, 101) === true, '首个认领者认领成功')
assert(q1('SELECT owner_id FROM farms WHERE id=1').owner_id === 101, '农场归属首个认领者')
assert(q1('SELECT role FROM farm_members WHERE farm_id=1 AND user_id=101')?.role === 'owner', '首个认领者写入 owner 成员')

// ===== 2) 已被认领：预检直接拦下 =====
assert(claimIfNeeded(1, 102) === false, '农场已被认领时后续认领返回 false')

// ===== 3) 并发竞态：乙预检通过后、原子 UPDATE 执行前，被甲抢先认领 =====
run('UPDATE farms SET owner_id=NULL WHERE id=1')
run('DELETE FROM farm_members WHERE farm_id=1')

// 拦截 claimIfNeeded 的预检 SELECT：在其返回后、原子 UPDATE 前注入甲的认领，
// 模拟多进程/多实例共享同一 SQLite 时「预检通过 → 他人抢先 → 自己 UPDATE 命中 0 行」的交错
const realPrepare = db.prepare.bind(db)
let intercept = false
db.prepare = (sql, ...rest) => {
  const stmt = realPrepare(sql, ...rest)
  if (intercept && String(sql).includes('SELECT owner_id FROM farms')) {
    return {
      get: (...args) => {
        const row = stmt.get(...args)
        if (row && row.owner_id == null) {
          realPrepare('UPDATE farms SET owner_id=? WHERE id=? AND owner_id IS NULL').run(101, 1)
          realPrepare("INSERT OR IGNORE INTO farm_members (farm_id,user_id,role,status,joined_at) VALUES (?,?,'owner','active',?)")
            .run(1, 101, Date.now())
        }
        return row
      }
    }
  }
  return stmt
}

intercept = true
const loser = claimIfNeeded(1, 102) // 乙的 UPDATE 命中 0 行
intercept = false
assert(loser === false, '并发下原子 UPDATE 未命中者返回 false（修复前误返回 true）')
assert(q1('SELECT owner_id FROM farms WHERE id=1').owner_id === 101, '农场归属抢先认领的甲')
assert(!q1('SELECT * FROM farm_members WHERE farm_id=1 AND user_id=102'), '认领失败者未写入成员记录')

rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} 个断言失败` : '\n全部通过 🎉')
process.exit(failures ? 1 : 0)
