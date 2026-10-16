<template>
  <div v-if="page" class="page">
    <div class="heading">
      <div>
        <el-breadcrumb separator="/">
          <el-breadcrumb-item :to="{ path: '/' }">看板</el-breadcrumb-item>
          <el-breadcrumb-item>{{ page.app.name }}</el-breadcrumb-item>
        </el-breadcrumb>
        <h1>{{ page.app.name }}</h1>
        <p class="muted">包名 <code>{{ page.app.packId }}</code>。下面这张表是全部历史版本，包括草稿、灰度、已发布和已下线。</p>
      </div>
      <el-button v-if="session.role === 'admin'" type="primary" @click="open = true">发布新版本</el-button>
    </div>

    <el-card shadow="never">
      <div class="url-line">
        <span class="muted">客户端地址</span>
        <el-input :model-value="updateUrl" readonly />
        <el-button @click="copy(updateUrl)">复制</el-button>
      </div>
      <p class="muted">Velopack 的更新目录指向这个地址，它会拉取其中的 releases.win.json。按设备灰度时把地址写成 {{ deviceUrl }}。不带通道的 {{ aliasUrl }} 等同于正式通道。</p>
    </el-card>

    <div class="stats">
      <el-card shadow="never"><el-statistic title="历史版本" :value="shown.length" /></el-card>
      <el-card shadow="never"><el-statistic title="已发布" :value="shown.filter((row) => row.displayStatus === 'active').length" /></el-card>
      <el-card shadow="never"><el-statistic title="已下线" :value="shown.filter((row) => row.displayStatus === 'deprecated').length" /></el-card>
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="heading">
          <strong>历史版本</strong>
          <div class="filters">
            <el-radio-group v-model="channel">
              <el-radio-button value="all">全部通道</el-radio-button>
              <el-radio-button v-for="item in channels" :key="item.id" :value="item.id">{{ item.name }}</el-radio-button>
            </el-radio-group>
            <el-radio-group v-model="state">
              <el-radio-button value="all">全部</el-radio-button>
              <el-radio-button value="active">已发布</el-radio-button>
              <el-radio-button value="gray">灰度中</el-radio-button>
              <el-radio-button value="draft">草稿</el-radio-button>
              <el-radio-button value="deprecated">已下线</el-radio-button>
            </el-radio-group>
          </div>
        </div>
      </template>
      <el-table :data="filtered" empty-text="还没有历史版本" stripe>
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><el-tag :type="statusType(row)">{{ statusText(row) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="通道" width="90">
          <template #default="{ row }">{{ channelName(row.channel) }}</template>
        </el-table-column>
        <el-table-column prop="version" label="版本" width="130" />
        <el-table-column label="更新说明" min-width="200">
          <template #default="{ row }">
            <el-button link @click="notes = row">{{ row.notes ? row.notes.split("\n")[0] : "—" }}</el-button>
          </template>
        </el-table-column>
        <el-table-column label="全量包" width="110">
          <template #default="{ row }">{{ formatSize(row.fullSize) }}</template>
        </el-table-column>
        <el-table-column label="差分包" width="110">
          <template #default="{ row }">{{ formatSize(row.deltaSize) }}</template>
        </el-table-column>
        <el-table-column label="灰度" width="80">
          <template #default="{ row }">{{ row.displayStatus === "deprecated" ? "—" : `${row.rolloutPercent}%` }}</template>
        </el-table-column>
        <el-table-column label="SHA1" min-width="160">
          <template #default="{ row }"><span class="sha" :title="row.sha1">{{ row.sha1 || "—" }}</span></template>
        </el-table-column>
        <el-table-column label="发布时间" width="180">
          <template #default="{ row }">{{ formatTime(row.publishedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <div class="actions">
              <el-link v-if="row.displayStatus === 'active'" :href="`/updates/${page.app.id}/${row.channel}/${row.fullFileName}`" target="_blank">下载</el-link>
              <el-link :href="`/api/apps/${page.app.id}/versions/${row.channel}/${encodeURIComponent(row.version)}/export`">导出离线包</el-link>
              <el-button v-if="session.role === 'admin' && row.status !== 'deprecated'" link type="danger" @click="withdraw(row)">下线</el-button>
              <el-button v-if="session.role === 'admin' && row.displayStatus === 'draft'" link type="primary" @click="activate(row)">发布</el-button>
              <el-button v-if="session.role === 'admin' && row.displayStatus === 'deprecated'" link type="primary" @click="activate(row)">重新上线</el-button>
              <span v-if="row.displayStatus === 'deprecated'" class="muted">{{ row.fileKept ? "包仍在磁盘" : "磁盘上已没有这个包" }}</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog :model-value="Boolean(notes)" title="更新说明" width="560px" @close="notes = null">
      <div v-if="notes" class="notes-html" v-html="renderNotes(notes.notes)"></div>
    </el-dialog>
    <UploadDialog v-model="open" :app-id="page.app.id" @done="load" />
  </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import UploadDialog from "../components/UploadDialog.vue";
import { api } from "../api";
import { copyText, formatSize, formatTime, renderNotes } from "../format";
import { channelName, channels, statusText, statusType } from "../labels";
import { session } from "../session";

const route = useRoute();
const page = ref(null);
const channel = ref("all");
const state = ref("all");
const open = ref(false);
const notes = ref(null);

const shown = computed(() => {
  const rows = page.value?.versions ?? [];
  return channel.value === "all" ? rows : rows.filter((row) => row.channel === channel.value);
});
const filtered = computed(() => (
  state.value === "all" ? shown.value : shown.value.filter((row) => row.displayStatus === state.value)
));
const selectedChannel = computed(() => (channel.value === "all" ? "stable" : channel.value));
const origin = window.location.origin;
const updateUrl = computed(() => `${origin}/updates/${route.params.id}/${selectedChannel.value}/`);
const deviceUrl = computed(() => `${origin}/updates/${route.params.id}/${selectedChannel.value}/d/{设备ID}/`);
const aliasUrl = computed(() => `${origin}/updates/${route.params.id}/`);

watch(() => route.params.id, load, { immediate: true });

async function load() {
  page.value = await api.app(route.params.id);
}

async function copy(text) {
  await copyText(text);
  ElMessage.success("已复制");
}

async function withdraw(row) {
  try {
    await ElMessageBox.confirm(`从${channelName(row.channel)}通道下线 ${row.version}？包会留在磁盘上，历史记录里仍能看到。`, "下线版本", {
      type: "warning",
      confirmButtonText: "下线",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  try {
    await api.unpublish(route.params.id, row.channel, row.version);
    ElMessage.success(`已下线 ${row.version}`);
    await load();
  } catch (error) {
    ElMessage.error(error.message);
  }
}

async function activate(row) {
  try {
    await api.activate(route.params.id, row.channel, row.version);
    ElMessage.success(`已放回${channelName(row.channel)}通道 ${row.version}`);
    await load();
  } catch (error) {
    ElMessage.error(error.message);
  }
}
</script>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
</style>
