<template>
  <section class="page" data-module="ring">
    <header class="page-head">
      <div>
        <h2>掘进环次管理</h2>
        <p class="page-desc">维护掘进环，围绕环号、起始里程、掘进速度、总推力做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记掘进环</button>
        <button class="btn" type="button" @click="exportRows">导出掘进环次清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="panel">
      <h3>掘进环次交付清单（进度节点导出处理结论）</h3>
      <p class="page-desc">
        已完成节点数与进度节点台账读同一个函数：当前台账
        <strong>{{ ledgerCompleted }}</strong> 个，
        对账结果：<span :class="allMatched ? '' : 'error-text'">{{ allMatched ? '两边一致' : '两边对不上，请点对账刷新' }}</span>
        · 偏差天数算法以节点台账为准（{{ algorithm }}）
      </p>
      <div class="row-actions" style="margin:6px 0">
        <button class="btn" type="button" @click="recalc">按新算法重算已生成清单</button>
        <button class="btn" type="button" @click="refreshDeliveries">对账刷新</button>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>清单编号</th><th>导出任务</th><th>结论</th>
            <th>导出节点数</th><th>含补录</th><th>清单已完成数</th><th>台账已完成数</th>
            <th>已完成平均偏差(天)</th><th>在办最大偏差(天)</th><th>缺栏行</th><th>卷册</th><th>算法</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in deliveries" :key="record.id">
            <td>{{ record.id }}</td>
            <td>{{ record.jobId }}</td>
            <td style="max-width:360px">{{ record.conclusion }}</td>
            <td>{{ record.nodeTotal }}</td>
            <td>{{ record.backfilledIncluded }}</td>
            <td>{{ record.completedNodes }}</td>
            <td :class="record.matched ? '' : 'error-text'">{{ record.completedNodesNow }}</td>
            <td>{{ record.avgDeviationDone }}</td>
            <td>{{ record.maxDeviationActive }}</td>
            <td>{{ record.missingCellRows }}</td>
            <td>{{ record.volumesPacked }}/{{ record.volumes }}</td>
            <td>{{ record.algorithm }}</td>
          </tr>
          <tr v-if="!deliveries.length">
            <td colspan="12" class="empty-state">还没有交付清单：进度节点册子全部打包完成后，在进度节点页点「结论写入掘进环次交付清单」。</td>
          </tr>
        </tbody>
      </table>
      <p v-if="deliveryMessage" :class="recalcOk ? '' : 'error-text'" style="margin-top:6px">{{ deliveryMessage }}</p>
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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无掘进环次数据，可先登记掘进环</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条掘进环次记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  DEVIATION_ALGORITHM_VERSION,
  bootstrapProgress,
} from '@/data/progress-ledger'
import {
  listDeliveries,
  recalcDeliveries,
  reconcileDeliveries,
  type DeliveryRecord,
} from '@/data/ring-deliveries'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ring')
const columns = ["环号", "起始里程", "掘进速度", "总推力", "刀盘扭矩", "出土方量", "掘进班组", "环次状态"]
const actions = ["开始掘进", "确认完成", "申请纠偏"]
const statuses = ["待掘进", "掘进中", "已贯通", "已纠偏"]
const algorithm = DEVIATION_ALGORITHM_VERSION

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const deliveries = ref<DeliveryRecord[]>([])
const ledgerCompleted = ref(0)
const allMatched = ref(true)
const deliveryMessage = ref('')
const recalcOk = ref(true)

const stats = computed(() => [
  { label: '台账已完成进度节点', value: ledgerCompleted.value },
  { label: '交付清单份数', value: deliveries.value.length },
  { label: '两边已完成数一致', value: allMatched.value ? '是' : '否' },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function refreshDeliveries() {
  const result = reconcileDeliveries()
  deliveries.value = result.records
  ledgerCompleted.value = result.ledgerCompleted
  allMatched.value = result.allMatched
}

function recalc() {
  const result = recalcDeliveries()
  recalcOk.value = result.ok
  deliveryMessage.value = result.message
  refreshDeliveries()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '掘进环登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    bootstrapProgress()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshDeliveries()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '掘进环次列表读取失败'
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
</style>
