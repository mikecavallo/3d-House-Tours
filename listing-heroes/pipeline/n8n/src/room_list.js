// One item per room in the listing file, with the photo's absolute path.
const c = $input.first().json;
return c.listing.rooms.map((r) => ({ json: { room: r.room, photo: r.photo, path: `${c.photos}/${r.photo}.jpg` } }));
