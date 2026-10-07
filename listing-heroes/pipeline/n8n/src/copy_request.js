// Build the Messages API request that drafts room-by-room copy from the room photos + MLS facts.
// Run once for all items. Items come from "Read room photos" (binary.data = the photo, json.room/photo).
const cfg = $('Copy config').first().json;           // { prompts, listing }
const P = cfg.prompts, L = cfg.listing;
const content = [{ type: 'text', text: `Listing: ${L.address}\nMLS facts:\n${JSON.stringify(L.facts, null, 2)}\n\nOne photo per room follows.` }];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const buf = await this.helpers.getBinaryDataBuffer(i, 'data');
  content.push({ type: 'text', text: `Room: ${it.json.room} (photo id: ${it.json.photo})` });
  content.push({ type: 'image', source: { type: 'base64', media_type: it.binary.data.mimeType || 'image/jpeg', data: buf.toString('base64') } });
}
content.push({ type: 'text', text: 'Write the copy for every room above, in the same order, using each photo id as given. Also write a 6 to 10 word headline and a 2 sentence summary for the top of the page.' });
const body = {
  model: P.model,
  max_tokens: 16000,
  fallbacks: 'default',
  output_config: { effort: 'medium', format: { type: 'json_schema', schema: P.draft_schema } },
  system: P.draft_system,
  messages: [{ role: 'user', content }],
};
return [{ json: { body } }];
