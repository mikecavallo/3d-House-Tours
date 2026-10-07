// Give every job the names ComfyUI assigned its uploads ("subfolder/name"), keyed by param.
const metas = $('List uploads').all().map((x) => x.json);
const byJob = {};
$input.all().forEach((it, k) => {
  const m = metas[k];
  (byJob[m.ji] = byJob[m.ji] || {})[m.key] = it.json.subfolder ? `${it.json.subfolder}/${it.json.name}` : it.json.name;
});
return $('Job').all().map((it, ji) => ({ json: Object.assign({}, it.json, { uploads: byJob[ji] || {} }) }));
