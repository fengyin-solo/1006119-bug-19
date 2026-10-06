<template>
  <section class="page" data-module="progress">
    <header class="page-head">
      <div>
        <h2>进度节点管理</h2>
        <p class="page-desc">月底向建设单位报进度节点：列表、导出文件、下载册子读同一份节点台账；偏差天数以台账算法为准。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showForm = !showForm">登记/补录节点</button>
        <button class="btn" type="button" @click="exportRows">导出进度节点清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form v-if="showForm" class="filter-bar" @submit.prevent="submitRegister">
      <label class="filter-item"><span>节点编号</span><input v-model="form.code" placeholder="PROG-00xx" /></label>
      <label class="filter-item"><span>节点名称</span><input v-model="form.name" /></label>
      <label class="filter-item"><span>计划完成日</span><input v-model="form.planDate" placeholder="YYYY-MM-DD" /></label>
      <label class="filter-item"><span>实际完成日</span><input v-model="form.actualDate" placeholder="未完成留空" /></label>
      <label class="filter-item"><span>计划掘进量</span><input v-model.number="form.planQty" type="number" /></label>
      <label class="filter-item"><span>实际完成量</span><input v-model.number="form.actualQty" type="number" /></label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="form.status">
          <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit">提交登记</button>
    </form>

    <div class="filter-bar">
      <label class="filter-item"><span>打包任务号</span><input v-model="packageId" placeholder="PKG-2026-10" /></label>
      <label class="filter-item"><span>每卷条数</span><input v-model.number="volumeSize" type="number" min="1" /></label>
      <button class="btn" type="button" @click="startPack">新建打包</button>
      <button class="btn" type="button" @click="resumePack">从断卷续打</button>
      <button class="btn" type="button" @click="downloadBooklet">下载册子</button>
      <button class="btn ghost" type="button" @click="recompute">重算交付清单偏差</button>
    </div>

    <div v-if="packageState" class="status-legend">
      <span class="legend-item">任务 {{ packageState.packageId }}：{{ packageState.status === 'complete' ? '全部卷完成' : '打包中' }}</span>
      <span v-for="v in packageState.volumes" :key="v.index" class="legend-item">
        第{{ v.index + 1 }}卷：{{ v.status === 'done' ? '已成卷' : `半包/未打(${v.nodeIds.length}条)` }}
      </span>
      <span v-if="packageState.lastFailedVolume !== null" class="legend-item error-text">
        断点：第{{ packageState.lastFailedVolume + 1 }}卷
      </span>
    </div>

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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <span :class="{ 'error-text': isMissingCell(row, column) }">{{ cellText(row, column) }}</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="act('开始节点', row)">开始节点</button>
            <button class="link" type="button" @click="act('确认完成', row)">确认完成</button>
            <button class="link" type="button" @click="act('登记延期', row)">登记延期</button>
            <button class="link" type="button" @click="askPlanChange(row)">改计划日</button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 1" class="empty-state">暂无进度节点数据，可先登记进度节点</td>
        </tr>
      </tbody>
    </table>

    <section v-if="missingColumns.length" class="filter-bar" style="flex-direction:column;align-items:flex-start">
      <strong>导出缺列核对（文件里逐列标出，未删列）：</strong>
      <span v-for="m in missingColumns" :key="m.column" class="legend-item error-text">
        {{ m.column }}：涉及 {{ m.codes.length }} 条（{{ m.codes.join('、') }}）
      </span>
    </section>

    <section class="filter-bar" style="flex-direction:column;align-items:flex-start">
      <strong>掘进环次交付清单（已完成节点数与进度页同源：{{ statsCompleted }}）</strong>
      <table class="data-table" v-if="deliveries.length">
        <thead><tr><th>任务号</th><th>时间</th><th>导出条数</th><th>已完成节点</th><th>结论</th><th>偏差算法</th></tr></thead>
        <tbody>
          <tr v-for="d in deliveries" :key="d.id">
            <td>{{ d.packageId }}</td><td>{{ d.at.slice(0, 16).replace('T', ' ') }}</td>
            <td>{{ d.exportedCount }}</td><td>{{ d.completedCount }}</td>
            <td>{{ d.conclusion }}</td><td>{{ d.deviationVersion }}</td>
          </tr>
        </tbody>
      </table>
      <span v-else class="legend-item">暂无交付记录</span>
    </section>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条在办/在册进度节点记录（含补录）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  changePlanDate,
  downloadTextFile,
  exportProgress,
  getProgressRows,
  getProgressStats,
  getProgressPackage,
  buildProgressBooklet,
  listProgressDeliveries,
  recomputeProgressDeliveries,
  registerProgressNodes,
  resumeProgressPackage,
  startProgressPackage,
  writeProgressExportConclusion,
} from '@/data/progress'
import { runAction as applyAction } from '@/api/local-service'
import type { NodeProjection, Role } from '@/data/progress'

const columns = ['序号', '节点编号', '节点名称', '计划完成日', '实际完成日', '计划掘进量', '实际完成量', '偏差天数', '节点状态']
const statuses = ['未开始', '进行中', '已完成', '已延期']
const filterFields = ['节点编号', '节点名称', '计划完成日']

const rows = ref<NodeProjection[]>([])
const deliveries = ref(listProgressDeliveries())
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const showForm = ref(false)
const packageId = ref('PKG-2026-10')
const volumeSize = ref(10)
const packageState = ref(getProgressPackage(packageId.value))

const form = reactive({ code: '', name: '', planDate: '', actualDate: '', planQty: 0, actualQty: 0, status: '未开始' as string })

const stats = computed(() => {
  const s = getProgressStats()
  return [
    { label: '进行中节点', value: s.inProgress },
    { label: '已完成节点', value: s.completed },
    { label: '延期节点', value: s.delayed },
  ]
})
const statsCompleted = computed(() => getProgressStats().completed)

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((r) => r.status === status).length })),
)

const filteredRows = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, v]) => v.trim() !== '')
  if (!pairs.length) {
    return rows.value
  }
  const keyOf: Record<string, keyof NodeProjection> = {
    节点编号: 'code',
    节点名称: 'name',
    计划完成日: 'planDate',
  }
  return rows.value.filter((r) => pairs.every(([field, value]) => String(r[keyOf[field]] ?? '').includes(value.trim())))
})

const missingColumns = computed(() => exportProgress().missingColumns)

function cellText(row: NodeProjection, column: string): string {
  const map: Record<string, string | number | null> = {
    序号: row.ordinal,
    节点编号: row.code,
    节点名称: row.name,
    计划完成日: row.planDate,
    实际完成日: row.actualDate,
    计划掘进量: row.planQty,
    实际完成量: row.actualQty,
    偏差天数: row.deviationDays,
    节点状态: row.status,
  }
  const v = map[column]
  return v === null || v === '' ? '—' : String(v)
}

function isMissingCell(row: NodeProjection, column: string): boolean {
  return row.missingColumns.includes(column)
}

function resetFilters() {
  filters.value = {}
}

function reload() {
  rows.value = getProgressRows()
  deliveries.value = listProgressDeliveries()
  packageState.value = getProgressPackage(packageId.value)
}

function exportRows() {
  const snapshot = exportProgress()
  downloadTextFile(snapshot.filename, snapshot.content)
  const missingText = snapshot.missingColumns.length
    ? `缺列：${snapshot.missingColumns.map((m) => m.column).join('、')}`
    : '无缺列'
  // 导出处理结论写进掘进环次交付清单，已完成数取台账同源口径。
  const id = `CSV-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
  deliveries.value = writeProgressExportConclusion(id, `已导出${snapshot.total}条，${missingText}`)
}

function submitRegister() {
  // idemKey 用内容指纹：同一条重复点两次只生效一次。
  const idemKey = `reg:${[form.code, form.name, form.planDate, form.actualDate, form.planQty, form.actualQty, form.status].join('|')}`
  const result = registerProgressNodes(
    [{ code: form.code, name: form.name, planDate: form.planDate, actualDate: form.actualDate, planQty: form.planQty, actualQty: form.actualQty, status: form.status as NodeProjection['status'] }],
    idemKey,
  )
  if (result.idempotentReplay) {
    errorMessage.value = '该登记已提交过，重复提交只生效一次'
  } else if (result.droppedDuplicates.length) {
    errorMessage.value = `节点 ${result.droppedDuplicates.join('、')} 已存在，重复登记只保留最早那条，本次未覆盖`
  } else {
    errorMessage.value = ''
  }
  showForm.value = false
  reload()
}

function act(action: string, row: NodeProjection) {
  const result = applyAction('progress', row.id, action)
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

function askPlanChange(row: NodeProjection) {
  // 已完成节点计划日冻结；未完成需监理及以上。这里用浏览器角色模拟审批层级。
  const role = (window.prompt('以哪个角色提交？班组/项目部/监理/建设单位', '监理') ?? '') as Role
  if (!role) {
    return
  }
  const next = window.prompt(`将节点 ${row.code} 的计划完成日改为(YYYY-MM-DD)：`, row.planDate) ?? ''
  const result = changePlanDate(row.code, next, role)
  // 越权/越级/冻结都在这里被驳回，并明确卡在哪一步。
  errorMessage.value = result.ok ? '' : `已驳回（${result.step}）：${result.message}`
  reload()
}

function startPack() {
  const result = startProgressPackage(packageId.value, `pkg:${packageId.value}`, volumeSize.value || 10)
  errorMessage.value = result.idempotentReplay ? '该打包任务已存在，重复提交只生效一次' : ''
  packageState.value = result.pkg
}

function resumePack() {
  try {
    packageState.value = resumeProgressPackage(packageId.value)
    errorMessage.value = packageState.value.status === 'complete' ? '全部卷已续打完成，可下载册子' : ''
  } catch (e) {
    packageState.value = getProgressPackage(packageId.value)
    errorMessage.value = e instanceof Error ? e.message : '续打失败'
  }
}

function downloadBooklet() {
  try {
    const file = buildProgressBooklet(packageId.value)
    downloadTextFile(file.filename, file.content)
    deliveries.value = writeProgressExportConclusion(packageId.value, `册子已出齐，共${getProgressPackage(packageId.value)?.volumes.length ?? 0}卷`)
    errorMessage.value = ''
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '册子下载被驳回'
  }
  reload()
}

function recompute() {
  deliveries.value = recomputeProgressDeliveries()
  errorMessage.value = '已生成的交付清单已按台账新偏差算法重算'
}

onMounted(reload)
</script>
