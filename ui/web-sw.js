'use strict';
// The web app's service worker (/app/sw.js): shows Opaya's Web Push notifications (web/src/push.ts) and opens or
// focuses the web app when one is clicked.
self.addEventListener('push',event=>{
  let d={};try{d=event.data?event.data.json():{};}catch{}
  event.waitUntil(self.registration.showNotification(String(d.title||'Opaya'),{body:String(d.body||''),tag:String(d.tag||'opaya'),icon:'assets/opaya-logo.png',data:{url:String(d.url||'/app/')}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=new URL(event.notification.data?.url||'/app/',self.location.origin);if(url.origin!==self.location.origin)return;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{for(const c of list)if(new URL(c.url).pathname.startsWith('/app/')&&'focus' in c)return c.focus();return self.clients.openWindow(url.href);}));
});
