<template>
  <div class="page">
    <div>
      <h1>灰度策略</h1>
      <p class="muted">最低兼容版本写在 policy.json，不改 Velopack 的 releases.win.json。百分比灰度和草稿白名单只在客户端访问本服务时生效；直接拷贝磁盘目录时，只有已全量发布的版本。</p>
    </div>
    <el-card shadow="never">
      <div class="heading">
        <el-select v-model="appId" style="width: 220px" @change="load">
          <el-option v-for="app in apps" :key="app.id" :label="app.name" :value="app.id" />
        </el-select>
        <el-radio-group v-model="channel" @change="load">
          <el-radio-button v-for="item in channels" :key="item.id" :value="item.id">{{ item.name }}</el-radio-button>
        </el-radio-group>
      </div>
      <el-form inline style="margin-top: 16px">
        <el-form-item label="最低兼容版本">
          <el-input v-model="minVersion" placeholder="1.2.0，留空表示不限制" style="width: 240px" :disabled="session.role !== 'admin'" />
        </el-form-item>
        <el-form-item>
          <el-button v-if="session.role === 'admin'" type="primary" @click="saveMin">保存</el-button>
        </el-form-item>
      </el-form>
      <p class="muted">客户端地址 {{ origin }}/updates/{{ appId }}/{{ channel }}/policy.json</p>
    </el-card>

    <el-card shadow="never">
      <template #header>通道内版本</template>
      <el-table :data="versions" empty-text="这个通道还没有可调整的版本">
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><el-tag :type="statusType(row)">{{ statusText(row) }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="version" label="版本" width="140" />
        <el-table-column label="灰度比例" width="120">
          <template #default="{ row }">{{ row.rolloutPercent }}%</template>
        </el-table-column>
        <el-table-column label="设备白名单" min-width="180">
          <template #default="{ row }">{{ row.whitelistDevices.join("、") || "—" }}</template>
        </el-table-column>
        <el-table-column label="IP 白名单" min-width="160">
          <template #default="{ row }">{{ row.whitelistIps.join("、") || "—" }}</template>
        </el-table-column>
        <el-table-column label="" width="100">
          <template #default="{ row }">
            <el-button v-if="session.role === 'admin'" link type="primary" @click="edit(row)">调整</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="editing" :title="current ? `调整 ${current.version}` : '调整灰度'" width="520px">
      <el-form label-position="top">
        <el-form-item label="放行比例">
          <el-slider v-model="percent" :min="0" :max="100" show-input />
        </el-form-item>
        <el-form-item label="设备白名单">
          <el-input v-model="devices" type="textarea" :rows="4" placeholder="每行一个设备 ID。这些设备不受比例限制。" />
        </el-form-item>
        <el-form-item label="IP 白名单">
          <el-input v-model="ips" type="textarea" :rows="4" placeholder="每行一个 IP" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editing = false">取消</el-button>
        <el-button type="primary" @click="saveRollout">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import { channels, statusText, statusType } from "../labels";
import { session } from "../session";

const apps = ref([]);
const appId = ref("single-arm");
const channel = ref("stable");
const minVersion = ref("");
const versions = ref([]);
const editing = ref(false);
const current = ref(null);
const percent = ref(100);
const devices = ref("");
const ips = ref("");
const origin = window.location.origin;

onMounted(async () => {
  apps.value = (await api.apps()).apps;
  await load();
});

async function load() {
  const page = await api.app(appId.value);
  versions.value = page.versions.filter((row) => row.channel === channel.value && row.status !== "deprecated");
  const policies = (await api.policies()).policies;
  minVersion.value = policies.find((item) => item.appId === appId.value && item.channel === channel.value)?.minSupportedVersion || "";
}

async function saveMin() {
  try {
    await api.savePolicy(appId.value, channel.value, minVersion.value.trim());
    ElMessage.success("已保存最低兼容版本");
  } catch (error) {
    ElMessage.error(error.message);
  }
}

function edit(row) {
  current.value = row;
  percent.value = row.rolloutPercent;
  devices.value = row.whitelistDevices.join("\n");
  ips.value = row.whitelistIps.join("\n");
  editing.value = true;
}

async function saveRollout() {
  try {
    await api.rollout(appId.value, channel.value, current.value.version, {
      rolloutPercent: percent.value,
      devices: devices.value.split(/\n/).map((item) => item.trim()).filter(Boolean),
      ips: ips.value.split(/\n/).map((item) => item.trim()).filter(Boolean),
    });
    editing.value = false;
    ElMessage.success("已保存灰度规则");
    await load();
  } catch (error) {
    ElMessage.error(error.message);
  }
}
</script>
