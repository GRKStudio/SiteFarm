/* ==========================================================
   Smart Farm Web — маршруты: #/, #/login, #/d/:deviceId
   + cookie deviceId + живой MQTT + графики (Chart.js)
   Архитектура: Utils / Store / EventHub / MQTT / Telemetry / Views / Router / App
========================================================== */

// -------------------- Utils --------------------
const Utils = {
  qs: (sel, root=document)=> root.querySelector(sel),
  setHidden: (el, v)=> el.hidden = !!v,

  // cookie-хелперы
  setCookie(name, val, days=365){
    const exp = new Date(Date.now()+days*864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(val)}; expires=${exp}; path=/`;
  },
  getCookie(name){
    return document.cookie.split('; ').reduce((acc, c)=>{
      const [k,v] = c.split('=');
      return k===name ? decodeURIComponent(v) : acc;
    }, '');
  },
  delCookie(name){ document.cookie = `${name}=; Max-Age=0; path=/`; },

  // hash-роутинг: #/, #/login, #/d/:id
  parseRoute(){
    const h = location.hash || '#/';
    if (h === '#/' || h === '#') return { name:'home' };
    if (h.startsWith('#/login')) return { name:'login' };
    if (h.startsWith('#/d/')) {
      const id = decodeURIComponent(h.slice(4)); // после '#/d/'
      return { name:'device', params:{ deviceId:id } };
    }
    return { name:'home' };
  },
  go(path){               // path: '/login', '/d/<id>' или '/'
    location.hash = '#' + path;
    App.router.handle();
  },
  replace(path){
    const newHash = '#' + path;
    if (location.hash !== newHash) {
      location.replace(location.pathname + location.search + newHash);
    }
    App.router.handle();
  },

  nowISO(){ return new Date().toISOString(); }
};

// -------------------- Маленькая событийная шина --------------------
const EventHub = (()=> {
  const map = new Map();
  return {
    on(ev, fn){ if(!map.has(ev)) map.set(ev, new Set()); map.get(ev).add(fn); return ()=>this.off(ev, fn); },
    off(ev, fn){ map.get(ev)?.delete(fn); },
    emit(ev, payload){ map.get(ev)?.forEach(fn=>{ try{ fn(payload); }catch(e){ console.error(e);} }); }
  };
})();

// -------------------- Store --------------------
const Store = {
  COOKIE_KEY: 'deviceId',
  get deviceId(){ return Utils.getCookie(this.COOKIE_KEY) || ''; },
  set deviceId(v){ v ? Utils.setCookie(this.COOKIE_KEY, v) : Utils.delCookie(this.COOKIE_KEY); },

  saveMqttOpts(o){
    localStorage.sf_host = o.host || '';
    localStorage.sf_port = o.port || '';
    localStorage.sf_path = o.path || '';
    localStorage.sf_client = o.clientId || '';
  },
  loadMqttOpts(){
    return {
      host: localStorage.sf_host || 'broker.hivemq.com',
      port: localStorage.sf_port || '8884',
      path: localStorage.sf_path || '/mqtt',
      clientId: localStorage.sf_client || '',
    };
  }
};

// -------------------- MQTT реализация --------------------
/**
 * MQTT.connect({host,port,path,clientId,deviceId})
 * MQTT.disconnect()
 * MQTT.publishCmd(text)
 * События:
 *  - 'mqtt:status'  => {status:'online'|'offline'|'reconnecting'|'error'}
 *  - 'mqtt:message' => {topic, text}
 *  - 'mqtt:topics'  => {cmd, status}
 */
const MQTT = {
  client: null,
  topics: { cmd:null, status:null },
  isConnected: false,
  currentDeviceId: null,

  connect({ host, port, path, clientId, deviceId }){
    if(this.client){ try{ this.client.end(true); }catch{} this.client = null; }
    this.currentDeviceId = deviceId;
    this.topics.cmd = `farm/${deviceId}/cmd`;
    this.topics.status = `farm/${deviceId}/status`;
    EventHub.emit('mqtt:topics', { ...this.topics });

    const url = `wss://${host}:${port}${path}`;
    const opts = {
      clientId: clientId?.trim() || `sfw_${deviceId}_${Math.random().toString(16).slice(2)}`,
      clean: true,
      reconnectPeriod: 2000,
    };
    Store.saveMqttOpts({host,port,path,clientId:opts.clientId});

    // mqtt.js доступен глобально из <script src="https://unpkg.com/mqtt/dist/mqtt.min.js">
    this.client = mqtt.connect(url, opts);

    this.client.on('connect', ()=>{
      this.isConnected = true;
      EventHub.emit('mqtt:status', {status:'online'});
      this.client.subscribe(this.topics.status, {qos:0}, (err)=>{
        if(err){ console.error('subscribe error', err); }
        this.publishCmd('SHOW');
      });
    });
    this.client.on('reconnect', ()=>{
      this.isConnected = false;
      EventHub.emit('mqtt:status', {status:'reconnecting'});
    });
    this.client.on('close', ()=>{
      this.isConnected = false;
      EventHub.emit('mqtt:status', {status:'offline'});
    });
    this.client.on('error', (e)=>{
      this.isConnected = false;
      console.error('MQTT error', e);
      EventHub.emit('mqtt:status', {status:'error', error:e});
    });
    this.client.on('message', (topic, payload)=>{
      const text = payload.toString();
      EventHub.emit('mqtt:message', { topic, text, ts: Date.now() });
    });
  },

  disconnect(){
    if(this.client){
      try{ this.client.end(true); }catch{}
      this.client = null;
    }
    this.isConnected = false;
    EventHub.emit('mqtt:status', {status:'offline'});
  },

  publishCmd(text){
    if(!this.client || !this.isConnected){
      alert('Нет MQTT соединения');
      return;
    }
    this.client.publish(this.topics.cmd, text, {qos:0, retain:false});
  }
};

// -------------------- Telemetry (парсер + графики + история) --------------------
/**
 * Парсит компактный статус:
 * "S1=1830(M1200..X2000) Z1=OFF | S2=1950(M1200..X2000) Z2=ON | PUMP=ON | LIGHT=OFF 60s/30s"
 * и обновляет:
 *  - Chart.js (datasets на лету по найденным зонам)
 *  - локальную историю в localStorage (по девайсу)
 */
const Telemetry = {
  chart: null,
  datasetsByZone: new Map(), // k -> dataset index
  historyKey(devId){ return `sf_hist_${devId}`; }, // per-device
  maxPoints: 1000, // храним до 1000 точек на зону (можно увеличить)
  initChart(){
    if(this.chart) return; // уже инициализирован
    const ctx = document.getElementById('chart')?.getContext('2d');
    if(!ctx) return;
    this.chart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        animation: false,
        plugins: { legend: { labels: { color: '#eaf1ff' } } },
        scales: {
          x: { ticks: { color: '#99a3b3' }, grid: { color: 'rgba(255,255,255,0.05)'} },
          y: { ticks: { color: '#99a3b3' }, grid: { color: 'rgba(255,255,255,0.05)'} }
        }
      }
    });
  },


  ensureDataset(zoneLabel){
    if(this.datasetsByZone.has(zoneLabel)) return this.datasetsByZone.get(zoneLabel);
    const idx = this.chart.data.datasets.length;
    this.chart.data.datasets.push({
      label: zoneLabel,
      data: [],
      borderWidth: 2,
      tension: .25,
      fill: false
    });
    this.datasetsByZone.set(zoneLabel, idx);
    return idx;
  },

  pushPoint(deviceId, zoneNum, soil, ts){
    if(!this.chart) return;
    const label = `S${zoneNum}`;
    const idx = this.ensureDataset(label);
    const t = new Date(ts).toLocaleTimeString();

    // labels — общая шкала времени
    const labels = this.chart.data.labels;
    if(labels.length > this.maxPoints) labels.shift();
    labels.push(t);

    // данные по зоне
    const ds = this.chart.data.datasets[idx].data;
    if(ds.length > this.maxPoints) ds.shift();
    ds.push(soil);

    this.chart.update('none');

    // сохраним в localStorage (пер-устройство)
    try {
      const key = this.historyKey(deviceId);
      const raw = localStorage.getItem(key);
      const bag = raw ? JSON.parse(raw) : {};
      const arr = bag[label] || [];
      arr.push({ ts, v: soil });
      if(arr.length > this.maxPoints) arr.splice(0, arr.length - this.maxPoints);
      bag[label] = arr;
      localStorage.setItem(key, JSON.stringify(bag));
    } catch(e){ console.warn('hist save failed', e); }
  },

  

  loadHistoryToChart(deviceId){
    try{
      const key = this.historyKey(deviceId);
      const bag = JSON.parse(localStorage.getItem(key) || '{}');
      this.chart.data.labels = [];
      this.chart.data.datasets = [];
      this.datasetsByZone.clear();

      // соберём объединённую шкалу времени из наибольшей серии
      let longest = 0, baseSeries = null;
      for(const zoneLabel in bag){
        if(bag[zoneLabel].length > longest){
          longest = bag[zoneLabel].length;
          baseSeries = bag[zoneLabel];
        }
      }
      if(baseSeries){
        this.chart.data.labels = baseSeries.map(p => new Date(p.ts).toLocaleTimeString());
      }

      for(const zoneLabel in bag){
        const idx = this.ensureDataset(zoneLabel);
        this.chart.data.datasets[idx].data = bag[zoneLabel].map(p => p.v);
      }
      this.chart.update('none');
    }catch(e){ console.warn('hist load failed', e); }
  },

  parseAndFeed(deviceId, text, ts){
    // Ищем все вхождения: S<k>=<val>(M<min>..X<max>) Z<k>=MODE
    const re = /S(\d+)\s*=\s*(\d+)\s*\(\s*M\s*(\d+)\s*\.\.\s*X\s*(\d+)\s*\)\s*Z\1\s*=\s*(AUTO|ON|OFF)/ig;
    let m, any = false;
    while ((m = re.exec(text))) {
      const k = +m[1];
      const val = +m[2];
      const min = +m[3];
      const max = +m[4];
      const mode = m[5].toUpperCase();
      any = true;

      // график
      this.pushPoint(deviceId, k, val, ts);

      // UI зон
      Zones.update(k, {min, max, mode});
    }

    // дополнительно можно выцепить PUMP/LIGHT, если пригодится в UI:
    // const pump = (text.match(/PUMP\s*=\s*(AUTO|ON|OFF)/i)||[])[1];
    // const light = (text.match(/LIGHT\s*=\s*(AUTO|ON|OFF)/i)||[])[1];

    return any;
  }

};

// -------------------- Zones (UI ползунков и режимов) --------------------
const Zones = {
  container: Utils.qs('#zonesContainer'),
  items: new Map(), // k -> {root,minEl,maxEl,modeEl}

  ensure(k){
    if(this.items.has(k)) return this.items.get(k);
    const wrap = document.createElement('div');
    wrap.className = 'card magic-bento';
    wrap.style.background = 'transparent';
    wrap.id = `zone-${k}`;
    wrap.innerHTML = `
      <h2>Зона ${k} <span class="pill" id="mode-${k}">—</span></h2>
      <div class="slider">
        <div>MIN${k}</div>
        <input type="range" min="0" max="4000" step="10" id="min-${k}">
        <div><span id="minv-${k}">—</span></div>
      </div>
      <div class="slider">
        <div>MAX${k}</div>
        <input type="range" min="0" max="4000" step="10" id="max-${k}">
        <div><span id="maxv-${k}">—</span></div>
      </div>
      <div class="zone-controls">
        <button class="secondary" id="auto-${k}">Z${k} AUTO</button>
        <button class="secondary" id="on-${k}">Z${k} ON</button>
        <button class="secondary" id="off-${k}">Z${k} OFF</button>
        <button id="apply-${k}">Применить MIN/MAX</button>
      </div>
    `;
    this.container.appendChild(wrap);
    MagicBento.attach(wrap);

    // хэндлеры
    Utils.qs(`#auto-${k}`).onclick = ()=> MQTT.publishCmd(`Z${k} AUTO`);
    Utils.qs(`#on-${k}`).onclick   = ()=> MQTT.publishCmd(`Z${k} ON`);
    Utils.qs(`#off-${k}`).onclick  = ()=> MQTT.publishCmd(`Z${k} OFF`);
    Utils.qs(`#apply-${k}`).onclick= ()=>{
      const min = +Utils.qs(`#min-${k}`).value, max = +Utils.qs(`#max-${k}`).value;
      if(min>=max){ alert('MIN должен быть < MAX'); return; }
      MQTT.publishCmd(`SET MIN${k} ${min}`);
      MQTT.publishCmd(`SET MAX${k} ${max}`);
      setTimeout(()=> MQTT.publishCmd('SHOW'), 150);
    };

    const item = {
      root: wrap,
      minEl: Utils.qs(`#min-${k}`),
      maxEl: Utils.qs(`#max-${k}`),
      minv:  Utils.qs(`#minv-${k}`),
      maxv:  Utils.qs(`#maxv-${k}`),
      modeEl: Utils.qs(`#mode-${k}`)
    };
    this.items.set(k, item);
    return item;
  },

  update(k, {min, max, mode}){
    const it = this.ensure(k);
    if(min != null){ it.minEl.value = min; it.minv.textContent = String(min); }
    if(max != null){ it.maxEl.value = max; it.maxv.textContent = String(max); }
    if(mode){ it.modeEl.textContent = mode; }
  }
};

// -------------------- Views --------------------
const Views = {
  Home: {
    el: Utils.qs('#view-home'),
    btnGoLogin: Utils.qs('#btnGoLogin'),
    show(){ Utils.setHidden(this.el, false); },
    hide(){ Utils.setHidden(this.el, true); },
    mount(){
      this.btnGoLogin.onclick = ()=> Utils.go('/login');
    }
  },

  Login: {
    el: Utils.qs('#view-login'),
    input: Utils.qs('#loginDeviceId'),
    btnProceed: Utils.qs('#btnProceed'),
    btnUseCookie: Utils.qs('#btnUseCookie'),
    show(){
      Utils.setHidden(this.el, false);
      this.input.value = Store.deviceId || '';
    },
    hide(){ Utils.setHidden(this.el, true); },
    mount(){
      this.btnProceed.onclick = ()=>{
        const id = (this.input.value || '').trim();
        if(!id) return alert('Введите DeviceID');
        Store.deviceId = id;
        Utils.go(`/d/${encodeURIComponent(id)}`);
      };
      this.btnUseCookie.onclick = ()=>{
        const id = Store.deviceId;
        if(!id) return alert('В cookie нет сохранённого DeviceID');
        Utils.go(`/d/${encodeURIComponent(id)}`);
      };
    }
  },

  Dashboard: {
    el: Utils.qs('#view-dashboard'),
    idEl: Utils.qs('#currentDeviceId'),
    // MQTT-конфиг
    hostEl: Utils.qs('#mqttHost'),
    portEl: Utils.qs('#mqttPort'),
    pathEl: Utils.qs('#mqttPath'),
    clientEl: Utils.qs('#clientId'),
    topicsEl: Utils.qs('#topicsPreview'),
    statusEl: Utils.qs('#connStatus'),
    // кнопки
    btnChange: Utils.qs('#btnChangeDevice'),
    btnForget: Utils.qs('#btnForgetDevice'),
    btnConnect: Utils.qs('#btnConnect'),
    btnDisconnect: Utils.qs('#btnDisconnect'),
    // команды
    btnShow: Utils.qs('#btnShow'),
    btnLightOn: Utils.qs('#btnLightOn'),
    btnLightAuto: Utils.qs('#btnLightAuto'),
    btnPumpAuto: Utils.qs('#btnPumpAuto'),
    // вывод статуса
    statusBox: Utils.qs('#statusBox'),

    show(deviceId){
      Utils.setHidden(this.el, false);
      this.idEl.textContent = deviceId;
      if(Store.deviceId !== deviceId) Store.deviceId = deviceId;

      const saved = Store.loadMqttOpts();
      if(!this.hostEl.value) this.hostEl.value = saved.host;
      if(!this.portEl.value) this.portEl.value = saved.port;
      if(!this.pathEl.value) this.pathEl.value = saved.path;
      if(!this.clientEl.value) this.clientEl.value = saved.clientId;

      this.setTopics(`farm/${deviceId}/cmd ⇄ farm/${deviceId}/status`);

      // Инициализируем графики и грузим локальную историю для этого девайса
      Telemetry.initChart();
      Telemetry.loadHistoryToChart(deviceId);
    },
    hide(){ Utils.setHidden(this.el, true); },

    setConnStatus(text){ this.statusEl.textContent = text; },
    setTopics(text){ this.topicsEl.textContent = text; },
    appendStatus(line){
      const prev = this.statusBox.textContent === '— нет данных —' ? '' : this.statusBox.textContent + '\n';
      this.statusBox.textContent = prev + line;
      this.statusBox.scrollTop = this.statusBox.scrollHeight;
    },

    mount(){
      this.btnChange.onclick = ()=> Utils.go('/login');
      this.btnForget.onclick = ()=>{
        Store.deviceId = '';
        Utils.go('/login');
      };

      // MQTT → UI + Telemetry
      EventHub.on('mqtt:status', ({status})=>{
        this.setConnStatus(status);
      });
      EventHub.on('mqtt:topics', ({cmd, status})=>{
        this.setTopics(`${cmd} ⇄ ${status}`);
      });
      EventHub.on('mqtt:message', ({topic, text, ts})=>{
        this.appendStatus(text);
        // Парсим и кормим графики (если статус — компактный)
        const deviceId = this.idEl.textContent.trim();
        Telemetry.parseAndFeed(deviceId, text, ts || Date.now());
      });

      // Подключение/отключение
      this.btnConnect.onclick = ()=>{
        const deviceId = this.idEl.textContent.trim();
        MQTT.connect({
          host: this.hostEl.value.trim(),
          port: this.portEl.value.trim(),
          path: this.pathEl.value.trim(),
          clientId: this.clientEl.value.trim(),
          deviceId
        });
      };
      this.btnDisconnect.onclick = ()=> MQTT.disconnect();

      // команды
      this.btnShow.onclick = ()=> MQTT.publishCmd('SHOW');
      this.btnLightOn.onclick = ()=> MQTT.publishCmd('LIGHT ON');
      this.btnLightAuto.onclick = ()=> MQTT.publishCmd('LIGHT AUTO');
      this.btnPumpAuto.onclick = ()=> MQTT.publishCmd('PUMP AUTO');
    }
  }
};

// -------------------- MagicBento (hover spotlight + tilt) --------------------
const MagicBento = {
  attach(el){
    if(!el || el.__magicAttached) return;
    el.__magicAttached = true;

    el.addEventListener('pointermove', (e)=>{
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      el.style.setProperty('--x', `${x}px`);
      el.style.setProperty('--y', `${y}px`);
      const rx = ((r.height/2 - y)/r.height) * 6;
      const ry = ((x - r.width/2)/r.width) * 6;
      el.style.setProperty('--rx', `${rx}deg`);
      el.style.setProperty('--ry', `${ry}deg`);
    });

    el.addEventListener('pointerleave', ()=>{
      el.style.removeProperty('--x');
      el.style.removeProperty('--y');
      el.style.removeProperty('--rx');
      el.style.removeProperty('--ry');
    });
  },
  scan(){ document.querySelectorAll('.magic-bento').forEach((el)=> this.attach(el)); }
};

// -------------------- Router --------------------
const Router = {
  handle(){
    const route = Utils.parseRoute();

    // скрыть все
    Views.Home.hide();
    Views.Login.hide();
    Views.Dashboard.hide();

    if(route.name === 'home'){
      Views.Home.show();
      return;
    }
    if(route.name === 'login'){
      Views.Login.show();
      return;
    }
    if(route.name === 'device'){
      const id = (route.params.deviceId || '').trim();
      if(!id){ Utils.replace('/login'); return; }
      Views.Dashboard.show(id);
      return;
    }
  },
  mount(){
    window.addEventListener('hashchange', ()=> this.handle());
    this.handle();
  }
};

// -------------------- App --------------------
const App = {
  router: Router,
  start(){
    // на всякий случай скрыть все view перед первым рендером
    document.querySelectorAll('section[id^="view-"]').forEach(s => s.hidden = true);

    Views.Home.mount();
    Views.Login.mount();
    Views.Dashboard.mount();
    this.router.mount();
    MagicBento.scan();
    window.addEventListener('beforeunload', ()=> MQTT.disconnect());
  }
};




// Старт
document.addEventListener('DOMContentLoaded', ()=> App.start());
