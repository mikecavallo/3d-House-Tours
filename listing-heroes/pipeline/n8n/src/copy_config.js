// Gather everything the copy steps need: repo, listing, prompts, and absolute photo/output folders.
const repo = $('Config').first().json.repo;
const listing = $('Parse listing').first().json.data;
const prompts = $input.first().json.data;
const base = `${repo}/pipeline/listings`;
const resolve = (rel) => {
  const parts = (rel.startsWith('/') ? rel : `${base}/${rel}`).split('/');
  const out = [];
  for (const s of parts) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return '/' + out.join('/');
};
return [{ json: { repo, listing, prompts, photos: resolve(listing.photos_dir), out_dir: resolve(listing.out_dir) } }];
