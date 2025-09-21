/* ==========================================================
   Smart Farm Web — Шаги 1 и 4 выполнены, добавляем живой MQTT.
   Маршруты + cookie deviceId уже есть.
   Здесь реализуем подключение к брокеру по WSS через mqtt.js.

   Архитектура:
   - Utils / Store / EventHub
   - MQTT: connect/disconnect/publishCmd + auto-subscribe
   - Views: Login, Dashboard (добавлен вывод статуса)
   - Router/App — без изменений по контракту

   Безопасность сознательно опущена.
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
  // роут /d/:id
  parseRoute(){
    const path = location.pathname;
    if (path.startsWith('/d/')) {
      const id = decodeURIComponent(path.slice(3));
      return { name:'device', params:{ deviceId:id } };
    }
    return { name:'home' };
  },
  go(path){ history.pushState({}, '', path); App.router.handle(); },
  replace(path){ history.replaceState({}, '', path); App.router.handle(); },
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

  // сохраняем последние MQTT-настройки для удобства
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
 * Контракт:
 * MQTT.connect({host,port,path,clientId,deviceId})
 * MQTT.disconnect()
 * MQTT.publishCmd(text)
 * События:
 *  - 'mqtt:status'   => {status:'online'|'offline'|'reconnecting'|'error'}
 *  - 'mqtt:message'  => {topic, text}
 *  - 'mqtt:topics'   => {cmd, status}
 */
const MQTT = {
  client: null,
  topics: { cmd:null, status:null },
  isConnected: false,
  currentDeviceId: null,

  connect({ host, port, path, clientId, deviceId }){
    // если уже подключены к другому устройству — отключимся
    if(this.client){ try{ this.client.end(true); }catch{} this.client = null; }
    this.currentDeviceId = deviceId;
    this.topics.cmd = `farm/${deviceId}/cmd`;
    this.topics.status = `farm/${deviceId}/status`;
    EventHub.emit('mqtt:topics', { ...this.topics });

    // Собираем WSS URL
    const url = `wss://${host}:${port}${path}`;
    const opts = {
      clientId: clientId?.trim() || `sfw_${deviceId}_${Math.random().toString(16).slice(2)}`,
      clean: true,
      reconnectPeriod: 2000,
    };
    Store.saveMqttOpts({host,port,path,clientId:opts.clientId});

    // Глобальный mqtt из <script src="https://unpkg.com/mqtt/dist/mqtt.min.js">
    this.client = mqtt.connect(url, opts);

    this.client.on('connect', ()=>{
      this.isConnected = true;
      EventHub.emit('mqtt:status', {status:'online'});
      // подписка на статус
      this.client.subscribe(this.topics.status, {qos:0}, (err)=>{
        if(err){ console.error('subscribe error', err); }
        // сразу запросим статус
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
      EventHub.emit('mqtt:message', { topic, text });
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

// -------------------- Views --------------------
const Views = {
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
    // MQTT-конфиг элементы
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
    // базовые команды
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

      // подставим сохранённые MQTT-опции (удобство)
      const saved = Store.loadMqttOpts();
      if(!this.hostEl.value) this.hostEl.value = saved.host;
      if(!this.portEl.value) this.portEl.value = saved.port;
      if(!this.pathEl.value) this.pathEl.value = saved.path;
      if(!this.clientEl.value) this.clientEl.value = saved.clientId;

      // обновим предпросмотр топиков даже до подключения
      this.setTopics(`farm/${deviceId}/cmd ⇄ farm/${deviceId}/status`);
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
      // сменить/забыть устройство
      this.btnChange.onclick = ()=> Utils.go('/');
      this.btnForget.onclick = ()=>{
        Store.deviceId = '';
        Utils.go('/');
      };

      // события MQTT → UI
      EventHub.on('mqtt:status', ({status})=>{
        this.setConnStatus(status);
      });
      EventHub.on('mqtt:topics', ({cmd, status})=>{
        this.setTopics(`${cmd} ⇄ ${status}`);
      });
      EventHub.on('mqtt:message', ({topic, text})=>{
        // Пока просто выводим весь статус в коробку.
        // Позже сюда добавим нормализатор и графики.
        this.appendStatus(text);
      });

      // подключение/отключение
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

// -------------------- Router --------------------
const Router = {
  handle(){
    const route = Utils.parseRoute();
    // скрыть все
    Views.Login.hide();
    Views.Dashboard.hide();

    if(route.name === 'home'){
      const saved = Store.deviceId;
      if(saved){
        Utils.replace(`/d/${encodeURIComponent(saved)}`);
        return;
      }
      Views.Login.show();
      return;
    }

    if(route.name === 'device'){
      const id = (route.params.deviceId || '').trim();
      if(!id){
        Utils.replace('/');
        return;
      }
      Views.Dashboard.show(id);
      return;
    }
  },
  mount(){
    window.addEventListener('popstate', ()=> this.handle());
    this.handle();
  }
};

// -------------------- App --------------------
const App = {
  router: Router,
  start(){
    Views.Login.mount();
    Views.Dashboard.mount();
    this.router.mount();
    // аккуратно закрываем MQTT при выгрузке страницы
    window.addEventListener('beforeunload', ()=> MQTT.disconnect());
  }
};

// Старт
document.addEventListener('DOMContentLoaded', ()=> App.start());
