import {readSupplierExcel,exportOrders} from './xlsx.js';
import {manualProducts,groupKey} from './product-groups.js';

const $=s=>document.querySelector(s), app=$('#app'), dialog=$('#dialog');
const tg=window.Telegram?.WebApp;
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const moneyFormats=[0,2].map(maximumFractionDigits=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits}));
const money=n=>moneyFormats[n%100?1:0].format(n/100);
const date=s=>s?new Date(s.length===10?s+'T12:00:00':s).toLocaleDateString('ru-RU',{day:'numeric',month:'long'}):'Дата не указана';
const statuses={draft:'Скрыт',arrived:'В продаже',closed:'Продажа закрыта',placed:'Оформлен',confirmed:'Подтверждён',cancelled:'Отменён'};
const BRANDS=[
  {id:'apple',name:'Apple',categories:['Оригинал','Копия']},
  {id:'remax',name:'Remax',categories:['GL-27','GL-27 Privacy','ES-01']},
  {id:'gurdini',name:'Gurdini',categories:['Стекла','Чехлы','Аккумуляторы']}
];
const brandById=id=>BRANDS.find(b=>b.id===id);
const catalogForBrand=id=>{const b=brandById(id);return state.shipments.find(s=>s.id===id)||(b&&state.shipments.find(s=>String(s.brand||s.title).toLowerCase()===b.name.toLowerCase()));};
const sellableProducts=catalog=>(catalog?.products||[]).filter(p=>!p.hidden&&p.stock>0);
const categoriesFor=id=>brandById(id)?.categories||[];
const state={preview:false,admin:false,ready:false,view:'shipments',shipments:[],current:null,filter:'all',sort:'new',search:'',cart:{},images:{},orders:[],requestKey:null,productGroup:''};
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
      if(!tg?.initData){app.innerHTML=`<div class="empty"><strong>Откройте приложение в Telegram</strong>Ваши заказы привязаны к Telegram-аккаунту.<p><a class="primary" href="https://t.me/E_NewSletters_Bot">Открыть EL Store</a></p></div>`;return;}
      const me=await api('/me');state.admin=me.admin;state.user=me.user;
      state.shipments=(await api('/catalog')).shipments;
      $('#admin-tab').hidden=!state.admin;
      notice(state.ready?'':'Приём заказов откроется после подключения рабочего канала.');
    }
    render();
  }catch(e){app.innerHTML=`<div class="empty"><strong>Не удалось загрузить товары</strong>${esc(e.message)}<p><button class="primary" id="retry">Попробовать ещё раз</button></p></div>`;$('#retry').onclick=init;}
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
function activeShipment(){
  const exact=state.shipments.find(s=>s.id===state.current);
  if(exact)return exact;
  const brand=brandById(state.current),catalog=brand&&catalogForBrand(brand.id);
  return catalog|| (brand?{id:brand.id,title:brand.name,brand:brand.name,status:'arrived',groupingMode:'manual',groups:[...brand.categories],products:[],description:''}:null);
}
function isOpen(s){return s.status==='arrived';}
function render(){
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===(state.view==='all-orders'?'admin':state.view)));
  if(state.view==='shipments')state.current?renderDetail():renderShipments();
  else if(state.view==='orders')renderOrders();
  else if(state.view==='all-orders')renderOrders(true);
  else if(state.view==='admin')renderAdmin();
  cartBar();
  if(tg?.BackButton){if(state.view==='shipments'&&state.current){tg.BackButton.show();}else{tg.BackButton.hide();}}
}
function renderShipments(){
  app.innerHTML=`<div class="page-heading"><div><p class="eyebrow">EL / STORE</p><h1>Товары</h1><p class="subtitle">Выберите бренд.</p></div><span class="count">3 бренда</span></div><div class="brand-grid" id="shipment-grid"></div>`;
  cards();
}
function cards(){
  const list=BRANDS.map(brand=>({brand,catalog:catalogForBrand(brand.id)}));
  $('#shipment-grid').innerHTML=list.map(({brand,catalog})=>{
    const available=sellableProducts(catalog),examples=available.filter(p=>p.image||p.imageKey).slice(0,2);
    return `<article class="brand-card"><button class="brand-open" data-brand="${esc(brand.id)}"><div class="brand-visual ${esc(brand.id)}">${examples.map(p=>photo(p,'cover-photo')).join('')}<span class="brand-name">${esc(brand.name)}</span></div><div class="brand-card-footer"><span>${available.length} товаров</span><span class="arrow" aria-hidden="true">→</span></div></button></article>`;
  }).join('');
  document.querySelectorAll('[data-brand]').forEach(b=>b.onclick=()=>openShipment(b.dataset.brand));
  list.forEach(({catalog})=>catalog&&loadImages({...catalog,products:sellableProducts(catalog)}));
}
function openShipment(id){if(state.current!==id){state.cart={};state.requestKey=null;state.productGroup='';}state.current=id;state.view='shipments';render();window.scrollTo(0,0);}
function renderDetail(){
  const s=activeShipment();if(!s){state.current=null;render();return;}
  const brand=brandById(s.id)||BRANDS.find(b=>b.name.toLowerCase()===String(s.brand||s.title).toLowerCase());
  const categories=brand?.categories||[],visible=sellableProducts(s);
  if(!categories.some(name=>groupKey(name)===groupKey(state.productGroup)))state.productGroup='';
  if(!state.productGroup){
    app.innerHTML=`<button class="back" id="back">← Бренды</button><section class="detail-head"><p class="eyebrow">КАТАЛОГ</p><h1>${esc(brand?.name||s.brand||s.title)}</h1><p class="subtitle">Выберите категорию.</p></section><div class="category-grid count-${categories.length}">${categories.map(name=>{const count=visible.filter(p=>groupKey(p.group)===groupKey(name)).length;return `<button class="category-card" data-category="${esc(name)}"><strong>${esc(name)}</strong><span>${count} товаров</span><span class="arrow" aria-hidden="true">→</span></button>`;}).join('')}</div>`;
    $('#back').onclick=goBack;
    document.querySelectorAll('[data-category]').forEach(button=>button.onclick=()=>{state.productGroup=button.dataset.category;render();window.scrollTo(0,0);});
    loadImages({...s,products:visible});
    return;
  }
  const category=categories.find(name=>groupKey(name)===groupKey(state.productGroup))||state.productGroup;
  const count=visible.filter(p=>groupKey(p.group)===groupKey(category)).length;
  app.innerHTML=`<button class="back" id="back">← ${esc(brand?.name||'Категории')}</button><section class="detail-head"><p class="eyebrow">${esc(brand?.name||s.brand||s.title)}</p><h1>${esc(category)}</h1><div class="detail-meta"><span>В продаже<strong>${count} позиций</strong></span></div></section><div class="toolbar"><input class="search" type="search" id="product-search" placeholder="Название, модель или артикул" aria-label="Поиск товара"></div><div id="products"></div>`;
  $('#product-search').oninput=debounce(e=>{if(e.target.isConnected)products(e.target.value);});
  $('#back').onclick=goBack;products('');loadImages({...s,products:visible.filter(p=>groupKey(p.group)===groupKey(category))});
}
function products(query){
  const s=activeShipment(),category=state.productGroup;
  const list=sellableProducts(s).filter(p=>groupKey(p.group)===groupKey(category)&&`${p.name} ${p.sku}`.toLowerCase().includes(query.toLowerCase()));
  $('#products').innerHTML=list.length?`<div class="products">${list.map(p=>{
    const qty=state.cart[p.id]||0,disabled=(!isOpen(s)&&!state.preview)||p.stock<=0;
    return `<article class="product compact-product ${qty?'selected':''}" data-product="${esc(p.id)}">${photo(p)}<div class="product-info"><span class="sku">${esc(p.sku)}</span><p class="product-title">${esc(p.name)}</p><span class="price">${money(p.price)} <small>/ ${esc(p.unit||'шт.')}</small></span><div class="stock">В наличии: ${p.stock}</div></div><div class="product-controls"><div class="stepper"><button data-step="-1" data-id="${esc(p.id)}" aria-label="Уменьшить количество" ${disabled?'disabled':''}>−</button><input data-qty="${esc(p.id)}" type="number" inputmode="numeric" min="0" max="${p.stock}" value="${qty}" aria-label="Количество ${esc(p.sku)}" ${disabled?'disabled':''}><button data-step="1" data-id="${esc(p.id)}" aria-label="Увеличить количество" ${disabled?'disabled':''}>+</button></div><strong class="line-total" data-line-total="${esc(p.id)}">${money(qty*p.price)}</strong></div></article>`;
  }).join('')}</div>`:'<p class="empty">В этой категории товаров пока нет.</p>';
  document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>setQuantity(b.dataset.id,(state.cart[b.dataset.id]||0)+Number(b.dataset.step)));
  document.querySelectorAll('[data-qty]').forEach(input=>input.onchange=()=>setQuantity(input.dataset.qty,Number(input.value)));
  hydrateImages();
}
function setQuantity(id,value){
  const p=activeShipment()?.products.find(p=>p.id===id);if(!p)return;
  const qty=Math.max(0,Math.min(p.stock,Number.isFinite(value)?Math.floor(value):0));
  if(qty)state.cart[id]=qty;else delete state.cart[id];state.requestKey=null;
  const el=[...document.querySelectorAll('[data-qty]')].find(e=>e.dataset.qty===id);if(el){el.value=qty;el.closest('.product').classList.toggle('selected',qty>0);}
  const total=document.querySelector(`[data-line-total="${CSS.escape(id)}"]`);if(total)total.textContent=money(qty*p.price);
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
  const s=activeShipment(),t=totals();if(!s || !t.count)return;
  showDialog('Ваш заказ',`<p class="muted">${esc(s.title)}</p>${Object.entries(state.cart).map(([id,q])=>{const p=s.products.find(p=>p.id===id);return `<div class="cart-line"><p>${esc(p.name)}</p><span class="muted">${esc(p.sku)} · ${q} шт. × ${money(p.price)}</span></div>`;}).join('')}<div class="cart-total"><span>${t.count} шт.</span><span>${money(t.total)}</span></div><label class="field">Комментарий<textarea id="comment" maxlength="1000" placeholder="Например, название магазина"></textarea></label><p class="fine-print">После оформления количество товара в наличии сразу уменьшится.</p>${state.preview?'<p class="warning">Предпросмотр. Заказ не будет оформлен.</p>':''}<p id="placeOrder-error" class="error" role="alert"></p><button class="primary full" id="submit-placeOrder" ${state.preview||!state.ready?'disabled':''}>Оформить заказ</button>`);
  $('#comment').oninput=()=>state.requestKey=null;
  $('#submit-placeOrder').onclick=async()=>{
    const button=$('#submit-placeOrder');button.disabled=true;button.textContent='Отправляем…';$('#placeOrder-error').textContent='';$('#comment').disabled=true;
    state.requestKey ||= crypto.randomUUID();
    const key=state.requestKey;
    try{
      const {order}=await api('/orders','POST',{shipmentId:s.id,requestKey:key,lines:Object.entries(state.cart).map(([id,quantity])=>({id,quantity})),comment:$('#comment').value});
      state.cart={};state.requestKey=null;closeDialog();cartBar();
      toast(`Заказ №${order.id.slice(0,8)} оформлен и отправлен.`);
      state.shipments=(await api('/catalog')).shipments;state.view='orders';render();
    }catch(e){
      if(dialog.open&&$('#placeOrder-error')){$('#placeOrder-error').textContent=e.message;button.disabled=false;button.textContent='Повторить отправку';$('#comment').disabled=false;}
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
    $('#orders').innerHTML=orders.length?orders.map(r=>`<article class="order"><div class="top"><div><small>№ ${esc(r.id.slice(0,8))} · ${date(r.createdAt)}</small><h3 style="margin-top:8px">${esc(r.shipmentTitle)}</h3></div>${badge(r.status)}</div>${r.editedAt?'<p class="muted">Заказ изменён</p>':''}${all?`<p>${esc(r.user.name)} ${r.user.username?'@'+esc(r.user.username):''}</p>`:''}<strong>${money(r.total)}</strong><span class="muted"> · ${r.lines.reduce((s,l)=>s+l.quantity,0)} шт.</span><details><summary>Состав заказа</summary><ul>${r.lines.map(l=>`<li>${esc(l.sku)} · ${esc(l.name)} — <b>${l.quantity} шт.</b></li>`).join('')}</ul>${r.comment?`<p>${esc(r.comment)}</p>`:''}</details><div class="actions">${r.status==='placed'||all&&r.status==='confirmed'?`<button class="secondary" data-edit-order="${r.id}">Изменить</button>`:''}${all&&r.status==='placed'?`<button class="primary" data-confirm="${r.id}">Подтвердить</button>`:''}${r.status==='placed'||all&&r.status==='confirmed'?`<button class="danger" data-cancel="${r.id}">Отменить заказ</button>`:''}</div></article>`).join(''):'<div class="empty"><strong>Заказов пока нет</strong>Выберите бренд и добавьте нужные товары.</div>';
    document.querySelectorAll('[data-edit-order]').forEach(b=>b.onclick=()=>editOrderForm(orders.find(r=>r.id===b.dataset.editOrder),all));
    document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>changeOrder(b.dataset.cancel,'cancelled',all));
    document.querySelectorAll('[data-confirm]').forEach(b=>b.onclick=()=>changeOrder(b.dataset.confirm,'confirmed',all));
    if(all)$('#export').onclick=()=>exportOrders(orders).catch(e=>toast(e.message));
  }catch(e){if(container.isConnected)container.innerHTML=`<p class="empty error">${esc(e.message)}</p>`;}
}
async function editOrderForm(order,all){
  let shipment;
  try{shipment=(await api('/catalog')).shipments.find(s=>s.id===order.shipmentId);if(!shipment)throw Error('Каталог недоступен. Обратитесь в магазин.');}catch(e){toast(e.message);return;}
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
  app.innerHTML=`<div class="page-heading"><div><p class="eyebrow">EL / STORE</p><h1>Управление</h1><p class="subtitle">Excel обновляет цены и текущие остатки по артикулу. Товары, которых нет в новом файле, скрываются автоматически.</p></div></div><div class="actions"><button class="secondary" id="all-orders">Все заказы</button><button class="secondary" id="setup-bot">Подключить бота</button></div><section class="admin-panel">${BRANDS.map(brand=>{const catalog=catalogForBrand(brand.id),available=sellableProducts(catalog);return `<div class="admin-row"><div><strong>${esc(brand.name)}</strong><small>${brand.categories.map(esc).join(' · ')}</small><small>${available.length} товаров в продаже${catalog?' · каталог загружен':' · Excel ещё не загружен'}</small></div><button class="primary" data-brand-import="${esc(brand.id)}">${catalog?'Обновить Excel':'Загрузить Excel'}</button></div>`;}).join('')}</section>`;
  $('#all-orders').onclick=()=>{state.view='all-orders';render();};
  $('#setup-bot').onclick=showBotSetup;
  document.querySelectorAll('[data-brand-import]').forEach(b=>{const brand=brandById(b.dataset.brandImport);b.onclick=()=>editShipment(catalogForBrand(brand.id),brand);});
}
function deleteShipment(shipment){
  showDialog('Удалить каталог?',`<p><strong>${esc(shipment.title)}</strong></p><p>Каталог и его товары исчезнут из приложения. Отменённые заказы останутся в истории администратора. Каталог с действующими заказами удалить нельзя.</p><p id="delete-error" class="error" role="alert"></p><button class="danger full" id="delete-shipment">Удалить каталог</button>`);
  const error=$('#delete-error'),button=$('#delete-shipment');
  button.onclick=async()=>{
    button.disabled=true;error.textContent='';
    try{
      await api('/admin/shipments/'+encodeURIComponent(shipment.id),'DELETE');
      state.shipments=state.shipments.filter(s=>s.id!==shipment.id);
      if(state.current===shipment.id){state.current=null;state.cart={};state.requestKey=null;}
      closeDialog();render();toast('Каталог удалён.');
    }catch(e){error.textContent=e.message;button.disabled=false;}
  };
}
function showBotSetup(){
  showDialog('Подключение бота',`<p>Подключим команды бота и кнопку открытия товаров.</p><p>Затем добавьте @E_NewSletters_Bot администратором рабочего канала с правом публикации и перешлите ему сообщение из этого канала. Бот ответит ID канала для настройки уведомлений.</p><p id="bot-setup-error" class="error" role="alert"></p><button class="primary full" id="connect-bot">Подключить</button>`);
  $('#connect-bot').onclick=async()=>{
    const button=$('#connect-bot'),error=$('#bot-setup-error');button.disabled=true;button.textContent='Подключаем…';error.textContent='';
    try{
      await api('/admin/setup-bot','POST',{});
      showDialog('Бот подключён',`<p>Добавьте @E_NewSletters_Bot администратором рабочего канала с правом публикации сообщений.</p><p>Перешлите сообщение из канала в личный чат с ботом, сохранив источник пересылки. Полученный ID укажите в Cloudflare как Secret <strong>ORDER_CHAT_ID</strong>, сохраните и переоткройте приложение.</p><p><a class="primary" href="https://t.me/E_NewSletters_Bot" target="_blank" rel="noopener">Открыть бота</a></p>`);
    }catch(e){error.textContent=e.message;button.disabled=false;button.textContent='Повторить подключение';}
  };
}
function editShipment(existing,brand){
  importController?.abort();
  brand ||= BRANDS.find(b=>b.id===existing?.id)||BRANDS.find(b=>b.name.toLowerCase()===String(existing?.brand||'').toLowerCase());
  if(!brand){toast('Не удалось определить бренд.');return;}
  const groups=[...brand.categories],historyProducts=existing?.products||[];
  let products=existing?manualProducts(existing.products.filter(p=>!p.hidden&&p.stock>0).map(p=>({...p,stock:p.stock})),groups):null,warnings=[];
  showDialog(`${brand.name} — каталог`,`<form id="shipment-form"><p class="fine-print">Загрузите актуальный Excel. Совпадение идёт по артикулу: цена и остаток обновятся, отсутствующие в новом файле товары будут скрыты.</p><p class="fine-print"><strong>Категории:</strong> ${groups.map(esc).join(' · ')}</p><label class="field">${existing?'Обновить каталог из Excel':'Excel с товарами'}<input type="file" id="xlsx-file" accept=".xls,.xlsx" ${existing?'':'required'}></label><div id="import-info">${products?`<p class="import-summary">Сейчас в продаже: ${products.length} позиций</p>`:''}</div><div id="category-editor"></div><p id="import-error" class="error" role="alert"></p><button class="primary full" id="save-shipment" type="submit" ${products?'':'disabled'}>Сохранить каталог</button></form>`);
  const form=$('#shipment-form');
  function reviewCategories(){
    const container=$('#category-editor');if(!products){container.textContent='';return;}
    container.innerHTML=`<section class="category-review"><h3>Распределение по категориям</h3><p class="fine-print">Для каждого товара выберите одну из категорий ${esc(brand.name)}.</p><div class="category-editor-products">${products.map(p=>`<label class="category-editor-product"><span><strong>${esc(p.name)}</strong><small>${esc(p.sku)}</small></span><select data-product-category="${esc(p.id)}" required><option value="">Не выбрано</option>${groups.map(name=>`<option value="${esc(name)}" ${groupKey(p.group)===groupKey(name)?'selected':''}>${esc(name)}</option>`).join('')}</select></label>`).join('')}</div></section>`;
    container.querySelectorAll('[data-product-category]').forEach(select=>select.onchange=()=>{const p=products.find(x=>x.id===select.dataset.productCategory);if(p)p.group=select.value;});
  }
  if(products)reviewCategories();
  $('#xlsx-file').onchange=async e=>{
    const file=e.target.files[0];if(!file)return;
    importController?.abort();const controller=new AbortController();importController=controller;
    products=null;warnings=[];$('#category-editor').textContent='';
    $('#save-shipment').disabled=true;$('#import-info').textContent='Читаем Excel и сжимаем фотографии…';$('#import-error').textContent='';
    try{
      const result=await readSupplierExcel(file,{signal:controller.signal});
      if(controller.signal.aborted||!form.isConnected)return;
      const previousById=new Map(historyProducts.map(p=>[p.id,p]));
      const merged=result.products.map(p=>{const old=previousById.get(p.id);return {...p,group:old?.group||'',image:p.image||old?.image||null,imageKey:p.imageKey||old?.imageKey||null};});
      products=manualProducts(merged,groups,historyProducts);warnings=result.warnings;reviewCategories();
      const previousIds=new Set(historyProducts.filter(p=>!p.hidden).map(p=>p.id)),nextIds=new Set(products.map(p=>p.id));
      const hidden=[...previousIds].filter(id=>!nextIds.has(id)).length;
      $('#import-info').innerHTML=`<div class="import-summary">${products.length} позиций · ${products.filter(p=>p.image||p.imageKey).length} фотографий${hidden?` · будет скрыто: ${hidden}`:''}</div>${warnings.length?`<details class="warning"><summary>Замечания: ${warnings.length}</summary>${warnings.map(w=>`<div>${esc(w)}</div>`).join('')}</details><label class="field"><input id="accept-warnings" type="checkbox" style="width:auto;min-height:auto"> Проверил замечания</label>`:''}<div class="import-preview"><table><thead><tr><th>Товар</th><th>Остаток</th><th>Цена</th></tr></thead><tbody>${products.map(p=>`<tr><td>${esc(p.name)}<br>${esc(p.sku)}</td><td>${p.stock}</td><td>${p.price===null?`<input data-import-price="${esc(p.id)}" type="number" inputmode="decimal" required min="0" max="1000000" step="0.01" placeholder="Цена, ₽" aria-label="Цена ${esc(p.sku)}">`:money(p.price)}</td></tr>`).join('')}</tbody></table></div>`;
      form.querySelectorAll('[data-import-price]').forEach(input=>input.oninput=()=>{const product=products.find(p=>p.id===input.dataset.importPrice);product.price=input.value.trim()&&input.validity.valid?Math.round(Number(input.value)*100):null;});
      $('#save-shipment').disabled=false;
    }catch(e){if(controller.signal.aborted||!form.isConnected)return;products=null;$('#import-info').textContent='';$('#import-error').textContent=e.message;}
  };
  form.onsubmit=async e=>{
    e.preventDefault();if(!products)return;
    if(products.some(p=>p.price===null)){$('#import-error').textContent='Заполните цены всех товаров перед сохранением.';return;}
    if(products.some(p=>!groups.some(name=>groupKey(name)===groupKey(p.group)))){$('#import-error').textContent='Выберите категорию для каждого товара.';return;}
    if(warnings.length&&!$('#accept-warnings')?.checked){$('#import-error').textContent='Подтвердите проверку замечаний.';return;}
    const b=$('#save-shipment');b.disabled=true;$('#import-error').textContent='';
    try{
      await api('/admin/shipments','POST',{id:brand.id,title:brand.name,brand:brand.name,status:'arrived',stockMode:'live',description:'',groupingMode:'manual',groups,products});
      closeDialog();await refresh();toast(`${brand.name}: каталог обновлён.`);
    }catch(e){if($('#import-error')){$('#import-error').textContent=e.message;b.disabled=false;}else toast(e.message);}
  };
}
function goBack(){
  if(state.current&&state.productGroup){state.productGroup='';render();window.scrollTo(0,0);return;}
  if(Object.keys(state.cart).length){showDialog('Вернуться к брендам?',`<p>Выбранные количества будут сброшены.</p><button class="primary full" id="leave">Вернуться</button>`);$('#leave').onclick=()=>{closeDialog();state.cart={};state.current=null;state.productGroup='';state.requestKey=null;render();};}
  else{state.current=null;state.productGroup='';render();}
}
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
      if(state.view==='shipments' && $('#shipment-grid')){cards();$('.count').textContent='3 бренда';cartBar();return;}
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
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{
  const target=b.dataset.view;
  if(target==='shipments'){state.current=null;state.productGroup='';state.cart={};state.requestKey=null;}
  state.view=target;render();window.scrollTo(0,0);
});
$('#refresh').onclick=()=>refresh();
dialog.addEventListener('close',()=>importController?.abort());
$('.brand').onclick=e=>{e.preventDefault();state.view='shipments';if(state.current)goBack();else render();};
tg?.BackButton?.onClick(goBack);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.preview&&!dialog.open)refresh({background:true});});
setInterval(()=>{if(!state.preview&&!document.hidden&&!dialog.open&&state.view==='shipments'&&tg?.initData)refresh({background:true});},45000);
init();
