// One item per photo/video the jobs need uploaded to ComfyUI (ji = index of the job).
const manifest = $('Parse workflow files').all().find((x) => x.json.file === 'manifest.json').json.data;
const ups = [];
$('Job').all().forEach((it, ji) => {
  const job = it.json, spec = manifest.workflows[job.workflow];
  for (const [key, value] of Object.entries(job.params)) {
    if (spec.params[key] && spec.params[key][0][2] === 'image') ups.push({ json: { ji, key, path: value, server: job.server } });
  }
});
return ups;
