// Pull the JSON answer out of a Messages API response; fail loudly on refusal or truncation.
const r = $input.item.json;
if (r.type === 'error') throw new Error(`Claude API error: ${r.error && r.error.type}: ${r.error && r.error.message}`);
if (r.stop_reason === 'refusal') throw new Error(`Claude declined (${(r.stop_details || {}).category || 'no category'}): ${(r.stop_details || {}).explanation || ''}`);
if (r.stop_reason === 'max_tokens') throw new Error('Claude hit max_tokens before finishing; raise max_tokens');
const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
return { json: Object.assign(JSON.parse(text), { _usage: r.usage, _model: r.model }) };
