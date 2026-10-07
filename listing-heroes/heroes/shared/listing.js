/* Showing picker: the next six days with three time windows each, and a form that confirms in place. */
(function(){
"use strict";
const days = document.getElementById("days"), times = document.getElementById("times");
if (!days) return;
const fmtD = new Intl.DateTimeFormat("en-US", {weekday: "short"}), fmtN = new Intl.DateTimeFormat("en-US", {month: "short", day: "numeric"});
const now = new Date();
for (let i = 1; i <= 6; i++){
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
  const id = "day-" + i;
  days.insertAdjacentHTML("beforeend", `<label class="pick" for="${id}"><input type="radio" name="day" id="${id}" value="${fmtD.format(d)}, ${fmtN.format(d)}"${i === 1 ? " checked" : ""}><span><small>${fmtD.format(d)}</small>${fmtN.format(d)}</span></label>`);
}
[["t-am", "Morning", "9–12"], ["t-pm", "Afternoon", "12–4"], ["t-ev", "Evening", "4–7"]].forEach(([id, a, b], k) => {
  times.insertAdjacentHTML("beforeend", `<label class="pick" for="${id}"><input type="radio" name="time" id="${id}" value="${a}"${k === 2 ? " checked" : ""}><span><small>${a}</small>${b}</span></label>`);
});
const form = document.getElementById("show-form"), st = document.getElementById("f-status");
form.addEventListener("submit", e => {
  e.preventDefault();
  const f = new FormData(form);
  if (!String(f.get("name") || "").trim() || !String(f.get("phone") || "").trim()){ st.textContent = "Add your name and a mobile number so we can confirm."; return; }
  st.textContent = `Request received for ${f.get("day")}, ${String(f.get("time")).toLowerCase()}. This is a demo page, so no message was sent.`;
});
})();
