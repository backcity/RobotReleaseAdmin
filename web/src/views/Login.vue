<template>
  <div class="login-wrap">
    <el-card class="login-card" shadow="hover">
      <h1>发布管理</h1>
      <p class="muted">管理单臂、双臂客户端和后台的 Velopack 版本。发布管理员可以上传和下线，现场运维只能查看和导出。</p>
      <el-form :model="form" label-position="top" @submit.prevent="submit">
        <el-form-item label="账号">
          <el-input v-model="form.userName" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <el-button type="primary" native-type="submit" :loading="loading" style="width: 100%">进入</el-button>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api } from "../api";

const router = useRouter();
const loading = ref(false);
const form = reactive({ userName: "admin", password: "" });

async function submit() {
  loading.value = true;
  try {
    await api.login(form.userName, form.password);
    router.push("/");
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}
</script>
