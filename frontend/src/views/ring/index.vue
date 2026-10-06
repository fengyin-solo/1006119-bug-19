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

    <section class="filter-bar" style="flex-direction:column;align-items:flex-start;margin-top:12px">
      <strong>掘进环次交付清单（进度节点导出结论｜台账已完成节点：{{ completedNodes }}）</strong>
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
      <button class="btn ghost" type="button" @click="recomputeDeviation">按台账新算法重算清单偏差</button>
      <span v-if="recomputeTip" class="legend-item">{{ recomputeTip }}</span>
    </section>
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
import { getProgressStats, listProgressDeliveries, recomputeProgressDeliveries } from '@/data/progress'
import type { DeliveryItem } from '@/data/progress'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ring')
const columns = ["环号", "起始里程", "掘进速度", "总推力", "刀盘扭矩", "出土方量", "掘进班组", "环次状态"]
const actions = ["开始掘进", "确认完成", "申请纠偏"]
const statuses = ["待掘进", "掘进中", "已贯通", "已纠偏"]
const stats = [{"label": "本月掘进环数", "value": 0}, {"label": "平均掘进速度", "value": 0}, {"label": "纠偏环数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '掘进环次列表读取失败'
  }
}

const deliveries = ref<DeliveryItem[]>(listProgressDeliveries())
const recomputeTip = ref('')
const completedNodes = computed(() => getProgressStats().completed)

function recomputeDeviation() {
  deliveries.value = recomputeProgressDeliveries()
  recomputeTip.value = '已生成的交付清单已按节点台账新偏差算法重算，已完成节点数两边一致'
}

onMounted(reload)
</script>
