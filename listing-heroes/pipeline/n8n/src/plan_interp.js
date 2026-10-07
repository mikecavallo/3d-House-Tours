// Follow-up jobs: double each transition's frame rate with FILM (writes <name>-50fps.mp4 next to it).
const jobs = $('Plan jobs').all().map((x) => x.json).filter((j) => j.kind === 'transition' && j.interpolate);
return jobs.map((j) => ({ json: { kind: 'interpolate', mode: 'submit', server: j.server, repo: j.repo, listing_id: j.listing_id,
  name: `${j.name}-50fps`, workflow: 'interpolate', params: { video: `${j.dir}/${j.name}.mp4` }, dir: j.dir } }));
