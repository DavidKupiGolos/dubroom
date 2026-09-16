import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const deployFile = (name) => readFile(new URL(`../deploy/${name}`, import.meta.url), "utf8");

test("nginx applies narrow defaults and route-specific media limits", async () => {
  const templates = await Promise.all([
    deployFile("nginx.conf.template"),
    deployFile("nginx-ssl.conf.template"),
  ]);
  for (const nginx of templates) {
    assert.match(nginx, /client_max_body_size 1m;/);
    assert.match(nginx, /location = \/v1\/projects[\s\S]*client_max_body_size 64k;/);
    assert.match(nginx, /location ~ \^\/v1\/projects\/\[\^\/\]\+\/takes[\s\S]*client_max_body_size 510m;/);
    assert.match(nginx, /location \^~ \/v1\/admin\/recommendations[\s\S]*client_max_body_size 4100m;/);
    assert.match(nginx, /limit_req zone=dubroom_project_create/);
    assert.match(nginx, /limit_req_status 429;/);
    assert.match(nginx, /limit_conn_status 429;/);
    assert.match(nginx, /proxy_set_header Range \$http_range;/);
    assert.match(nginx, /location ~ \^\/v1\/recommendations\/\[\^\/\]\+\/\(\?:poster\|video\)\$/);
    assert.match(nginx, /location = \/v1\/metrics[\s\S]*return 404;/);
  }
});

test("backup includes permanent data and verifies the archive", async () => {
  const [backup, verify, service, timer] = await Promise.all([
    deployFile("backup.sh"),
    deployFile("verify-backup.sh"),
    deployFile("dubroom-backup.service"),
    deployFile("dubroom-backup.timer"),
  ]);
  assert.match(backup, /paths=\(recommendations\)/);
  assert.match(backup, /paths\+=\(settings\.json\)/);
  assert.doesNotMatch(backup, /paths=.*projects/);
  assert.match(backup, /verify-backup\.sh/);
  assert.match(verify, /sha256sum -c/);
  assert.match(verify, /mapfile -t archive_members/);
  assert.match(verify, /tar -xOzf/);
  assert.match(verify, /JSON\.parse/);
  assert.match(service, /ExecStart=\/usr\/local\/lib\/dubroom\/backup\.sh/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /Unit=dubroom-backup\.service/);
});

test("production services run with baseline systemd hardening", async () => {
  const [api, web] = await Promise.all([deployFile("dubroom-api.service"), deployFile("dubroom-web.service")]);
  for (const service of [api, web]) {
    assert.match(service, /NoNewPrivileges=true/);
    assert.match(service, /PrivateDevices=true/);
    assert.match(service, /ProtectHome=true/);
    assert.match(service, /RestrictSUIDSGID=true/);
    assert.match(service, /UMask=0027/);
  }
});

test("systemd monitor checks readiness and dead-letter metrics", async () => {
  const [monitor, service, timer, installer] = await Promise.all([
    deployFile("monitor.sh"),
    deployFile("dubroom-monitor.service"),
    deployFile("dubroom-monitor.timer"),
    deployFile("install-server.sh"),
  ]);
  assert.match(monitor, /\/v1\/health\/ready/);
  assert.match(monitor, /\/v1\/metrics/);
  assert.match(monitor, /dubroom_job_dead_letter/);
  assert.match(service, /ExecStart=\/usr\/local\/lib\/dubroom\/monitor\.sh/);
  assert.match(timer, /OnUnitActiveSec=1m/);
  assert.match(installer, /dubroom-monitor\.timer/);
});

test("release activation supports repeat deployments and rollback", async () => {
  const activate = await deployFile("activate-release.sh");
  assert.match(activate, /previous="\$\(readlink -f/);
  assert.match(activate, /previous_moved=1/);
  assert.match(activate, /ln -s -- "\$\{previous\}" "\$\{app_path\}"/);
  assert.match(activate, /service_units=\(/);
});
