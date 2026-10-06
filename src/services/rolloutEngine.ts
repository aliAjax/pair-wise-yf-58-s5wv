// 分档灰度发布引擎（纯函数，不依赖 Vue / Pinia）
//
// 关键语义：
// 1. 发布计划拆成若干档，每档固定比例 + 观察时长；观察期结束错误率没降下去（不低于入档基线）
//    自动退回上一档并冻结，同时对“已命中的范围”发起快照收回。
// 2. 推进/停止走决策序号 revision 做 CAS：两名值班员并发提交时只有一个落地，
//    后到者若 revision 已过期，必须按新档位重新判断（rejudge 回调）。
// 3. 收回按命中范围分片执行；某片失败则从断点重试，剩余未完成项记为待收项。
// 4. 档位变化时，还没收完的快照按新档位命中范围整体重算。
// 5. 一次回退无论触发了多少收回/重算，审计只产出一条。

export type StageStatus = 'idle' | 'observing' | 'cleared' | 'frozen';
export type FreezeKind = 'rollback' | 'stop';
export type GateStatus = 'pending' | 'cleared' | 'frozen';
export type PlanStatus = 'idle' | 'running' | 'frozen' | 'completed';

export interface Stage {
  index: number;
  percent: number;
  observeMinutes: number;
  status: StageStatus;
  enteredAt: number | null;
  /** 入档时的错误率基线；门禁要求观察期错误率低于基线（“降下去”） */
  baselineErrorRate: number | null;
  readings: { at: number; value: number }[];
  gate: GateStatus;
}

export interface ScopeItem {
  id: string;
  bucketFrom: number;
  bucketTo: number;
  region: string;
  snapshotIds: string[];
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  lastError?: string;
}

export interface RollbackSnapshot {
  id: string;
  stageIndex: number;
  bucket: number;
  region: string;
  userId: string;
  takenAt: number;
  status: 'pending' | 'pending-reclaim' | 'reclaimed';
  revision: number;
  scopeItemId: string | null;
}

export interface RevokeTask {
  id: string;
  fromStage: number;
  toStage: number;
  revision: number;
  items: ScopeItem[];
  checkpointItemId: string | null;
  status: 'active' | 'recomputing' | 'done';
  createdAt: number;
}

export interface StagedPlan {
  status: PlanStatus;
  stages: Stage[];
  currentStage: number;
  /** 决策序号：每次状态推进 +1，作为并发提交的乐观锁 */
  revision: number;
  frozenKind: FreezeKind | null;
  revokeTask: RevokeTask | null;
  /** 回退审计去抖：同一次回退（含断点重试、快照重算）只记一条 */
  rollbackAuditKey: string | null;
}

export interface AuditDraft {
  action: string;
  detail: string;
  actor: string;
  /** 去重键：非空时同一 key 只保留一条（回退重试/重算不追加） */
  dedupKey?: string;
}

export interface EngineResult {
  audit: AuditDraft[];
}

export interface Clock {
  now(): number;
}

export const clock: Clock = { now: () => Date.now() };

let seq = 0;
export function resetSeq(value = 0) { seq = value; }
function nextId(prefix: string) { seq += 1; return `${prefix}-${seq}`; }

// ---------------- 构造 ----------------

export function createStages(specs: { percent: number; observeMinutes: number }[]): Stage[] {
  return specs.map((spec, index) => ({
    index,
    percent: spec.percent,
    observeMinutes: spec.observeMinutes,
    status: 'idle' as StageStatus,
    enteredAt: null,
    baselineErrorRate: null,
    readings: [],
    gate: 'pending' as GateStatus
  }));
}

export function createStagedPlan(specs: { percent: number; observeMinutes: number }[]): StagedPlan {
  return {
    status: 'idle',
    stages: createStages(specs),
    currentStage: -1,
    revision: 0,
    frozenKind: null,
    revokeTask: null,
    rollbackAuditKey: null
  };
}

export function cloneStage(stage: Stage): Stage {
  return { ...stage, readings: stage.readings.map((r) => ({ ...r })) };
}

export function currentPercent(plan: StagedPlan): number {
  if (plan.currentStage < 0) return 0;
  return plan.stages[plan.currentStage].percent;
}

export function observedMinutes(stage: Stage, now: number): number {
  if (stage.enteredAt == null) return 0;
  return Math.max(0, Math.round((now - stage.enteredAt) / 60000));
}

export function observeRemaining(stage: Stage, now: number): number {
  return Math.max(0, stage.observeMinutes - observedMinutes(stage, now));
}

export function latestReading(stage: Stage): number | null {
  return stage.readings.length ? stage.readings[stage.readings.length - 1].value : null;
}

function gatePassed(stage: Stage, now: number): boolean {
  if (observeRemaining(stage, now) > 0) return false;
  const value = latestReading(stage);
  if (value == null || stage.baselineErrorRate == null) return false;
  return value < stage.baselineErrorRate; // 错误率必须“降下去”
}

function gateFailed(stage: Stage, now: number): boolean {
  if (observeRemaining(stage, now) > 0) return false;
  const value = latestReading(stage);
  if (value == null || stage.baselineErrorRate == null) return false;
  return value >= stage.baselineErrorRate;
}

// ---------------- 命中范围与快照 ----------------

/** 灰度桶沿用命中模拟的取模方式 */
export function bucketOf(userId: string): number {
  return [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
}

export function userHitsPercent(percent: number, userId: string): boolean {
  return bucketOf(userId) < percent;
}

export function hitBuckets(plan: StagedPlan): number[] {
  const percent = currentPercent(plan);
  return Array.from({ length: percent }, (_, i) => i);
}

/**
 * 按指定命中比例构造范围（区域仍由开关规则负责，这里收回当前区域下的桶）。
 * 每 10 个桶切一片，作为收回的最小断点单位。
 */
export function buildScope(scopePercent: number, region: string): Omit<ScopeItem, 'id' | 'snapshotIds'>[] {
  const items: Omit<ScopeItem, 'id' | 'snapshotIds'>[] = [];
  for (let from = 0; from < scopePercent; from += 10) {
    items.push({
      bucketFrom: from,
      bucketTo: Math.min(from + 10, scopePercent),
      region,
      status: 'pending',
      attempts: 0
    });
  }
  return items;
}

export interface SnapshotStore {
  add(snapshots: RollbackSnapshot[]): void;
  all(): RollbackSnapshot[];
  update(id: string, patch: Partial<RollbackSnapshot>): void;
  remove(ids: string[]): void;
}

export function createInMemorySnapshots(): SnapshotStore {
  const map = new Map<string, RollbackSnapshot>();
  return {
    add(snapshots) { snapshots.forEach((s) => map.set(s.id, s)); },
    all() { return [...map.values()]; },
    update(id, patch) { const cur = map.get(id); if (cur) map.set(id, { ...cur, ...patch }); },
    remove(ids) { ids.forEach((id) => map.delete(id)); }
  };
}

// 新建收回任务时同步构造的快照经此缓冲区交给调用方落到 SnapshotStore
const snapshotBuffer: RollbackSnapshot[] = [];

function snapshotsForRange(stageIndex: number, from: number, to: number, region: string, now: number, revision: number): RollbackSnapshot[] {
  const list: RollbackSnapshot[] = [];
  for (let bucket = from; bucket < to; bucket += 1) {
    list.push({
      id: nextId('s'),
      stageIndex,
      bucket,
      region,
      userId: `snapshot-u-${bucket}`,
      takenAt: now,
      status: 'pending',
      revision,
      scopeItemId: null
    });
  }
  return list;
}

function createRevokeTask(scopePercent: number, fromStage: number, revision: number, region: string, now: number): RevokeTask {
  const task: RevokeTask = {
    id: nextId('rt'),
    fromStage,
    toStage: fromStage - 1,
    revision,
    items: [],
    checkpointItemId: null,
    status: 'active',
    createdAt: now
  };
  for (const partial of buildScope(scopePercent, region)) {
    const item: ScopeItem = { ...partial, id: nextId('sc'), snapshotIds: [] };
    for (const snap of snapshotsForRange(fromStage, item.bucketFrom, item.bucketTo, region, now, revision)) {
      snap.scopeItemId = item.id;
      item.snapshotIds.push(snap.id);
      snapshotBuffer.push(snap);
    }
    task.items.push(item);
  }
  return task;
}

function drainSnapshots(): RollbackSnapshot[] {
  return snapshotBuffer.splice(0, snapshotBuffer.length);
}

/**
 * 档位变化后，把未收完（非 reclaimed）的快照按新命中范围整体重算：
 * 仍在新范围内的标记待续收，超出新范围的作废删除；收回断点若已失效则回到起点。
 */
export function recomputeSnapshots(plan: StagedPlan, snapshots: SnapshotStore): { retained: number; dropped: number } {
  const task = plan.revokeTask;
  if (!task || task.status === 'done') return { retained: 0, dropped: 0 };
  task.status = 'recomputing';
  task.revision = plan.revision;
  if (task.checkpointItemId && !task.items.some((i) => i.id === task.checkpointItemId)) {
    task.checkpointItemId = null;
  }
  const liveBuckets = new Set(hitBuckets(plan));

  let retained = 0;
  let dropped = 0;
  for (const item of task.items) {
    if (item.status === 'done') continue;
    const keep: string[] = [];
    const gone: string[] = [];
    for (const snapId of item.snapshotIds) {
      const snap = snapshots.all().find((s) => s.id === snapId);
      if (!snap) continue;
      if (snap.status === 'reclaimed') { keep.push(snapId); continue; }
      if (liveBuckets.has(snap.bucket)) {
        snapshots.update(snap.id, { status: 'pending-reclaim', revision: plan.revision });
        keep.push(snapId);
        retained += 1;
      } else {
        gone.push(snapId);
        dropped += 1;
      }
    }
    item.snapshotIds = keep;
    snapshots.remove(gone);
    if (keep.length === 0) item.status = 'done';
    else if (item.status === 'failed') item.status = 'pending';
  }
  task.status = task.items.every((i) => i.status === 'done') ? 'done' : 'active';
  return { retained, dropped };
}

// ---------------- 收回执行（失败从断点重试，剩余记待收项） ----------------

export interface Revoker {
  /** 收回单个范围片；抛错表示该片失败，整体下次从该断点重试 */
  reclaim(item: ScopeItem): Promise<void> | void;
}

export interface PumpReport {
  attempted: string[];
  failed: { itemId: string; error: string }[];
  finished: boolean;
}

export async function pumpRevocation(plan: StagedPlan, snapshots: SnapshotStore, revoker: Revoker): Promise<PumpReport> {
  const report: PumpReport = { attempted: [], failed: [], finished: false };
  const task = plan.revokeTask;
  if (!task || task.status === 'done') { report.finished = true; return report; }

  let cursor = task.items.findIndex((i) => i.status !== 'done');
  if (task.checkpointItemId) {
    const at = task.items.findIndex((i) => i.id === task.checkpointItemId);
    if (at >= 0) cursor = at;
  }
  if (cursor < 0) { task.status = 'done'; report.finished = true; return report; }

  for (let idx = cursor; idx < task.items.length; idx += 1) {
    const item = task.items[idx];
    if (item.status === 'done') continue;
    item.attempts += 1;
    report.attempted.push(item.id);
    try {
      await revoker.reclaim(item);
      item.status = 'done';
      item.lastError = undefined;
      item.snapshotIds.forEach((id) => snapshots.update(id, { status: 'reclaimed' }));
      task.checkpointItemId = idx + 1 < task.items.length ? task.items[idx + 1].id : null;
    } catch (error) {
      item.status = 'failed';
      item.lastError = error instanceof Error ? error.message : String(error);
      task.checkpointItemId = item.id; // 断点：下次从这一片重试
      report.failed.push({ itemId: item.id, error: item.lastError });
      return report; // 剩余片保持 pending，即“待收项”
    }
  }

  task.status = task.items.every((i) => i.status === 'done') ? 'done' : 'active';
  report.finished = task.status === 'done';
  return report;
}

export function pendingItems(task: RevokeTask | null): ScopeItem[] {
  return task ? task.items.filter((i) => i.status !== 'done') : [];
}

// ---------------- 发布状态机 ----------------

function enterStage(plan: StagedPlan, now: number) {
  const stage = plan.stages[plan.currentStage];
  stage.status = 'observing';
  stage.enteredAt = now;
  stage.baselineErrorRate = null;
  stage.readings = [];
  stage.gate = 'pending';
}

export function beginRollout(plan: StagedPlan, region: string, snapshots: SnapshotStore, actor: string, now = clock.now()): EngineResult {
  if (plan.status !== 'idle' || plan.stages.length === 0) return { audit: [] };
  plan.currentStage = 0;
  plan.revision += 1;
  plan.frozenKind = null;
  plan.status = 'running';
  enterStage(plan, now);
  void region; void snapshots;
  const stage = plan.stages[0];
  return {
    audit: [{
      action: '开始灰度',
      detail: `第 1/${plan.stages.length} 档 · 0→${stage.percent}% · 观察 ${stage.observeMinutes} 分钟`,
      actor
    }]
  };
}

export function submitReading(plan: StagedPlan, value: number, now = clock.now()): EngineResult {
  if (plan.status !== 'running' || plan.currentStage < 0) return { audit: [] };
  const stage = plan.stages[plan.currentStage];
  stage.readings.push({ at: now, value });
  if (stage.baselineErrorRate == null) stage.baselineErrorRate = value;
  return { audit: [] };
}

/**
 * 评估当前观察档：
 * - 观察时长未到：不动；
 * - 时长已到且错误率降下去：门禁解除（可推进下一档）；
 * - 时长已到但错误率没降下去：退回上一档并冻结，发起收回（只产出一条审计）。
 */
export function evaluateGate(plan: StagedPlan, region: string, snapshots: SnapshotStore, now = clock.now()): EngineResult {
  if (plan.status !== 'running' || plan.currentStage < 0) return { audit: [] };
  const stage = plan.stages[plan.currentStage];
  if (stage.status !== 'observing') return { audit: [] };

  if (gatePassed(stage, now)) {
    stage.status = 'cleared';
    stage.gate = 'cleared';
    return {
      audit: [{
        action: '门禁通过',
        detail: `第 ${plan.currentStage + 1} 档 ${stage.percent}% 观察期满，错误率 ${latestReading(stage)}% < 基线 ${stage.baselineErrorRate}%`,
        actor: '系统门禁'
      }]
    };
  }
  if (gateFailed(stage, now)) {
    stage.gate = 'frozen';
    return performRollback(plan, region, snapshots, `观察 ${stage.observeMinutes} 分钟错误率未下降（${latestReading(stage)}% ≥ 基线 ${stage.baselineErrorRate}%）`, '系统门禁', now);
  }
  return { audit: [] };
}

/** 回退：退回上一档并冻结，对失败档命中范围发起收回；已是首档则归零全关。一次只记一条审计。 */
export function performRollback(plan: StagedPlan, region: string, snapshots: SnapshotStore, reason: string, actor: string, now = clock.now()): EngineResult {
  const failedIndex = plan.currentStage;
  if (failedIndex < 0) return { audit: [] };
  const failedPercent = plan.stages[failedIndex].percent;
  plan.stages[failedIndex].status = 'frozen';
  plan.stages[failedIndex].gate = 'frozen';

  if (failedIndex <= 0) {
    plan.currentStage = -1;
    plan.status = 'frozen';
    plan.frozenKind = 'rollback';
    plan.revision += 1;
    // 首档失败归零：收回范围覆盖首档命中的全部桶，重算后全部作废（不再有任何范围）
    plan.revokeTask = createRevokeTask(failedPercent, 0, plan.revision, region, now);
    snapshots.add(drainSnapshots());
    recomputeSnapshots(plan, snapshots);
    plan.revokeTask = null;
    plan.rollbackAuditKey = `rollback-${plan.revision}`;
    return {
      audit: [{
        action: '回退冻结',
        detail: `第 1 档未达标：${reason}；归零全量关闭，已命中范围与快照全部收回，解冻后从第 1 档重新观察`,
        actor,
        dedupKey: plan.rollbackAuditKey
      }]
    };
  }

  const target = failedIndex - 1;
  plan.currentStage = target;
  plan.status = 'frozen';
  plan.frozenKind = 'rollback';
  plan.revision += 1;
  const prev = plan.stages[target];
  prev.status = 'observing';
  prev.enteredAt = now;
  prev.gate = 'pending';
  // 冻结期继续按上一档比例放流量；按失败档的命中范围发起收回
  if (plan.revokeTask && plan.revokeTask.status !== 'done') {
    // 连续回退：未收完的任务不丢弃，档位变化时整体重算
    plan.revokeTask.fromStage = failedIndex;
    plan.revokeTask.toStage = target;
  } else {
    plan.revokeTask = createRevokeTask(failedPercent, failedIndex, plan.revision, region, now);
    snapshots.add(drainSnapshots());
  }
  // 档位变化，未收完的快照按新档位命中范围重算（超出范围的作废，范围内的续收）
  recomputeSnapshots(plan, snapshots);
  const pending = pendingItems(plan.revokeTask).length;
  plan.rollbackAuditKey = `rollback-${plan.revision}`;
  return {
    audit: [{
      action: '回退冻结',
      detail: `第 ${failedIndex + 1} 档未达标：${reason}；退回第 ${target + 1} 档（${prev.percent}%）冻结，按第 ${failedIndex + 1} 档命中范围收回，待收项 ${pending} 片`,
      actor,
      dedupKey: plan.rollbackAuditKey
    }]
  };
}

/** 紧急停止：保持当前档位流量但冻结推进；尚未开始则仅冻结。 */
export function performStop(plan: StagedPlan, actor: string, now = clock.now()): EngineResult {
  if (plan.status !== 'running') return { audit: [] };
  const idx = plan.currentStage;
  plan.status = 'frozen';
  plan.frozenKind = 'stop';
  plan.revision += 1;
  if (idx >= 0) plan.stages[idx].status = 'frozen';
  void now;
  return {
    audit: [{
      action: '紧急停止',
      detail: idx >= 0 ? `冻结在第 ${idx + 1} 档（${plan.stages[idx].percent}%），推进暂停` : '灰度尚未开始，已冻结',
      actor
    }]
  };
}

/** 解冻：从当前档重新计时观察。 */
export function thaw(plan: StagedPlan, actor: string, now = clock.now()): EngineResult {
  if (plan.status !== 'frozen') return { audit: [] };
  plan.status = 'running';
  plan.frozenKind = null;
  plan.revision += 1;
  const idx = plan.currentStage;
  if (idx >= 0) {
    const stage = plan.stages[idx];
    stage.status = 'observing';
    stage.enteredAt = now;
    stage.baselineErrorRate = null;
    stage.readings = [];
    stage.gate = 'pending';
  }
  return {
    audit: [{
      action: '解冻继续',
      detail: idx >= 0 ? `从第 ${idx + 1} 档（${plan.stages[idx].percent}%）重新观察 ${plan.stages[idx].observeMinutes} 分钟` : '解冻后可重新开始灰度',
      actor
    }]
  };
}

/** 推进到下一档；要求当前档门禁已通过。最后一档通过则灰度完成。 */
export function advanceStage(plan: StagedPlan, region: string, snapshots: SnapshotStore, actor: string, now = clock.now()): EngineResult {
  if (plan.status !== 'running') return { audit: [] };
  const idx = plan.currentStage;
  if (idx < 0 || plan.stages[idx].status !== 'cleared') return { audit: [] };
  if (idx + 1 >= plan.stages.length) {
    plan.status = 'completed';
    plan.revision += 1;
    return { audit: [{ action: '灰度完成', detail: `全部 ${plan.stages.length} 档放量至 ${plan.stages[idx].percent}%`, actor }] };
  }
  const fromPercent = plan.stages[idx].percent;
  plan.currentStage = idx + 1;
  plan.revision += 1;
  enterStage(plan, now);
  void region; void snapshots;
  const stage = plan.stages[idx + 1];
  return {
    audit: [{
      action: '推进档位',
      detail: `第 ${idx + 1}→${idx + 2}/${plan.stages.length} 档 · ${fromPercent}%→${stage.percent}% · 观察 ${stage.observeMinutes} 分钟`,
      actor
    }]
  };
}

// ---------------- 并发值班：只让一个操作落地，后到的按新档位再判断 ----------------

export interface DecisionContext {
  plan: StagedPlan;
  snapshots: SnapshotStore;
  region: string;
  now: number;
}

export interface DecisionResult extends EngineResult {
  applied: boolean;
  reason: string;
  revision: number;
}

export function submitDecision(
  ctx: DecisionContext,
  baseRevision: number,
  action: 'advance' | 'stop',
  actor: string,
  rejudge?: (plan: StagedPlan) => 'advance' | 'stop' | 'abort'
): DecisionResult {
  const { plan } = ctx;
  if (baseRevision !== plan.revision) {
    const retried = rejudge ? rejudge(plan) : 'abort';
    if (retried === 'abort') {
      return {
        applied: false,
        reason: `决策基于过期版本 r${baseRevision}（当前 r${plan.revision}），按新档位重新判断后放弃`,
        revision: plan.revision,
        audit: [{ action: '并发冲突', detail: `${actor} 的${action === 'advance' ? '推进' : '停止'}未落地：档位已变化`, actor }]
      };
    }
    return applyDecision(ctx, retried, actor, true);
  }
  return applyDecision(ctx, action, actor, false);
}

function applyDecision(ctx: DecisionContext, action: 'advance' | 'stop', actor: string, stale: boolean): DecisionResult {
  const { plan, snapshots, region, now } = ctx;
  if (action === 'stop') {
    const result = performStop(plan, actor, now);
    if (result.audit.length === 0) return { applied: false, reason: '当前不在灰度中，停止不适用', revision: plan.revision, audit: [] };
    if (stale) result.audit[0].detail += '（后到操作，已按新档位重新判断后落地）';
    return { applied: true, reason: '停止已落地', revision: plan.revision, audit: result.audit };
  }
  const result = advanceStage(plan, region, snapshots, actor, now);
  if (result.audit.length === 0) {
    return {
      applied: false,
      reason: plan.currentStage >= 0 && plan.stages[plan.currentStage].status !== 'cleared'
        ? '当前档位观察期/门禁未通过，不能推进'
        : '推进不适用于当前状态',
      revision: plan.revision,
      audit: []
    };
  }
  if (stale) result.audit[0].detail += '（后到操作，已按新档位重新判断后落地）';
  return { applied: true, reason: '推进已落地', revision: plan.revision, audit: result.audit };
}
