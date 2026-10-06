import { strict as assert } from 'node:assert';
import {
  beginRollout,
  createInMemorySnapshots,
  createStagedPlan,
  evaluateGate,
  currentPercent,
  performRollback,
  pumpRevocation,
  submitDecision,
  submitReading,
  type Revoker,
  type ScopeItem
} from '../src/services/rolloutEngine.ts';

const T0 = 1_800_000_000_000;
let passed = 0;
function test(name, fn) {
  return fn().then(() => { passed += 1; console.log('  ✓', name); });
}

function planWithStages() {
  return createStagedPlan([
    { percent: 5, observeMinutes: 30 },
    { percent: 20, observeMinutes: 60 },
    { percent: 50, observeMinutes: 120 },
    { percent: 100, observeMinutes: 240 }
  ]);
}

function minutes(plan, snapshots, n) {
  // 模拟观察期经过 n 分钟：推进虚拟 now
  return T0 + n * 60000;
}

await test('开始灰度锁定第 1 档比例，未观察满不能推进', async () => {
  const snaps = createInMemorySnapshots();
  const plan = planWithStages();
  beginRollout(plan, '上海', snaps, 'A', T0);
  assert.equal(currentPercent(plan), 5);
  assert.equal(plan.status, 'running');
  assert.equal(plan.revision, 1);
  // 10 分钟时上报，观察时长未满，门禁无动作
  submitReading(plan, 2.0, T0 + 10 * 60000);
  const r = evaluateGate(plan, '上海', snaps, T0 + 10 * 60000);
  assert.equal(r.audit.length, 0);
  assert.equal(plan.stages[0].status, 'observing');
});

await test('观察期错误率降下去 → 门禁通过 → 推进下一档', async () => {
  const snaps = createInMemorySnapshots();
  const plan = planWithStages();
  beginRollout(plan, '上海', snaps, 'A', T0);
  submitReading(plan, 2.0, T0);
  submitReading(plan, 1.2, T0 + 30 * 60000);
  const gate = evaluateGate(plan, '上海', snaps, T0 + 30 * 60000);
  assert.equal(gate.audit[0].action, '门禁通过');
  const adv = submitDecision({ plan, snapshots: snaps, region: '上海', now: T0 + 31 * 60000 }, plan.revision, 'advance', 'A');
  assert.equal(adv.applied, true);
  assert.equal(currentPercent(plan), 20);
  assert.equal(plan.currentStage, 1);
  assert.equal(plan.stages[1].status, 'observing');
});

await test('错误率没降下去：退回上一档冻结 + 收回 + 只记一条审计', async () => {
  const snaps = createInMemorySnapshots();
  const plan = planWithStages();
  beginRollout(plan, '上海', snaps, 'A', T0);
  // 进入第 2 档
  submitReading(plan, 2.0, T0);
  submitReading(plan, 1.0, T0 + 30 * 60000);
  evaluateGate(plan, '上海', snaps, T0 + 30 * 60000);
  submitDecision({ plan, snapshots: snaps, region: '上海', now: T0 + 31 * 60000 }, plan.revision, 'advance', 'A');
  assert.equal(currentPercent(plan), 20);
  const revAtStart = plan.revision;

  // 第 2 档观察 60 分钟后错误率未下降
  const t2 = T0 + 31 * 60000;
  submitReading(plan, 2.0, t2);
  submitReading(plan, 2.5, t2 + 60 * 60000);
  const gate = evaluateGate(plan, '上海', snaps, t2 + 60 * 60000);
  assert.equal(gate.audit.length, 1);
  assert.equal(gate.audit[0].action, '回退冻结');
  assert.ok(gate.audit[0].dedupKey, '回退审计必须带 dedupKey');
  assert.equal(plan.status, 'frozen');
  assert.equal(plan.frozenKind, 'rollback');
  assert.equal(currentPercent(plan), 5, '退回上一档比例');
  assert.equal(plan.revision, revAtStart + 1);
  assert.ok(plan.revokeTask, '已发起收回任务');
  const pending = snaps.all().filter((s) => s.status !== 'reclaimed');
  assert.equal(pending.length, 5, '按失败档范围收回，重算后只剩新档位命中的快照');
  assert.ok(pending.every((s) => s.bucket < 5), '未收完快照已按新档位范围重算');
});

await test('收回失败从断点重试，剩余记待收项；重试不新增回退审计', async () => {
  // 用 5%→20% 的计划：回退到 5% 时，失败档范围 20% 切成两片（桶0-9、桶10-19），
  // 重算后第二片超范围自动完成，第一片（桶0-4）保留为唯一待收断点片
  const snaps = createInMemorySnapshots();
  const plan = createStagedPlan([
    { percent: 5, observeMinutes: 30 },
    { percent: 20, observeMinutes: 60 }
  ]);
  beginRollout(plan, '上海', snaps, 'A', T0);
  submitReading(plan, 2, T0);
  submitReading(plan, 1, T0 + 30 * 60000);
  evaluateGate(plan, '上海', snaps, T0 + 30 * 60000);
  submitDecision({ plan, snapshots: snaps, region: '上海', now: T0 }, plan.revision, 'advance', 'A');
  submitReading(plan, 2, T0);
  submitReading(plan, 3, T0 + 60 * 60000);
  const rollback = evaluateGate(plan, '上海', snaps, T0 + 60 * 60000);
  const task = plan.revokeTask!;
  assert.equal(task.items.length, 2, '失败档 20% → 两片');
  assert.equal(task.items[0].status, 'pending', '桶0-9 重算后桶0-4 仍待收');
  assert.equal(task.items[1].status, 'done', '桶10-19 超出新范围，自动完成');

  let failOnce = true;
  const flaky: Revoker = {
    async reclaim(item: ScopeItem) {
      if (failOnce) { failOnce = false; throw new Error('收回超时'); }
    }
  };
  const r1 = await pumpRevocation(plan, snaps, flaky);
  assert.equal(r1.failed.length, 1, '第一片失败');
  assert.equal(task.checkpointItemId, r1.failed[0].itemId, '断点记录为失败片');
  assert.equal(task.items[0].attempts, 1);

  // 成功重试：从断点继续，不新增回退审计
  const auditBefore = rollback.audit.length;
  const ok: Revoker = { async reclaim() {} };
  const r2 = await pumpRevocation(plan, snaps, ok);
  assert.equal(r2.failed.length, 0);
  assert.equal(task.status, 'done');
  assert.equal(task.items[0].attempts, 2);
  assert.ok(snaps.all().filter((s) => s.status === 'reclaimed').length >= 5);
  assert.equal(auditBefore, 1, '回退始终只记一条');
});

await test('并发推进/停止：只落一个，后到者按新档位再判断', async () => {
  const snaps = createInMemorySnapshots();
  const plan = planWithStages();
  beginRollout(plan, '上海', snaps, 'A', T0);
  submitReading(plan, 2, T0);
  submitReading(plan, 1, T0 + 30 * 60000);
  evaluateGate(plan, '上海', snaps, T0 + 30 * 60000);
  const base = plan.revision; // 门禁不改 revision

  const ctx = { plan, snapshots: snaps, region: '上海', now: T0 + 31 * 60000 };
  const r1 = submitDecision(ctx, base, 'advance', '值班员A', (p) => p.status === 'running' && p.stages[p.currentStage].status === 'cleared' ? 'advance' : 'abort');
  const r2 = submitDecision(ctx, base, 'stop', '值班员B', (p) => p.status === 'running' ? 'stop' : 'abort');
  assert.equal(r1.applied, true, '先到的推进落地');
  assert.equal(r2.applied, true, '后到的停止按新档位（仍在灰度中）重新判断后落地，冻结在新档');
  assert.equal(currentPercent(plan), 20);
  assert.equal(plan.status, 'frozen');
  assert.equal(plan.frozenKind, 'stop');
  // 只有一个推进动作落地：revision 从 base 起只 +2（推进一次、停止一次）
  assert.equal(plan.revision, base + 2);

  // 反过来：先停止落地，后到的推进在新档位不适用
  const snaps2 = createInMemorySnapshots();
  const p2 = planWithStages();
  beginRollout(p2, '上海', snaps2, 'A', T0);
  submitReading(p2, 2, T0);
  submitReading(p2, 1, T0 + 30 * 60000);
  evaluateGate(p2, '上海', snaps2, T0 + 30 * 60000);
  const base2 = p2.revision;
  const ctx2 = { plan: p2, snapshots: snaps2, region: '上海', now: T0 + 31 * 60000 };
  const s1 = submitDecision(ctx2, base2, 'stop', 'A', (p) => (p.status === 'running' ? 'stop' : 'abort'));
  const s2 = submitDecision(ctx2, base2, 'advance', 'B', (p) => (p.status === 'running' && p.stages[p.currentStage].status === 'cleared' ? 'advance' : 'abort'));
  assert.equal(s1.applied, true);
  assert.equal(s2.applied, false, '冻结后推进不能落地');
  assert.equal(p2.status, 'frozen');
});

await test('档位变化时未收完的快照按新范围重算（超出范围作废）', async () => {
  const snaps = createInMemorySnapshots();
  const plan = createStagedPlan([
    { percent: 5, observeMinutes: 30 },
    { percent: 20, observeMinutes: 60 },
    { percent: 50, observeMinutes: 60 }
  ]);
  beginRollout(plan, '上海', snaps, 'A', T0);
  // 连进两档：5% → 20% → 50%
  for (const [base, wait] of [[2, 1], [2, 1]] as const) {
    submitReading(plan, base, T0);
    submitReading(plan, wait, T0 + 60 * 60000);
    evaluateGate(plan, '上海', snaps, T0 + 60 * 60000);
    submitDecision({ plan, snapshots: snaps, region: '上海', now: T0 }, plan.revision, 'advance', 'A');
  }
  assert.equal(currentPercent(plan), 50);
  // 50% 观察失败 → 回退到 20%：按 50 桶建收回任务，重算后仅桶 0..19 保留
  submitReading(plan, 2, T0);
  submitReading(plan, 3, T0 + 60 * 60000);
  evaluateGate(plan, '上海', snaps, T0 + 60 * 60000);
  assert.equal(currentPercent(plan), 20);
  assert.equal(snaps.all().length, 20, '超出新范围（桶≥20）的快照作废');
  assert.ok(snaps.all().every((s) => s.bucket < 20));

  // 冻结在 20% 未收完时，再次回退到 5%：同一收回任务不丢弃，快照整体重算
  performRollback(plan, '上海', snaps, '二次回退', '系统门禁', T0 + 200 * 60000);
  assert.equal(currentPercent(plan), 5);
  let remaining = snaps.all();
  assert.ok(remaining.every((s) => s.bucket < 5), '二次档位变化后只留新范围快照');
  assert.ok(remaining.every((s) => s.revision === plan.revision), '重算快照刷新到新 revision');

  // 从断点收回第一片后，已收回快照保持 reclaimed 终态
  await pumpRevocation(plan, snaps, { async reclaim() {} });
  remaining = snaps.all();
  assert.ok(remaining.length > 0 && remaining.every((s) => s.status === 'reclaimed'), '全部收回完成');
  assert.equal(plan.revokeTask!.status, 'done');
});

await test('第 1 档失败归零全关并冻结', async () => {
  const snaps = createInMemorySnapshots();
  const plan = planWithStages();
  beginRollout(plan, '上海', snaps, 'A', T0);
  submitReading(plan, 2, T0);
  submitReading(plan, 3, T0 + 30 * 60000);
  const gate = evaluateGate(plan, '上海', snaps, T0 + 30 * 60000);
  assert.equal(gate.audit[0].action, '回退冻结');
  assert.equal(plan.currentStage, -1);
  assert.equal(currentPercent(plan), 0);
  assert.equal(plan.status, 'frozen');
  assert.equal(plan.revokeTask, null);
});

console.log(`\n${passed} 个引擎行为测试全部通过`);
