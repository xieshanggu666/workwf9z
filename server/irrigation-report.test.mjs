// 回归测试：irrigation_report 的唯一约束必须是「农场内按绝对天唯一」。
// 历史 bug：新库建表语句误加 abs_day 全局 UNIQUE，多农场同一游戏日结算灌溉时，
// INSERT OR REPLACE 会因全局日期冲突吞掉其他农场的当日日报（读到过期分水结果）。
// 这里在临时目录中导入 db.js（farm.db 建于模块所在目录），分别验证：
//  1) 全新建库：两农场同一绝对天各自写日报互不覆盖，同农场同日重算幂等覆盖
//  2) 历史误建结构：启动时的修复迁移重建表、保留存量数据，之后多农场同日可共存
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, cpSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

// 在独立临时目录建库：可选预置历史 bug 版表结构，再导入 db.js 触发建表/迁移
async function loadDb(dir, { buggySchema = false } = {}) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  if (buggySchema) {
    const pre = new DatabaseSync(path.join(dir, 'farm.db'))
    pre.exec(`CREATE TABLE irrigation_report (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      farm_id INTEGER NOT NULL,
      abs_day INTEGER NOT NULL UNIQUE,
      detail TEXT NOT NULL,
      UNIQUE(farm_id, abs_day)
    )`)
    pre.exec(`INSERT INTO irrigation_report (farm_id,abs_day,detail) VALUES (1,5,'{"farm":1}')`)
    pre.close()
  }
  cpSync(path.join(root, 'db.js'), path.join(dir, 'db.js'))
  await import(pathToFileURL(path.join(dir, 'db.js')).href)
  return new DatabaseSync(path.join(dir, 'farm.db'))
}

// 与 settleIrrigation 相同的写入方式（server/irrigation.js）
const upsert = (db, farmId, absDay, detail) =>
  db.prepare('INSERT OR REPLACE INTO irrigation_report (farm_id,abs_day,detail) VALUES (?,?,?)')
    .run(farmId, absDay, detail)

const uniqueIndexes = (db) =>
  db.prepare('PRAGMA index_list(irrigation_report)').all()
    .filter((ix) => ix.unique)
    .map((ix) => db.prepare('PRAGMA index_info(' + ix.name + ')').all().map((c) => c.name))

test('irrigation_report：唯一约束为 (farm_id, abs_day)，不存在 abs_day 全局唯一', async (t) => {
  const dir = path.join(root, '.tmp-irr-report-schema')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = await loadDb(dir)
  t.after(() => db.close())

  const uniques = uniqueIndexes(db)
  assert.ok(
    uniques.some((cols) => cols.join(',') === 'farm_id,abs_day'),
    '存在 (farm_id, abs_day) 联合唯一索引'
  )
  assert.ok(
    !uniques.some((cols) => cols.length === 1 && cols[0] === 'abs_day'),
    '不存在 abs_day 单列全局唯一索引'
  )
})

test('irrigation_report：多农场同一游戏日结算互不覆盖，同农场同日重算幂等', async (t) => {
  const dir = path.join(root, '.tmp-irr-report-multi')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = await loadDb(dir)
  t.after(() => db.close())

  // 农场 1、2 在同一绝对天各自结算灌溉（各农场独立推进游戏日，同日结算是常态）
  upsert(db, 1, 10, '{"farm":1,"used":30}')
  upsert(db, 2, 10, '{"farm":2,"used":55}')
  // 农场 1 同日重算：只覆盖自己的当日报告
  upsert(db, 1, 10, '{"farm":1,"used":42}')

  const rows = db.prepare('SELECT farm_id, detail FROM irrigation_report WHERE abs_day=10 ORDER BY farm_id').all()
  assert.equal(rows.length, 2, '两农场当日日报共存')
  assert.equal(JSON.parse(rows[0].detail).used, 42, '农场 1 当日重算覆盖自己的报告')
  assert.equal(JSON.parse(rows[1].detail).used, 55, '农场 2 当日报告不受农场 1 重算影响')
})

test('irrigation_report：历史误建的全局日期唯一约束在启动时修复，存量数据保留', async (t) => {
  const dir = path.join(root, '.tmp-irr-report-repair')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = await loadDb(dir, { buggySchema: true })
  t.after(() => db.close())

  const uniques = uniqueIndexes(db)
  assert.ok(
    !uniques.some((cols) => cols.length === 1 && cols[0] === 'abs_day'),
    '修复后不存在 abs_day 单列全局唯一索引'
  )
  const kept = db.prepare('SELECT farm_id, abs_day, detail FROM irrigation_report').all()
  assert.equal(kept.length, 1, '存量日报保留')
  assert.deepEqual([kept[0].farm_id, kept[0].abs_day], [1, 5])

  // 修复后：农场 2 在同一绝对天可以写入自己的日报，不再吞掉农场 1 的行
  upsert(db, 2, 5, '{"farm":2}')
  const rows = db.prepare('SELECT farm_id FROM irrigation_report WHERE abs_day=5 ORDER BY farm_id').all()
  assert.deepEqual(rows.map((r) => r.farm_id), [1, 2], '修复后多农场同日日报共存')
})
