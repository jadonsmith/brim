// Entry point: ?tv opens the big-screen view, ?lab a bare glass, anything else a phone.
const params = new URLSearchParams(location.search);
if (params.has("lab")) import("./lab.js").then((m) => m.startLab());
else if (params.has("tv")) import("./tv.js").then((m) => m.startTv());
else import("./phone.js").then((m) => m.startPhone());
