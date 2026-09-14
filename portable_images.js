(function(global){
"use strict";
const HOST="https://www.battlespirits.com",PREFIX=HOST+"/images/cardlist/";
const IMAGE_CACHE_PREFIX="bsdb-receiver-images-",META_CACHE="bsdb-receiver-image-meta",ACTIVE_REQUEST="./__active_image_set__";
const WAIT_MS=1100,FETCH_TIMEOUT_MS=20000,DECODE_TIMEOUT_MS=15000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function slug(no){const m=/^(.*)\((A|B)\)$/.exec(no);if(m)return m[2]==="A"?m[1]:m[1]+"_b";if(no==="BS01-014")return"BS01-014A";return no.replace(/^KF(?=\d)/,"KF-")}
function url(no){return PREFIX+encodeURIComponent(slug(no))+".webp"}
function cacheName(id){return IMAGE_CACHE_PREFIX+id}
async function imageLoads(src){return new Promise(resolve=>{const img=new Image(),timer=setTimeout(()=>done(false),DECODE_TIMEOUT_MS);function done(value){clearTimeout(timer);img.onload=img.onerror=null;resolve(value)}img.onload=()=>done(true);img.onerror=()=>done(false);img.src=src+"?bsdb_probe="+Date.now()})}
async function active(){const cache=await caches.open(META_CACHE),response=await cache.match(ACTIVE_REQUEST);return response?(await response.text()).trim():""}
async function setActive(id){const cache=await caches.open(META_CACHE);if(id)await cache.put(ACTIVE_REQUEST,new Response(id,{headers:{"Content-Type":"text/plain"}}));else await cache.delete(ACTIVE_REQUEST)}
async function activeUrls(cardNos){const id=await active();if(!id)return new Map();const cache=await caches.open(cacheName(id)),result=new Map();for(const no of cardNos){const src=url(no);if(await cache.match(src))result.set(no,src)}return result}
async function discard(id){if(id)await caches.delete(cacheName(id))}
async function clearActive(){const id=await active();await setActive("");if(id)await discard(id)}
async function clearOldStaging(){const keep=await active();for(const name of await caches.keys())if(name.startsWith(IMAGE_CACHE_PREFIX)&&name!==cacheName(keep))await caches.delete(name)}
async function promote(id){if(!id)throw new Error("待機中の画像セットがありません");const previous=await active();await setActive(id);if(previous&&previous!==id)await discard(previous);navigator.serviceWorker?.controller?.postMessage({type:"BSDB_IMAGES_PROMOTED"});return id}
async function fetchImage(src){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);try{return await fetch(src,{mode:"no-cors",cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal:controller.signal})}finally{clearTimeout(timer)}}
async function fetchSet(manifest,onProgress=()=>{}){if(!manifest||!Array.isArray(manifest.card_nos))throw new Error("画像対象リストがありません");if(manifest.card_nos.length>120)throw new Error("画像対象が上限を超えています");await clearOldStaging();const id=crypto.randomUUID(),cache=await caches.open(cacheName(id)),failed=[];let done=0;for(const no of manifest.card_nos){const src=url(no);try{const response=await fetchImage(src);if(response.type!=="opaque"&&!response.ok)throw new Error("HTTP "+response.status);if(!await imageLoads(src))throw new Error("画像として開けません");await cache.put(src,response)}catch(error){failed.push({card_no:no,error:error?.name==="AbortError"?"通信がタイムアウトしました":String(error?.message||error)})}done++;onProgress({done,total:manifest.card_nos.length,failed:failed.length});if(done<manifest.card_nos.length)await sleep(WAIT_MS)}const downloaded=manifest.card_nos.length-failed.length;if(!downloaded){await discard(id);throw new Error("画像を取得できませんでした。通信状態を確認して再試行してください")};return{id,downloaded,total:manifest.card_nos.length,failed}}
async function notifyReady(result){if(!("serviceWorker"in navigator)||Notification.permission!=="granted")return false;const reg=await navigator.serviceWorker.ready;await reg.showNotification("カード画像の準備ができました",{body:`${result.downloaded}/${result.total}件。表示を更新しますか？`,tag:"bsdb-image-ready",data:{setId:result.id},actions:[{action:"apply",title:"はい"},{action:"discard",title:"いいえ"}]});return true}
async function enableNotifications(){if(!("Notification"in global))return"unsupported";return Notification.permission==="default"?Notification.requestPermission():Notification.permission}
global.BSDBReceiverImages=Object.freeze({HOST,url,activeUrls,fetchSet,promote,discard,clearActive,notifyReady,enableNotifications});
})(globalThis);
