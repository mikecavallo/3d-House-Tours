// One item per file to download, across every finished job.
return $input.all().flatMap((it) => it.json.downloads.map((dl) => ({ json: { server: it.json.server, name: it.json.name, dl } })));
