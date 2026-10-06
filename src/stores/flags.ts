import { defineStore } from 'pinia';
import {
  advanceStage,
  beginRollout,
  createInMemorySnapshots,
  createStagedPlan,
  currentPercent,
  evaluateGate,
  latestReading,
  observeRemaining,
  observedMinutes,
  pendingItems,
  performRollback,
  pumpRevocation,
  submitDecision,
  submitReading,
  thaw as thawPlan,
  type AuditDraft,
  type DecisionResult,
  type RevokeTask,
  type RollbackSnapshot,
  type ScopeItem,
  type SnapshotStore,
  type StagedPlan
} from '../services/rolloutEngine';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back' | 'frozen' | 'completed';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; rollout: number; rules: RuleSet; status: FlagStatus; }
export interface RolloutPlan { id: string; flagId: string; scheduledAt: string; approvals: string[]; version: number; staged: StagedPlan; }
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; dedupKey?: string; }

const DEFAULT_STAGES = [
  { percent: 5, observeMinutes: 30 },
  { percent: 20, observeMinutes: 60 },
  { percent: 50, observeMinutes: 120 },
  { percent: 100, observeMinutes: 240 }
];

interface State {
  flags: FeatureFlag[];
  plans: RolloutPlan[];
  audit: AuditRecord[];
  activeId: string;
  snapshots: RollbackSnapshot[];
  /** 虚拟时钟相对真实时间的分钟偏移，用于演示“观察时长” */
  clockOffsetMin: number;
  /** 收回故障注入：剩余失败次数（每片尝试消耗一次），用于演示断点重试 */
  recallFailNext: number;
}

const seed: State = {
  activeId: 'f1',
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 0, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft' },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 100, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'completed' }
  ],
  plans: [
    { id: 'p1', flagId: 'f1', scheduledAt: '2026-10-06T10:00', approvals: [], version: 3, staged: createStagedPlan(DEFAULT_STAGES) },
    { id: 'p2', flagId: 'f2', scheduledAt: '2026-10-05T09:00', approvals: ['产品负责人', '研发负责人'], version: 1, staged: completedPlan() }
  ],
  audit: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3，分 4 档：5%→20%→50%→100%' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ],
  snapshots: [],
  clockOffsetMin: 0,
  recallFailNext: 0
};

function completedPlan(): StagedPlan {
  const plan = createStagedPlan(DEFAULT_STAGES);
  plan.status = 'completed';
  plan.currentStage = 3;
  plan.revision = 4;
  plan.stages.forEach((stage, i) => {
    stage.status = i === 3 ? 'cleared' : 'cleared';
    stage.gate = 'cleared';
  });
  return plan;
}

function load(): State {
  const saved = localStorage.getItem('yf58-flag-state-v2');
  if (saved) {
    try { return JSON.parse(saved) as State; } catch { /* 损坏则回落种子 */ }
  }
  return structuredClone(seed);
}

export const useFlagStore = defineStore('flags', {
  state: () => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    staged(): StagedPlan | undefined { return this.activePlan?.staged; },
    now(): number { return Date.now() + this.clockOffsetMin * 60000; },
    activeTask(): RevokeTask | null { return this.staged?.revokeTask ?? null; },
    pendingSnapshots(): RollbackSnapshot[] {
      return this.snapshots.filter((s) => s.status !== 'reclaimed');
    },
    pendingScopeItems(): ScopeItem[] { return pendingItems(this.activeTask); }
  },
  actions: {
    persist() { localStorage.setItem('yf58-flag-state-v2', JSON.stringify(this.$state)); },
    nowTs() { return Date.now() + this.clockOffsetMin * 60000; },

    addAudit(drafts: AuditDraft[]) {
      for (const draft of drafts) {
        if (draft.dedupKey && this.audit.some((item) => item.dedupKey === draft.dedupKey)) continue;
        this.audit.unshift({
          id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          at: new Date(this.nowTs()).toLocaleTimeString(),
          actor: draft.actor,
          action: draft.action,
          detail: draft.detail,
          ...(draft.dedupKey ? { dedupKey: draft.dedupKey } : {})
        });
      }
      this.persist();
    },
    audit(action: string, detail: string, actor = '当前操作人') { this.addAudit([{ action, detail, actor }]); },

    /** 把收回进展追加到同一条回退审计上（这次回退始终只记一条） */
    supplementRollbackAudit(suffix: string) {
      const key = this.activePlan?.staged.rollbackAuditKey;
      if (!key) { this.audit('收回', suffix); return; }
      const record = this.audit.find((item) => item.dedupKey === key);
      if (record && !record.detail.includes(suffix)) record.detail += suffix;
      this.persist();
    },

    select(id: string) { this.activeId = id; this.persist(); },

    snapshotAccessor(): SnapshotStore {
      return {
        add: (list) => { this.snapshots.push(...list.map((s) => ({ ...s }))); },
        all: () => this.snapshots,
        update: (id, patch) => { const cur = this.snapshots.find((s) => s.id === id); if (cur) Object.assign(cur, patch); },
        remove: (ids) => { const gone = new Set(ids); this.snapshots = this.snapshots.filter((s) => !gone.has(s.id)); }
      };
    },

    syncFlag() {
      const flag = this.active;
      const plan = this.activePlan?.staged;
      if (!flag || !plan) return;
      flag.rollout = currentPercent(plan);
      if (plan.status === 'idle') {
        flag.enabled = false;
        flag.status = this.activePlan!.approvals.length >= 2 ? 'approved' : 'draft';
      } else if (plan.status === 'running') {
        flag.enabled = true;
        flag.status = 'rolling';
      } else if (plan.status === 'frozen') {
        // 回退到第 0 档之前：全关；其余冻结档继续按上一档比例放流量
        flag.enabled = plan.currentStage >= 0;
        flag.status = 'frozen';
      } else if (plan.status === 'completed') {
        flag.enabled = true;
        flag.status = 'completed';
      }
    },

    updateRule(rule: Partial<RuleSet>) {
      if (!this.active) return;
      this.active.rules = { ...this.active.rules, ...rule };
      this.active.status = 'draft';
      const plan = this.activePlan;
      if (plan) {
        plan.approvals = [];
        if (plan.staged.status === 'idle') this.syncFlag();
      }
      this.audit('修改规则', JSON.stringify(this.active.rules));
    },

    // -------- 分档配置（仅 idle 可改） --------
    editStage(index: number, patch: Partial<{ percent: number; observeMinutes: number }>) {
      const staged = this.staged;
      if (!staged || staged.status !== 'idle') return;
      const stage = staged.stages[index];
      if (!stage) return;
      if (patch.percent != null) stage.percent = Math.min(100, Math.max(0, Math.round(patch.percent)));
      if (patch.observeMinutes != null) stage.observeMinutes = Math.max(1, Math.round(patch.observeMinutes));
      this.activePlan!.approvals = [];
      this.syncFlag();
      this.persist();
    },
    addStage() {
      const staged = this.staged;
      if (!staged || staged.status !== 'idle') return;
      const last = staged.stages[staged.stages.length - 1];
      staged.stages.push({
        index: staged.stages.length,
        percent: last?.percent ?? 5,
        observeMinutes: last?.observeMinutes ?? 30,
        status: 'idle', enteredAt: null, baselineErrorRate: null, readings: [], gate: 'pending'
      });
      this.persist();
    },
    removeStage(index: number) {
      const staged = this.staged;
      if (!staged || staged.status !== 'idle' || staged.stages.length <= 1) return;
      staged.stages = staged.stages.filter((_, i) => i !== index).map((s, i) => ({ ...s, index: i }));
      this.persist();
    },

    schedule(value: string) {
      if (!this.active || !this.activePlan) return;
      this.activePlan.scheduledAt = value;
      this.active.status = 'scheduled';
      this.audit('设置定时', `${this.active.key} 于 ${value} 生效`);
    },
    approve(role: string) {
      if (!this.active || !this.activePlan || this.activePlan.approvals.includes(role)) return;
      this.activePlan.approvals.push(role);
      this.syncFlag();
      this.audit('审批发布', `${role} 已确认 ${this.active.key}（${this.staged?.stages.length} 档发布计划）`, role);
    },

    // -------- 灰度推进 --------
    startRollout(actor = '值班员A') {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan || plan.staged.status !== 'idle' || plan.approvals.length < 2) return;
      const result = beginRollout(plan.staged, flag.rules.region, this.snapshotAccessor(), actor, this.nowTs());
      this.syncFlag();
      this.addAudit(result.audit);
      void this.autoPump(actor);
    },

    recordErrorRate(value: number) {
      const plan = this.staged;
      if (!plan) return;
      submitReading(plan, value, this.nowTs());
      this.afterTick('监控上报');
    },

    /** 上报/快进后的统一收尾：评估门禁，必要时自动回退并尝试收回 */
    afterTick(actor = '系统') {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan) return;
      const result = evaluateGate(plan.staged, flag.rules.region, this.snapshotAccessor(), this.nowTs());
      this.syncFlag();
      this.addAudit(result.audit);
      if (plan.staged.status === 'frozen' && plan.staged.revokeTask) void this.autoPump(actor);
      this.persist();
    },

    advance(actor = '值班员A'): DecisionResult {
      const flag = this.active;
      const plan = this.activePlan;
      const empty: DecisionResult = { applied: false, reason: '无可执行计划', revision: 0, audit: [] };
      if (!flag || !plan) return empty;
      const result = submitDecision(
        { plan: plan.staged, snapshots: this.snapshotAccessor(), region: flag.rules.region, now: this.nowTs() },
        plan.staged.revision, 'advance', actor,
        (latest) => latest.status === 'running' && latest.currentStage >= 0 && latest.stages[latest.currentStage].status === 'cleared' ? 'advance' : 'abort'
      );
      this.syncFlag();
      this.addAudit(result.audit);
      return result;
    },

    stop(actor = '值班员A'): DecisionResult {
      const flag = this.active;
      const plan = this.activePlan;
      const empty: DecisionResult = { applied: false, reason: '无可执行计划', revision: 0, audit: [] };
      if (!flag || !plan) return empty;
      const result = submitDecision(
        { plan: plan.staged, snapshots: this.snapshotAccessor(), region: flag.rules.region, now: this.nowTs() },
        plan.staged.revision, 'stop', actor,
        // 后到的停止：只要还在灰度中，按新档位重新判断后仍然落地
        (latest) => latest.status === 'running' ? 'stop' : 'abort'
      );
      this.syncFlag();
      this.addAudit(result.audit);
      return result;
    },

    /**
     * 两名值班员基于同一版本同时提交：引擎按 revision 做 CAS，
     * 只有先处理的一个落地；后到的按新档位重新判断。
     */
    concurrentSubmit(a: { actor: string; action: 'advance' | 'stop' }, b: { actor: string; action: 'advance' | 'stop' }): DecisionResult[] {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan) return [];
      const base = plan.staged.revision;
      const ctx = { plan: plan.staged, snapshots: this.snapshotAccessor(), region: flag.rules.region, now: this.nowTs() };
      const r1 = submitDecision(ctx, base, a.action, a.actor, rejudge(a.action));
      const r2 = submitDecision(ctx, base, b.action, b.actor, rejudge(b.action));
      this.syncFlag();
      this.addAudit([...r1.audit, ...r2.audit]);
      return [r1, r2];
    },

    thaw(actor = '值班员A') {
      const plan = this.activePlan;
      if (!plan) return;
      this.addAudit(thawPlan(plan.staged, actor, this.nowTs()).audit);
      this.syncFlag();
    },

    /** 归零全关后的冻结：重置档位后重新走审批与第 1 档 */
    restartRollout(actor = '值班员A') {
      const plan = this.activePlan;
      const flag = this.active;
      if (!plan || !flag || plan.staged.status !== 'frozen' || plan.staged.currentStage !== -1) return;
      const staged = plan.staged;
      staged.status = 'idle';
      staged.currentStage = -1;
      staged.frozenKind = null;
      staged.revokeTask = null;
      staged.rollbackAuditKey = null;
      staged.stages.forEach((stage) => {
        stage.status = 'idle';
        stage.enteredAt = null;
        stage.baselineErrorRate = null;
        stage.readings = [];
        stage.gate = 'pending';
      });
      plan.approvals = [];
      this.syncFlag();
      this.audit('重置发布计划', `${flag.key} 归零冻结后重置为草稿，需重新审批并从第 1 档开始`, actor);
    },

    emergencyStop(actor = '值班员A') { this.stop(actor); },

    rollback(actor = '值班员A') {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan || plan.staged.status !== 'running' || plan.staged.currentStage < 0) return;
      const stage = plan.staged.stages[plan.staged.currentStage];
      const rate = latestReading(stage);
      const result = performRollback(
        plan.staged, flag.rules.region, this.snapshotAccessor(),
        rate == null ? '人工触发' : `人工触发（当前错误率 ${rate}%）`, actor, this.nowTs()
      );
      this.syncFlag();
      this.addAudit(result.audit);
      void this.autoPump(actor);
    },

    // -------- 收回（失败从断点重试，剩余记待收项） --------
    injectRecallFault(times = 1) { this.recallFailNext += times; this.persist(); },

    async autoPump(actor = '系统') {
      const plan = this.activePlan;
      if (!plan || !plan.staged.revokeTask) return;
      const accessor = this.snapshotAccessor();
      const failLeft = () => this.recallFailNext;
      const revoker = {
        reclaim: async (item: ScopeItem) => {
          if (failLeft() > 0) {
            this.recallFailNext -= 1;
            throw new Error(`范围片 桶${item.bucketFrom}-${item.bucketTo} 收回超时（第 ${item.attempts} 次尝试）`);
          }
        }
      };
      const report = await pumpRevocation(plan.staged, accessor, revoker);
      this.syncFlag();
      this.persist();
      if (report.failed.length) {
        // 进展追加到同一条回退记录：失败片成为断点，其余记待收项
        this.supplementRollbackAudit(`；收回中断于断点 ${report.failed[0].itemId}（${report.failed[0].error}），其余 ${Math.max(0, pendingItems(plan.staged.revokeTask).length - 1)} 片待收`);
      } else if (report.finished && report.attempted.length) {
        this.supplementRollbackAudit('；命中范围与快照已全部收回');
      }
    },

    /** 快进虚拟时间：观察期走完自动评估门禁，收回任务自动从断点续收 */
    fastForward(minutes: number) {
      this.clockOffsetMin += minutes;
      const plan = this.activePlan;
      if (!plan) { this.persist(); return; }
      if (plan.staged.status === 'running') this.afterTick('虚拟时钟');
      if (plan.staged.revokeTask && plan.staged.revokeTask.status !== 'done') void this.autoPump('虚拟时钟');
      this.persist();
    },

    stageObserved(): number {
      const staged = this.staged;
      return staged && staged.currentStage >= 0 ? observedMinutes(staged.stages[staged.currentStage], this.nowTs()) : 0;
    },
    stageRemaining(): number {
      const staged = this.staged;
      return staged && staged.currentStage >= 0 ? observeRemaining(staged.stages[staged.currentStage], this.nowTs()) : 0;
    },

    simulateHit(user: { region: string; appVersion: string; authenticated: boolean; id: string }) {
      if (!this.active) return { hit: false, reason: '请选择开关' };
      const plan = this.activePlan?.staged;
      const rollout = plan ? currentPercent(plan) : this.active.rollout;
      if (!this.active.enabled) return { hit: false, reason: plan?.status === 'frozen' && plan.currentStage < 0 ? '回退冻结：已归零全关' : '开关未启用' };
      const rule = this.active.rules;
      if (rule.region !== '全部' && rule.region !== user.region) return { hit: false, reason: `地区不匹配（要求${rule.region}）` };
      if (rule.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户' };
      const hash = [...user.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
      const hit = hash < rollout;
      return { hit, reason: hit ? `灰度桶 ${hash} < 当前档 ${rollout}%` : `灰度桶 ${hash} ≥ 当前档 ${rollout}%` };
    }
  }
});

function rejudge(action: 'advance' | 'stop') {
  return (latest: StagedPlan): 'advance' | 'stop' | 'abort' => {
    if (action === 'stop') return latest.status === 'running' ? 'stop' : 'abort';
    return latest.status === 'running' && latest.currentStage >= 0 && latest.stages[latest.currentStage].status === 'cleared'
      ? 'advance'
      : 'abort';
  };
}

// 供单测直接构造内存快照仓
export { createInMemorySnapshots, advanceStage };
