// Build the fair-housing / accuracy review request for the drafted copy.
const P = $('Copy config').first().json.prompts, L = $('Copy config').first().json.listing;
const draft = $input.first().json;
const body = {
  model: P.model,
  max_tokens: 16000,
  fallbacks: 'default',
  output_config: { effort: 'high', format: { type: 'json_schema', schema: P.check_schema } },
  system: P.check_system,
  messages: [{ role: 'user', content: `Listing: ${L.address}\nMLS facts:\n${JSON.stringify(L.facts, null, 2)}\n\nDraft copy:\n${JSON.stringify({ headline: draft.headline, summary: draft.summary, rooms: draft.rooms }, null, 2)}\n\nReview every room. The headline and summary must pass too; report them with photo "headline" or "summary".` }],
};
return [{ json: { body, draft } }];
