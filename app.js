const STORAGE_KEY = 'delivery-route-app-state-gmaps-v1';
const CONFIG = window.APP_CONFIG || {};

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
  addressSearchRunning: false,
  mapType: CONFIG.DEFAULT_MAP_TYPE || 'hybrid'
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
  nextStopStatus: document.getElementById('nextStopStatus'),
  mapProviderStatus: document.getElementById('mapProviderStatus'),
  mapHint: document.getElementById('mapHint'),
  mapHybridBtn: document.getElementById('mapHybridBtn'),
  mapSatelliteBtn: document.getElementById('mapSatelliteBtn'),
  mapRoadmapBtn: document.getElementById('mapRoadmapBtn')
};

const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const mapState = {
  map: null,
  ready: false,
  stopMarkers: [],
  deliveredPolyline: null,
  gpsTrailPolyline: null,
  currentMarker: null,
  infoWindow: null,
  previewRouteId: null,
  googleLoadingPromise: null,
  clickListener: null
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
  mapState.previewRouteId = null;
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
    selectedSavedRouteId: state.selectedSavedRouteId,
    mapType: state.mapType
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
    state.mapType = parsed.mapType || state.mapType;
    dom.routeName.value = state.routeName;
  } catch (error) {
    console.error('load failed', error);
  }
}

function nextDeliveryOrder() {
  return deliveredCountFromStops(state.stops) + 1;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setMapProviderStatus(text) {
  if (dom.mapProviderStatus) {
    dom.mapProviderStatus.textContent = text;
  }
}

function setMapHint(text) {
  if (dom.mapHint) dom.mapHint.textContent = text;
}

function setGeocodeStatus(text) {
  if (dom.geocodeStatus) dom.geocodeStatus.textContent = text;
}

function setNextStopStatus(text) {
  if (dom.nextStopStatus) dom.nextStopStatus.textContent = text;
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

function refreshSummary() {
  const deliveredCount = deliveredCountFromStops(state.stops);
  dom.stopCount.textContent = `${state.stops.length}件`;
  dom.deliveredCount.textContent = `${deliveredCount}件`;
  dom.trackPointCount.textContent = `${state.gpsTrail.length}点`;
  dom.distanceText.textContent = formatDistance(state.distanceMeters);
  dom.savedRouteCount.textContent = `${state.savedRoutes.length}件`;

  if (mapState.previewRouteId) {
    const preview = state.savedRoutes.find(route => route.id === mapState.previewRouteId);
    if (preview) {
      dom.currentRouteStatus.textContent = `地図プレビュー中: 保存済み「${preview.routeName || '名称未設定'}」 / 作業中ルートは未変更`;
      return;
    }
  }

  if (state.selectedSavedRouteId) {
    const selected = state.savedRoutes.find(route => route.id === state.selectedSavedRouteId);
    if (selected) {
      dom.currentRouteStatus.textContent = `現在表示中: 保存済み「${selected.routeName || '名称未設定'}」 / 最終保存 ${formatDateTime(selected.savedAt)}`;
      return;
    }
  }
  dom.currentRouteStatus.textContent = '現在表示中: 未保存の作業ルート';
}

function createStopIcon(label, delivered) {
  const fill = delivered ? '#2057d4' : '#ffffff';
  const stroke = delivered ? '#2057d4' : '#5d6b82';
  const textColor = delivered ? '#ffffff' : '#1c2430';
  const fontSize = String(label).length > 1 ? 14 : 18;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
      <circle cx="22" cy="22" r="17" fill="${fill}" stroke="${stroke}" stroke-width="4" />
      <text x="22" y="27" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-weight="700" font-size="${fontSize}" fill="${textColor}">${escapeHtml(String(label))}</text>
    </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(44, 44),
    anchor: new google.maps.Point(22, 22)
  };
}

function createCurrentPositionIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
      <circle cx="14" cy="14" r="9" fill="#28b7ff" stroke="#ffffff" stroke-width="4" />
    </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(28, 28),
    anchor: new google.maps.Point(14, 14)
  };
}

function pendingStopsInOrder() {
  return [...state.stops]
    .filter(stop => stop.deliveredOrder === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function deliveredStopsInOrder(stops = state.stops) {
  return [...stops]
    .filter(stop => stop.deliveredOrder !== null)
    .sort((a, b) => a.deliveredOrder - b.deliveredOrder);
}

function updateMapTypeButtons() {
  const btns = [
    [dom.mapHybridBtn, 'hybrid'],
    [dom.mapSatelliteBtn, 'satellite'],
    [dom.mapRoadmapBtn, 'roadmap']
  ];
  btns.forEach(([btn, type]) => {
    if (!btn) return;
    btn.classList.toggle('active', state.mapType === type);
  });

  if (state.mapType === 'hybrid') {
    setMapHint('Google航空写真 + ラベル');
  } else if (state.mapType === 'satellite') {
    setMapHint('Google航空写真のみ');
  } else {
    setMapHint('Google通常地図');
  }
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
      focusLatLng(stop.lat, stop.lng, 19);
      const marker = findMarkerByLatLng(stop.lat, stop.lng);
      if (marker) openStopInfo(marker);
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
    node.classList.toggle('selected', route.id === state.selectedSavedRouteId || route.id === mapState.previewRouteId);
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
  renderWorkspaceRouteOnMap();
  renderList();
  renderSavedRoutes();
  updateMapTypeButtons();
  persist();
}

function popupHtmlForStop(stop) {
  return `
    <div style="line-height:1.6;min-width:180px;">
      <strong>${escapeHtml(stop.name || '名称未設定')}</strong><br>
      状態: ${stop.deliveredOrder !== null ? `配達順 ${stop.deliveredOrder}` : '未配達'}<br>
      座標: ${toFixedCoord(stop.lat)}, ${toFixedCoord(stop.lng)}<br>
      ${stop.address ? `住所: ${escapeHtml(stop.address)}<br>` : ''}
      ${stop.note ? `メモ: ${escapeHtml(stop.note)}<br>` : ''}
      ${stop.deliveredAt ? `記録時刻: ${escapeHtml(formatDateTime(stop.deliveredAt))}` : ''}
    </div>`;
}

function clearMapObjects() {
  if (!mapState.ready) return;
  mapState.stopMarkers.forEach(marker => marker.setMap(null));
  mapState.stopMarkers = [];

  if (mapState.deliveredPolyline) mapState.deliveredPolyline.setMap(null);
  if (mapState.gpsTrailPolyline) mapState.gpsTrailPolyline.setMap(null);
  if (mapState.currentMarker) mapState.currentMarker.setMap(null);

  mapState.deliveredPolyline = null;
  mapState.gpsTrailPolyline = null;
  mapState.currentMarker = null;
}

function openStopInfo(marker) {
  if (!mapState.ready || !marker) return;
  if (!mapState.infoWindow) {
    mapState.infoWindow = new google.maps.InfoWindow();
  }
  mapState.infoWindow.setContent(marker.__popupHtml || '');
  mapState.infoWindow.open({ map: mapState.map, anchor: marker });
}

function drawRouteOnMap(route, options = {}) {
  if (!mapState.ready) return;
  const showCurrentPosition = options.showCurrentPosition !== false;

  clearMapObjects();

  route.stops.forEach(stop => {
    const label = stop.deliveredOrder !== null ? stop.deliveredOrder : '未';
    const marker = new google.maps.Marker({
      position: { lat: stop.lat, lng: stop.lng },
      map: mapState.map,
      title: stop.name || '配達先',
      icon: createStopIcon(label, stop.deliveredOrder !== null),
      zIndex: stop.deliveredOrder !== null ? 20 : 10
    });
    marker.__popupHtml = popupHtmlForStop(stop);
    marker.__stopLat = stop.lat;
    marker.__stopLng = stop.lng;
    marker.addListener('click', () => openStopInfo(marker));
    mapState.stopMarkers.push(marker);
  });

  const deliveredPath = deliveredStopsInOrder(route.stops).map(stop => ({ lat: stop.lat, lng: stop.lng }));
  mapState.deliveredPolyline = new google.maps.Polyline({
    map: mapState.map,
    path: deliveredPath,
    strokeColor: '#1d4ed8',
    strokeOpacity: 0.95,
    strokeWeight: 5
  });

  const gpsPath = (route.gpsTrail || []).map(point => ({ lat: point.lat, lng: point.lng }));
  mapState.gpsTrailPolyline = new google.maps.Polyline({
    map: mapState.map,
    path: gpsPath,
    strokeColor: '#67e8f9',
    strokeOpacity: 0.95,
    strokeWeight: 4
  });

  if (showCurrentPosition && state.currentPosition) {
    mapState.currentMarker = new google.maps.Marker({
      position: { lat: state.currentPosition.lat, lng: state.currentPosition.lng },
      map: mapState.map,
      title: '現在地',
      icon: createCurrentPositionIcon(),
      zIndex: 100
    });
  }
}

function renderWorkspaceRouteOnMap() {
  if (mapState.previewRouteId) return;
  drawRouteOnMap(snapshotCurrentRoute(), { showCurrentPosition: true });
}

function previewSavedRoute(routeId) {
  const route = state.savedRoutes.find(item => item.id === routeId);
  if (!route) return;
  mapState.previewRouteId = route.id;
  drawRouteOnMap(route, { showCurrentPosition: false });
  zoomToPoints([
    ...(route.stops || []).map(stop => ({ lat: stop.lat, lng: stop.lng })),
    ...(route.gpsTrail || []).map(point => ({ lat: point.lat, lng: point.lng }))
  ]);
  refreshSummary();
  renderSavedRoutes();
  persist();
}

function findMarkerByLatLng(lat, lng) {
  return mapState.stopMarkers.find(marker => {
    const pos = marker.getPosition();
    return pos && Math.abs(pos.lat() - lat) < 0.000001 && Math.abs(pos.lng() - lng) < 0.000001;
  }) || null;
}

function focusLatLng(lat, lng, zoom = 18) {
  if (!mapState.ready) return;
  mapState.map.setCenter({ lat, lng });
  if (zoom) mapState.map.setZoom(zoom);
}

function zoomToPoints(points) {
  if (!mapState.ready) return;
  if (!points || points.length === 0) {
    if (state.currentPosition) {
      focusLatLng(state.currentPosition.lat, state.currentPosition.lng, 18);
    }
    return;
  }
  if (points.length === 1) {
    focusLatLng(points[0].lat, points[0].lng, 19);
    return;
  }
  const bounds = new google.maps.LatLngBounds();
  points.forEach(point => bounds.extend(point));
  mapState.map.fitBounds(bounds, 48);
}

function zoomToCurrentRoute() {
  zoomToPoints([
    ...state.stops.map(stop => ({ lat: stop.lat, lng: stop.lng })),
    ...state.gpsTrail.map(point => ({ lat: point.lat, lng: point.lng }))
  ]);
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
  mapState.previewRouteId = null;
  renderAll();
}

function toHalfWidth(value) {
  return (value || '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

function normalizeJapaneseAddress(address) {
  let s = toHalfWidth(address || '').trim();
  s = s.replace(/〒\s*/g, '');
  s = s.replace(/[ー−‐―ｰ]/g, '-');
  s = s.replace(/\b(\d{3})-(\d{4})\b/g, '$1-$2');
  s = s.replace(/\b(\d{3})(\d{4})\b/g, '$1-$2');
  s = s.replace(/\s+/g, ' ');
  return s;
}

function buildAddressQueries(address) {
  const normalized = normalizeJapaneseAddress(address);
  const queries = [];
  const seen = new Set();

  const add = value => {
    const q = (value || '').trim();
    if (!q || seen.has(q)) return;
    seen.add(q);
    queries.push(q);
  };

  add(normalized);
  add(normalized.replace(/^\d{3}-\d{4}\s*/, ''));
  add(normalized.replace(/\d{3}-\d{4}/g, '').replace(/\s+/g, ' ').trim());
  add(normalized.replace(/県/g, '県 ').replace(/市/g, '市 ').replace(/区/g, '区 ').replace(/町/g, '町 ').replace(/村/g, '村 ').replace(/\s+/g, ' ').trim());
  add(normalized.replace(/-/g, ' '));

  return queries;
}

async function fetchGeocode(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('countrycodes', 'jp');
  url.searchParams.set('accept-language', 'ja');
  url.searchParams.set('q', query);

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`住所検索に失敗しました (${response.status})`);
  }

  return response.json();
}

async function geocodeAddress(address) {
  const queries = buildAddressQueries(address);
  let lastError = null;

  for (const query of queries) {
    try {
      const data = await fetchGeocode(query);
      if (Array.isArray(data) && data.length > 0) {
        return { result: data[0], usedQuery: query };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  throw new Error('該当する住所が見つかりませんでした。郵便番号を外すか、丁目・番地を半角で入力してみてください');
}

function geocodeWithGeolonia(address) {
  return new Promise((resolve, reject) => {
    if (typeof window.getLatLng !== 'function') {
      reject(new Error('Geolonia住所検索を読み込めませんでした'));
      return;
    }
    window.getLatLng(address, (latlng) => {
      if (!latlng || typeof latlng.lat === 'undefined' || typeof latlng.lng === 'undefined') {
        reject(new Error('住所の座標を取得できませんでした'));
        return;
      }
      resolve({
        result: {
          lat: latlng.lat,
          lon: latlng.lng,
          display_name: [latlng.pref, latlng.city, latlng.town, latlng.addr].filter(Boolean).join('')
        },
        usedQuery: address,
        provider: 'geolonia',
        raw: latlng
      });
    }, (error) => {
      reject(error instanceof Error ? error : new Error(typeof error === 'string' ? error : '住所検索に失敗しました'));
    });
  });
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
    let geocoded;
    try {
      geocoded = await geocodeWithGeolonia(address);
    } catch (primaryError) {
      console.warn('Geolonia geocoder failed, fallback to Nominatim', primaryError);
      geocoded = await geocodeAddress(address);
    }

    const lat = Number(geocoded.result.lat);
    const lng = Number(geocoded.result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('住所の座標を取得できませんでした');
    }

    addStop(lat, lng, dom.stopName.value.trim(), dom.stopNote.value.trim(), address);
    focusLatLng(lat, lng, 19);
    const marker = findMarkerByLatLng(lat, lng);
    if (marker) openStopInfo(marker);
    const providerLabel = geocoded.provider === 'geolonia' ? 'Geolonia' : 'OpenStreetMap';
    const normalized = geocoded.usedQuery && geocoded.usedQuery !== address ? `（検索語: ${geocoded.usedQuery}）` : '';
    setGeocodeStatus(`住所から追加しました: ${address} / ${providerLabel}${normalized}`);
  } catch (error) {
    setGeocodeStatus(error.message || '住所検索に失敗しました');
    console.error(error);
  } finally {
    state.addressSearchRunning = false;
  }
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

  mapState.previewRouteId = null;
  renderWorkspaceRouteOnMap();
  focusLatLng(nextStop.lat, nextStop.lng, 19);
  const marker = findMarkerByLatLng(nextStop.lat, nextStop.lng);
  if (marker) openStopInfo(marker);
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
  mapState.previewRouteId = null;
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

  mapState.previewRouteId = null;
  renderAll();
}

function undoLatestDelivered() {
  const latest = deliveredStopsInOrder().slice(-1)[0];
  if (!latest) {
    alert('取り消せる配達済みがありません');
    return;
  }
  toggleDelivered(latest.id);
}

function resetDeliveryOrder() {
  if (!confirm('現在の配達順をすべて未配達に戻しますか？')) return;
  state.stops.forEach(stop => {
    stop.deliveredOrder = null;
    stop.deliveredAt = null;
  });
  mapState.previewRouteId = null;
  renderAll();
}

function clearWorkspace() {
  state.routeName = '';
  state.stops = [];
  state.gpsTrail = [];
  state.distanceMeters = 0;
  state.selectedSavedRouteId = null;
  mapState.previewRouteId = null;
  dom.routeName.value = '';
  setGeocodeStatus('');
  setNextStopStatus('未配達の先頭順で案内できます');
  renderAll();
}

function clearAll() {
  if (!confirm('作業中ルートを空にします。保存済みルート一覧は残ります。よろしいですか？')) return;
  clearWorkspace();
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
  if (mapState.previewRouteId) {
    renderSavedRoutes();
    persist();
    if (mapState.currentMarker) {
      mapState.currentMarker.setPosition({ lat: latitude, lng: longitude });
    }
    return;
  }
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
    focusLatLng(latitude, longitude, 19);
  } catch (error) {
    setGpsStatus(`現在地取得失敗: ${error.message}`);
  }
}

function toggleMapPickMode() {
  state.mapPickMode = !state.mapPickMode;
  dom.pickModeStatus.textContent = `地図タップ追加: ${state.mapPickMode ? 'ON' : 'OFF'}`;
}

function centerToCurrentPosition() {
  if (state.currentPosition) {
    mapState.previewRouteId = null;
    renderWorkspaceRouteOnMap();
    focusLatLng(state.currentPosition.lat, state.currentPosition.lng, 19);
    return;
  }
  getCurrentPositionOnce()
    .then(pos => {
      mapState.previewRouteId = null;
      handlePosition(pos);
      focusLatLng(pos.coords.latitude, pos.coords.longitude, 19);
    })
    .catch(handleGpsError);
}

function routeFileName(routeName) {
  const cleaned = (routeName || 'delivery-route').trim().replace(/\s+/g, '-');
  return cleaned || 'delivery-route';
}

async function shareOrDownloadJson(jsonText, filename, shareTitle, shareText) {
  const file = new File([jsonText], filename, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: shareTitle, text: shareText });
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
  mapState.previewRouteId = null;
  renderAll();
  alert('保存済みルート一覧に保存しました');
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
  if (mapState.previewRouteId === routeId) {
    mapState.previewRouteId = null;
  }
  renderAll();
}

function newRouteWorkspace() {
  if (!confirm('現在の作業ルートを新規状態にします。保存していない変更は失われます。よろしいですか？')) return;
  clearWorkspace();
}

function setMapType(type) {
  state.mapType = type;
  if (mapState.ready) {
    mapState.map.setMapTypeId(type);
    mapState.map.setTilt(0);
  }
  updateMapTypeButtons();
  persist();
}

function loadGoogleMapsApi() {
  const apiKey = CONFIG.GOOGLE_MAPS_API_KEY || '';
  if (!apiKey) {
    return Promise.reject(new Error('config.js に Google Maps APIキーを設定してください'));
  }
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  if (mapState.googleLoadingPromise) return mapState.googleLoadingPromise;

  mapState.googleLoadingPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-google-maps-loader="1"]');
    if (existing && window.google?.maps?.Map) {
      resolve(window.google.maps);
      return;
    }

    const callbackName = '__deliveryAppGoogleMapsReady';
    window[callbackName] = () => {
      if (window.google?.maps?.Map) {
        resolve(window.google.maps);
      } else {
        reject(new Error('Google Maps APIは読み込まれましたが Map クラスが見つかりません'));
      }
      try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
    };

    if (existing) {
      return;
    }

    const script = document.createElement('script');
    script.dataset.googleMapsLoader = '1';
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&callback=${callbackName}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
      reject(new Error('Google Maps APIの読み込みに失敗しました'));
    };
    document.head.appendChild(script);
  });

  return mapState.googleLoadingPromise;
}

window.gm_authFailure = function gmAuthFailure() {
  setMapProviderStatus('Google Maps APIキーが無効か、HTTPリファラ制限に引っかかっています');
};

async function initMap() {
  try {
    setMapProviderStatus('Google Maps を読み込み中…');
    await loadGoogleMapsApi();

    const center = CONFIG.DEFAULT_CENTER || { lat: 33.5902, lng: 130.4017 };
    mapState.map = new google.maps.Map(document.getElementById('map'), {
      center,
      zoom: CONFIG.DEFAULT_ZOOM || 13,
      mapTypeId: state.mapType,
      streetViewControl: false,
      fullscreenControl: false,
      mapTypeControl: false,
      rotateControl: false,
      gestureHandling: 'greedy',
      tilt: 0,
      clickableIcons: true,
      keyboardShortcuts: true
    });

    mapState.ready = true;
    mapState.infoWindow = new google.maps.InfoWindow();
    mapState.clickListener = mapState.map.addListener('click', (event) => {
      if (!state.mapPickMode) return;
      addStop(event.latLng.lat(), event.latLng.lng(), dom.stopName.value.trim(), dom.stopNote.value.trim(), dom.stopAddress.value.trim());
      focusLatLng(event.latLng.lat(), event.latLng.lng(), 19);
    });

    updateMapTypeButtons();
    setMapProviderStatus('Google Maps: 2D航空写真を使用中');
    renderAll();
  } catch (error) {
    console.error(error);
    setMapProviderStatus(error.message || '地図の初期化に失敗しました');
    setMapHint('Google Maps APIキーを設定すると航空写真表示になります');
  }
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
  document.getElementById('guideNextStopBtn').addEventListener('click', guideToNextUndelivered);
  document.getElementById('importInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importJson(file);
    e.target.value = '';
  });

  document.getElementById('mobileAddCurrentStopBtn').addEventListener('click', addStopFromCurrentLocation);
  document.getElementById('mobileStartTrackBtn').addEventListener('click', () => {
    if (state.tracking) {
      stopTracking();
      return;
    }
    startTracking();
  });

  dom.mapHybridBtn.addEventListener('click', () => setMapType('hybrid'));
  dom.mapSatelliteBtn.addEventListener('click', () => setMapType('satellite'));
  dom.mapRoadmapBtn.addEventListener('click', () => setMapType('roadmap'));

  window.addEventListener('beforeunload', persist);
  window.addEventListener('resize', () => {
    if (mapState.ready) {
      google.maps.event.trigger(mapState.map, 'resize');
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
  refreshSummary();
  renderList();
  renderSavedRoutes();
  updateMapTypeButtons();
  setGpsStatus('GPS: 「現在地へ移動」または「GPS記録開始」を押してください');
  setGeocodeStatus('');
  setNextStopStatus('未配達の先頭順で案内できます');
  await disableOldServiceWorkers();
  await initMap();
}

init();
