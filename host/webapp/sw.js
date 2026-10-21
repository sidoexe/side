// Shows a machine's notifications and opens the session they are about.
// This host's registration has the scope /web/; another machine's,
// /web/m/<id>/, and its links name sessions without a machine.
const machine = new URL(self.registration.scope).pathname.match(/^\/web\/m\/([^/]+)\/$/)?.[1];
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = { title: "sIDE", body: "", url: "/web/", tag: "side" };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    /* an empty push still shows something */
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag,
      icon: "/web/side.png",
      badge: "/web/side.png",
      data: { url: message.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/web/", self.location.origin);
  // `#/s/<project>/<session>` from another machine becomes
  // `#/s/<machine>/<project>/<session>`.
  const parts = target.hash.replace(/^#\/?/, "").split("/");
  if (machine && parts[0] === "s" && parts.length === 3) target.hash = `#/s/${machine}/${parts[1]}/${parts[2]}`;
  const url = target.href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url.startsWith(self.location.origin + "/web/"));
      if (open) return open.navigate(url).then((client) => (client ?? open).focus());
      return self.clients.openWindow(url);
    }),
  );
});
