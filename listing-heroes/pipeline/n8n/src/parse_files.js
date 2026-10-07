// Parse every JSON file read by "Read workflow files" into { file, data }.
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const buf = await this.helpers.getBinaryDataBuffer(i, 'data');
  out.push({ json: { file: items[i].binary.data.fileName, data: JSON.parse(buf.toString('utf8')) } });
}
return out;
