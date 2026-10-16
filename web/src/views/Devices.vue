<template>
  <div class="page">
    <div class="heading">
      <div>
        <h1>现场设备</h1>
        <p class="muted">客户端检查更新时上报心跳。超过 5 分钟没有心跳记为离线。</p>
      </div>
      <el-select v-model="appId" style="width: 220px" @change="load">
        <el-option label="全部程序" value="" />
        <el-option v-for="app in apps" :key="app.id" :label="app.name" :value="app.id" />
      </el-select>
    </div>
    <el-card shadow="never">
      <el-table :data="rows" empty-text="还没有设备上报" @row-click="open">
        <el-table-column label="设备" min-width="160">
          <template #default="{ row }">
            <div>{{ row.machineName || row.deviceId }}</div>
            <div class="muted">{{ row.deviceId }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="appName" label="程序" width="140" />
        <el-table-column prop="ip" label="IP" width="140" />
        <el-table-column prop="version" label="当前版本" width="120" />
        <el-table-column prop="group" label="分组" width="120" />
        <el-table-column label="通道" width="90">
          <template #default="{ row }">{{ row.channel ? channelName(row.channel) : "—" }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.online ? 'success' : 'info'">{{ row.online ? "在线" : "离线" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近更新" width="120">
          <template #default="{ row }">
            <el-tag :type="row.lastEvent === 'Failed' ? 'danger' : row.lastEvent === 'AppliedSuccess' ? 'success' : 'info'">
              {{ eventText(row.lastEvent) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最后心跳" width="190">
          <template #default="{ row }">{{ formatTime(row.lastSeen) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-drawer v-model="drawer" :title="current ? (current.machineName || current.deviceId) : '设备'" size="480px">
      <p v-if="current?.lastError" class="muted">最近错误：{{ current.lastError }}</p>
      <el-timeline>
        <el-timeline-item v-for="item in events" :key="item.id" :timestamp="formatTime(item.createdAt)" :type="item.event === 'Failed' ? 'danger' : 'primary'">
          <div>{{ eventText(item.event) }} {{ item.version }}</div>
          <div v-if="item.message" class="muted">{{ item.message }}</div>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-if="events.length === 0" description="还没有更新事件" />
    </el-drawer>
  </div>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { api } from "../api";
import { formatTime } from "../format";
import { channelName, eventText } from "../labels";

const apps = ref([]);
const appId = ref("");
const rows = ref([]);
const drawer = ref(false);
const current = ref(null);
const events = ref([]);

onMounted(async () => {
  apps.value = (await api.apps()).apps;
  await load();
});

async function load() {
  rows.value = (await api.devices(appId.value)).devices;
}

async function open(row) {
  current.value = row;
  events.value = (await api.events(row.appId, row.deviceId)).events;
  drawer.value = true;
}
</script>
