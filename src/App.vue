<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useFlagStore } from './stores/flags';
import type { DecisionResult } from './services/rolloutEngine';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const staged = computed(() => store.staged);
const createOpen = ref(false);
const simulation = ref<{ hit: boolean; reason: string } | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');

const actor = ref('值班员A');
const errorRateInput = ref(2.0);
const concurrentAction = reactive<{ a: 'advance' | 'stop'; b: 'advance' | 'stop' }>({ a: 'advance', b: 'stop' });
const decisionLog = ref<{ actor: string; applied: boolean; reason: string }[]>([]);

const currentStageRef = computed(() => {
  const s = staged.value;
  return s && s.currentStage >= 0 ? s.stages[s.currentStage] : null;
});
const currentReading = computed(() => {
  const stage = currentStageRef.value;
  return stage && stage.readings.length ? stage.readings[stage.readings.length - 1].value : null;
});
const task = computed(() => store.activeTask);

const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  store.flags.push({ id, name: values.name, key: values.key, enabled: false, rollout: 0, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, status: 'draft' });
  store.plans.push({
    id: `p-${Date.now()}`, flagId: id, scheduledAt: '2026-10-06T10:00', approvals: [], version: 1,
    staged: { status: 'idle', currentStage: -1, revision: 0, frozenKind: null, revokeTask: null, rollbackAuditKey: null,
      stages: [
        { index: 0, percent: 5, observeMinutes: 30, status: 'idle', enteredAt: null, baselineErrorRate: null, readings: [], gate: 'pending' },
        { index: 1, percent: 25, observeMinutes: 60, status: 'idle', enteredAt: null, baselineErrorRate: null, readings: [], gate: 'pending' },
        { index: 2, percent: 100, observeMinutes: 120, status: 'idle', enteredAt: null, baselineErrorRate: null, readings: [], gate: 'pending' }
      ] }
  });
  store.select(id);
  store.audit('创建开关', `${values.key} 草稿，默认 3 档发布计划`);
  createOpen.value = false;
  resetForm();
});

function simulate() { if (active.value) simulation.value = store.simulateHit(user); }
function statusColor(status?: string) {
  switch (status) {
    case 'rolling': return 'green';
    case 'completed': return 'success';
    case 'approved': return 'blue';
    case 'frozen':
    case 'stopped':
    case 'rolled-back': return 'red';
    default: return 'gold';
  }
}
function stageColor(status: string) {
  return status === 'cleared' ? 'green' : status === 'observing' ? 'blue' : status === 'frozen' ? 'red' : 'default';
}
function stageLabel(status: string) {
  return { idle: '未开始', observing: '观察中', cleared: '已通过', frozen: '已冻结' }[status] ?? status;
}
function reportRate() {
  store.recordErrorRate(Number(errorRateInput.value));
  simulation.value = null;
}
function ff(min: number) {
  store.fastForward(min);
}
function logDecision(actorName: string, result: DecisionResult) {
  decisionLog.value.unshift({ actor: actorName, applied: result.applied, reason: result.reason });
  if (decisionLog.value.length > 6) decisionLog.value.pop();
}
function doAdvance() { logDecision(actor.value, store.advance(actor.value)); }
function doStop() { logDecision(actor.value, store.stop(actor.value)); }
function doConcurrent() {
  const results = store.concurrentSubmit(
    { actor: '值班员A', action: concurrentAction.a },
    { actor: '值班员B', action: concurrentAction.b }
  );
  results.forEach((r, i) => logDecision(i === 0 ? '值班员A' : '值班员B', r));
}
function retryRecall() { void store.autoPump(actor.value); }
function resetDemo() { localStorage.removeItem('yf58-flag-state-v2'); location.reload(); }
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar">
      <div><div class="eyebrow">STAGED ROLLOUT / PORT 62023</div><h1>{{ $t('title') }}</h1></div>
      <a-space>
        <a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag>
        <a-button ghost @click="resetDemo">重置演示数据</a-button>
        <a-button type="primary" @click="createOpen = true">新建功能开关</a-button>
      </a-space>
    </a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="档位修改保留在浏览器，恢复网络后仍需完成双审批才能发布。" class="mb" />
      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small">
            <a-list :data-source="store.flags" bordered>
              <template #renderItem="{ item }">
                <a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)">
                  <a-list-item-meta>
                    <template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag></a-space></template>
                    <template #description><code>{{ item.key }}</code> · 当前放量 {{ item.rollout }}%</template>
                  </a-list-item-meta>
                </a-list-item>
              </template>
            </a-list>
          </a-card>
          <a-card title="规则命中模拟" size="small" class="mt">
            <a-form layout="vertical">
              <a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item>
              <a-row :gutter="8"><a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col><a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col></a-row>
              <a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox>
              <a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button>
            </a-form>
            <a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'info'" show-icon :message="simulation.hit ? '命中新功能' : '未命中'" :description="simulation.reason" />
          </a-card>
        </a-col>

        <a-col :xs="24" :lg="17">
          <template v-if="active && plan && staged">
            <a-card :title="active.name" class="mb">
              <template #extra>
                <a-space wrap>
                  <a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag>
                  <a-button danger :disabled="staged.status !== 'running'" @click="store.rollback(actor)">人工回退</a-button>
                  <a-button danger ghost :disabled="staged.status !== 'frozen' || staged.currentStage < 0" @click="store.thaw(actor)">解冻继续</a-button>
                  <a-button ghost :disabled="staged.status !== 'frozen' || staged.currentStage !== -1" @click="store.restartRollout(actor)">重置后重新开始</a-button>
                </a-space>
              </template>
              <a-descriptions bordered :column="{ xs: 1, md: 3 }">
                <a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item>
                <a-descriptions-item label="当前档位">
                  <template v-if="staged.currentStage >= 0">第 {{ staged.currentStage + 1 }}/{{ staged.stages.length }} 档 · {{ active.rollout }}%</template>
                  <template v-else>未开始（0%）</template>
                </a-descriptions-item>
                <a-descriptions-item label="审批">{{ plan.approvals.join('、') || '待审批' }}</a-descriptions-item>
              </a-descriptions>

              <a-divider>发布档位（比例 + 观察时长）</a-divider>
              <a-table
                :data-source="staged.stages" :pagination="false" size="small" :row-key="(r: any) => r.index"
                :columns="[
                  { title: '档位', dataIndex: 'index', customRender: ({ record }: any) => `第 ${record.index + 1} 档`, width: 90 },
                  { title: '放量比例', dataIndex: 'percent' },
                  { title: '观察时长(分钟)', dataIndex: 'observeMinutes' },
                  { title: '状态', dataIndex: 'status' }
                ]"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.dataIndex === 'percent'">
                    <a-input-number v-if="staged.status === 'idle'" :value="record.percent" :min="0" :max="100" size="small" @change="(v: number) => store.editStage(record.index, { percent: v })" />
                    <span v-else>{{ record.percent }}%</span>
                  </template>
                  <template v-else-if="column.dataIndex === 'observeMinutes'">
                    <a-input-number v-if="staged.status === 'idle'" :value="record.observeMinutes" :min="1" size="small" @change="(v: number) => store.editStage(record.index, { observeMinutes: v })" />
                    <span v-else>{{ record.observeMinutes }} 分钟</span>
                  </template>
                  <template v-else-if="column.dataIndex === 'status'">
                    <a-tag :color="stageColor(record.status)">{{ stageLabel(record.status) }}</a-tag>
                    <a-button v-if="staged.status === 'idle' && staged.stages.length > 1" type="link" danger size="small" @click="store.removeStage(record.index)">删</a-button>
                  </template>
                </template>
              </a-table>
              <a-space class="mt">
                <a-button v-if="staged.status === 'idle'" size="small" @click="store.addStage">增加一档</a-button>
                <a-button v-if="staged.status === 'idle'" size="small" :disabled="plan.approvals.includes('产品负责人')" @click="store.approve('产品负责人')">产品审批</a-button>
                <a-button v-if="staged.status === 'idle'" size="small" :disabled="plan.approvals.includes('研发负责人')" @click="store.approve('研发负责人')">研发审批</a-button>
                <a-button type="primary" size="small" :disabled="staged.status !== 'idle' || plan.approvals.length < 2" @click="store.startRollout(actor)">开始分档灰度</a-button>
              </a-space>

              <template v-if="currentStageRef">
                <a-divider>观察门禁 · 第 {{ staged.currentStage + 1 }} 档</a-divider>
                <a-descriptions :column="{ xs: 1, md: 4 }" size="small" bordered>
                  <a-descriptions-item label="入档基线错误率">{{ currentStageRef.baselineErrorRate ?? '—' }}%</a-descriptions-item>
                  <a-descriptions-item label="最新错误率">{{ currentReading ?? '—' }}%</a-descriptions-item>
                  <a-descriptions-item label="已观察 / 需观察">{{ store.stageObserved() }} / {{ currentStageRef.observeMinutes }} 分钟</a-descriptions-item>
                  <a-descriptions-item label="门禁">
                    <a-tag :color="currentStageRef.gate === 'cleared' ? 'green' : currentStageRef.gate === 'frozen' ? 'red' : 'orange'">
                      {{ currentStageRef.gate === 'cleared' ? '已通过，可推进' : currentStageRef.gate === 'frozen' ? '未达标，已回退冻结' : `还差 ${store.stageRemaining()} 分钟` }}
                    </a-tag>
                  </a-descriptions-item>
                </a-descriptions>
                <a-space class="mt" wrap>
                  <a-input-number v-model:value="errorRateInput" :step="0.1" :min="0" :max="100" size="small" addon-after="%" />
                  <a-button size="small" @click="reportRate">上报错误率</a-button>
                  <a-button-group>
                    <a-button size="small" @click="ff(30)">快进 30 分钟</a-button>
                    <a-button size="small" @click="ff(60)">快进 1 小时</a-button>
                    <a-button size="small" @click="ff(240)">快进 4 小时</a-button>
                  </a-button-group>
                </a-space>
                <a-alert class="mt" type="info" show-icon message="门禁规则：观察时长走满后，最新错误率必须低于入档基线；否则自动退回上一档并冻结，发起命中范围与快照收回。" />
              </template>

              <a-divider>值班操作（并发只落一个）</a-divider>
              <a-space wrap>
                <span>操作人：</span>
                <a-radio-group v-model:value="actor" button-style="solid" option-type="button" :options="['值班员A', '值班员B']" />
                <a-button type="primary" :disabled="staged.status !== 'running' || !currentStageRef || currentStageRef.status !== 'cleared'" @click="doAdvance">推进下一档</a-button>
                <a-button danger :disabled="staged.status !== 'running'" @click="doStop">停止</a-button>
              </a-space>
              <a-card size="small" class="mt" title="两名值班员同时提交（同一 revision）">
                <a-space wrap>
                  <span>A：</span>
                  <a-select v-model:value="concurrentAction.a" style="width: 110px" :options="[{ value: 'advance', label: '推进' }, { value: 'stop', label: '停止' }]" />
                  <span>B：</span>
                  <a-select v-model:value="concurrentAction.b" style="width: 110px" :options="[{ value: 'advance', label: '推进' }, { value: 'stop', label: '停止' }]" />
                  <a-button type="primary" ghost :disabled="staged.status !== 'running'" @click="doConcurrent">同时提交</a-button>
                </a-space>
                <a-list v-if="decisionLog.length" class="mt" size="small" bordered :data-source="decisionLog">
                  <template #renderItem="{ item }">
                    <a-list-item>
                      <a-tag :color="item.applied ? 'green' : 'red'">{{ item.applied ? '落地' : '未落地' }}</a-tag>
                      <b>{{ item.actor }}</b>&nbsp;：{{ item.reason }}
                    </a-list-item>
                  </template>
                </a-list>
              </a-card>

              <template v-if="task">
                <a-divider>收回任务 {{ task.id }}（{{ task.status }}）</a-divider>
                <a-space wrap class="mb">
                  <a-tag color="blue">从第 {{ task.fromStage + 1 }} 档收回至第 {{ task.toStage + 1 }} 档范围</a-tag>
                  <a-tag>待收范围片 {{ store.pendingScopeItems.length }} / {{ task.items.length }}</a-tag>
                  <a-tag :color="store.pendingSnapshots.length ? 'orange' : 'green'">待收快照 {{ store.pendingSnapshots.length }}</a-tag>
                  <a-button size="small" danger ghost @click="store.injectRecallFault(1)">注入下一片收回失败</a-button>
                  <a-button size="small" type="primary" :disabled="task.status === 'done'" @click="retryRecall">从断点重试收回</a-button>
                </a-space>
                <a-table
                  :data-source="task.items" :pagination="false" size="small" :row-key="(r: any) => r.id"
                  :columns="[
                    { title: '范围片（灰度桶）', key: 'range' },
                    { title: '快照数', dataIndex: 'snapshotIds', customRender: ({ record }: any) => record.snapshotIds.length, width: 90 },
                    { title: '尝试', dataIndex: 'attempts', width: 70 },
                    { title: '状态', dataIndex: 'status', width: 100 },
                    { title: '断点/错误', key: 'err' }
                  ]"
                >
                  <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'range'">桶 {{ record.bucketFrom }}–{{ record.bucketTo - 1 }}（{{ record.region }}）</template>
                    <template v-else-if="column.dataIndex === 'status'">
                      <a-tag :color="record.status === 'done' ? 'green' : record.status === 'failed' ? 'red' : 'orange'">
                        {{ record.status === 'done' ? '已收回' : record.status === 'failed' ? '失败（断点）' : '待收' }}
                      </a-tag>
                    </template>
                    <template v-else-if="column.key === 'err'">
                      <a-tag v-if="task.checkpointItemId === record.id" color="purple">断点</a-tag>
                      <span v-if="record.lastError" class="err">{{ record.lastError }}</span>
                    </template>
                  </template>
                </a-table>
              </template>
            </a-card>

            <a-card title="审计记录">
              <a-timeline>
                <a-timeline-item v-for="item in store.audit" :key="item.id" :color="['停止', '回退', '冲突', '中断'].some((k) => item.action.includes(k)) ? 'red' : 'blue'">
                  <b>{{ item.at }} · {{ item.actor }}</b>
                  <p>{{ item.action }}：{{ item.detail }}</p>
                </a-timeline-item>
              </a-timeline>
            </a-card>
          </template>
        </a-col>
      </a-row>
    </a-layout-content>
    <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create">
      <a-form layout="vertical">
        <a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name"><a-input v-model:value="name" /></a-form-item>
        <a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key"><a-input v-model:value="key" /></a-form-item>
      </a-form>
    </a-modal>
  </a-layout></a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }
.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }
.selected { background: #eef2ff; cursor: pointer; }.ant-list-item { cursor: pointer; }
.err { color: #cf1322; font-size: 12px; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
