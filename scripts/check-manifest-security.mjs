// Checks the security context of every container in rendered Kubernetes
// manifests (`kustomize build` output), so a manifest that the kubelet would
// refuse, or that drops a hardening setting, fails CI instead of the live pod.
//
//   kustomize build install/manifests/overlays/main > rendered.yaml
//   node scripts/check-manifest-security.mjs rendered.yaml
//
// Why: Docker does not enforce runAsNonRoot, so the image smoke tests cannot
// catch "container has runAsNonRoot and image has non-numeric user". Setting a
// numeric, non-zero runAsUser in the manifest makes the kubelet's check pass
// whatever USER the image declares.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-manifest-security.mjs <rendered.yaml>');
  process.exit(2);
}

const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']);
const docs = parseAllDocuments(readFileSync(file, 'utf8')).map((d) => d.toJS());

const failures = [];
let checked = 0;

for (const doc of docs) {
  if (!doc || !WORKLOADS.has(doc.kind)) continue;
  const podSpec = doc.kind === 'CronJob' ? doc.spec.jobTemplate.spec.template.spec : doc.spec.template.spec;
  const pod = podSpec.securityContext ?? {};
  const containers = [...(podSpec.initContainers ?? []), ...(podSpec.containers ?? [])];

  for (const c of containers) {
    checked++;
    const where = `${doc.kind}/${doc.metadata.name} container ${c.name}`;
    const sc = c.securityContext ?? {};
    // Container settings override pod settings, as in Kubernetes
    const effective = (key) => (sc[key] !== undefined ? sc[key] : pod[key]);
    const check = (ok, message) => {
      if (!ok) failures.push(`${where}: ${message}`);
    };

    check(effective('runAsNonRoot') === true, 'runAsNonRoot must be true');
    for (const key of ['runAsUser', 'runAsGroup']) {
      const id = effective(key);
      check(Number.isInteger(id) && id > 0, `${key} must be a numeric, non-zero id (got ${JSON.stringify(id)})`);
    }
    check(sc.allowPrivilegeEscalation === false, 'allowPrivilegeEscalation must be false');
    check(sc.readOnlyRootFilesystem === true, 'readOnlyRootFilesystem must be true');
    check(sc.privileged !== true, 'privileged must not be true');
    const drop = sc.capabilities?.drop ?? [];
    check(drop.includes('ALL'), 'capabilities.drop must include ALL');
    check((sc.capabilities?.add ?? []).length === 0, 'capabilities.add must be empty');
    const seccomp = effective('seccompProfile')?.type;
    check(seccomp === 'RuntimeDefault' || seccomp === 'Localhost', 'seccompProfile must be RuntimeDefault or Localhost');
  }
}

try {
  assert.ok(checked > 0, `no workload containers found in ${file}`);
} catch (err) {
  failures.push(err.message);
}

if (failures.length > 0) {
  console.error(`Manifest security check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Manifest security check passed (${checked} container(s)).`);
