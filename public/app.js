import {readSupplierExcel,exportOrders} from './xlsx.js';
import {groupProducts,manualProducts,groupKey} from './product-groups.js';
import {mountGroupEditor} from './group-editor.js';

const $=s=>document.querySelector(s), app=$('#app'), dialog=$('#dialog');
const tg=window.Telegram?.WebApp;
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const moneyFormats=[0,2].map(maximumFractionDigits=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits}));
const money=n=>moneyFormats[n%100?1:0].format(n/100);
const date=s=>s?new Date(s.length===10?s+'T12:00:00':s).toLocaleDateString('ru-RU',{day:'numeric',month:'long'}):'Дата не указана';
const statuses={draft:'Черновик',arrived:'В продаже',closed:'Продажа закрыта',placed:'Оформлен',confirmed:'Подтверждён',cancelled:'Отменён'};
const state={preview:false,admin:false,ready:false,view:'shipments',shipments:[],current:null,filter:'all',sort:'new',search:'',cart:{},images:{},orders:[],requestKey:null,managers:[],managerId:null,productGroup:''};
let toastTimer,refreshPromise,importController;
const imageRequests=new Map();
const debounce=(fn,delay=120)=>{let timer;return (...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),delay);};};
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6500);}
function badge(status){return `<span class="badge ${esc(status)}">${esc(statuses[status]||status)}</span>`;}
function notice(text){$('#notice').textContent=text;$('#notice').hidden=!text;}
async function api(path,method='GET',body){
  const response=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json','X-Telegram-Init-Data':tg?.initData||''},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
  const data=await response.json();
  if(!response.ok){const error=Error(data.error||'Не удалось выполнить запрос.');error.status=response.status;throw error;}
  return data;
}
async function init(){
  try{
    tg?.ready();tg?.expand();
    if(tg?.isVersionAtLeast?.('6.1')){tg.setHeaderColor('#C7B3F0');tg.setBackgroundColor('#FBF9FE');}
    const config=await api('/bootstrap');
    state.preview=config.mode==='preview';state.ready=Boolean(config.notificationReady);
    if(state.preview){state.shipments=(await (await fetch('./data/catalog.json')).json()).shipments;notice('Предпросмотр: условные товары для проверки интерфейса. Отправка заказов отключена.');}
    else{
      if(!tg?.initData){app.innerHTML=`<div class="empty"><strong>Откройте приложение в Telegram</strong>Ваши заказы привязаны к Telegram-аккаунту.<p><a class="primary" href="https://t.me/EL_Store_Bot">Открыть EL Store</a></p></div>`;return;}
      const me=await api('/me');state.admin=me.admin;state.user=me.user;
      state.shipments=(await api('/catalog')).shipments;
      $('#admin-tab').hidden=!state.admin;
      notice(state.ready?'':'Приём заказов откроется после подключения рабочего канала.');
    }
    render();
  }catch(e){app.innerHTML=`<div class="empty"><strong>Не удалось загрузить поступления</strong>${esc(e.message)}<p><button class="primary" id="retry">Попробовать ещё раз</button></p></div>`;$('#retry').onclick=init;}
}
async function loadImages(shipment){
  const keys=[...new Set(shipment.products.filter(p=>p.imageKey).map(p=>p.imageKey.split('/')[0]))];
  for(const key of keys){
    if(state.images[key])continue;
    if(!imageRequests.has(key))imageRequests.set(key,fetch(`./data/${encodeURIComponent(key)}-images.json`).then(r=>r.json()).then(images=>state.images[key]=images).catch(()=>state.images[key]={}).finally(()=>imageRequests.delete(key)));
    await imageRequests.get(key);
  }
  hydrateImages();
}
function photo(p,cls='product-photo'){
  const key=p.imageKey,src=p.image || (key && state.images[key.split('/')[0]]?.[key.split('/')[1]]);
  if(!src&&!key)return `<div class="${cls} no-photo">Нет фото</div>`;
  return `<img class="${cls}" ${key?`data-image="${esc(key)}"`:''} ${src?`src="${esc(src)}"`:''} alt="${esc(p.name)}" loading="lazy">`;
}
function hydrateImages(){document.querySelectorAll('img[data-image]').forEach(el=>{const [key,sku]=el.dataset.image.split('/'),src=state.images[key]?.[sku];if(src)el.src=src;});}
function activeShipment(){return state.shipments.find(s=>s.id===state.current);}
function isOpen(s){return s.status==='arrived';}
function render(){
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===(state.view==='all-orders'?'admin':state.view)));
  if(state.view==='shipments')state.current?renderDetail():renderShipments();
  else if(state.view==='orders')renderOrders();
  else if(state.view==='all-orders')renderOrders(true);
  else if(state.view==='admin')renderAdmin();
  cartBar();
  if(tg?.BackButton){if(state.current){tg.BackButton.show();}else{tg.BackButton.hide();}}
}
function renderShipments(){
  app.innerHTML=`<div class="page-heading"><div><p class="eyebrow">EL / STORE</p><h1>Поступление</h1><p class="subtitle">Товары уже в наличии. Выберите нужное и оформите заказ.</p></div><span class="count">${state.shipments.length} поступлений</span></div>
  <div class="toolbar"><input class="search" id="shipment-search" type="search" placeholder="Найти поступление или бренд" aria-label="Поиск поступления" value="${esc(state.search)}"><select id="sort" aria-label="Сортировка"><option value="new">Сначала новые</option><option value="eta">По дате поступления</option><option value="old">Сначала старые</option></select></div>
  <div class="chips">${[['all','Все поступления'],['arrived','В продаже'],['closed','Завершённые']].map(([id,label])=>`<button class="chip ${state.filter===id?'active':''}" data-filter="${id}">${label}</button>`).join('')}</div><div class="shipment-grid" id="shipment-grid"></div>`;
  $('#sort').value=state.sort;
  const updateCards=debounce(()=>{if($('#shipment-grid'))cards();});
  $('#shipment-search').oninput=e=>{state.search=e.target.value;updateCards();};
  $('#sort').onchange=e=>{state.sort=e.target.value;cards();};
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(c=>c.classList.toggle('active',c===b));cards();});
  cards();
}
function cards(){
  const list=state.shipments.filter(s=>(state.filter==='all'||s.status===state.filter)&&`${s.title} ${s.brand}`.toLowerCase().includes(state.search.toLowerCase())).sort((a,b)=>{
    const key=state.sort==='eta'?'eta':'publishedAt',av=a[key],bv=b[key];
    if(!av)return bv?1:0;if(!bv)return -1;
    return state.sort==='new'?bv.localeCompare(av):av.localeCompare(bv);
  });
  $('#shipment-grid').innerHTML=list.length?list.map(s=>{
    const examples=s.products.filter(p=>p.image||p.imageKey).slice(0,2),min=s.products.length?Math.min(...s.products.map(p=>p.price)):0;
    return `<article class="shipment-card"><button class="card-open" data-shipment="${esc(s.id)}"><div class="card-visual ${esc(s.brand.toLowerCase())}">${examples.map(p=>photo(p,'cover-photo')).join('')}<span class="brand-label">${esc(s.brand)}</span></div><div class="card-body"><div class="card-meta">${badge(s.status)}<span class="muted">${s.publishedAt?date(s.publishedAt):'Не опубликовано'}</span></div><h2>${esc(s.title)}</h2><span class="muted">${s.products.length} позиций · от ${money(min)}</span><div class="card-footer"><span>Дата: ${date(s.eta)}</span><span class="arrow" aria-hidden="true">↗</span></div></div></button></article>`;
  }).join(''):'<div class="empty"><strong>Поступлений пока нет</strong>Новые товары появятся здесь после публикации.</div>';
  document.querySelectorAll('[data-shipment]').forEach(b=>b.onclick=()=>openShipment(b.dataset.shipment));
  list.forEach(loadImages);
}
function openShipment(id){if(state.current!==id){state.cart={};state.requestKey=null;state.productGroup='';}state.current=id;state.view='shipments';render();window.scrollTo(0,0);}
function renderDetail(){
  const s=activeShipment();if(!s){state.current=null;render();return;}
  const groups=groupProducts(s.products,s.groupingMode==='manual'?s.groups:[]),hasGroups=groups.some(g=>g.name);
  state.productGroup=groups.find(g=>groupKey(g.name)===groupKey(state.productGroup))?.name||'';
  app.innerHTML=`<button class="back" id="back">← Все поступления</button><section class="detail-head">${badge(s.status)}<h1>${esc(s.title)}</h1>${s.description?`<p class="subtitle">${esc(s.description).replaceAll('\n','<br>')}</p>`:''}<div class="detail-meta"><span>Дата поступления<strong>${date(s.eta)}</strong></span><span>Позиций<strong>${s.products.length}</strong></span></div></section>${hasGroups?`<div class="toolbar"><input class="search" type="search" id="product-search" placeholder="Название, модель или артикул" aria-label="Поиск товара"><select id="product-group" aria-label="Группа товаров"><option value="">Все товары</option>${groups.filter(g=>g.name).map(g=>`<option value="${esc(g.name)}">${esc(g.name)} (${g.products.length})</option>`).join('')}</select></div>`:''}<div class="product-groups" id="products"></div>`;
  if(hasGroups){$('#product-group').value=state.productGroup;$('#product-group').onchange=e=>{state.productGroup=e.target.value;products($('#product-search').value);};$('#product-search').oninput=debounce(e=>{if(e.target.isConnected)products(e.target.value);});}
  $('#back').onclick=goBack;products('');loadImages(s);
}
function products(query){
  const s=activeShipment(),list=s.products.filter(p=>`${p.name} ${p.sku}`.toLowerCase().includes(query.toLowerCase()));
  const definitions=s.groupingMode==='manual'?s.groups:[],hasGroups=groupProducts(s.products,definitions).some(g=>g.name);
  const groups=groupProducts(list,definitions).filter(g=>!state.productGroup||groupKey(g.name)===groupKey(state.productGroup));
  $('#products').innerHTML=groups.length?groups.map((group,index)=>`<section class="product-group" ${hasGroups?`aria-labelledby="product-group-${index}"`:''}>${hasGroups?`<div class="group-heading"><h2 id="product-group-${index}">${esc(group.name||'Без группы')}</h2><span class="muted">Позиций: ${group.products.length}</span></div>`:''}<div class="products">${group.products.map(p=>{
    const qty=state.cart[p.id]||0,disabled=(!isOpen(s)&&!state.preview)||p.stock<=0;
    return `<article class="product ${qty?'selected':''}" data-product="${esc(p.id)}">${photo(p)}<div><span class="sku">АРТ. ${esc(p.sku)}</span><p class="product-title">${esc(p.name)}</p><span class="price">${money(p.price)}</span><div class="stock">${p.stock>0?`В наличии ${p.stock} шт.`:'Нет в наличии'}</div></div><div class="product-bottom"><span class="muted" style="font-size:13px">Количество</span><div class="stepper"><button data-step="-1" data-id="${esc(p.id)}" aria-label="Уменьшить количество" ${disabled?'disabled':''}>−</button><input data-qty="${esc(p.id)}" type="number" inputmode="numeric" min="0" max="${p.stock}" value="${qty}" aria-label="Количество ${esc(p.sku)}" ${disabled?'disabled':''}><button data-step="1" data-id="${esc(p.id)}" aria-label="Увеличить количество" ${disabled?'disabled':''}>+</button></div></div></article>`;
  }).join('')}</div></section>`).join(''):'<p class="empty">Ничего не найдено.</p>';
  document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>setQuantity(b.dataset.id,(state.cart[b.dataset.id]||0)+Number(b.dataset.step)));
  document.querySelectorAll('[data-qty]').forEach(input=>input.onchange=()=>setQuantity(input.dataset.qty,Number(input.value)));
  hydrateImages();
}
function setQuantity(id,value){
  const p=activeShipment()?.products.find(p=>p.id===id);if(!p)return;
  const qty=Math.max(0,Math.min(p.stock,Number.isFinite(value)?Math.floor(value):0));
  if(qty)state.cart[id]=qty;else delete state.cart[id];state.requestKey=null;
  const el=[...document.querySelectorAll('[data-qty]')].find(e=>e.dataset.qty===id);if(el){el.value=qty;el.closest('.product').classList.toggle('selected',qty>0);}
  cartBar();
}
function totals(){const s=activeShipment();return Object.entries(state.cart).reduce((r,[id,q])=>{const p=s?.products.find(p=>p.id===id);if(p){r.count+=q;r.total+=q*p.price;}return r;},{count:0,total:0});}
function cartBar(){
  const t=totals(),visible=state.view==='shipments'&&state.current&&t.count>0;
  $('#cart-bar').hidden=!visible;document.body.classList.toggle('has-cart',visible);
  if(visible){$('#cart-bar').innerHTML=`<button id="open-cart"><span>В заказе: ${t.count} шт.<br><small>Проверить заказ</small></span><strong>${money(t.total)} →</strong></button>`;$('#open-cart').onclick=showCart;}
}
function closeDialog(){importController?.abort();dialog.close();}
function showDialog(title,body){dialog.innerHTML=`<div class="dialog-header"><h2>${esc(title)}</h2><button class="icon-button" id="close-dialog" aria-label="Закрыть">×</button></div>${body}`;$('#close-dialog').onclick=closeDialog;if(!dialog.open)dialog.showModal();}
async function showCart(){
  try{if(!state.preview)state.managers=(await api('/managers')).managers;}catch(e){toast(e.message);return;}
  if(!state.managers.some(m=>m.id===state.managerId)){state.managerId=null;state.requestKey=null;}
  const s=activeShipment(),t=totals();if(!s || !t.count)return;
  showDialog('Ваш заказ',`<p class="muted">${esc(s.title)}</p>${Object.entries(state.cart).map(([id,q])=>{const p=s.products.find(p=>p.id===id);return `<div class="cart-line"><p>${esc(p.name)}</p><span class="muted">${esc(p.sku)} · ${q} шт. × ${money(p.price)}</span></div>`;}).join('')}<div class="cart-total"><span>${t.count} шт.</span><span>${money(t.total)}</span></div><label class="field">Ваш менеджер<select id="placeOrder-manager" required><option value="">Выберите менеджера</option>${state.managers.map(m=>`<option value="${esc(m.id)}" ${m.id===state.managerId?'selected':''}>${esc(m.name)}</option>`).join('')}</select></label>${!state.preview&&!state.managers.length?'<p class="warning">Список менеджеров ещё не заполнен. Обратитесь в магазин.</p>':''}<label class="field">Комментарий<textarea id="comment" maxlength="1000" placeholder="Например, название магазина"></textarea></label><p class="fine-print">После оформления количество товара в наличии сразу уменьшится.</p>${state.preview?'<p class="warning">Предпросмотр. Заказ не будет оформлен.</p>':''}<p id="placeOrder-error" class="error" role="alert"></p><button class="primary full" id="submit-placeOrder" ${state.preview||!state.ready||!state.managerId?'disabled':''}>Оформить заказ</button>`);
  $('#comment').oninput=()=>state.requestKey=null;
  $('#placeOrder-manager').onchange=e=>{state.managerId=e.target.value||null;state.requestKey=null;$('#submit-placeOrder').disabled=state.preview||!state.ready||!state.managerId;};
  $('#submit-placeOrder').onclick=async()=>{
    if(!state.managerId){$('#placeOrder-error').textContent='Выберите менеджера.';return;}
    const button=$('#submit-placeOrder');$('#placeOrder-manager').disabled=true;button.disabled=true;button.textContent='Отправляем…';$('#placeOrder-error').textContent='';$('#comment').disabled=true;
    state.requestKey ||= crypto.randomUUID();
    const key=state.requestKey;
    try{
      const {order}=await api('/orders','POST',{shipmentId:s.id,requestKey:key,managerId:state.managerId,lines:Object.entries(state.cart).map(([id,quantity])=>({id,quantity})),comment:$('#comment').value});
      state.cart={};state.requestKey=null;closeDialog();cartBar();
      toast(`Заказ №${order.id.slice(0,8)} оформлен. Он появится в канале для менеджера.`);
      state.shipments=(await api('/catalog')).shipments;state.view='orders';render();
    }catch(e){
      // Same idempotency key is retained for a network retry, even if response was lost.
      if(dialog.open&&$('#placeOrder-error')){$('#placeOrder-error').textContent=e.message;button.disabled=false;button.textContent='Повторить отправку';$('#comment').disabled=false;$('#placeOrder-manager').disabled=false;}
      else toast('Проверьте «Мои Заказы»: запрос мог быть выполнен.');
    }
  };
}
async function renderOrders(all=false){
  state.view=all?'all-orders':'orders';
  app.innerHTML=`<div class="page-heading"><div><p class="eyebrow">EL / STORE</p><h1>${all?'Все заказы':'Мои заказы'}</h1></div>${all?'<button class="secondary" id="export">Excel ↓</button>':''}</div><div id="orders"><p class="empty">Загружаем…</p></div>`;
  if(!all && !state.preview && state.user)$('#orders').insertAdjacentHTML('beforebegin',`<p class="muted">Заказы привязаны к вашему Telegram-аккаунту.</p>`);
  if(state.preview){$('#orders').innerHTML='<div class="empty"><strong>Здесь будут ваши заказы</strong>Отправка появится после подключения бота и рабочего канала.</div>';return;}
  const container=$('#orders');
  try{
    const {orders}=await api('/orders'+(all?'?all=1':''));
    if(!container.isConnected)return;
    state.orders=orders;
    $('#orders').innerHTML=orders.length?orders.map(r=>`<article class="order"><div class="top"><div><small>№ ${esc(r.id.slice(0,8))} · ${date(r.createdAt)}</small><h3 style="margin-top:8px">${esc(r.shipmentTitle)}</h3></div>${badge(r.status)}</div>${r.editedAt?'<p class="muted">Заказ изменён</p>':''}${all?`<p>${esc(r.user.name)} ${r.user.username?'@'+esc(r.user.username):''}</p>`:''}${r.manager?`<p class="muted">Менеджер: ${esc(r.manager.name)} · @${esc(r.manager.username)}</p>`:''}<strong>${money(r.total)}</strong><span class="muted"> · ${r.lines.reduce((s,l)=>s+l.quantity,0)} шт.</span><details><summary>Состав заказа</summary><ul>${r.lines.map(l=>`<li>${esc(l.sku)} · ${esc(l.name)} — <b>${l.quantity} шт.</b></li>`).join('')}</ul>${r.comment?`<p>${esc(r.comment)}</p>`:''}</details><div class="actions">${r.status==='placed'||all&&r.status==='confirmed'?`<button class="secondary" data-edit-order="${r.id}">Изменить</button>`:''}${all&&r.status==='placed'?`<button class="primary" data-confirm="${r.id}">Подтвердить</button>`:''}${r.status==='placed'||all&&r.status==='confirmed'?`<button class="danger" data-cancel="${r.id}">Отменить заказ</button>`:''}</div></article>`).join(''):'<div class="empty"><strong>Заказов пока нет</strong>Выберите поступление и добавьте нужные товары.</div>';
    document.querySelectorAll('[data-edit-order]').forEach(b=>b.onclick=()=>editOrderForm(orders.find(r=>r.id===b.dataset.editOrder),all));
    document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>changeOrder(b.dataset.cancel,'cancelled',all));
    document.querySelectorAll('[data-confirm]').forEach(b=>b.onclick=()=>changeOrder(b.dataset.confirm,'confirmed',all));
    if(all)$('#export').onclick=()=>exportOrders(orders).catch(e=>toast(e.message));
  }catch(e){if(container.isConnected)container.innerHTML=`<p class="empty error">${esc(e.message)}</p>`;}
}
async function editOrderForm(order,all){
  let shipment;
  try{shipment=(await api('/catalog')).shipments.find(s=>s.id===order.shipmentId);if(!shipment)throw Error('Поступление недоступно. Обратитесь к менеджеру.');}catch(e){toast(e.message);return;}
  const originals=new Map(order.lines.map(l=>[l.id,l])),draft=new Map(order.lines.map(l=>[l.id,l.quantity]));
  let requestKey=null;
  showDialog('Изменить заказ',`<p class="muted">${esc(order.shipmentTitle)}</p><p class="fine-print">Поставьте 0, чтобы убрать позицию. Увеличение количества возможно в пределах наличия. Для полного отказа отмените заказ.</p><form id="edit-order-form"><div id="edit-order-lines"></div><label class="field">Добавить товар<select id="add-order-product"><option value="">Выберите товар</option></select></label><p class="fine-print">Цена ранее выбранных позиций сохраняется. Новые позиции добавляются по текущей цене.</p><label class="field">Комментарий<textarea id="edit-order-comment" maxlength="1000">${esc(order.comment)}</textarea></label><p class="cart-total" id="edit-order-total"></p><p id="edit-order-error" class="error" role="alert"></p><button type="button" class="secondary full" id="reload-orders" hidden>Обновить список заказов</button><button class="primary full" type="submit" id="save-order">Сохранить изменения</button></form>`);
  const form=$('#edit-order-form');
  const price=id=>originals.get(id)?.price??shipment.products.find(p=>p.id===id)?.price??0;
  function total(){const sum=[...draft].reduce((n,[id,q])=>n+q*price(id),0);$('#edit-order-total').textContent='Итого: '+money(sum);}
  function draw(){
    $('#edit-order-lines').innerHTML=[...draft].map(([id,quantity])=>{
      const p=shipment.products.find(p=>p.id===id),old=originals.get(id),max=(p?.stock||0)+(old?.quantity||0);
      return `<div class="cart-line"><p>${esc(old?.name||p?.name)}</p><span class="muted">${esc(old?.sku||p?.sku)} · ${money(price(id))} · Доступно с вашим заказом: ${max} шт.</span><label class="field">Количество<input data-edit-qty="${esc(id)}" type="number" inputmode="numeric" required min="0" max="${max}" step="1" value="${quantity}"></label></div>`;
    }).join('');
    form.querySelectorAll('[data-edit-qty]').forEach(el=>el.oninput=()=>{draft.set(el.dataset.editQty,Number(el.value));requestKey=null;total();});
    $('#add-order-product').innerHTML='<option value="">Выберите товар</option>'+shipment.products.filter(p=>p.stock>0&&!draft.has(p.id)).map(p=>`<option value="${esc(p.id)}">${esc(p.sku)} · ${esc(p.name)} · ${money(p.price)}</option>`).join('');
    total();
  }
  draw();
  $('#add-order-product').onchange=e=>{if(e.target.value){draft.set(e.target.value,1);requestKey=null;draw();}};
  $('#edit-order-comment').oninput=()=>requestKey=null;
  $('#reload-orders').onclick=()=>{closeDialog();renderOrders(all);};
  form.onsubmit=async e=>{
    e.preventDefault();const error=$('#edit-order-error');error.textContent='';
    const lines=[...draft].filter(([,quantity])=>quantity>0).map(([id,quantity])=>({id,quantity}));
    if(!lines.length||lines.length>100){error.textContent='Оставьте от 1 до 100 позиций. Для полного отказа отмените заказ.';return;}
    requestKey ||= crypto.randomUUID();
    const input={requestKey,expectedRevision:order.revision||1,lines,comment:$('#edit-order-comment').value};
    const controls=[...form.querySelectorAll('input,select,textarea,button')];controls.forEach(c=>c.disabled=true);
    try{
      await api('/orders/'+order.id,'PATCH',input);closeDialog();toast('Заказ изменён. Остатки пересчитаны.');renderOrders(all);
    }catch(e){error.textContent=e.message;controls.forEach(c=>c.disabled=false);if(e.status===409)form.querySelector('#reload-orders').hidden=false;}
  };
}
function changeOrder(id,status,all){
  const expectedRevision=state.orders.find(r=>r.id===id)?.revision||1;
  showDialog(status==='cancelled'?'Отменить заказ?':'Подтвердить заказ?',`<p class="status-message">${status==='cancelled'?'Товары снова появятся в наличии.':'Заказ остаётся за клиентом.'}</p><button class="primary full" id="confirm-action">${status==='cancelled'?'Да, отменить':'Подтвердить'}</button>`);
  $('#confirm-action').onclick=async()=>{const b=$('#confirm-action');b.disabled=true;try{await api('/orders/'+id,'PATCH',{status,expectedRevision});closeDialog();state.shipments=(await api('/catalog')).shipments;renderOrders(all);}catch(e){b.disabled=false;toast(e.message);}};
}
function renderAdmin(){
  if(!state.admin){state.view='shipments';render();return;}
  app.innerHTML=`<div class="page-heading"><div><p class="eyebrow">EL / STORE</p><h1>Управление</h1></div><button class="primary" id="new-shipment">+ Поступление</button></div><div class="actions"><button class="secondary" id="all-orders">Все заказы</button><button class="secondary" id="managers">Менеджеры</button><button class="secondary" id="setup-bot">Подключить бота</button></div><section class="admin-panel">${state.shipments.length?state.shipments.map(s=>`<div class="admin-row"><div><strong>${esc(s.title)}</strong><small>${s.products.length} позиций · ${date(s.eta)}</small>${badge(s.status)}</div><div class="shipment-actions"><button class="secondary" data-edit="${esc(s.id)}">Изменить</button><button class="danger" data-delete-shipment="${esc(s.id)}">Удалить</button></div></div>`).join(''):'<p class="muted">Загрузите Excel, проверьте товары и опубликуйте поступление.</p>'}</section>`;
  $('#new-shipment').onclick=()=>editShipment();$('#all-orders').onclick=()=>{state.view='all-orders';render();};
  document.querySelectorAll('[data-delete-shipment]').forEach(b=>b.onclick=()=>deleteShipment(state.shipments.find(s=>s.id===b.dataset.deleteShipment)));
  $('#setup-bot').onclick=showBotSetup;
  $('#managers').onclick=editManagers;
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editShipment(state.shipments.find(s=>s.id===b.dataset.edit)));
}
function deleteShipment(shipment){
  showDialog('Удалить поступление?',`<p><strong>${esc(shipment.title)}</strong></p><p>Поступление и его товары исчезнут из приложения. Отменённые заказы останутся в истории администратора. Поступление с действующими заказами удалить нельзя.</p><p id="delete-error" class="error" role="alert"></p><button class="danger full" id="delete-shipment">Удалить поступление</button>`);
  const error=$('#delete-error'),button=$('#delete-shipment');
  button.onclick=async()=>{
    button.disabled=true;error.textContent='';
    try{
      await api('/admin/shipments/'+encodeURIComponent(shipment.id),'DELETE');
      state.shipments=state.shipments.filter(s=>s.id!==shipment.id);
      if(state.current===shipment.id){state.current=null;state.cart={};state.requestKey=null;}
      closeDialog();render();toast('Поступление удалено.');
    }catch(e){error.textContent=e.message;button.disabled=false;}
  };
}
async function editManagers(){
  let list;
  try{list=(await api('/managers')).managers;}catch(e){toast(e.message);return;}
  showDialog('Менеджеры',`<p class="fine-print">Клиент выбирает имя при оформлении. Telegram-ник добавляется в сообщение с заказом.</p><form id="managers-form"><div id="manager-rows"></div><button type="button" class="secondary" id="add-manager">+ Менеджер</button><p class="fine-print">Удаление менеджера убирает его из выбора для новых заказов. В оформленных заказах сохраняются прежние имя и ник.</p><p class="error" id="managers-error" role="alert"></p><button class="primary full" type="submit">Сохранить менеджеров</button></form>`);
  const form=$('#managers-form');
  function addRow(m={id:crypto.randomUUID(),name:'',username:''}){
    const row=document.createElement('div');row.className='manager-editor';row.dataset.managerId=m.id;
    row.innerHTML=`<label class="field">Имя<input data-manager-name required maxlength="80" value="${esc(m.name)}" placeholder="Например, Анна"></label><label class="field">Telegram-ник<input data-manager-username required maxlength="33" value="${esc(m.username?'@'+m.username:'')}" placeholder="@username" autocapitalize="none" spellcheck="false" pattern="@?[A-Za-z][A-Za-z0-9_]{0,31}"></label><button type="button" class="danger">Удалить</button>`;
    row.querySelector('button').onclick=()=>row.remove();$('#manager-rows').append(row);
  }
  list.forEach(addRow);if(!list.length)addRow();$('#add-manager').onclick=()=>{if(form.querySelectorAll('.manager-editor').length<100)addRow();};
  form.onsubmit=async e=>{
    e.preventDefault();const error=$('#managers-error');error.textContent='';
    const managers=[...form.querySelectorAll('.manager-editor')].map(row=>({id:row.dataset.managerId,name:row.querySelector('[data-manager-name]').value,username:row.querySelector('[data-manager-username]').value}));
    const controls=[...form.querySelectorAll('input,button')];controls.forEach(c=>c.disabled=true);
    try{state.managers=(await api('/admin/managers','PUT',{managers})).managers;closeDialog();toast('Список менеджеров сохранён.');}
    catch(e){error.textContent=e.message;controls.forEach(c=>c.disabled=false);}
  };
}
function showBotSetup(){
  showDialog('Подключение бота',`<p>Подключим команды бота и кнопку открытия поступлений.</p><p>Затем добавьте @EL_Store_Bot администратором рабочего канала с правом публикации и перешлите ему сообщение из этого канала. Бот ответит ID канала для настройки уведомлений.</p><p id="bot-setup-error" class="error" role="alert"></p><button class="primary full" id="connect-bot">Подключить</button>`);
  $('#connect-bot').onclick=async()=>{
    const button=$('#connect-bot'),error=$('#bot-setup-error');button.disabled=true;button.textContent='Подключаем…';error.textContent='';
    try{
      await api('/admin/setup-bot','POST',{});
      showDialog('Бот подключён',`<p>Добавьте @EL_Store_Bot администратором рабочего канала с правом публикации сообщений.</p><p>Перешлите сообщение из канала в личный чат с ботом, сохранив источник пересылки. Полученный ID укажите в Cloudflare как Secret <strong>ORDER_CHAT_ID</strong>, сохраните и переоткройте приложение.</p><p><a class="primary" href="https://t.me/EL_Store_Bot" target="_blank" rel="noopener">Открыть бота</a></p>`);
    }catch(e){error.textContent=e.message;button.disabled=false;button.textContent='Повторить подключение';}
  };
}
function editShipment(existing){
  importController?.abort();
  const groups=existing?.groupingMode==='manual'?[...(existing.groups||[])]:[];
  let products=existing?manualProducts(existing.products.map(p=>({...p,total:p.total??p.stock})),groups):null,warnings=[],previousProducts=products||[];
  showDialog(existing?'Настройки поступления':'Новое поступление',`<form id="shipment-form"><label class="field">Название<input name="title" required maxlength="160" value="${esc(existing?.title||'')}" placeholder="Например, Gurdini Slim Series"></label><div class="form-grid"><label class="field">Бренд<input name="brand" maxlength="80" value="${esc(existing?.brand||'')}"></label><label class="field">Статус<select name="status">${Object.entries(statuses).filter(([k])=>['draft','arrived','closed'].includes(k)).map(([k,v])=>`<option value="${k}" ${(existing?.status || 'arrived')===k?'selected':''}>${v}</option>`).join('')}</select></label><label class="field">Дата поступления<input type="date" name="eta" value="${esc(existing?.eta||'')}"></label><label class="field">Дата публикации<input type="date" name="publishedAt" value="${esc(existing?.publishedAt||'')}"></label></div><label class="field">Описание<textarea name="description" maxlength="3000">${esc(existing?.description||'')}</textarea></label><label class="field">${existing?'Обновить товары из Excel':'Excel с товарами'}<input type="file" id="xlsx-file" accept=".xls,.xlsx"></label><p class="fine-print">Кол-во в Excel — исходное количество товара до вычета заказов. При обновлении действующие заказы сохраняются.</p><div id="import-info">${products?`<p class="import-summary">${products.length} позиций</p>`:''}</div><div id="group-editor"></div><p id="import-error" class="error" role="alert"></p><button class="primary full" id="save-shipment" type="submit" ${products?'':'disabled'}>Сохранить поступление</button></form>`);
  const form=$('#shipment-form');
  function reviewGroups(){mountGroupEditor($('#group-editor'),products,groups);}
  if(products)reviewGroups();
  $('#xlsx-file').onchange=async e=>{
    const file=e.target.files[0];if(!file)return;
    importController?.abort();const controller=new AbortController();importController=controller;
    if(products)previousProducts=products;
    products=null;warnings=[];$('#group-editor').textContent='';
    $('#save-shipment').disabled=true;$('#import-info').textContent='Читаем Excel и сжимаем фотографии…';$('#import-error').textContent='';
    try{
      const result=await readSupplierExcel(file,{signal:controller.signal});
      if(controller.signal.aborted||!form.isConnected)return;
      products=manualProducts(result.products,groups,previousProducts);warnings=result.warnings;reviewGroups();
      if(!form.elements.title.value)form.elements.title.value=file.name.replace(/\.xlsx?$/i,'');
      $('#import-info').innerHTML=`<div class="import-summary">${products.length} позиций · ${products.filter(p=>p.image).length} фотографий</div>${warnings.length?`<details class="warning"><summary>Замечания: ${warnings.length}</summary>${warnings.map(w=>`<div>${esc(w)}</div>`).join('')}</details><label class="field"><input id="accept-warnings" type="checkbox" style="width:auto;min-height:auto"> Проверил замечания</label>`:''}<div class="import-preview"><table><thead><tr><th>Товар</th><th>Кол-во</th><th>Цена</th></tr></thead><tbody>${products.map(p=>`<tr><td>${esc(p.name)}<br>${esc(p.sku)}</td><td>${p.stock}</td><td>${p.price===null?`<input data-import-price="${esc(p.id)}" type="number" inputmode="decimal" required min="0" max="1000000" step="0.01" placeholder="Цена, ₽" aria-label="Цена ${esc(p.sku)}">`:money(p.price)}</td></tr>`).join('')}</tbody></table></div>`;
      form.querySelectorAll('[data-import-price]').forEach(input=>input.oninput=()=>{const product=products.find(p=>p.id===input.dataset.importPrice);product.price=input.value.trim()&&input.validity.valid?Math.round(Number(input.value)*100):null;});
      $('#save-shipment').disabled=false;
    }catch(e){if(controller.signal.aborted||!form.isConnected)return;products=null;$('#import-info').textContent='';$('#import-error').textContent=e.message;}
  };
  form.onsubmit=async e=>{
    e.preventDefault();if(!products)return;
    if(products.some(p=>p.price===null)){$('#import-error').textContent='Заполните цены всех товаров перед сохранением.';return;}
    if(warnings.length&&!$('#accept-warnings')?.checked){$('#import-error').textContent='Подтвердите проверку замечаний.';return;}
    const b=$('#save-shipment');b.disabled=true;$('#import-error').textContent='';
    try{await api('/admin/shipments','POST',{id:existing?.id||crypto.randomUUID(),...Object.fromEntries(new FormData(form)),groupingMode:'manual',groups,products});closeDialog();await refresh();toast('Поступление сохранено.');}catch(e){if($('#import-error')){$('#import-error').textContent=e.message;b.disabled=false;}else toast(e.message);}
  };
}
function goBack(){if(Object.keys(state.cart).length){showDialog('Вернуться к поступлениям?',`<p>Выбранные количества будут сброшены.</p><button class="primary full" id="leave">Вернуться</button>`);$('#leave').onclick=()=>{closeDialog();state.cart={};state.current=null;state.requestKey=null;render();};}else{state.current=null;render();}}
async function refresh({background=false}={}){
  if(state.preview){if(!background)render();return;}
  if(background&&document.activeElement?.matches('[data-qty]'))return;
  if(refreshPromise){await refreshPromise;if(background)return;}
  const button=$('#refresh');button.disabled=true;
  refreshPromise=(async()=>{
    try{
      const previous=JSON.stringify(state.shipments);
      const shipments=(await api('/catalog')).shipments;
      if(background&&dialog.open)return;
      state.shipments=shipments;
      const changed=previous!==JSON.stringify(state.shipments);
      if(background && (!changed||dialog.open))return;
      if(state.view==='shipments' && $('#shipment-grid')){cards();$('.count').textContent=state.shipments.length+' поступлений';cartBar();return;}
      if(state.view==='shipments' && $('#product-search')){
        const input=$('#product-search'),query=input.value,focused=document.activeElement;
        if(!activeShipment()){state.current=null;state.cart={};state.requestKey=null;render();return;}
        if(!changed)return;
        const selection=focused?.matches('[data-qty]')?focused.dataset.qty:null;
        renderDetail();if($('#product-search')){$('#product-search').value=query;products(query);}cartBar();
        if(focused===input)$('#product-search')?.focus({preventScroll:true});
        else if(selection)app.querySelector(`[data-qty="${CSS.escape(selection)}"]`)?.focus({preventScroll:true});
        return;
      }
      if(!background||changed)render();
    }catch(e){toast(e.message);}
    finally{button.disabled=false;refreshPromise=null;}
  })();
  return refreshPromise;
}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{state.view=b.dataset.view;render();window.scrollTo(0,0);});
$('#refresh').onclick=()=>refresh();
dialog.addEventListener('close',()=>importController?.abort());
$('.brand').onclick=e=>{e.preventDefault();state.view='shipments';if(state.current)goBack();else render();};
tg?.BackButton?.onClick(goBack);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.preview&&!dialog.open)refresh({background:true});});
setInterval(()=>{if(!state.preview&&!document.hidden&&!dialog.open&&state.view==='shipments'&&tg?.initData)refresh({background:true});},45000);
init();
