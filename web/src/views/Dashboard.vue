<template>
  <div class="page">
    <div class="heading">
      <div>
        <h1>看板</h1>
        <p class="muted">现场设备上报心跳后，这里汇总在线情况和各版本占比。</p>
      </div>
      <el-select v-model="appId" style="width: 220px" @change="load">
        <el-option label="全部程序" value="" />
        <el-option v-for="app in apps" :key="app.id" :label="app.name" :value="app.id" />
      </el-select>
    </div>

    <div class="stats">
      <el-card shadow="never"><el-statistic title="设备总数" :value="board.deviceTotal" /></el-card>
      <el-card shadow="never"><el-statistic title="在线设备" :value="board.deviceOnline" /></el-card>
      <el-card shadow="never"><el-statistic title="近 7 天更新失败" :value="board.failureTotal" /></el-card>
      <el-card shadow="never"><el-statistic title="历史版本" :value="historyTotal" /></el-card>
    </div>

    <el-row :gutter="16">
      <el-col v-for="app in apps" :key="app.id" :xs="24" :sm="12" :lg="6">
        <router-link class="card-link" :to="`/apps/${app.id}`">
          <el-card class="app-card" shadow="hover">
            <h2>{{ app.name }}</h2>
            <p class="latest">{{ app.latestVersion || "尚未发布" }}</p>
            <p class="muted">历史版本 {{ app.historyCount }} 个<span v-if="app.withdrawnCount">，已下线 {{ app.withdrawnCount }} 个</span></p>
            <p class="notes">{{ app.notes || "暂无更新说明" }}</p>
          </el-card>
        </router-link>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :xs="24" :lg="12">
        <el-card shadow="never">
          <template #header>版本分布</template>
          <el-empty v-if="board.versionShares.length === 0" description="还没有设备上报" />
          <div v-else ref="pieEl" class="chart"></div>
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="12">
        <el-card shadow="never">
          <template #header>近 7 天更新失败</template>
          <div ref="lineEl" class="chart"></div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <template #header>最近失败</template>
      <el-table :data="board.recentFailures" empty-text="近 7 天没有失败记录">
        <el-table-column prop="machineName" label="设备" min-width="140">
          <template #default="{ row }">{{ row.machineName || row.deviceId }}</template>
        </el-table-column>
        <el-table-column prop="version" label="版本" width="120" />
        <el-table-column prop="message" label="错误" min-width="220" />
        <el-table-column label="时间" width="190">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { api } from "../api";
import { formatTime } from "../format";

echarts.use([LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const apps = ref([]);
const appId = ref("");
const board = ref({ deviceTotal: 0, deviceOnline: 0, failureTotal: 0, versionShares: [], failures: [], recentFailures: [] });
const pieEl = ref(null);
const lineEl = ref(null);
let pie;
let line;
const historyTotal = computed(() => apps.value.reduce((sum, app) => sum + (appId.value && app.id !== appId.value ? 0 : app.historyCount), 0));

onMounted(async () => {
  apps.value = (await api.apps()).apps;
  await load();
  window.addEventListener("resize", resize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", resize);
  pie?.dispose();
  line?.dispose();
});

watch(board, () => nextTick(draw), { deep: true });

async function load() {
  board.value = await api.dashboard(appId.value);
}

function draw() {
  if (!pieEl.value) {
    pie?.dispose();
    pie = undefined;
  } else {
    pie ??= echarts.init(pieEl.value);
    pie.setOption({
      tooltip: { trigger: "item" },
      legend: { bottom: 0 },
      series: [{
        type: "pie",
        radius: ["42%", "68%"],
        data: board.value.versionShares.map((item) => ({ name: item.version, value: item.count })),
      }],
    });
  }
  if (lineEl.value) {
    line ??= echarts.init(lineEl.value);
    line.setOption({
      tooltip: { trigger: "axis" },
      grid: { left: 40, right: 16, top: 24, bottom: 32 },
      xAxis: { type: "category", data: board.value.failures.map((item) => item.date.slice(5)) },
      yAxis: { type: "value", minInterval: 1 },
      series: [{ type: "line", smooth: true, data: board.value.failures.map((item) => item.count), areaStyle: {} }],
    });
  }
}

function resize() {
  pie?.resize();
  line?.resize();
}
</script>
