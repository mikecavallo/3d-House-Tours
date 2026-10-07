// Put each room's name back on its photo (Read Files keeps the binary, drops the json).
return $input.all().map((it, i) => ({ json: $('Room list').all()[i].json, binary: it.binary }));
