import { createRouter, createWebHistory } from "vue-router";
import { api } from "./api";
import { session } from "./session";
import Layout from "./views/Layout.vue";
import Dashboard from "./views/Dashboard.vue";
import Releases from "./views/Releases.vue";
import Devices from "./views/Devices.vue";
import Policy from "./views/Policy.vue";
import Login from "./views/Login.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: Login },
    {
      path: "/",
      component: Layout,
      children: [
        { path: "", component: Dashboard },
        { path: "apps/:id", component: Releases },
        { path: "devices", component: Devices },
        { path: "policy", component: Policy },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  if (to.path === "/login") return true;
  const me = await api.me();
  if (!me) return "/login";
  session.user = me.user;
  session.role = me.role;
  session.factory = Boolean(me.usesFactoryPassword);
  return true;
});
