// Classify one job from GET /history/<id>: pending, error or done (+ the files to download).
const job = $('Wait for job').item.json;
const hist = $input.item.json || {};
const entry = hist[job.prompt_id];
if (!entry) return { json: Object.assign({}, job, { state: 'pending' }) };
const st = entry.status || {};
if (st.status_str === 'error') {
  const errs = (st.messages || []).filter((m) => m[0] === 'execution_error').map((m) => `${m[1].node_type} (${m[1].node_id}): ${(m[1].exception_message || '').trim()}`);
  return { json: Object.assign({}, job, { state: 'error', error: errs.join('; ') || 'unknown ComfyUI error' }) };
}
if (st.completed === false) return { json: Object.assign({}, job, { state: 'pending' }) };
const downloads = [];
for (const [label, nodeId] of Object.entries(job.titles)) {
  const out = (entry.outputs || {})[nodeId] || {};
  const f = [].concat(out.images || [], out.videos || [], out.gifs || []).find((x) => x && x.filename && x.type === 'output');
  if (f) {
    const ext = f.filename.slice(f.filename.lastIndexOf('.'));
    downloads.push({ filename: f.filename, subfolder: f.subfolder || '', type: f.type, dest: `${job.dir}/${job.name}${label ? '-' + label : ''}${ext}` });
  }
}
if (!downloads.length) return { json: Object.assign({}, job, { state: 'error', error: 'job finished but saved nothing' }) };
return { json: Object.assign({}, job, { state: 'done', downloads }) };
