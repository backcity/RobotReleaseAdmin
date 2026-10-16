<template>
  <el-dialog
    :model-value="modelValue"
    title="发布新版本"
    width="680px"
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    @close="emit('update:modelValue', false)"
  >
    <p class="muted">可以上传单个 nupkg，也可以一次拖入 vpk 目录打好的 zip。版本号能从包名解析时可以留空。同一版本再次上传会替换它，比通道里已有版本更旧的号会被拒绝。</p>
    <el-form label-position="top">
      <el-row :gutter="12">
        <el-col :span="12">
          <el-form-item label="通道">
            <el-select v-model="form.channel" style="width: 100%">
              <el-option v-for="channel in channels" :key="channel.id" :label="channel.name" :value="channel.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="版本号">
            <el-input v-model="form.version" placeholder="1.2.3，可留空" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-form-item label="发布方式">
        <el-radio-group v-model="form.status">
          <el-radio value="active">立即发布</el-radio>
          <el-radio value="draft">存为草稿，仅白名单可下载</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="灰度比例">
        <el-slider v-model="form.percent" :min="0" :max="100" show-input />
      </el-form-item>
      <el-form-item label="更新说明">
        <el-input v-model="form.notes" type="textarea" :rows="5" maxlength="8000" show-word-limit placeholder="支持 Markdown" />
        <div class="preview notes-html" v-html="preview"></div>
      </el-form-item>
      <el-row :gutter="12">
        <el-col :span="12">
          <el-form-item label="设备白名单">
            <el-input v-model="form.devices" type="textarea" :rows="3" placeholder="每行一个设备 ID" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="IP 白名单">
            <el-input v-model="form.ips" type="textarea" :rows="3" placeholder="每行一个 IP" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-upload drag multiple :auto-upload="false" :file-list="files" :disabled="saving" :on-change="onChoose" :on-remove="onRemove">
        <div>把 .nupkg、releases.win.json、Setup.exe 或 .zip 拖到这里</div>
      </el-upload>
      <div v-if="saving" class="upload-progress">
        <el-progress :percentage="progress" :stroke-width="10" :striped="progress === 100" :striped-flow="progress === 100" />
        <p class="muted">{{ progressText }}</p>
      </div>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import { renderNotes } from "../format";
import { channels } from "../labels";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  appId: { type: String, required: true },
});
const emit = defineEmits(["update:modelValue", "done"]);
const saving = ref(false);
const progress = ref(0);
const progressText = computed(() => (
  progress.value < 100
    ? `正在上传 ${progress.value}%`
    : "文件已传到服务器，正在保存版本"
));
const files = ref([]);
const form = reactive({ channel: "stable", version: "", status: "active", percent: 100, notes: "", devices: "", ips: "" });
const preview = computed(() => renderNotes(form.notes));

watch(() => props.modelValue, (open) => {
  if (!open) return;
  files.value = [];
});

function onChoose(_file, list) {
  files.value = list;
}

function onRemove(_file, list) {
  files.value = list;
}

async function submit() {
  if (files.value.length === 0) {
    ElMessage.warning("请先选择要上传的文件。");
    return;
  }
  const body = new FormData();
  body.set("channel", form.channel);
  body.set("version", form.version.trim());
  body.set("notes", form.notes);
  body.set("status", form.status);
  body.set("rolloutPercent", String(form.percent));
  body.set("devices", form.devices);
  body.set("ips", form.ips);
  for (const file of files.value) body.append("packages", file.raw, file.name);
  saving.value = true;
  progress.value = 0;
  try {
    const saved = await api.publish(props.appId, body, (value) => {
      progress.value = value;
    });
    ElMessage.success(`已保存 ${saved.version}`);
    emit("update:modelValue", false);
    emit("done");
    form.version = "";
    form.notes = "";
    form.devices = "";
    form.ips = "";
    form.percent = 100;
    form.status = "active";
    files.value = [];
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    saving.value = false;
    progress.value = 0;
  }
}
</script>

<style scoped>
.upload-progress {
  margin-top: 16px;
}
</style>
