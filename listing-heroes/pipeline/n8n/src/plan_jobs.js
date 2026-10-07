// Plan GPU jobs from the listing file (mirrors run_listing.py plan()).
// The parsed listings/<id>.json comes from Parse listing (Extract From File puts it in json.data); repo from Config.
const L = $('Parse listing').first().json.data;
const repo = $('Config').first().json.repo;
const join = (...p) => p.join('/').replace(/\/+/g, '/');
const base = join(repo, 'pipeline/listings');
const resolve = (rel) => {
  if (rel.startsWith('/')) return rel;
  const parts = join(base, rel).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
  return '/' + out.filter(Boolean).join('/');
};
const photos = resolve(L.photos_dir);
const outDir = resolve(L.out_dir);
const servers = Object.assign({ gpu0: 'http://127.0.0.1:8188' }, L.servers || {});
servers.gpu1 = servers.gpu1 || servers.gpu0;
const photo = (n) => `${photos}/${n}.jpg`;
const jobs = [];
for (const n of L.depth || []) jobs.push({ kind: 'depth', server: servers.gpu0, name: n, workflow: 'depth', params: { image: photo(n) }, dir: `${outDir}/raw` });
for (const d of L.dusk || []) jobs.push({ kind: 'dusk', server: servers.gpu0, name: `${d.photo}-dusk`, workflow: 'dusk', params: Object.assign({ image: photo(d.photo) }, d.prompt ? { prompt: d.prompt } : {}), dir: outDir });
for (const v of L.living || []) jobs.push({ kind: 'living', server: servers.gpu0, name: `${v.photo}-living`, workflow: 'living', params: Object.assign({ image: photo(v.photo) }, v.prompt ? { prompt: v.prompt } : {}), dir: outDir });
(L.transitions || []).forEach((t, i) => {
  const params = { first: photo(t.from), last: photo(t.to), prompt: t.prompt };
  for (const k of ['seconds', 'strength', 'seed']) if (k in t) params[k] = t[k];
  jobs.push({ kind: 'transition', server: i % 2 === 0 ? servers.gpu1 : servers.gpu0, name: `${t.from}-to-${t.to}`, workflow: 'transition', params, dir: outDir });
});
// custom jobs: {"workflow": "selftest", "name": "front-test", "images": {"image": "front"}, "params": {...}, "gpu": "gpu1"}
for (const c of L.jobs || []) {
  const params = Object.assign({}, c.params || {});
  for (const [k, n] of Object.entries(c.images || {})) params[k] = photo(n);
  jobs.push({ kind: 'custom', server: servers[c.gpu || 'gpu0'], name: c.name, workflow: c.workflow, params, dir: outDir });
}
return jobs.map((j) => ({ json: Object.assign(j, { mode: 'submit', repo, listing_id: L.id, interpolate: !!L.interpolate_transitions }) }));
