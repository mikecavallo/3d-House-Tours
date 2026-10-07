// Build the ComfyUI API prompt for one job: load the workflow, apply params (image params use the uploaded
// names collected by the previous nodes), randomise seeds the caller didn't pin.
// Runs once per item. Input item = the job plus uploads { paramName: 'subfolder/name' };
// $('Parse workflow files') holds manifest.json and every workflow file.
const job = $input.item.json;
const files = {};
for (const it of $('Parse workflow files').all()) files[it.json.file] = it.json.data;
const manifest = files['manifest.json'];
const spec = manifest.workflows[job.workflow];
if (!spec) throw new Error(`unknown workflow ${job.workflow}`);
const prompt = JSON.parse(JSON.stringify(files[spec.file]));
const byTitle = (t) => {
  const id = Object.keys(prompt).find((k) => (prompt[k]._meta || {}).title === t);
  if (!id) throw new Error(`${job.workflow}: no node titled "${t}"`);
  return id;
};
const uploads = job.uploads || {};
for (const [key, raw] of Object.entries(job.params)) {
  const targets = spec.params[key];
  if (!targets) throw new Error(`${job.workflow}: unknown param ${key}`);
  const kind = targets[0][2];
  let v = raw;
  if (kind === 'image') v = uploads[key];
  else if (kind === 'int') v = parseInt(raw, 10);
  else if (kind === 'float') v = parseFloat(raw);
  else if (kind === 'bool') v = ['1', 'true', 'yes', true].includes(raw);
  for (const [title, field] of targets) prompt[byTitle(title)].inputs[field] = v;
}
if (!('seed' in job.params)) {
  for (const node of Object.values(prompt)) {
    for (const f of ['seed', 'noise_seed']) {
      if (f in node.inputs && !Array.isArray(node.inputs[f])) node.inputs[f] = Math.floor(Math.random() * 2 ** 48);
    }
  }
}
return { json: Object.assign({}, job, { prompt_body: { prompt, client_id: 'listing-heroes-n8n' }, outputs: spec.outputs, titles: Object.fromEntries(Object.entries(spec.outputs).map(([label, t]) => [label, byTitle(t)])) }) };
