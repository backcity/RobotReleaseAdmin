<template>
  <el-container class="shell">
    <el-aside class="aside" width="232px">
      <div class="brand">发布管理</div>
      <el-menu background-color="#001529" text-color="#ffffffb3" active-text-color="#fff" :default-active="route.path" router>
        <el-menu-item index="/">
          <el-icon><Odometer /></el-icon>
          <span>看板</span>
        </el-menu-item>
        <el-menu-item-group title="版本历史">
          <el-menu-item v-for="app in apps" :key="app.id" :index="`/apps/${app.id}`">{{ app.name }}</el-menu-item>
        </el-menu-item-group>
        <el-menu-item index="/devices">
          <el-icon><Monitor /></el-icon>
          <span>现场设备</span>
        </el-menu-item>
        <el-menu-item index="/policy">
          <el-icon><Setting /></el-icon>
          <span>灰度策略</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="topbar">
        <span class="top-title">Velopack 版本与现场设备</span>
        <div class="top-actions">
          <span>{{ session.user }}</span>
          <el-tag size="small" effect="plain">{{ session.role === "admin" ? "发布管理员" : "现场运维" }}</el-tag>
          <el-button link @click="logout">退出</el-button>
        </div>
      </el-header>
      <el-main>
        <el-alert
          v-if="session.factory"
          title="当前仍是初始口令 change-me。部署前请修改 server/config.json 里的管理员密码、运维密码和 token。"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 16px"
        />
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Monitor, Odometer, Setting } from "@element-plus/icons-vue";
import { api } from "../api";
import { session } from "../session";

const route = useRoute();
const router = useRouter();
const apps = ref([]);

onMounted(async () => {
  apps.value = (await api.apps()).apps;
});

async function logout() {
  await api.logout();
  router.push("/login");
}
</script>
