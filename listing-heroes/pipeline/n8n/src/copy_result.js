// Merge the review into the final rooms file the hero pages read (rooms.json).
const review = $input.first().json;
const draft = $('Build review request').first().json.draft;
const fix = (id, text) => { const i = review.issues.find((x) => x.photo === id); return i ? text.split(i.phrase).join(i.rewrite) : text; };
const out = {
  listing: $('Copy config').first().json.listing.id,
  generated: new Date().toISOString(),
  model: review._model,
  fair_housing_passed_first_draft: review.passes,
  issues_fixed: review.issues,
  headline: fix('headline', draft.headline),
  summary: fix('summary', draft.summary),
  rooms: review.rooms,
  note: 'Drafted with AI from the listing photos and MLS facts, reviewed for fair-housing language. Read it before publishing.',
};
const data = await this.helpers.prepareBinaryData(Buffer.from(JSON.stringify(out, null, 2)), 'rooms.json', 'application/json');
return [{ json: out, binary: { data } }];
