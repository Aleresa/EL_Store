import {MIN_ORDER,isRemaxGlass,unitPrice,wholesaleTier} from './pricing.js';
import {readSupplierExcel,exportOrders} from './xlsx.js';
import {manualProducts,groupKey} from './product-groups.js';
import {DEFAULT_BRANDS,searchCatalog} from './catalog-config.js';
import {cartKey,cartEntry,readCart,reconcileCart,repeatCart,repriceCart} from './cart.js';
import {phoneModels,sortProducts} from './catalog-tools.js';

const $=s=>document.querySelector(s), app=$('#app'), dialog=$('#dialog');
const tg=window.Telegram?.WebApp;
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const moneyFormats=[0,2].map(maximumFractionDigits=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits}));
const money=n=>moneyFormats[n%100?1:0].format(n/100);
const date=s=>s?new Date(s.length===10?s+'T12:00:00':s).toLocaleDateString('ru-RU',{day:'numeric',month:'long'}):'Дата не указана';
const statuses={draft:'Скрыт',arrived:'В продаже',closed:'Продажа закрыта',placed:'Оформлен',confirmed:'Подтверждён',cancelled:'Отменён'};
const brandById=id=>state.brands.find(b=>b.id===id);
const visibleBrands=()=>state.brands.filter(b=>!b.hidden);
const builtInBrandCovers=[
  ['macbook','macbook'],
  ['iphone','iphone'],
  ['ipad','ipad'],
  ['remax','remax'],
  ['apple','apple']
];
const builtInBrandCover=brand=>{
  const text=groupKey([brand?.id,brand?.name].filter(Boolean).join(' '));
  const match=builtInBrandCovers.find(([key])=>text.includes(key));
  return match?`./images/brands/${match[1]}.webp`:null;
};
const catalogForBrand=id=>state.shipments.find(s=>s.id===id);
const sellableProducts=catalog=>(catalog?.status==='arrived'&&!catalog.hidden?catalog.products:[]).filter(p=>!p.hidden&&p.stock>0);
const state={preview:false,admin:false,ready:false,view:'shipments',brands:[...DEFAULT_BRANDS],shipments:[],current:null,sort:'new',search:'',cart:{},images:{},orders:[],productGroup:'',phoneModel:'',comment:'',pendingOrder:null,cartChanges:[]};
let toastTimer,refreshPromise,importController,placingOrder=false;
const imageRequests=new Map();
const debounce=(fn,delay=120)=>{let timer;return (...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),delay);};};
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6500);}
function badge(status){return `<span class="badge ${esc(status)}">${esc(statuses[status]||status)}</span>`;}
function notice(text){$('#notice').textContent=text;$('#notice').hidden=!text;}
async function api(path,method='GET',body){
  const savingBrand=method!=='GET'&&/^\/admin\/brands(?:\/[^/]+)?$/.test(path);
  let response,data;
  try{
    response=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json','X-Telegram-Init-Data':tg?.initData||''},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(savingBrand?120000:25000)});
    data=await response.json();
  }catch(error){
    if(error.name==='AbortError'||error.name==='TimeoutError')throw Error(savingBrand?'Сервер не ответил вовремя. Закройте настройки и откройте их заново, чтобы проверить, сохранились ли изменения.':'Сервер не ответил вовремя. Проверьте подключение и попробуйте снова.');
    throw error;
  }
  if(!response.ok){const error=Error(data.error||'Не удалось выполнить запрос.');error.status=response.status;throw error;}
  if(path==='/catalog'&&Array.isArray(data.brands))state.brands=data.brands;
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
    restoreCart();render();
  }catch(e){app.innerHTML=`<div class="empty"><strong>Не удалось загрузить товары</strong>${esc(e.message)}<p><button class="primary" id="retry">Попробовать ещё раз</button></p></div>`;$('#retry').onclick=init;}
}
function cartStorageKey(){return 'el-store-cart-v1:'+ (state.preview?'preview':state.user?.id);}
function saveCart(){
  try{localStorage.setItem(cartStorageKey(),JSON.stringify({cart:state.cart,comment:state.comment,pendingOrder:state.pendingOrder}));return true;}
  catch{toast('Не удалось сохранить корзину на устройстве. Не закрывайте приложение до завершения заказа.');return false;}
}
function restoreCart(){
  try{
    const saved=JSON.parse(localStorage.getItem(cartStorageKey())||'null');
    state.cart=readCart(saved?.cart);state.comment=String(saved?.comment||'').slice(0,1000);
    const pending=saved?.pendingOrder;
    if(pending&&/^[-\w]{1,80}$/.test(pending.requestKey)&&Array.isArray(pending.lines)&&pending.lines.length&&pending.lines.length<=100)state.pendingOrder=pending;
  }catch{state.cart={};}
  if(state.pendingOrder)toast('Осталась неподтверждённая отправка. Откройте корзину и проверьте заказ повторной отправкой.');
}
function cartLocked(){if(!state.pendingOrder&&!placingOrder)return false;toast('Сначала завершите предыдущую отправку в корзине. Повторная отправка не создаст дубль.');return true;}
function checkCart(){
  const checked=reconcileCart(state.cart,state.shipments);state.cart=checked.cart;
  state.cartChanges.push(...checked.changes);saveCart();cartBar();
}
function sortingControls(items){
  const models=[...new Set(items.flatMap(p=>phoneModels(p.name)))].sort((a,b)=>a.localeCompare(b,'ru',{numeric:true}));
  if(state.phoneModel&&!models.includes(state.phoneModel))state.phoneModel='';
  return `<div class="catalog-controls"><label>Сортировка<select id="product-sort">${[['new','Сначала новые'],['price-asc','Сначала дешевле'],['price-desc','Сначала дороже'],['name','По названию']].map(([v,t])=>`<option value="${v}" ${state.sort===v?'selected':''}>${t}</option>`).join('')}</select></label>${models.length?`<label>Модель телефона<select id="phone-model"><option value="">Все модели</option>${models.map(m=>`<option ${state.phoneModel===m?'selected':''}>${esc(m)}</option>`).join('')}</select></label>`:''}</div>`;
}
function bindSorting(redraw){
  if($('#product-sort'))$('#product-sort').onchange=e=>{state.sort=e.target.value;redraw();};
  if($('#phone-model'))$('#phone-model').onchange=e=>{state.phoneModel=e.target.value;redraw();};
}
function filteredProducts(items){return sortProducts(items.filter(p=>!state.phoneModel||phoneModels(p.name).includes(state.phoneModel)),state.sort);}
async function enlargePhoto(p,shipment){
  if(p.imageKey&&!p.image)await loadImages(shipment);
  const [key,sku]=(p.imageKey||'').split('/'),src=p.image||state.images[key]?.[sku];
  if(!src){toast('Фотография пока недоступна.');return;}
  let viewer=$('#photo-dialog');
  if(!viewer){viewer=document.createElement('dialog');viewer.id='photo-dialog';document.body.append(viewer);viewer.addEventListener('click',e=>{if(e.target===viewer)viewer.close();});}
  viewer.innerHTML=`<div class="dialog-header"><h2>${esc(p.sku)}</h2><button class="icon-button" aria-label="Закрыть фото">×</button></div><img src="${esc(src)}" alt="${esc(p.name)}"><p>${esc(p.name)}</p>`;
  viewer.querySelector('button').onclick=()=>viewer.close();viewer.showModal();
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

function searchBox(value=state.search){return `<div class="toolbar home-search"><input class="search" type="search" id="catalog-search" placeholder="Поиск товара или бренда" aria-label="Поиск товара или бренда" value="${esc(value)}"></div>`;}
function searchResultsMarkup(query){
  const found=searchCatalog(state.shipments,query),controls=query?sortingControls(found.map(m=>m.product)):'';
  const matches=filteredProducts(found.map(m=>({...m.product,brand:m.brand}))).map(product=>({brand:product.brand,product}));
  return `${controls}<div class="section-header"><h2>Найдено товаров: ${matches.length}</h2></div>${matches.length?`<div class="search-products">${matches.slice(0,100).map(({brand,product:p},index)=>`<button class="search-product" data-search-result="${index}">${photo(p)}<span><small>${esc(brand.name)} · ${esc(p.group)} · ${esc(p.sku)}</small><strong>${esc(p.name)}</strong><span class="price">${money(displayPrice(p,brand))}</span></span></button>`).join('')}</div>${matches.length>100?'<p class="fine-print">Показаны первые 100 товаров. Уточните запрос.</p>':''}`:'<p class="empty">Ничего не найдено. Попробуйте другое название, модель или артикул.</p>'}`;
}
function bindCatalogSearch(redraw){const input=$('#catalog-search');if(input)input.oninput=debounce(event=>{if(event.target.isConnected){state.search=event.target.value;redraw();}});}
function bindSearchResults(){
  const found=searchCatalog(state.shipments,state.search.trim());
  const matches=filteredProducts(found.map(m=>({...m.product,brand:m.brand}))).map(product=>({brand:product.brand,product}));
  bindSorting(()=>render());
  document.querySelectorAll('[data-search-result]').forEach(button=>button.onclick=()=>{const {brand,product}=matches[Number(button.dataset.searchResult)];openShipment(brand.id);state.productGroup=product.group;render();$('#product-search').value=product.sku;products(product.sku);});
}

function renderShipments(){
  app.innerHTML=`${searchBox()}<div class="page-heading compact-heading"><span class="count">Брендов: ${visibleBrands().length}</span></div><div class="brand-grid" id="shipment-grid"></div><section id="search-results" aria-label="Результаты поиска" hidden></section>`;
  bindCatalogSearch(cards);
  cards();
}
function cards(){
  const query=state.search.trim();
  const list=visibleBrands().map(brand=>({brand,catalog:catalogForBrand(brand.id)}));
  $('#shipment-grid').innerHTML=list.map(({brand,catalog})=>{
    const available=sellableProducts(catalog),examples=available.filter(p=>p.image||p.imageKey).slice(0,2);
    const cover=builtInBrandCover(brand)||brand.cover;
    return `<article class="brand-card"><button class="brand-open" data-brand="${esc(brand.id)}"><div class="brand-visual${cover||examples.length?' has-photo':''}">${cover?`<img class="brand-cover" src="${esc(cover)}" alt="${esc(brand.name)}" loading="lazy">`:examples.map(p=>photo(p,'cover-photo')).join('')}${cover?'':`<span class="brand-name">${esc(brand.name)}</span>`}</div><div class="brand-card-footer"><span>${available.length} товаров</span></div></button></article>`;
  }).join('');
  document.querySelectorAll('[data-brand]').forEach(button=>button.onclick=()=>openShipment(button.dataset.brand));
  const results=$('#search-results');results.hidden=!query;
  results.innerHTML=query?searchResultsMarkup(query):'';
  if(query)bindSearchResults();
  list.forEach(({catalog})=>catalog&&loadImages({...catalog,products:sellableProducts(catalog)}));
}
function openShipment(id){if(state.current!==id){state.productGroup='';state.phoneModel='';}state.current=id;state.view='shipments';render();window.scrollTo(0,0);}
const iphoneSeriesCovers={'alba series':'alba','shockproof series':'shockproof','ocean series':'ocean','slim series':'slim'};
const builtInCategoryCovers={
  'magnet series':'../series/magnet',
  'origami series':'../series/origami',
  'оригинал':'original',
  'копия':'copy',
  'накладки':'nakladki',
  'сумки':'sumki',
  'cases':'nakladki',
  'bags':'sumki',
  'gl-27':'gl-27',
  'gl-27 privacy':'gl-27-privacy',
  'gl-27 антишпион':'gl-27-privacy',
  'es-01':'es-01'
};
function renderDetail(){
  const s=activeShipment();if(!s){state.current=null;render();return;}
  const brand=brandById(s.id);
  const categories=brand?.categories||[],visible=sellableProducts(s);
  if(!categories.some(name=>groupKey(name)===groupKey(state.productGroup)))state.productGroup='';
  if(!state.productGroup){
    const query=state.search.trim();
    const categoryCards=`<section class="detail-head"><h1>${esc(brand?.name||s.brand||s.title)}</h1></section><div class="category-grid count-${categories.length}" data-category-brand="${esc(s.id)}">${categories.map(name=>{const count=visible.filter(p=>groupKey(p.group)===groupKey(name)).length;const customCover=brand?.categoryCovers&&Object.hasOwn(brand.categoryCovers,name)?brand.categoryCovers[name]:null,series=groupKey(brand?.name||s.brand||s.title)==='iphone'?iphoneSeriesCovers[groupKey(name)]:null,builtIn=builtInCategoryCovers[groupKey(name)],cover=customCover||(series?`./images/series/${series}.webp`:builtIn?`./images/categories/${builtIn}.webp`:null);return `<button class="category-card${cover?' category-with-cover':''}" data-category="${esc(name)}" aria-label="${esc(name)}">${cover?`<img class="category-cover" src="${esc(cover)}" alt="" width="800" height="1067" loading="lazy">`: ''}${cover&&!customCover?'':`<strong>${esc(name)}</strong>`}<span>${count} товаров</span></button>`;}).join('')}</div>`;
    app.innerHTML=`<button class="back" id="back">← Бренды</button>${searchBox()}${query?`<section id="search-results" aria-label="Результаты поиска">${searchResultsMarkup(query)}</section>`:categoryCards}`;
    $('#back').onclick=goBack;bindCatalogSearch(renderDetail);if(query)bindSearchResults();
    document.querySelectorAll('[data-category]').forEach(button=>button.onclick=()=>{state.productGroup=button.dataset.category;state.phoneModel='';render();window.scrollTo(0,0);});
    loadImages({...s,products:visible});
    return;
  }
  const category=categories.find(name=>groupKey(name)===groupKey(state.productGroup))||state.productGroup;
  const count=visible.filter(p=>groupKey(p.group)===groupKey(category)).length;
  app.innerHTML=`<button class="back" id="back">← ${esc(brand?.name||'Категории')}</button><section class="detail-head category-heading"><div class="category-heading-title"><h1>${esc(category)}</h1></div><div class="detail-meta"><span>В продаже<strong>${count} позиций</strong></span></div></section><div class="toolbar home-search"><input class="search" type="search" id="product-search" placeholder="Поиск товара или бренда" aria-label="Поиск товара"></div>${sortingControls(visible.filter(p=>groupKey(p.group)===groupKey(category)))}<div id="products"></div>`;
  $('#product-search').oninput=debounce(e=>{if(e.target.isConnected)products(e.target.value);});
  bindSorting(()=>products($('#product-search').value));
  $('#back').onclick=goBack;products('');loadImages({...s,products:visible.filter(p=>groupKey(p.group)===groupKey(category))});
}
function remaxQuantity(){return Object.values(state.cart).reduce((n,l)=>{const s=state.shipments.find(s=>s.id===l.shipmentId),p=s?.products.find(p=>p.id===l.id);return n+(p&&isRemaxGlass(brandById(s.id),p)?l.quantity:0);},0);}
function displayPrice(p,brand){return unitPrice(p,remaxQuantity(),isRemaxGlass(brand,p));}
function products(query){
  const s=activeShipment(),category=state.productGroup;
  const list=filteredProducts(sellableProducts(s).filter(p=>groupKey(p.group)===groupKey(category)&&`${p.name} ${p.sku}`.toLowerCase().includes(query.toLowerCase())));
  $('#products').innerHTML=list.length?`<div class="products">${list.map(p=>{
    const qty=state.cart[cartKey(s.id,p.id)]?.quantity||0,disabled=Boolean(state.pendingOrder)||(!isOpen(s)&&!state.preview)||p.stock<=0;
    return `<article class="product compact-product ${qty?'selected':''}" data-product="${esc(p.id)}">${p.image||p.imageKey?`<button class="photo-button" data-enlarge="${esc(p.id)}" aria-label="Увеличить фото ${esc(p.name)}">${photo(p)}</button>`:photo(p)}<div class="product-info"><span class="sku">${esc(p.sku)}</span><p class="product-title">${esc(p.name)}</p><span class="price">${money(displayPrice(p,brandById(s.id)))} <small>/ ${esc(p.unit||'шт.')}</small></span><div class="stock">В наличии: ${p.stock}</div></div><div class="product-controls"><div class="stepper"><button data-step="-1" data-id="${esc(p.id)}" aria-label="Уменьшить количество" ${disabled?'disabled':''}>−</button><input data-qty="${esc(p.id)}" type="number" inputmode="numeric" min="0" max="${p.stock}" value="${qty}" aria-label="Количество ${esc(p.sku)}" ${disabled?'disabled':''}><button data-step="1" data-id="${esc(p.id)}" aria-label="Увеличить количество" ${disabled?'disabled':''}>+</button></div><strong class="line-total" data-line-total="${esc(p.id)}">${money(qty*displayPrice(p,brandById(s.id)))}</strong></div></article>`;
  }).join('')}</div>`:'<p class="empty">В этой категории товаров пока нет.</p>';
  document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>setQuantity(b.dataset.id,(state.cart[cartKey(s.id,b.dataset.id)]?.quantity||0)+Number(b.dataset.step)));
  document.querySelectorAll('[data-qty]').forEach(input=>input.onchange=()=>setQuantity(input.dataset.qty,Number(input.value)));
  document.querySelectorAll('[data-enlarge]').forEach(b=>b.onclick=()=>enlargePhoto(s.products.find(p=>p.id===b.dataset.enlarge),s));
  hydrateImages();
}
function setQuantity(id,value){
  if(cartLocked())return;
  const shipment=activeShipment(),p=shipment?.products.find(p=>p.id===id);if(!p)return;
  const key=cartKey(shipment.id,id);
  if(!state.cart[key]&&Object.keys(state.cart).length>=100){toast('В один заказ можно добавить до 100 позиций.');return;}
  const qty=Math.max(0,Math.min(p.stock,Number.isFinite(value)?Math.floor(value):0));
  if(qty)state.cart[key]=cartEntry(shipment.id,p,qty);else delete state.cart[key];saveCart();
  const el=[...document.querySelectorAll('[data-qty]')].find(e=>e.dataset.qty===id);if(el){el.value=qty;el.closest('.product').classList.toggle('selected',qty>0);}
  const total=document.querySelector(`[data-line-total="${CSS.escape(id)}"]`);if(total)total.textContent=money(qty*p.price);
  repriceCart(state.cart,state.shipments);saveCart();
  document.querySelectorAll('[data-product]').forEach(row=>{const product=shipment.products.find(p=>p.id===row.dataset.product);if(!product)return;const price=displayPrice(product,brandById(shipment.id));row.querySelector('.price').innerHTML=money(price)+' <small>/ '+esc(product.unit||'шт.')+'</small>';row.querySelector('.line-total').textContent=money((state.cart[cartKey(shipment.id,product.id)]?.quantity||0)*price);});
  cartBar();
}
function totals(){if(!state.pendingOrder)repriceCart(state.cart,state.shipments);return Object.values(state.cart).reduce((r,l)=>({count:r.count+l.quantity,total:r.total+l.quantity*l.price}),{count:0,total:0});}
function cartBar(){
  const t=totals(),visible=t.count>0||Boolean(state.pendingOrder);
  $('#cart-bar').hidden=!visible;document.body.classList.toggle('has-cart',visible);
  if(visible){$('#cart-bar').innerHTML=`<button id="open-cart"><span>В корзине: ${t.count} шт.<br><small>${state.pendingOrder?'Проверить отправку':'Проверить заказ'}</small></span><strong>${money(t.total)}</strong></button>`;$('#open-cart').onclick=showCart;}
}
function closeDialog(){importController?.abort();dialog.close();}
function showDialog(title,body){dialog.innerHTML=`<div class="dialog-header"><h2>${esc(title)}</h2><button class="icon-button" id="close-dialog" aria-label="Закрыть">×</button></div>${body}`;$('#close-dialog').onclick=closeDialog;if(!dialog.open)dialog.showModal();}
async function showCart(){
  if(!state.pendingOrder){
    try{if(!state.preview)state.shipments=(await api('/catalog')).shipments;checkCart();}
    catch(e){toast('Не удалось проверить цены и остатки. '+e.message);return;}
  }
  drawCart();
}
function drawCart(){
  const t=totals(),locked=Boolean(state.pendingOrder);
  showDialog('Ваша корзина',`${state.cartChanges.length?`<div class="warning" role="status"><strong>Корзина обновлена. Проверьте изменения:</strong><ul>${[...new Set(state.cartChanges)].map(c=>`<li>${esc(c)}</li>`).join('')}</ul></div>`:''}${locked?'<p class="warning">Предыдущая отправка ещё не подтверждена. Нажмите «Проверить отправку»: повторный запрос не создаст второй заказ.</p>':''}${Object.values(state.cart).map(l=>`<div class="cart-line"><small>${esc(brandById(l.shipmentId)?.name)}</small><p>${esc(l.name)}</p><span class="muted">${esc(l.sku)} · ${money(l.price)} / шт.</span><div class="cart-quantity"><label>Количество<input data-cart-qty="${esc(cartKey(l.shipmentId,l.id))}" type="number" min="1" step="1" value="${l.quantity}" ${locked?'disabled':''}></label><button class="danger" data-cart-remove="${esc(cartKey(l.shipmentId,l.id))}" ${locked?'disabled':''}>Убрать</button></div></div>`).join('')||'<p class="empty">Корзина пуста. Выберите товары в каталоге.</p>'}<div class="cart-total"><span>${t.count} шт.</span><span>${money(t.total)}</span></div>${remaxQuantity()>0&&t.total<MIN_ORDER?`<p class="warning">Минимальный заказ от 10.000 рублей. Добавьте товаров ещё на ${money(MIN_ORDER-t.total)}.</p>`:''}${remaxQuantity()?`<p class="fine-print">Стёкол Remax: ${remaxQuantity()} шт. · Опт ${wholesaleTier(remaxQuantity())+1}. До 19 шт. — Опт 1, 20–99 — Опт 2, от 100 — Опт 3.</p>`:''}<label class="field">Комментарий<textarea id="comment" maxlength="1000" placeholder="Например, название магазина" ${locked?'disabled':''}>${esc(state.comment)}</textarea></label><p class="fine-print">Товары разных брендов оформляются одним заказом. Перед отправкой проверяются актуальные цены и остатки.</p>${state.preview?'<p class="warning">Предпросмотр. Заказ не будет оформлен.</p>':''}<p id="placeOrder-error" class="error" role="alert"></p><button class="primary full" id="submit-placeOrder" ${state.preview||!state.ready||((!t.count||((remaxQuantity()>0)&&t.total<MIN_ORDER))&&!locked)?'disabled':''}>${locked?'Проверить отправку':'Оформить заказ'}</button>`);
  $('#comment').oninput=e=>{state.comment=e.target.value;saveCart();};
  dialog.querySelectorAll('[data-cart-remove]').forEach(b=>b.onclick=()=>{if(cartLocked())return;delete state.cart[b.dataset.cartRemove];saveCart();cartBar();drawCart();});
  dialog.querySelectorAll('[data-cart-qty]').forEach(el=>el.onchange=()=>{
    if(cartLocked())return;
    const l=state.cart[el.dataset.cartQty],p=state.shipments.find(s=>s.id===l.shipmentId)?.products.find(p=>p.id===l.id);
    l.quantity=Math.max(1,Math.min(p?.stock||l.quantity,Number.isFinite(Number(el.value))?Math.floor(Number(el.value)):1));saveCart();cartBar();drawCart();
  });
  $('#submit-placeOrder').onclick=submitCart;
}
async function submitCart(){
  if(placingOrder)return;placingOrder=true;
  dialog.querySelectorAll('input,textarea,button').forEach(el=>el.disabled=true);
  const button=$('#submit-placeOrder');button.disabled=true;button.textContent='Проверяем…';
  try{
    if(!state.pendingOrder){
      state.shipments=(await api('/catalog')).shipments;
      const checked=reconcileCart(state.cart,state.shipments);state.cart=checked.cart;
      if(checked.changes.length){state.cartChanges.push(...checked.changes);saveCart();cartBar();drawCart();return;}
      if(!Object.keys(state.cart).length||(remaxQuantity()>0&&totals().total<MIN_ORDER)){drawCart();return;}
      state.pendingOrder={enforceMinimum:true,requestKey:crypto.randomUUID(),lines:Object.values(state.cart).map(l=>({shipmentId:l.shipmentId,id:l.id,quantity:l.quantity,expectedPrice:l.price})),comment:state.comment};
      saveCart();
    }
    dialog.querySelectorAll('input,textarea,button').forEach(el=>el.disabled=true);
    button.textContent='Отправляем…';
    const {order}=await api('/orders','POST',state.pendingOrder);
    state.cart={};state.pendingOrder=null;state.comment='';state.cartChanges=[];saveCart();closeDialog();cartBar();
    toast(`Заказ №${order.id.slice(0,8)} оформлен.`);
    state.view='orders';render();void refresh({background:true});
  }catch(e){
    if(e.status===400||e.status===409){state.pendingOrder=null;saveCart();drawCart();await showCart();}
    else if(dialog.open)drawCart();
    if($('#placeOrder-error')&&dialog.open)$('#placeOrder-error').textContent=e.message;else toast(e.message);
  }finally{placingOrder=false;}
}
async function repeatOrder(order){
  if(cartLocked())return;
  try{
    state.shipments=(await api('/catalog')).shipments;
    const result=repeatCart(state.cart,order,state.shipments);state.cart=result.cart;state.cartChanges.push(...result.changes);
    saveCart();cartBar();drawCart();
  }catch(e){toast(e.message);}
}
async function renderOrders(all=false){
  state.view=all?'all-orders':'orders';
  app.innerHTML=`<div class="page-heading"><div><h1>${all?'Все заказы':'Мои заказы'}</h1></div>${all?'<button class="secondary" id="export">Excel ↓</button>':''}</div><div id="orders"><p class="empty">Загружаем…</p></div>`;
  if(!all && !state.preview && state.user)$('#orders').insertAdjacentHTML('beforebegin',`<p class="muted">Заказы привязаны к вашему Telegram-аккаунту.</p>`);
  if(state.preview){$('#orders').innerHTML='<div class="empty"><strong>Здесь будут ваши заказы</strong>Отправка появится после подключения бота и рабочего канала.</div>';return;}
  const container=$('#orders');
  try{
    const {orders}=await api('/orders'+(all?'?all=1':''));
    if(!container.isConnected)return;
    state.orders=orders;
    $('#orders').innerHTML=orders.length?orders.map(r=>`<article class="order"><div class="top"><div><small>№ ${esc(r.id.slice(0,8))} · ${date(r.createdAt)}</small><h3 style="margin-top:8px">${esc(r.shipmentTitle)}</h3></div>${badge(r.status)}</div>${r.editedAt?'<p class="muted">Заказ изменён</p>':''}${all?`<p>${esc(r.user.name)} ${r.user.username?'@'+esc(r.user.username):''}</p>`:''}<strong>${money(r.total)}</strong><span class="muted"> · ${r.lines.reduce((s,l)=>s+l.quantity,0)} шт.</span><details><summary>Состав заказа</summary><ul>${r.lines.map(l=>`<li>${l.shipmentTitle?esc(l.shipmentTitle)+' · ':''}${esc(l.sku)} · ${esc(l.name)} — <b>${l.quantity} шт.</b></li>`).join('')}</ul>${r.comment?`<p>${esc(r.comment)}</p>`:''}</details><div class="actions">${!all?`<button class="secondary" data-repeat-order="${r.id}">Повторить заказ</button>`:''}${r.status==='placed'||all&&r.status==='confirmed'?`<button class="secondary" data-edit-order="${r.id}">Изменить</button>`:''}${all&&r.status==='placed'?`<button class="primary" data-confirm="${r.id}">Подтвердить</button>`:''}${r.status==='placed'||all&&r.status==='confirmed'?`<button class="danger" data-cancel="${r.id}">Отменить заказ</button>`:''}</div></article>`).join(''):'<div class="empty"><strong>Заказов пока нет</strong>Выберите бренд и добавьте нужные товары.</div>';
    document.querySelectorAll('[data-repeat-order]').forEach(b=>b.onclick=()=>repeatOrder(orders.find(r=>r.id===b.dataset.repeatOrder)));
    document.querySelectorAll('[data-edit-order]').forEach(b=>b.onclick=()=>editOrderForm(orders.find(r=>r.id===b.dataset.editOrder),all));
    document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>changeOrder(b.dataset.cancel,'cancelled',all));
    document.querySelectorAll('[data-confirm]').forEach(b=>b.onclick=()=>changeOrder(b.dataset.confirm,'confirmed',all));
    if(all)$('#export').onclick=()=>exportOrders(orders).catch(e=>toast(e.message));
  }catch(e){if(container.isConnected)container.innerHTML=`<p class="empty error">${esc(e.message)}</p>`;}
}
async function editOrderForm(order,all){
  let shipment;
  try{const catalogs=(await api('/catalog')).shipments;shipment={products:catalogs.flatMap(s=>sellableProducts(s).map(p=>({...p,originalId:p.id,id:cartKey(s.id,p.id),shipmentId:s.id,name:s.title+' · '+p.name})))};}catch(e){toast(e.message);return;}
  const originals=new Map(order.lines.map(l=>[cartKey(l.shipmentId??order.shipmentId,l.id),l])),draft=new Map([...originals].map(([id,l])=>[id,l.quantity]));
  let requestKey=null;
  showDialog('Изменить заказ',`<p class="muted">${esc(order.shipmentTitle)}</p><p class="fine-print">Поставьте 0, чтобы убрать позицию. Увеличение количества возможно в пределах наличия. Для полного отказа отмените заказ.</p><form id="edit-order-form"><div id="edit-order-lines"></div><label class="field">Добавить товар<select id="add-order-product"><option value="">Выберите товар</option></select></label><p class="fine-print">Для стёкол Remax оптовая цена пересчитывается по общему количеству. Для остальных товаров ранее выбранная цена сохраняется. Минимальный заказ — 10 000 ₽.</p><label class="field">Комментарий<textarea id="edit-order-comment" maxlength="1000">${esc(order.comment)}</textarea></label><p class="cart-total" id="edit-order-total"></p><p id="edit-order-error" class="error" role="alert"></p><button type="button" class="secondary full" id="reload-orders" hidden>Обновить список заказов</button><button class="primary full" type="submit" id="save-order">Сохранить изменения</button></form>`);
  const form=$('#edit-order-form');
  const draftProduct=id=>originals.get(id)||shipment.products.find(p=>p.id===id)||{price:0};
  const eligible=id=>{const p=draftProduct(id);return p.wholesale??isRemaxGlass(brandById(p.shipmentId||order.shipmentId),p);};
  const price=id=>unitPrice(draftProduct(id),[...draft].reduce((n,[key,q])=>n+(eligible(key)?q:0),0),eligible(id));
  function total(){const sum=[...draft].reduce((n,[id,q])=>n+q*price(id),0);$('#edit-order-total').textContent='Итого: '+money(sum)+(sum<MIN_ORDER?' · Минимум 10 000 ₽':'');$('#save-order').disabled=sum<MIN_ORDER;form.querySelectorAll('[data-edit-price]').forEach(el=>el.textContent=money(price(el.dataset.editPrice)));}
  function draw(){
    $('#edit-order-lines').innerHTML=[...draft].map(([id,quantity])=>{
      const p=shipment.products.find(p=>p.id===id),old=originals.get(id),max=(p?.stock||0)+(old?.quantity||0);
      return `<div class="cart-line"><p>${old?esc(brandById(old.shipmentId??order.shipmentId)?.name||old.shipmentTitle||order.shipmentTitle)+' · ':''}${esc(old?.name||p?.name)}</p><span class="muted">${esc(old?.sku||p?.sku)} · <span data-edit-price="${esc(id)}">${money(price(id))}</span> · Доступно с вашим заказом: ${max} шт.</span><label class="field">Количество<input data-edit-qty="${esc(id)}" type="number" inputmode="numeric" required min="0" max="${max}" step="1" value="${quantity}"></label></div>`;
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
    const lines=[...draft].filter(([,quantity])=>quantity>0).map(([key,quantity])=>{const [shipmentId,id]=key.split(':');return {shipmentId,id,quantity,...(!originals.has(key)?{expectedPrice:price(key)}:{})};});
    if(!lines.length||lines.length>100){error.textContent='Оставьте от 1 до 100 позиций. Для полного отказа отмените заказ.';return;}
    if([...draft].reduce((n,[id,q])=>n+q*price(id),0)<MIN_ORDER && [...draft].some(([id])=>eligible(id))){error.textContent='Минимальный заказ от 10.000 рублей.';return;}
    requestKey ||= crypto.randomUUID();
    const input={enforceMinimum:true,requestKey,expectedRevision:order.revision||1,lines,comment:$('#edit-order-comment').value};
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
  app.innerHTML=`<div class="page-heading"><div><h1>Управление</h1></div></div><div class="actions"><button class="primary" id="add-brand">+ Добавить бренд</button><button class="secondary" id="all-orders">Все заказы</button><button class="secondary" id="setup-bot">Подключить бота</button><button class="secondary" id="notification-settings">Уведомления в канал</button></div><section class="admin-panel">${state.brands.map(brand=>{const catalog=catalogForBrand(brand.id),count=catalog?.products.filter(p=>!p.hidden&&p.stock>0).length||0;return `<div class="admin-row"><div>${brand.cover?`<img class="admin-brand-cover" src="${esc(brand.cover)}" alt="">`:''}<strong>${esc(brand.name)}</strong><small>${brand.hidden?'Скрыт от покупателей':'Показывается покупателям'}</small><small>${brand.categories.map(esc).join(' · ')}</small><small>${count} товаров${catalog?'':' · Excel ещё не загружен'}</small></div><div class="brand-actions">${catalog?`<button class="secondary" data-brand-prices="${esc(brand.id)}">Цены</button>`:''}<button class="primary" data-brand-import="${esc(brand.id)}">${catalog?'Обновить Excel':'Загрузить Excel'}</button><button class="secondary" data-brand-edit="${esc(brand.id)}">Настройки</button></div></div>`;}).join('')}</section>`;
  $('#add-brand').onclick=()=>editBrand();
  $('#all-orders').onclick=()=>{state.view='all-orders';render();};
  $('#setup-bot').onclick=showBotSetup;
  $('#notification-settings').onclick=showNotifications;
  document.querySelectorAll('[data-brand-import]').forEach(b=>b.onclick=()=>editShipment(catalogForBrand(b.dataset.brandImport),brandById(b.dataset.brandImport)));
  document.querySelectorAll('[data-brand-edit]').forEach(b=>b.onclick=()=>editBrand(brandById(b.dataset.brandEdit)));
  document.querySelectorAll('[data-brand-prices]').forEach(b=>b.onclick=()=>editPrices(brandById(b.dataset.brandPrices)));
}
async function coverFromFile(file){
  if(!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>15*1024*1024)throw Error('Выберите JPG, PNG или WebP размером до 15 МБ.');
  const bitmap=await createImageBitmap(file);
  try{
    const scale=Math.min(1,720/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    let image=canvas.toDataURL('image/webp',.8);
    if(image.length>350000)image=canvas.toDataURL('image/webp',.55);
    if(image.length>350000)throw Error('Выберите изображение меньшего размера.');
    return image;
  }finally{bitmap.close();}
}
function editBrand(brand=null){
  let cover=brand?.cover||null,processing=0;
  const categoryImages=new Map(Object.entries(brand?.categoryCovers||{}));
  let previousNames=brand?.categories||[];
  showDialog(brand?'Настройки бренда':'Добавить бренд',`<form id="brand-form"><label class="field">Название<input id="brand-name" required maxlength="80" value="${esc(brand?.name||'')}" placeholder="Например, Baseus"></label><label class="field">Категории — по одной на строку<textarea id="brand-categories" required rows="5" placeholder="Кабели&#10;Зарядные устройства&#10;Аккумуляторы">${esc(brand?.categories.join('\n')||'')}</textarea></label><div id="category-covers"></div><label class="field">Обложка бренда<input type="file" id="brand-cover-file" accept="image/png,image/jpeg,image/webp"></label><div id="brand-cover-preview"></div><button type="button" class="secondary" id="remove-brand-cover">Убрать обложку</button>${brand?`<label class="field checkbox-field"><input type="checkbox" id="brand-visible" ${brand.hidden?'':'checked'}> Показывать бренд покупателям</label><p class="fine-print">Скрытый бренд недоступен для новых заказов. Товары и история заказов сохраняются.</p>`:'<p class="fine-print">После создания загрузите Excel и опубликуйте бренд.</p>'}<p class="error" id="brand-error" role="alert"></p><button class="primary full" id="save-brand" type="submit">${brand?'Сохранить':'Создать и загрузить товары'}</button></form>`);
  const form=$('#brand-form');
  const categoryNames=()=>$('#brand-categories').value.split('\n').map(x=>x.trim().replace(/\s+/g,' ')).filter(Boolean);
  const renderCategoryCovers=()=>{
    const names=categoryNames();
    if(previousNames.length===names.length&&!names.every(name=>previousNames.includes(name))){
      const images=previousNames.map(name=>categoryImages.get(name));
      previousNames.forEach(name=>categoryImages.delete(name));
      names.forEach((name,index)=>{if(images[index])categoryImages.set(name,images[index]);});
    }
    previousNames=names;
    $('#category-covers').innerHTML=`<p>Обложки категорий</p>${names.map((name,index)=>`<div class="category-cover-field"><label class="field">${esc(name)}<input type="file" data-category-cover="${index}" accept="image/png,image/jpeg,image/webp"></label><div data-category-preview="${index}">${categoryImages.get(name)?`<img class="brand-cover-preview" src="${esc(categoryImages.get(name))}" alt="Обложка ${esc(name)}">`:''}</div><button type="button" class="secondary" data-remove-category-cover="${index}" ${categoryImages.has(name)?'':'hidden'}>Убрать обложку</button></div>`).join('')}`;
    form.querySelectorAll('[data-category-cover]').forEach(input=>input.onchange=async()=>{
      const file=input.files[0],name=names[Number(input.dataset.categoryCover)];if(!file)return;
      processing++;$('#brand-categories').disabled=true;$('#save-brand').disabled=true;$('#brand-error').textContent='';
      try{const image=await coverFromFile(file);if(form.isConnected)categoryImages.set(name,image);}
      catch(error){if(form.isConnected)$('#brand-error').textContent=error.message;}
      finally{processing--;if(form.isConnected){$('#brand-categories').disabled=processing>0;$('#save-brand').disabled=processing>0;if(!processing)renderCategoryCovers();}}
    });
    form.querySelectorAll('[data-remove-category-cover]').forEach(button=>button.onclick=()=>{categoryImages.delete(names[Number(button.dataset.removeCategoryCover)]);renderCategoryCovers();});
  };
  $('#brand-categories').oninput=renderCategoryCovers;renderCategoryCovers();
  const preview=()=>{$('#brand-cover-preview').innerHTML=cover?`<img class="brand-cover-preview" src="${esc(cover)}" alt="Обложка бренда">`:'';$('#remove-brand-cover').hidden=!cover;};preview();
  $('#remove-brand-cover').onclick=()=>{cover=null;$('#brand-cover-file').value='';preview();};
  $('#brand-cover-file').onchange=async e=>{
    const file=e.target.files[0];if(!file)return;processing++;$('#brand-categories').disabled=true;$('#save-brand').disabled=true;$('#brand-error').textContent='';
    try{const image=await coverFromFile(file);if(form.isConnected){cover=image;preview();}}
    catch(error){if(form.isConnected)$('#brand-error').textContent=error.message;}
    finally{processing--;if(form.isConnected){$('#brand-categories').disabled=processing>0;$('#save-brand').disabled=processing>0;}}
  };
  form.onsubmit=async e=>{
    e.preventDefault();if(processing)return;
    const categories=categoryNames(),categoryCovers=Object.fromEntries(categories.filter(name=>categoryImages.has(name)).map(name=>[name,categoryImages.get(name)])),button=$('#save-brand');button.disabled=true;
    try{
      const {brand:saved}=await api('/admin/brands'+(brand?'/'+brand.id:''),brand?'PATCH':'POST',{name:$('#brand-name').value,categories,cover,categoryCovers,hidden:brand?!$('#brand-visible').checked:true,...(brand?{expectedRevision:brand.revision}:{})});
      const index=state.brands.findIndex(item=>item.id===saved.id);
      if(index<0)state.brands.push(saved);else state.brands[index]=saved;
      const catalog=catalogForBrand(saved.id);
      if(catalog){
        if(brand?.categories.length===saved.categories.length){
          const renames=new Map(brand.categories.map((name,index)=>[groupKey(name),saved.categories[index]]));
          catalog.products.forEach(product=>{const name=renames.get(groupKey(product.group));if(name)product.group=name;});
        }
        Object.assign(catalog,{title:saved.name,brand:saved.name,brandInfo:saved,groups:saved.categories,hidden:saved.hidden});
      }
      closeDialog();render();
      if(!brand)editShipment(null,saved);else toast('Настройки бренда сохранены.');
    }catch(error){if(form.isConnected){$('#brand-error').textContent=error.message;button.disabled=false;}else toast(error.message);}
  };
}
function editPrices(brand){
  const catalog=catalogForBrand(brand.id),products=(catalog?.products||[]).filter(p=>!p.hidden);
  if(!products.length){toast('В этом бренде пока нет товаров.');return;}
  const wholesale=products.some(p=>Array.isArray(p.prices)&&p.prices.length===3);
  showDialog(`Цены — ${brand.name}`,`<form id="prices-form"><p class="fine-print">Измените цены точечно и сохраните. Excel загружать заново не нужно.</p><div class="import-preview"><table><thead><tr><th>Товар</th><th>${wholesale?'Цена / оптовые уровни':'Цена, ₽'}</th></tr></thead><tbody>${products.map(p=>{const tiered=Array.isArray(p.prices)&&p.prices.length===3,values=tiered?p.prices:[p.price];return `<tr><td>${esc(p.sku||p.id)}<br><small>${esc(p.name)}</small></td><td>${tiered?`<div class="price-edit-grid">${[0,1,2].map(i=>`<input data-price="${esc(p.id)}" data-tier="${i}" type="number" min="0" step="0.01" value="${(Number(values[i]||0)/100).toFixed(2)}" aria-label="Опт ${i+1} ${esc(p.sku||p.id)}">`).join('')}</div>`:`<input data-price="${esc(p.id)}" type="number" min="0" step="0.01" value="${(Number(values[0]||0)/100).toFixed(2)}" aria-label="Цена ${esc(p.sku||p.id)}">`}</td></tr>`;}).join('')}</tbody></table></div><p id="prices-error" class="error" role="alert"></p><button class="primary full" id="save-prices" type="submit">Сохранить цены</button></form>`);
  $('#prices-form').onsubmit=async e=>{e.preventDefault();const grouped=new Map();document.querySelectorAll('[data-price]').forEach(input=>{const id=input.dataset.price;const value=Number(input.value);if(!Number.isFinite(value)||value<0){return;}const item=grouped.get(id)||{id};if(input.dataset.tier===undefined)item.price=Math.round(value*100);else{item.prices=item.prices||[];item.prices[Number(input.dataset.tier)]=Math.round(value*100);}grouped.set(id,item);});const changes=[...grouped.values()];const button=$('#save-prices');button.disabled=true;try{await api('/admin/brands/'+encodeURIComponent(brand.id)+'/prices','PATCH',{updates:changes});state.shipments=(await api('/catalog')).shipments;closeDialog();toast('Цены сохранены.');}catch(error){$('#prices-error').textContent=error.message;button.disabled=false;}};
}
async function showNotifications(){
  showDialog('Уведомления в канал','<p id="notifications-status" class="muted">Проверяем подключение…</p>');
  const container=$('#notifications-status');
  try{
    const data=await api('/admin/notifications/check','POST',{});
    if(!container.isConnected)return;
    drawNotifications(data);
  }catch(e){if(container.isConnected)container.innerHTML=`<span class="error">${esc(e.message)}</span>`;}
}
function drawNotifications(data){
  showDialog('Уведомления в канал',`<div id="notification-details"><p><strong>Канал:</strong> ${esc(data.channel?.title||data.target||'не задан')}</p><p><strong>Бот:</strong> @${esc(data.botUsername||'E_NewSletters_Bot')}</p><p><strong>Ожидают отправки:</strong> ${data.pending}</p>${data.check?`<p class="${data.check.ok?'import-summary':'warning'}">${esc(data.check.message)}</p>`:''}${data.lastError?`<div class="warning"><strong>Последняя ошибка отправки</strong><p>${esc(data.lastError.message)}</p><small>${esc(data.lastError.description||'')}</small></div>`:''}${data.lastSuccess?`<p class="fine-print">Последняя успешная отправка: ${esc(new Date(data.lastSuccess).toLocaleString('ru-RU'))}</p>`:''}<p class="fine-print">Повторная отправка обрабатывает сохранённые заказы. Уже доставленные сообщения обновляются.</p></div><p class="error" id="notifications-error" role="alert"></p><div class="actions"><button class="primary" id="retry-notifications" ${!data.configured||!data.pending?'disabled':''}>Отправить ожидающие</button><button class="secondary" id="recheck-notifications">Проверить снова</button></div>`);
  $('#recheck-notifications').onclick=showNotifications;
  $('#retry-notifications').onclick=async()=>{
    const button=$('#retry-notifications');button.disabled=true;button.textContent='Отправляем…';
    try{
      await api('/admin/notifications/retry','POST',{});
      for(let attempt=0;attempt<4;attempt++){
        await new Promise(resolve=>setTimeout(resolve,1500));if(!button.isConnected)return;
        const next=await api('/admin/notifications');
        if(!next.pending||attempt===3){drawNotifications({...data,...next});return;}
      }
    }catch(e){if(button.isConnected){$('#notifications-error').textContent=e.message;button.disabled=false;button.textContent='Повторить отправку';}}
  };
}
function deleteShipment(shipment){
  showDialog('Удалить каталог?',`<p><strong>${esc(shipment.title)}</strong></p><p>Каталог и его товары исчезнут из приложения. Отменённые заказы останутся в истории администратора. Каталог с действующими заказами удалить нельзя.</p><p id="delete-error" class="error" role="alert"></p><button class="danger full" id="delete-shipment">Удалить каталог</button>`);
  const error=$('#delete-error'),button=$('#delete-shipment');
  button.onclick=async()=>{
    button.disabled=true;error.textContent='';
    try{
      await api('/admin/shipments/'+encodeURIComponent(shipment.id),'DELETE');
      state.shipments=state.shipments.filter(s=>s.id!==shipment.id);
      if(state.current===shipment.id){state.current=null;}
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
  brand ||= brandById(existing?.id);
  if(!brand){toast('Не удалось определить бренд.');return;}
  const groups=[...brand.categories],historyProducts=existing?.products||[];
  let importCategory='';
  let products=existing?manualProducts(existing.products.filter(p=>!p.hidden&&p.stock>0).map(p=>({...p,stock:p.stock})),groups):null,warnings=[];
  showDialog(`${brand.name} — каталог`,`<form id="shipment-form"><p class="fine-print">Выберите категорию перед загрузкой Excel. Обновятся только её товары; остальные категории сохранятся. Отсутствующие в файле товары выбранной категории будут скрыты.</p><p class="fine-print"><strong>Категории:</strong> ${groups.map(esc).join(' · ')}</p><label class="field">Куда загрузить Excel<select id="import-category"><option value="">Весь бренд — обновить все категории</option>${groups.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select></label><label class="field">${existing?'Обновить каталог из Excel':'Excel с товарами'}<input type="file" id="xlsx-file" accept=".xls,.xlsx" ${existing?'':'required'}></label><div id="import-info">${products?`<p class="import-summary">Сейчас в продаже: ${products.length} позиций</p>`:''}</div><div id="category-editor"></div><label class="field checkbox-field"><input id="publish-brand" type="checkbox" ${!existing||!brand.hidden?'checked':''}> Показывать бренд покупателям после сохранения</label><p id="import-error" class="error" role="alert"></p><button class="primary full" id="save-shipment" type="submit" ${products?'':'disabled'}>Сохранить каталог</button></form>`);
  const form=$('#shipment-form');
  function reviewCategories(){
    const container=$('#category-editor');if(!products){container.textContent='';return;}
    container.innerHTML=`<section class="category-review"><h3>Распределение по категориям</h3><p class="fine-print">${importCategory?`Все товары будут загружены в категорию «${esc(importCategory)}».`:`Для каждого товара выберите одну из категорий ${esc(brand.name)}.`}</p><div class="category-editor-products">${products.map(p=>`<label class="category-editor-product"><span><strong>${esc(p.name)}</strong><small>${esc(p.sku)}</small></span><select data-product-category="${esc(p.id)}" ${importCategory?'disabled':''} required><option value="">Не выбрано</option>${groups.map(name=>`<option value="${esc(name)}" ${groupKey(p.group)===groupKey(name)?'selected':''}>${esc(name)}</option>`).join('')}</select></label>`).join('')}</div></section>`;
    container.querySelectorAll('[data-product-category]').forEach(select=>select.onchange=()=>{const p=products.find(x=>x.id===select.dataset.productCategory);if(p)p.group=select.value;});
  }
  if(products)reviewCategories();
  $('#import-category').onchange=()=>{
    importController?.abort();importCategory=$('#import-category').value;
    products=null;warnings=[];$('#xlsx-file').value='';$('#xlsx-file').required=true;
    $('#category-editor').textContent='';$('#import-error').textContent='';$('#save-shipment').disabled=true;
    $('#import-info').textContent=importCategory?`Загрузите Excel для категории «${importCategory}». Остальные категории не изменятся.`:'Excel обновит все категории бренда. Отсутствующие товары будут скрыты.';
  };

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
      products=importCategory?merged.map(p=>({...p,group:importCategory})):manualProducts(merged,groups,historyProducts);warnings=result.warnings;reviewCategories();
      const previousIds=new Set(historyProducts.filter(p=>!p.hidden&&(!importCategory||groupKey(p.group)===groupKey(importCategory))).map(p=>p.id)),nextIds=new Set(products.map(p=>p.id));
      const hidden=[...previousIds].filter(id=>!nextIds.has(id)).length;
      $('#import-info').innerHTML=`<div class="import-summary">${products.length} позиций · ${products.filter(p=>p.image||p.imageKey).length} фотографий${hidden?` · будет скрыто: ${hidden}`:''}</div>${warnings.length?`<details class="warning"><summary>Замечания: ${warnings.length}</summary>${warnings.map(w=>`<div>${esc(w)}</div>`).join('')}</details><label class="field"><input id="accept-warnings" type="checkbox" style="width:auto;min-height:auto"> Проверил замечания</label>`:''}<div class="import-preview"><table><thead><tr><th>Товар</th><th>Остаток</th><th>Цена</th></tr></thead><tbody>${products.map(p=>`<tr><td>${esc(p.name)}<br>${esc(p.sku)}</td><td>${p.stock}</td><td>${p.price===null?`<input data-import-price="${esc(p.id)}" type="number" inputmode="decimal" required min="0" max="1000000" step="0.01" placeholder="Цена, ₽" aria-label="Цена ${esc(p.sku)}">`:p.prices?p.prices.map((price,i)=>`Опт ${i+1}: ${money(price)}`).join('<br>'):money(p.price)}</td></tr>`).join('')}</tbody></table></div>`;
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
      await api('/admin/shipments','POST',{id:brand.id,title:brand.name,brand:brand.name,status:'arrived',stockMode:'live',description:'',groupingMode:'manual',groups,products,...(importCategory?{importCategory}:{}),publishBrand:$('#publish-brand').checked,expectedBrandRevision:brand.revision});
      closeDialog();await refresh();toast(`${brand.name}: каталог обновлён.`);
    }catch(e){if($('#import-error')){$('#import-error').textContent=e.message;b.disabled=false;}else toast(e.message);}
  };
}
function goBack(){
  if(state.current&&state.productGroup){state.productGroup='';state.phoneModel='';render();window.scrollTo(0,0);return;}
  state.current=null;state.productGroup='';state.phoneModel='';render();
}
async function refresh({background=false}={}){
  if(state.preview){if(!background)render();return;}
  if(background&&document.activeElement?.matches('[data-qty]'))return;
  if(refreshPromise){await refreshPromise;if(background)return;}
  const button=$('#refresh');button.disabled=true;
  refreshPromise=(async()=>{
    try{
      const previous=JSON.stringify([state.shipments,state.brands]);
      const shipments=(await api('/catalog')).shipments;
      if(background&&dialog.open)return;
      state.shipments=shipments;
      const changed=previous!==JSON.stringify([state.shipments,state.brands]);
      if(background && (!changed||dialog.open))return;
      if(state.view==='shipments' && $('#shipment-grid')){cards();$('.count').textContent='Брендов: '+visibleBrands().length;cartBar();return;}
      if(state.view==='shipments' && $('#product-search')){
        const input=$('#product-search'),query=input.value,focused=document.activeElement;
        if(!activeShipment()){state.current=null;render();return;}
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
  if(target==='shipments'){state.current=null;state.productGroup='';state.phoneModel='';}
  state.view=target;render();window.scrollTo(0,0);
});
$('#refresh').onclick=()=>refresh();
dialog.addEventListener('cancel',e=>{if(placingOrder)e.preventDefault();});
dialog.addEventListener('close',()=>{importController?.abort();if($('#products'))products($('#product-search')?.value||'');cartBar();});
$('.brand').onclick=e=>{e.preventDefault();state.view='shipments';if(state.current)goBack();else render();};
tg?.BackButton?.onClick(goBack);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.preview&&!dialog.open)refresh({background:true});});
setInterval(()=>{if(!state.preview&&!document.hidden&&!dialog.open&&state.view==='shipments'&&tg?.initData)refresh({background:true});},45000);
init();
