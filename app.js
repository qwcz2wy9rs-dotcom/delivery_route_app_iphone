const STORAGE_KEY = 'delivery-route-app-state-v5';

const state = {
  routeName: '',
  stops: [],
  gpsTrail: [],
  distanceMeters: 0,
  mapPickMode: false,
  tracking: false,
  watchId: null,
  currentPosition: null,
  savedRoutes: [],
  selectedSavedRouteId: null,
  addressSearchRunning: false
};

const dom = {
  routeName: document.getElementById('routeName'),
  stopName: document.getElementById('stopName'),
  stopNote: document.getElementById('stopNote'),
  stopAddress: document.getElementById('stopAddress'),
  gpsStatus: document.getElementById('gpsStatus'),
  pickModeStatus: document.getElementById('pickModeStatus'),
  stopCount: document.getElementById('stopCount'),
  deliveredCount: document.getElementById('deliveredCount'),
  trackPointCount: document.getElementById('trackPointCount'),
  distanceText: document.getElementById('distanceText'),
  stopList: document.getElementById('stopList'),
  template: document.getElementById('stopItemTemplate'),
  installStatus: document.getElementById('installStatus'),
  currentRouteStatus: document.getElementById('currentRouteStatus'),
  savedRouteCount: document.getElementById('savedRouteCount'),
  savedRoutesList: document.getElementById('savedRoutesList'),
  savedRouteTemplate: document.getElementById('savedRouteItemTemplate'),
  geocodeStatus: document.getElementById('geocodeStatus'),
  nextStopStatus: document.getElementById('nextStopStatus')
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deliveredCountFromStops(stops) {
  return stops.filter(stop => stop.deliveredOrder !== null).length;
}

function snapshotCurrentRoute() {
  return {
    routeName: state.routeName,
    stops: clone(state.stops),
    gpsTrail: clone(state.gpsTrail),
    distanceMeters: state.distanceMeters
  };
}

function applyRouteSnapshot(route) {
  state.routeName = route.routeName || '';
  state.stops = Array.isArray(route.stops) ? clone(route.stops) : [];
  state.gpsTrail = Array.isArray(route.gpsTrail) ? clone(route.gpsTrail) : [];
  state.distanceMeters = Number(route.distanceMeters || 0);
  dom.routeName.value = state.routeName;
  setGeocodeStatus('');
  setNextStopStatus('未配達の先頭順で案内できます');
}

function workspacePayload() {
  return {
    routeName: state.routeName,
    stops: state.stops,
    gpsTrail: state.gpsTrail,
    distanceMeters: state.distanceMeters,
    savedRoutes: state.savedRoutes,
    selectedSavedRouteId: state.selectedSavedRouteId
  };
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspacePayload()));
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
    state.savedRoutes = Array.isArray(parsed.savedRoutes) ? parsed.savedRoutes : [];
    state.selectedSavedRouteId = parsed.selectedSavedRouteId || null;
    dom.routeName.value = state.routeName;
  } catch (error) {
    console.error('load failed', error);
  }
}

function nextDeliveryOrder() {
  return deliveredCountFromStops(state.stops) + 1;
}

function refreshSummary() {
  const deliveredCount = deliveredCountFromStops(state.stops);
  dom.stopCount.textContent = `${state.stops.length}件`;
  dom.deliveredCount.textContent = `${deliveredCount}件`;
  dom.trackPointCount.textContent = `${state.gpsTrail.length}点`;
  dom.distanceText.textContent = formatDistance(state.distanceMeters);
  dom.savedRouteCount.textContent = `${state.savedRoutes.length}件`;

  if (state.selectedSavedRouteId) {
    const selected = state.savedRoutes.find(route => route.id === state.selectedSavedRouteId);
    if (selected) {
      dom.currentRouteStatus.textContent = `現在表示中: 保存済み「${selected.routeName || '名称未設定'}」 / 最終保存 ${formatDateTime(selected.savedAt)}`;
      return;
    }
  }
  dom.currentRouteStatus.textContent = '現在表示中: 未保存の作業ルート';
}


function makeStopIcon(label, delivered) {
  return L.divIcon({
    className: 'custom-stop-icon',
    html: `<div class="numbered-stop${delivered ? '' : ' pending'}">${escapeHtml(label)}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16]
  });
}

function setGeocodeStatus(text) {
  if (dom.geocodeStatus) dom.geocodeStatus.textContent = text;
}

function setNextStopStatus(text) {
  if (dom.nextStopStatus) dom.nextStopStatus.textContent = text;
}

function makeCurrentIcon() {
  return L.divIcon({
    className: 'custom-current-icon',
    html: '<div class="current-marker-dot"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
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
      ${stop.address ? `住所: ${escapeHtml(stop.address)}<br>` : ''}
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

function zoomToCurrentRoute() {
  const points = [
    ...state.stops.map(stop => [stop.lat, stop.lng]),
    ...state.gpsTrail.map(point => [point.lat, point.lng])
  ];

  if (points.length === 0) {
    if (state.currentPosition) {
      map.setView([state.currentPosition.lat, state.currentPosition.lng], 17);
    }
    return;
  }

  if (points.length === 1) {
    map.setView(points[0], 18);
    return;
  }

  map.fitBounds(L.latLngBounds(points), { padding: [30, 30] });
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
    node.querySelector('.stop-note').textContent = [stop.address || '', stop.note || ''].filter(Boolean).join(' / ');

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

function renderSavedRoutes() {
  dom.savedRoutesList.innerHTML = '';

  if (state.savedRoutes.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = '保存済みルートはまだありません';
    dom.savedRoutesList.appendChild(empty);
    return;
  }

  const sorted = [...state.savedRoutes].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

  sorted.forEach(route => {
    const node = dom.savedRouteTemplate.content.firstElementChild.cloneNode(true);
    node.classList.toggle('selected', route.id === state.selectedSavedRouteId);
    node.querySelector('.saved-route-title').textContent = route.routeName || '名称未設定';
    node.querySelector('.saved-route-meta').textContent = `保存 ${formatDateTime(route.savedAt)} / 配達先 ${route.stops.length}件 / 配達済み ${deliveredCountFromStops(route.stops)}件 / GPS ${route.gpsTrail.length}点 / ${formatDistance(route.distanceMeters)}`;

    node.querySelector('.load-route-btn').addEventListener('click', () => {
      loadSavedRoute(route.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    node.querySelector('.show-route-btn').addEventListener('click', () => {
      previewSavedRoute(route.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    node.querySelector('.export-route-btn').addEventListener('click', () => exportJson({ route }));
    node.querySelector('.delete-route-btn').addEventListener('click', () => deleteSavedRoute(route.id));

    dom.savedRoutesList.appendChild(node);
  });
}

function renderAll() {
  refreshSummary();
  renderMap();
  renderList();
  renderSavedRoutes();
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

function addStop(lat, lng, name, note, address = '') {
  state.stops.push({
    id: uid(),
    name: name || `配達先${state.stops.length + 1}`,
    note: note || '',
    address: address || '',
    lat,
    lng,
    createdAt: new Date().toISOString(),
    deliveredOrder: null,
    deliveredAt: null
  });
  dom.stopName.value = '';
  dom.stopNote.value = '';
  if (dom.stopAddress) dom.stopAddress.value = '';
  setGeocodeStatus('');
  renderAll();
}

async function geocodeAddress(address) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('countrycodes', 'jp');
  url.searchParams.set('q', address);

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`住所検索に失敗しました (${response.status})`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('該当する住所が見つかりませんでした');
  }

  return data[0];
}

async function addStopFromAddress() {
  const address = dom.stopAddress?.value.trim() || '';
  if (!address) {
    setGeocodeStatus('住所を入力してください');
    return;
  }
  if (state.addressSearchRunning) return;

  state.addressSearchRunning = true;
  setGeocodeStatus('住所を検索中…');

  try {
    const result = await geocodeAddress(address);
    const lat = Number(result.lat);
    const lng = Number(result.lon);
    addStop(lat, lng, dom.stopName.value.trim(), dom.stopNote.value.trim(), address);
    map.setView([lat, lng], 18);
    const marker = findMarkerByLatLng(lat, lng);
    if (marker) marker.openPopup();
    setGeocodeStatus(`住所から追加しました: ${address}`);
  } catch (error) {
    setGeocodeStatus(error.message || '住所検索に失敗しました');
    console.error(error);
  } finally {
    state.addressSearchRunning = false;
  }
}

function pendingStopsInOrder() {
  return [...state.stops]
    .filter(stop => stop.deliveredOrder === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function openDirectionsToStop(stop) {
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const encodedName = encodeURIComponent(stop.name || '配達先');
  const destination = `${stop.lat},${stop.lng}`;
  const url = isIOS
    ? `https://maps.apple.com/?daddr=${destination}&dirflg=d&q=${encodedName}`
    : `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
  window.open(url, '_blank');
}

function guideToNextUndelivered() {
  const nextStop = pendingStopsInOrder()[0];
  if (!nextStop) {
    setNextStopStatus('未配達はありません');
    alert('未配達はありません');
    return;
  }

  map.setView([nextStop.lat, nextStop.lng], 18);
  const marker = findMarkerByLatLng(nextStop.lat, nextStop.lng);
  if (marker) marker.openPopup();
  setNextStopStatus(`次の未配達: ${nextStop.name || '名称未設定'}${nextStop.address ? ` / ${nextStop.address}` : ''}`);
  openDirectionsToStop(nextStop);
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
  setNextStopStatus('未配達の先頭順で案内できます');
  renderAll();
}

function clearWorkspace() {
  state.routeName = '';
  state.stops = [];
  state.gpsTrail = [];
  state.distanceMeters = 0;
  state.selectedSavedRouteId = null;
  dom.routeName.value = '';
  if (dom.stopAddress) dom.stopAddress.value = '';
  setGeocodeStatus('');
  setNextStopStatus('未配達の先頭順で案内できます');
  renderAll();
}

function clearAll() {
  if (!confirm('作業中ルートを空にします。保存済みルート一覧は残ります。よろしいですか？')) return;
  clearWorkspace();
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
  const codeText = error && typeof error.code === 'number' ? ` (code: ${error.code})` : '';
  const message = error?.message || '位置情報を取得できませんでした';
  setGpsStatus(`GPSエラー: ${message}${codeText}${help}`);
  console.error('GPS error detail', error);
}

function syncTrackButtons() {
  const mobileBtn = document.getElementById('mobileStartTrackBtn');
  if (mobileBtn) mobileBtn.textContent = state.tracking ? 'GPS停止' : 'GPS開始';
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
    maximumAge: 15000,
    timeout: 20000
  });
  setGpsStatus('GPS: 起動中…');
  syncTrackButtons();
}

function stopTracking() {
  state.tracking = false;
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  setGpsStatus('GPS: 停止');
  syncTrackButtons();
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
      maximumAge: 15000,
      timeout: 20000
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

function routeFileName(routeName) {
  const cleaned = (routeName || 'delivery-route').trim().replace(/\s+/g, '-');
  return cleaned || 'delivery-route';
}

async function shareOrDownloadJson(jsonText, filename, shareTitle, shareText) {
  const file = new File([jsonText], filename, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: shareTitle,
        text: shareText
      });
      return true;
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
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

async function exportJson(options = {}) {
  const route = options.route || snapshotCurrentRoute();
  const payload = {
    format: 'delivery-route-single-v1',
    exportedAt: new Date().toISOString(),
    ...clone(route)
  };
  const filename = `${routeFileName(route.routeName)}.json`;
  await shareOrDownloadJson(
    JSON.stringify(payload, null, 2),
    filename,
    '配達ルートJSON',
    '配達ルートのバックアップです'
  );
}

async function exportLibraryJson() {
  const payload = {
    format: 'delivery-route-library-v1',
    exportedAt: new Date().toISOString(),
    currentRoute: snapshotCurrentRoute(),
    selectedSavedRouteId: state.selectedSavedRouteId,
    savedRoutes: clone(state.savedRoutes)
  };
  const filename = `${routeFileName(state.routeName || 'delivery-route-library')}-library.json`;
  await shareOrDownloadJson(
    JSON.stringify(payload, null, 2),
    filename,
    '保存済みルートJSON',
    '保存済みルート一覧のバックアップです'
  );
}

function normalizeSavedRoutes(items) {
  return items
    .filter(Boolean)
    .map(item => ({
      id: item.id || uid(),
      routeName: item.routeName || '名称未設定',
      stops: Array.isArray(item.stops) ? item.stops : [],
      gpsTrail: Array.isArray(item.gpsTrail) ? item.gpsTrail : [],
      distanceMeters: Number(item.distanceMeters || 0),
      createdAt: item.createdAt || item.savedAt || new Date().toISOString(),
      savedAt: item.savedAt || new Date().toISOString()
    }));
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);

      if (parsed.format === 'delivery-route-library-v1') {
        state.savedRoutes = normalizeSavedRoutes(parsed.savedRoutes || []);
        state.selectedSavedRouteId = parsed.selectedSavedRouteId || null;
        applyRouteSnapshot(parsed.currentRoute || {});
        renderAll();
        zoomToCurrentRoute();
        alert('保存済みルート一覧を読み込みました');
        return;
      }

      const now = new Date().toISOString();
      const singleRoute = {
        id: parsed.id || uid(),
        routeName: parsed.routeName || '名称未設定',
        stops: Array.isArray(parsed.stops) ? parsed.stops : [],
        gpsTrail: Array.isArray(parsed.gpsTrail) ? parsed.gpsTrail : [],
        distanceMeters: Number(parsed.distanceMeters || 0),
        createdAt: parsed.createdAt || parsed.savedAt || now,
        savedAt: now
      };
      const existingIndex = state.savedRoutes.findIndex(route => route.id === singleRoute.id);
      if (existingIndex >= 0) {
        state.savedRoutes.splice(existingIndex, 1, singleRoute);
      } else {
        state.savedRoutes.unshift(singleRoute);
      }
      applyRouteSnapshot(singleRoute);
      state.selectedSavedRouteId = singleRoute.id;
      renderAll();
      zoomToCurrentRoute();
      alert('ルートを読み込みました。保存済みルート一覧にも追加しました');
    } catch (error) {
      alert('JSONの読み込みに失敗しました');
      console.error(error);
    }
  };
  reader.readAsText(file);
}

function saveCurrentRoute() {
  const now = new Date().toISOString();
  const routeName = state.routeName.trim() || `ルート ${formatDateTime(now)}`;
  state.routeName = routeName;
  dom.routeName.value = routeName;

  const snapshot = {
    id: state.selectedSavedRouteId || uid(),
    routeName,
    stops: clone(state.stops),
    gpsTrail: clone(state.gpsTrail),
    distanceMeters: state.distanceMeters,
    createdAt: now,
    savedAt: now
  };

  const existingIndex = state.savedRoutes.findIndex(route => route.id === snapshot.id);
  if (existingIndex >= 0) {
    snapshot.createdAt = state.savedRoutes[existingIndex].createdAt || now;
    state.savedRoutes.splice(existingIndex, 1, snapshot);
  } else {
    state.savedRoutes.unshift(snapshot);
  }

  state.selectedSavedRouteId = snapshot.id;
  renderAll();
  alert('保存済みルート一覧に保存しました');
}


function previewSavedRoute(routeId) {
  const route = state.savedRoutes.find(item => item.id === routeId);
  if (!route) return;

  layers.stops.clearLayers();
  route.stops.forEach(stop => {
    const label = stop.deliveredOrder !== null ? stop.deliveredOrder : '未';
    const marker = L.marker([stop.lat, stop.lng], {
      icon: makeStopIcon(label, stop.deliveredOrder !== null)
    });
    const popup = `
      <strong>${escapeHtml(stop.name || '名称未設定')}</strong><br>
      状態: ${stop.deliveredOrder !== null ? `配達順 ${stop.deliveredOrder}` : '未配達'}<br>
      座標: ${toFixedCoord(stop.lat)}, ${toFixedCoord(stop.lng)}<br>
      ${stop.address ? `住所: ${escapeHtml(stop.address)}<br>` : ''}
      ${stop.note ? `メモ: ${escapeHtml(stop.note)}<br>` : ''}
      ${stop.deliveredAt ? `記録時刻: ${escapeHtml(formatDateTime(stop.deliveredAt))}` : ''}
    `;
    marker.bindPopup(popup);
    marker.addTo(layers.stops);
  });

  const deliveredRoute = [...route.stops]
    .filter(stop => stop.deliveredOrder !== null)
    .sort((a, b) => a.deliveredOrder - b.deliveredOrder)
    .map(stop => [stop.lat, stop.lng]);
  layers.deliveredRoute.setLatLngs(deliveredRoute);
  layers.gpsTrail.setLatLngs((route.gpsTrail || []).map(point => [point.lat, point.lng]));

  const points = [
    ...(route.stops || []).map(stop => [stop.lat, stop.lng]),
    ...(route.gpsTrail || []).map(point => [point.lat, point.lng])
  ];
  if (points.length > 0) {
    map.fitBounds(L.latLngBounds(points), { padding: [30, 30] });
  }
  state.selectedSavedRouteId = route.id;
  refreshSummary();
  renderSavedRoutes();
  persist();
}

function loadSelectedRoute() {
  if (!state.selectedSavedRouteId) {
    alert('保存済みルート一覧から先にルートを選んでください');
    return;
  }
  loadSavedRoute(state.selectedSavedRouteId);
}

function loadSavedRoute(routeId) {
  const route = state.savedRoutes.find(item => item.id === routeId);
  if (!route) return;
  applyRouteSnapshot(route);
  state.selectedSavedRouteId = route.id;
  renderAll();
  zoomToCurrentRoute();
}

function deleteSavedRoute(routeId) {
  const route = state.savedRoutes.find(item => item.id === routeId);
  if (!route) return;
  if (!confirm(`保存済みルート「${route.routeName}」を削除しますか？`)) return;

  state.savedRoutes = state.savedRoutes.filter(item => item.id !== routeId);
  if (state.selectedSavedRouteId === routeId) {
    state.selectedSavedRouteId = null;
  }
  renderAll();
}

function newRouteWorkspace() {
  if (!confirm('現在の作業ルートを新規状態にします。保存していない変更は失われます。よろしいですか？')) return;
  clearWorkspace();
}

function bindEvents() {
  dom.routeName.addEventListener('input', (e) => {
    state.routeName = e.target.value;
    persist();
  });

  document.getElementById('startTrackBtn').addEventListener('click', startTracking);
  document.getElementById('stopTrackBtn').addEventListener('click', stopTracking);
  document.getElementById('centerBtn').addEventListener('click', centerToCurrentPosition);
  document.getElementById('zoomRouteBtn').addEventListener('click', zoomToCurrentRoute);
  document.getElementById('newRouteBtn').addEventListener('click', newRouteWorkspace);
  document.getElementById('addCurrentStopBtn').addEventListener('click', addStopFromCurrentLocation);
  document.getElementById('addAddressStopBtn').addEventListener('click', addStopFromAddress);
  document.getElementById('mapPickModeBtn').addEventListener('click', toggleMapPickMode);
  document.getElementById('undoDeliveryBtn').addEventListener('click', undoLatestDelivered);
  document.getElementById('resetDeliveryOrderBtn').addEventListener('click', resetDeliveryOrder);
  document.getElementById('saveRouteBtn').addEventListener('click', saveCurrentRoute);
  document.getElementById('saveBtn').addEventListener('click', () => {
    persist();
    alert('このiPhoneのブラウザ保存領域に保存しました');
  });
  document.getElementById('exportBtn').addEventListener('click', () => exportJson());
  document.getElementById('exportLibraryBtn').addEventListener('click', exportLibraryJson);
  document.getElementById('clearAllBtn').addEventListener('click', clearAll);
  document.getElementById('loadSelectedRouteBtn').addEventListener('click', loadSelectedRoute);
  document.getElementById('importInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importJson(file);
    e.target.value = '';
  });

  document.getElementById('mobileAddCurrentStopBtn').addEventListener('click', addStopFromCurrentLocation);
  document.getElementById('guideNextStopBtn').addEventListener('click', guideToNextUndelivered);
  document.getElementById('mobileStartTrackBtn').addEventListener('click', () => {
    if (state.tracking) {
      stopTracking();
      return;
    }
    startTracking();
  });

  window.addEventListener('beforeunload', persist);
  window.addEventListener('resize', () => map.invalidateSize());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(() => map.invalidateSize(), 100);
    }
  });
}

async function disableOldServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(r => r.unregister()));
  } catch (error) {
    console.error('service worker cleanup failed', error);
  }
}

async function init() {
  load();
  bindEvents();
  setInstallStatus();
  syncTrackButtons();
  renderAll();
  setGpsStatus('GPS: 「現在地へ移動」または「GPS記録開始」を押してください');
  setGeocodeStatus('');
  setNextStopStatus('未配達の先頭順で案内できます');
  await disableOldServiceWorkers();
}

init();
