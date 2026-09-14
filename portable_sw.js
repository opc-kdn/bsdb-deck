const IMAGE_CACHE_PREFIX="bsdb-receiver-images-",META_CACHE="bsdb-receiver-image-meta",ACTIVE_REQUEST="./__active_image_set__";
self.addEventListener("install",event=>event.waitUntil(self.skipWaiting()));
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
async function active(){const cache=await caches.open(META_CACHE),response=await cache.match(ACTIVE_REQUEST);return response?(await response.text()).trim():""}
async function setActive(id){const cache=await caches.open(META_CACHE);await cache.put(ACTIVE_REQUEST,new Response(id,{headers:{"Content-Type":"text/plain"}}))}
async function discard(id){if(id)await caches.delete(IMAGE_CACHE_PREFIX+id)}
async function promote(id){if(!id)return;const previous=await active();await setActive(id);if(previous&&previous!==id)await discard(previous)}
self.addEventListener("fetch",event=>{const url=new URL(event.request.url);if(url.origin!=="https://www.battlespirits.com"||!url.pathname.startsWith("/images/cardlist/"))return;event.respondWith((async()=>{const id=await active();if(id){const hit=await caches.match(event.request,{cacheName:IMAGE_CACHE_PREFIX+id,ignoreSearch:true});if(hit)return hit}return fetch(event.request)})())});
self.addEventListener("notificationclick",event=>{event.notification.close();const id=event.notification.data?.setId;if(event.action==="discard"){event.waitUntil(discard(id));return}event.waitUntil((async()=>{if(event.action==="apply")await promote(id);const clients=await self.clients.matchAll({type:"window",includeUncontrolled:true});for(const client of clients){if(event.action==="apply")client.postMessage({type:"BSDB_IMAGE_DECISION",decision:"apply",setId:id});client.focus()}if(!clients.length)await self.clients.openWindow("./")})())});
