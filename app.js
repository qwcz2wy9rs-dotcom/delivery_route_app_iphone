const STORAGE_KEY = 'delivery-route-app-state-v2';

const state = {
  routeName: '',
  stops: [],
  gpsTrail: [],
  distanceMeters: 0,
  mapPickMode: false,
  tracking: false,
  watchId: null,
  currentPosition: null
};

const dom = {
  routeName: document.getElementById('routeName'),
  stopName: document.getElementById('stopName'),
  stopNote: document.getElementById('stopNote'),
  gpsStatus: document.getElementById('gpsStatus'),
  pickModeStatus: document.getElementById('pickModeStatus'),
  stopCount: document.getElementById('stopCount'),
  deliveredCount: document.getElementById('deliveredCount'),
  trackPointCount: document.getElementById('trackPointCount'),
  distanceText: document.getElementById('distanceText'),
  stopList: document.getElementById('stopList'),
  template: document.getElementById('stopItemTemplate'),
  installStatus: document.getElementById('installStatus')
};

const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const map = L.map('map', { tap: true, zoomControl: true }).setView([33.5902, 130.4017], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const layers = {
  stops: L.layerGroup().addTo(map),
  deliveredRoute: L.polyline([], { weight: 4 }).addTo(map),
  gpsTrail: L.polyline([], { weight: 3, dashArray: '6 8' }).addTo(map),
  currentMarker: null
};

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ja-JP');
}

function toFixedCoord(v) {
  return Number(v).toFixed(6);
}

function haversineMeters(a, b) {
  const toRad = deg => deg * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function makeStopIcon(label, delivered) {
  return L.divIcon({
    className: '',
    html: `<div class="numbered-stop ${delivered ? '' : 'pending'}">${label}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });
}

function makeCurrentIcon() {
  return L.divIcon({
    className: '',
    html: '<div class="current-marker-dot"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

function persist() {
  const payload = {
    routeName: state.routeName,
    stops: state.stops,
    gpsTrail: state.gpsTrail,
    distanceMeters: state.distanceMeters
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.routeName = parsed.routeName || '';
    state.stops = Array.isArray(parsed.stops) ? parsed.stops : [];
    state.gpsTrail = Array.isArray(parsed.gpsTrail) ? parsed.gpsTrail : [];
    state.distanceMeters = Number(parsed.distanceMeters || 0);
    dom.routeName.value = state.routeName;
  } catch (error) {
    console.error('load failed', error);
  }
}

function nextDeliveryOrder() {
  return state.stops.filter(stop => stop.deliveredOrder !== null).length + 1;
}

function refreshSummary() {
  const deliveredCount = state.stops.filter(stop => stop.deliveredOrder !== null).length;
  dom.stopCount.textContent = `${state.stops.length}件`;
  dom.deliveredCount.textContent = `${deliveredCount}件`;
  dom.trackPointCount.textContent = `${state.gpsTrail.length}点`;
  dom.distanceText.textContent = formatDistance(state.distanceMeters);
}

function deliveredStopsInOrder() {
  return [...state.stops]
    .filter(stop => stop.deliveredOrder !== null)
    .sort((a, b) => a.deliveredOrder - b.deliveredOrder);
}

function renderMap() {
  layers.stops.clearLayers();

  state.stops.forEach(stop => {
    const label = stop.deliveredOrder !== null ? stop.deliveredOrder : '未';
    const marker = L.marker([stop.lat, stop.lng], {
      icon: makeStopIcon(label, stop.deliveredOrder !== null)
    });
    const popup = `
      <strong>${escapeHtml(stop.name || '名称未設定')}</strong><br>
      状態: ${stop.deliveredOrder !== null ? `配達順 ${stop.deliveredOrder}` : '未配達'}<br>
      座標: ${toFixedCoord(stop.lat)}, ${toFixedCoord(stop.lng)}<br>
      ${stop.note ? `メモ: ${escapeHtml(stop.note)}<br>` : ''}
      ${stop.deliveredAt ? `記録時刻: ${escapeHtml(formatDateTime(stop.deliveredAt))}` : ''}
    `;
    marker.bindPopup(popup);
    marker.addTo(layers.stops);
  });

  const deliveredRoute = deliveredStopsInOrder().map(stop => [stop.lat, stop.lng]);
  layers.deliveredRoute.setLatLngs(deliveredRoute);
  layers.gpsTrail.setLatLngs(state.gpsTrail.map(point => [point.lat, point.lng]));

  if (state.currentPosition) {
    if (!layers.currentMarker) {
      layers.currentMarker = L.marker([state.currentPosition.lat, state.currentPosition.lng], {
        icon: makeCurrentIcon()
      }).addTo(map);
    } else {
      layers.currentMarker.setLatLng([state.currentPosition.lat, state.currentPosition.lng]);
    }
  }

  setTimeout(() => map.invalidateSize(), 0);
}

function renderList() {
  dom.stopList.innerHTML = '';
  const sorted = [...state.stops].sort((a, b) => {
    if (a.deliveredOrder === null && b.deliveredOrder === null) return a.createdAt.localeCompare(b.createdAt);
    if (a.deliveredOrder === null) return 1;
    if (b.deliveredOrder === null) return -1;
    return a.deliveredOrder - b.deliveredOrder;
  });

  sorted.forEach(stop => {
    const node = dom.template.content.firstElementChild.cloneNode(true);
    node.querySelector('.stop-order-badge').textContent = stop.deliveredOrder !== null ? `${stop.deliveredOrder}` : '未';
    node.querySelector('.stop-title').textContent = stop.name || '名称未設定';
    node.querySelector('.stop-meta').textContent = `座標 ${toFixedCoord(stop.lat)}, ${toFixedCoord(stop.lng)} / 追加 ${formatDateTime(stop.createdAt)}`;
    node.querySelector('.stop-note').textContent = stop.note || '';

    node.querySelector('.deliver-btn').textContent = stop.deliveredOrder !== null ? '未配達に戻す' : '配達済みにする';
    node.querySelector('.deliver-btn').addEventListener('click', () => toggleDelivered(stop.id));
    node.querySelector('.focus-btn').addEventListener('click', () => {
      map.setView([stop.lat, stop.lng], 18);
      const marker = findMarkerByLatLng(stop.lat, stop.lng);
      if (marker) marker.openPopup();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    node.querySelector('.delete-btn').addEventListener('click', () => removeStop(stop.id));

    dom.stopList.appendChild(node);
  });
}

function renderAll() {
  refreshSummary();
  renderMap();
  renderList();
  persist();
}

function findMarkerByLatLng(lat, lng) {
  let found = null;
  layers.stops.eachLayer(layer => {
    const ll = layer.getLatLng?.();
    if (ll && Math.abs(ll.lat - lat) < 0.000001 && Math.abs(ll.lng - lng) < 0.000001) {
      found = layer;
    }
  });
  return found;
}

function addStop(lat, lng, name, note) {
  state.stops.push({
    id: uid(),
    name: name || `配達先${state.stops.length + 1}`,
    note: note || '',
    lat,
    lng,
    createdAt: new Date().toISOString(),
    deliveredOrder: null,
    deliveredAt: null
  });
  dom.stopName.value = '';
  dom.stopNote.value = '';
  renderAll();
}

function removeStop(id) {
  const target = state.stops.find(stop => stop.id === id);
  if (!target) return;
  const removedOrder = target.deliveredOrder;
  state.stops = state.stops.filter(stop => stop.id !== id);
  if (removedOrder !== null) {
    state.stops.forEach(stop => {
      if (stop.deliveredOrder !== null && stop.deliveredOrder > removedOrder) {
        stop.deliveredOrder -= 1;
      }
    });
  }
  renderAll();
}

function toggleDelivered(id) {
  const stop = state.stops.find(item => item.id === id);
  if (!stop) return;

  if (stop.deliveredOrder === null) {
    stop.deliveredOrder = nextDeliveryOrder();
    stop.deliveredAt = new Date().toISOString();
  } else {
    const removedOrder = stop.deliveredOrder;
    stop.deliveredOrder = null;
    stop.deliveredAt = null;
    state.stops.forEach(item => {
      if (item.deliveredOrder !== null && item.deliveredOrder > removedOrder) {
        item.deliveredOrder -= 1;
      }
    });
  }
  renderAll();
}

function undoLatestDelivered() {
  const latest = deliveredStopsInOrder().at(-1);
  if (!latest) return;
  toggleDelivered(latest.id);
}

function resetDeliveryOrder() {
  state.stops.forEach(stop => {
    stop.deliveredOrder = null;
    stop.deliveredAt = null;
  });
  renderAll();
}

function clearAll() {
  if (!confirm('配達先・GPS履歴をすべて消します。よろしいですか？')) return;
  state.stops = [];
  state.gpsTrail = [];
  state.distanceMeters = 0;
  renderAll();
}

function setGpsStatus(text) {
  dom.gpsStatus.textContent = text;
}

function setInstallStatus() {
  if (isStandalone) {
    dom.installStatus.textContent = 'ホーム画面から起動中です';
    return;
  }
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    dom.installStatus.textContent = 'Safariの共有ボタンから「ホーム画面に追加」で使いやすくなります';
    return;
  }
  dom.installStatus.textContent = 'ブラウザで使用中です';
}

function addTrailPoint(lat, lng) {
  const point = { lat, lng, recordedAt: new Date().toISOString() };
  const prev = state.gpsTrail[state.gpsTrail.length - 1];
  if (prev) {
    const step = haversineMeters(prev, point);
    if (step < 3) return;
    state.distanceMeters += step;
  }
  state.gpsTrail.push(point);
}

function handlePosition(position) {
  const { latitude, longitude, accuracy } = position.coords;
  state.currentPosition = { lat: latitude, lng: longitude, accuracy };

  if (state.tracking) {
    addTrailPoint(latitude, longitude);
  }

  setGpsStatus(`GPS: ${state.tracking ? '記録中' : '取得済み'} / 精度 約${Math.round(accuracy)}m / ${formatDateTime(new Date().toISOString())}`);
  renderAll();
}

function handleGpsError(error) {
  const help = location.protocol !== 'https:' && location.hostname !== 'localhost'
    ? ' / iPhoneではHTTPSで開いてください'
    : '';
  setGpsStatus(`GPSエラー: ${error.message}${help}`);
}

function startTracking() {
  if (!navigator.geolocation) {
    setGpsStatus('この端末ではGPSが使えません');
    return;
  }
  if (state.watchId !== null) return;

  state.tracking = true;
  state.watchId = navigator.geolocation.watchPosition(handlePosition, handleGpsError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 10000
  });
  setGpsStatus('GPS: 起動中…');
}

function stopTracking() {
  state.tracking = false;
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  setGpsStatus('GPS: 停止');
  renderAll();
}

function getCurrentPositionOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('この端末ではGPSが使えません'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    });
  });
}

async function addStopFromCurrentLocation() {
  try {
    const pos = await getCurrentPositionOnce();
    const { latitude, longitude } = pos.coords;
    state.currentPosition = { lat: latitude, lng: longitude, accuracy: pos.coords.accuracy };
    addStop(latitude, longitude, dom.stopName.value.trim(), dom.stopNote.value.trim());
    map.setView([latitude, longitude], 18);
  } catch (error) {
    setGpsStatus(`現在地取得失敗: ${error.message}`);
  }
}

function toggleMapPickMode() {
  state.mapPickMode = !state.mapPickMode;
  dom.pickModeStatus.textContent = `地図タップ追加: ${state.mapPickMode ? 'ON' : 'OFF'}`;
}

map.on('click', (event) => {
  if (!state.mapPickMode) return;
  addStop(event.latlng.lat, event.latlng.lng, dom.stopName.value.trim(), dom.stopNote.value.trim());
});

function centerToCurrentPosition() {
  if (state.currentPosition) {
    map.setView([state.currentPosition.lat, state.currentPosition.lng], 18);
    return;
  }
  getCurrentPositionOnce()
    .then(pos => {
      handlePosition(pos);
      map.setView([pos.coords.latitude, pos.coords.longitude], 18);
    })
    .catch(handleGpsError);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    routeName: state.routeName,
    stops: state.stops,
    gpsTrail: state.gpsTrail,
    distanceMeters: state.distanceMeters
  };

  const route = (state.routeName || 'delivery-route').replace(/\s+/g, '-');
  const jsonText = JSON.stringify(payload, null, 2);
  const file = new File([jsonText], `${route}.json`, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: '配達ルートJSON',
        text: '配達ルートのバックアップです'
      });
      return;
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('share failed', error);
      }
    }
  }

  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${route}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      state.routeName = parsed.routeName || '';
      state.stops = Array.isArray(parsed.stops) ? parsed.stops : [];
      state.gpsTrail = Array.isArray(parsed.gpsTrail) ? parsed.gpsTrail : [];
      state.distanceMeters = Number(parsed.distanceMeters || 0);
      dom.routeName.value = state.routeName;
      renderAll();
    } catch (error) {
      alert('JSONの読み込みに失敗しました');
      console.error(error);
    }
  };
  reader.readAsText(file);
}

function bindEvents() {
  dom.routeName.addEventListener('input', (e) => {
    state.routeName = e.target.value;
    persist();
  });

  document.getElementById('startTrackBtn').addEventListener('click', startTracking);
  document.getElementById('stopTrackBtn').addEventListener('click', stopTracking);
  document.getElementById('centerBtn').addEventListener('click', centerToCurrentPosition);
  document.getElementById('addCurrentStopBtn').addEventListener('click', addStopFromCurrentLocation);
  document.getElementById('mapPickModeBtn').addEventListener('click', toggleMapPickMode);
  document.getElementById('undoDeliveryBtn').addEventListener('click', undoLatestDelivered);
  document.getElementById('resetDeliveryOrderBtn').addEventListener('click', resetDeliveryOrder);
  document.getElementById('clearAllBtn').addEventListener('click', clearAll);
  document.getElementById('saveBtn').addEventListener('click', () => {
    persist();
    alert('このiPhoneのブラウザ保存領域に保存しました');
  });
  document.getElementById('exportBtn').addEventListener('click', exportJson);
  document.getElementById('importInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importJson(file);
    e.target.value = '';
  });

  document.getElementById('mobileAddCurrentStopBtn').addEventListener('click', addStopFromCurrentLocation);
  document.getElementById('mobileStartTrackBtn').addEventListener('click', () => {
    if (state.tracking) {
      stopTracking();
      document.getElementById('mobileStartTrackBtn').textContent = 'GPS開始';
      return;
    }
    startTracking();
    document.getElementById('mobileStartTrackBtn').textContent = 'GPS停止';
  });

  window.addEventListener('beforeunload', persist);
  window.addEventListener('resize', () => map.invalidateSize());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(() => map.invalidateSize(), 100);
    }
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (error) {
    console.error('service worker registration failed', error);
  }
}

function init() {
  load();
  bindEvents();
  setInstallStatus();
  renderAll();
  centerToCurrentPosition();
  registerServiceWorker();
}

init();
