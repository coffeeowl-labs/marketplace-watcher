const checkbox = document.getElementById("debug_logging");
const status = document.getElementById("status");

(async () => {
  const { debug_logging } = await chrome.storage.local.get("debug_logging");
  checkbox.checked = debug_logging ?? false;
})();

checkbox.addEventListener("change", async () => {
  await chrome.storage.local.set({ debug_logging: checkbox.checked });
  status.textContent = `Saved — debug logging ${checkbox.checked ? "ON" : "OFF"}`;
  setTimeout(() => (status.textContent = ""), 2000);
});
