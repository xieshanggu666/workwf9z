// 回归测试：多农场同一游戏日结算灌溉时，日报必须按 (farm_id,abs_day) 隔离，
// 不能因全局 abs_day 唯一约束互相覆盖；同时验证启动迁移能修复旧库的错误约束。
// 用临时工作目录复制 server 模块，db.js 会在该目录创建独立 farm.db
import { mkdirSync, cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = path.dirname(fileURLToPath(import.meta.url))
const tmp = path.join(root, '.tmp-irrig-report-test')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
for (const f of ['db.js', 'irrigation.js', 'irrigation-core.js', 'breeding.js']) {
  cpSync(path.join(root, f), path.join(tmp, f))
}

let failures = 0
const assert = (cond, msg) => {
  if (cond) { console.log('✅', msg) }
  else { failures++; console.error('❌', msg) }
}

const { db } = await import(pathToFileURL(path.join(tmp, 'db.js')).href)
const I = await import(pathToFileURL(path.join(tmp, 'irrigation.js')).href)

const run = (sql, ...p) => db.prepare(sql).run(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)

// ===== 准备两座农场（7、8），各有一个蓄水池 + 一块相邻、带作物的缺水地块 =====
const now = Date.now()
for (const fid of [7, 8]) {
  run('INSERT INTO farms (id,name,owner_id,version,created_at) VALUES (?,?,?,0,?)', fid, `农场${fid}`, 1, now)
  run('INSERT INTO player (farm_id,name,gold,season,day,abs_day) VALUES (?,?,999,0,1,1)', fid, `p${fid}`)
  run('INSERT INTO crops (farm_id,id,name,days,season,price,seedPrice,sprite) VALUES (?,1,\'小麦\',5,0,12,3,\'🌾\')', fid)
  // 地块 (1,0) 与蓄水池 (1,1) 相邻即接通
  run('INSERT INTO plots (farm_id,x,y,crop_id,stage,water,irr_target,irr_priority) VALUES (?,1,0,1,0,20,100,1)', fid)
  run("INSERT INTO irrigation (farm_id,kind,x,y,active,water) VALUES (?,'reservoir',1,1,1,50)", fid)
}

// ===== 1) 两座农场在同一游戏日 abs_day=5 先后结算（旧 bug 会让后写覆盖前写并改挂 farm_id）=====
I.settleIrrigation({ type: 'sunny' }, 5, 7)
I.settleIrrigation({ type: 'sunny' }, 5, 8)

const rows = db.prepare('SELECT farm_id, abs_day FROM irrigation_report ORDER BY farm_id').all()
assert(rows.length === 2, '同一 abs_day 两个农场各保留一条日报（实际行数=' + rows.length + '）')
assert(rows.some((r) => r.farm_id === 7 && r.abs_day === 5), '农场 7 的日报仍存在')
assert(rows.some((r) => r.farm_id === 8 && r.abs_day === 5), '农场 8 的日报仍存在')

// lastReport 按 farm_id 读取：两农场都必须读到自己当天的分水结果，而不是 null
const rep7 = I.lastReport(7)
const rep8 = I.lastReport(8)
assert(!!rep7 && rep7.absDay === 5, '农场 7 能读到自己当天的分水报告')
assert(!!rep8 && rep8.absDay === 5, '农场 8 能读到自己当天的分水报告')

// 报告内容确实是各农场自己的调度结果（各浇 1 块地）
assert(rep7?.totals?.fed === 1 && rep8?.totals?.fed === 1, '两份日报分别记录各农场浇地数量（不串台）')

// ===== 2) 同农场同日重算：幂等覆盖，仍只有一行；次日结算保留两行 =====
I.settleIrrigation({ type: 'sunny' }, 5, 7)
assert(q1('SELECT COUNT(*) c FROM irrigation_report WHERE farm_id=7 AND abs_day=5').c === 1,
  '同农场同日重复结算保持幂等（仅一行）')
I.settleIrrigation({ type: 'sunny' }, 6, 7)
assert(q1('SELECT COUNT(*) c FROM irrigation_report WHERE farm_id=7').c === 2,
  '同农场次日结算追加新日报')
assert(q1('SELECT COUNT(*) c FROM irrigation_report WHERE farm_id=8').c === 1,
  '农场 7 的结算不影响农场 8 的日报')

db.close()

// ===== 3) 旧库迁移：预置带「列级 UNIQUE(abs_day)」缺陷的表，重启 db.js 应自动重建为复合约束 =====
const dbPath = path.join(tmp, 'farm.db')
rmSync(dbPath, { force: true })
const pre = new DatabaseSync(dbPath)
// db.js 启动迁移会访问 farms/schema_meta 等表，需按已迁移旧库的最小形态预置
pre.exec('CREATE TABLE farms (id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER, version INTEGER DEFAULT 0, created_at INTEGER)')
pre.prepare("INSERT INTO farms (id,name,owner_id,created_at) VALUES (1,'我的农场',NULL,?)").run(now)
pre.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
pre.exec("INSERT INTO schema_meta (key,value) VALUES ('coop_v1','1')")
pre.exec(`
  CREATE TABLE irrigation_report (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL,
    abs_day INTEGER NOT NULL UNIQUE,
    detail TEXT NOT NULL,
    UNIQUE(farm_id, abs_day)
  )`)
// 旧缺陷下同日只能存在一行（模拟先结算农场的残留数据）
pre.prepare('INSERT INTO irrigation_report (farm_id,abs_day,detail) VALUES (?,?,?)').run(1, 9, '{"absDay":9}')
pre.close()

// 带查询串重新加载模块，确保拿到新的 DatabaseSync 连接
const migrateURL = pathToFileURL(path.join(tmp, 'db.js')).href + '?migrate=1'
const { db: db2 } = await import(migrateURL)

// 列级 UNIQUE 已消除：两个农场可在同一 abs_day 各写一行，INSERT OR REPLACE 不互相覆盖
db2.prepare('INSERT INTO irrigation_report (farm_id,abs_day,detail) VALUES (?,?,?)').run(1, 11, '{"absDay":11}')
db2.prepare('INSERT INTO irrigation_report (farm_id,abs_day,detail) VALUES (?,?,?)').run(2, 11, '{"absDay":11}')
assert(db2.prepare('SELECT COUNT(*) c FROM irrigation_report WHERE abs_day=11').get().c === 2,
  '迁移后同一游戏日允许两个农场各持一条日报')
assert(!!db2.prepare('SELECT 1 FROM irrigation_report WHERE farm_id=1 AND abs_day=9').get(),
  '迁移保留旧报告数据')
const ddl = db2.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='irrigation_report'").get().sql
assert(!/abs_day\s+INTEGER[^,)]*UNIQUE/i.test(ddl), '迁移后 DDL 不再含列级 UNIQUE(abs_day)')
assert(/UNIQUE\s*\(\s*farm_id\s*,\s*abs_day\s*\)/i.test(ddl), '迁移后仍保留复合 UNIQUE(farm_id,abs_day)')
db2.close()

rmSync(tmp, { recursive: true, force: true })

console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
