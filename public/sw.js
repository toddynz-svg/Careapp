// Service worker: lets the calendar install as an app and show notifications.
// It doesn't cache anything, so the calendar is always up to date.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Care calendar", {
    body: d.body || "",
    tag: d.tag,
    renotify: true,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { tab: d.tag },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const tab = { req: "req", exp: "exp", kids: "kids" }[(e.notification.data || {}).tab] || "";
  const url = "/" + (tab ? "#" + tab : "");
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
