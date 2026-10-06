<template>
  <section class="page" data-module="progress">
    <header class="page-head">
      <div>
        <h2>进度节点管理</h2>
        <p class="page-desc">
          月底报建设单位：列表、导出文件、下载册子读同一份台账（偏差算法 {{ algorithm }}）。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleCreate">{{ showCreate ? '收起登记' : '登记/补录节点' }}</button>
        <button class="btn" type="button" @click="exportRows">导出进度节点清单</button>
        <button class="btn" type="button" @click="submitJob">提交打包任务</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="showCreate" class="panel">
      <h3>登记 / 补录节点</h3>
      <p class="page-desc">同节点编号重复提交直接驳回；补录节点和正常节点一起导出，不会只在页面上可见。</p>
      <form class="filter-bar" @submit.prevent="submitCreate">
        <label class="filter-item"><span>节点编号</span><input v-model="createForm.nodeCode" placeholder="JD-031" /></label>
        <label class="filter-item"><span>节点名称</span><input v-model="createForm.nodeName" /></label>
        <label class="filter-item"><span>计划完成日</span><input v-model="createForm.planDate" type="date" /></label>
        <label class="filter-item"><span>计划掘进量(环)</span><input v-model.number="createForm.planAmount" type="number" /></label>
        <label class="filter-item">
          <span>节点状态</span>
          <select v-model="createForm.status">
            <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label class="filter-item"><span>补录？</span><input v-model="createForm.backfilled" type="checkbox" /></label>
        <button class="btn primary" type="submit">提交登记</button>
      </form>
    </div>

    <div class="panel">
      <h3>导出打包（分卷册子）</h3>
      <p class="page-desc">
        每卷 {{ volumeSize }} 个节点。中断后点「续打下一卷」从断掉的那卷接着打；同一台账重复提交只生效一次。
        <label style="margin-left:8px">
          <input v-model="failNextPack" type="checkbox" /> 模拟下一卷打包中途断开
        </label>
      </p>
      <div v-if="!activeJob" class="page-desc">当前没有导出任务，点右上角「提交打包任务」。</div>
      <div v-else class="job-box">
        <div>
          <strong>任务 {{ activeJob.id }}</strong>
          状态：<span :class="activeJob.status === 'rejected' ? 'error-text' : ''">{{ statusText(activeJob.status) }}</span>
          · 共 {{ activeJob.volumes.length }} 卷 · 节点 {{ activeJob.nodeIds.length }} 个（含补录）
          · 指纹 {{ activeJob.fingerprint }}
        </div>
        <div class="row-actions" style="margin:6px 0">
          <button class="btn" type="button" @click="packOne">续打下一卷</button>
          <button class="btn" type="button" @click="packAllVols">一键打完</button>
          <button class="btn" type="button" :disabled="activeJob.status !== 'done'" @click="downloadBooklet">下载整册</button>
          <button class="btn" type="button" :disabled="activeJob.status !== 'done'" @click="writeDelivery">
            结论写入掘进环次交付清单
          </button>
        </div>
        <table class="data-table">
          <thead><tr><th>卷次</th><th>节点数</th><th>状态</th><th>文件</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="v in activeJob.volumes" :key="v.index">
              <td>{{ v.label }}</td>
              <td>{{ v.nodeIds.length }}</td>
              <td>{{ v.packed ? `已打包 ${v.packedAt.slice(11, 19)}` : '未打包（断点）' }}</td>
              <td>{{ v.filename || '—' }}</td>
              <td><button class="link" type="button" :disabled="!v.packed" @click="downloadVol(v.index)">下载本卷</button></td>
            </tr>
          </tbody>
        </table>
        <p v-if="activeJob.lastError" class="error-text">驳回原因：{{ activeJob.lastError }}</p>
      </div>
    </div>

    <div class="panel">
      <h3>计划完成日改期（已完成节点冻结）</h3>
      <form class="filter-bar" @submit.prevent="submitPlanChange">
        <label class="filter-item">
          <span>当前角色</span>
          <select v-model="planForm.role">
            <option v-for="level in roleOptions" :key="level" :value="level">{{ level }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>节点行号(台账 id)</span>
          <input v-model.number="planForm.nodeId" type="number" style="width:90px" />
        </label>
        <label class="filter-item"><span>新计划完成日</span><input v-model="planForm.newPlanDate" type="date" /></label>
        <button class="btn primary" type="submit">提交改期</button>
      </form>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>台账id</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row.id }}</td>
          <td v-for="column in columns" :key="column">
            {{ row[column] === '' || row[column] === undefined ? '【缺栏】' : row[column] }}
          </td>
          <td class="row-actions">
            <button v-for="action in actions" :key="action" class="link" type="button" @click="runAction(action, row)">
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无进度节点数据，可先登记进度节点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条进度节点（在办 {{ stats[0].value }}，已完成 {{ stats[1].value }}，补录 {{ stats[3].value }}）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createNode,
  downloadEntries,
  listEntries,
  moduleMeta,
  progressStats,
  runAction as applyAction,
  changePlanDate,
} from '@/api/local-service'
import {
  listJobs,
  submitExportJob,
  packNextVolume,
  packAll,
  downloadVolume,
  downloadText,
  assembleBooklet,
  type ExportJob,
} from '@/data/progress-export'
import { recordDelivery } from '@/data/ring-deliveries'
import {
  DEVIATION_ALGORITHM_VERSION,
  PROGRESS_COLUMNS,
  ROLE_LEVELS,
} from '@/data/progress-ledger'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('progress')
const columns = [...PROGRESS_COLUMNS]
const actions = ['开始节点', '确认完成', '登记延期']
const statuses = ['未开始', '进行中', '已完成', '已延期']
const roleOptions = Object.keys(ROLE_LEVELS)
const algorithm = DEVIATION_ALGORITHM_VERSION
const volumeSize = 10

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['节点编号', '节点名称', '计划完成日']

const stats = computed(() => {
  const s = progressStats()
  return [
    { label: '在办节点', value: s.active },
    { label: '已完成节点', value: s.done },
    { label: '延期节点', value: s.delayed },
    { label: '补录节点', value: s.backfilled },
    { label: '节点总数', value: s.total },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// ---- 登记 / 补录 ----
const showCreate = ref(false)
const createForm = ref({ nodeCode: '', nodeName: '', planDate: '', planAmount: 0, status: '未开始', backfilled: false })

function toggleCreate() {
  showCreate.value = !showCreate.value
}

function submitCreate() {
  const result = createNode({ ...createForm.value })
  flash(result.ok ? '' : result.message)
  if (result.ok) {
    createForm.value = { nodeCode: '', nodeName: '', planDate: '', planAmount:0, status: '未开始', backfilled: false }
    reload()
  }
}

// ---- 计划完成日改期 ----
const planForm = ref({ role: '值班员', nodeId: 1, newPlanDate: '' })

function submitPlanChange() {
  if (!planForm.value.newPlanDate) {
    flash('驳回：请选择新的计划完成日')
    return
  }
  const result = changePlanDate({
    nodeId: planForm.value.nodeId,
    newPlanDate: planForm.value.newPlanDate,
    operator: '值班管理员',
    role: planForm.value.role,
  })
  flash(result.ok ? '' : result.message)
  reload()
  refreshJob()
}

// ---- 导出打包 ----
const activeJob = ref<ExportJob | null>(null)
const failNextPack = ref(false)

function refreshJob() {
  activeJob.value = listJobs()[0] ?? null
}

function statusText(status: ExportJob['status']): string {
  return { packing: '打包中（可断点续打）', done: '已完成', rejected: '已驳回' }[status]
}

function submitJob() {
  const result = submitExportJob({ volumeSize })
  flash(result.duplicated ? '' : result.ok ? '' : result.message)
  refreshJob()
}

function failFlag(): number | undefined {
  if (!failNextPack.value) {
    return undefined
  }
  failNextPack.value = false
  // 让当前待打卷里任意节点触发中断即可，传 -1 不会命中；取待打卷首节点 id。
  const pending = activeJob.value?.volumes.find((v) => !v.packed)
  return pending?.nodeIds[0]
}

function packOne() {
  if (!activeJob.value) {
    return
  }
  const result = packNextVolume(activeJob.value.id, { failPlanDateForId: failFlag() })
  flash(result.ok ? '' : result.message)
  refreshJob()
}

function packAllVols() {
  if (!activeJob.value) {
    return
  }
  const result = packAll(activeJob.value.id, { failPlanDateForId: failFlag() })
  flash(result.ok ? '' : result.message)
  refreshJob()
}

function downloadBooklet() {
  if (!activeJob.value) {
    return
  }
  const result = assembleBooklet(activeJob.value.id)
  if (!('filename' in result)) {
    flash(result.message)
    return
  }
  downloadText(result.filename, result.content)
}

function downloadVol(index: number) {
  if (!activeJob.value) {
    return
  }
  const result = downloadVolume(activeJob.value.id, index)
  flash(result.ok ? '' : result.message)
}

function writeDelivery() {
  if (!activeJob.value) {
    return
  }
  const result = recordDelivery(activeJob.value.id)
  flash(result.ok ? result.message : result.message)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  refreshJob()
}

function flash(message: string) {
  errorMessage.value = message
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshJob()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '进度节点列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.panel h3 {
  margin: 0 0 6px;
  font-size: 14px;
}
.job-box {
  margin-top: 8px;
  font-size: 13px;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
